// The jobs run (src/jobs.ts, run by scripts/run-jobs.ts in GitHub Actions): one run drains every queue in passes,
// stops at its budget and resumes with the next run; an idle run makes one read.
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bunGrid } from "../scripts/lib/sim-core";
import { RUN_D1_CALLS, RUN_MS } from "../src/budget";
import { runJobs } from "../src/jobs";
import { battleResponse, fleet, harness, LAYOUT_15, seedBasic, type Harness } from "./helpers";

let h: Harness;
const deps = { gridFn: bunGrid, now: () => h.clock.t };
const count = async (sql: string) => (await h.db.prepare(sql).first<{ n: number }>())!.n;
const lock = async () => (await h.db.prepare("SELECT value FROM kv_state WHERE key = 'jobs_lock_until'").first<{ value: string }>())!.value;

/** Stages `uploads` × 50 battles (one request per 60 s); nothing is processed yet. */
async function stage(uploads: number) {
  const { token } = await h.register();
  let seq = 0;
  for (let u = 0; u < uploads; u++) {
    h.clock.t += 61_000;
    const observations = Array.from({ length: 50 }, () => {
      seq++;
      return {
        clientObsId: `b${seq}`, observedAt: new Date(h.clock.t - 86_400_000 + seq * 1000).toISOString(), map: "1-5", cell: 1,
        layout: LAYOUT_15, difficulty: 0, kind: "battle", fleet: fleet(),
        raw: { path: "api_req_sortie/battle", visitId: `visit-${seq}`, sortieId: null, raw: battleResponse([1501, 1502, 1502]), result: null },
      };
    });
    const r = await h.call("POST", "/api/v1/observations", { token, body: { observations } });
    expect(r.status).toBe(202);
  }
  return seq;
}

beforeEach(async () => {
  h = harness();
  await seedBasic(h.db);
});

describe("jobs run", () => {
  test("the worker has no cron and no scheduled handler; GitHub Actions runs the jobs", async () => {
    expect(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8")).toContain("crons = []");
    const workflow = readFileSync(new URL("../../.github/workflows/jobs.yml", import.meta.url), "utf8");
    expect(workflow).toContain("scripts/run-jobs.ts run");
    expect(workflow.match(/- cron: "([^"]+)"/g)).toEqual(['- cron: "7 18 * * *"']);
    expect(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")).not.toContain("scheduled");
  });

  test("an idle run makes one read and takes no lease", async () => {
    const r = await runJobs(h.db, deps);
    expect(r).toMatchObject({ busy: false, idle: true, passes: 0, d1Calls: 1 });
    expect(await lock()).toBe("0");
  });

  test("one run drains staged uploads, aggregation and the estimator in several passes", async () => {
    const n = await stage(6);
    const r = await runJobs(h.db, deps);
    expect(r.busy).toBe(false);
    expect(r.passes).toBeGreaterThan(1); // aggregation folds ≤ 200 observations per pass
    expect(r.ingest).toMatchObject({ ingested: n, rejected: 0, remaining: 0 });
    expect(r.aggregation).toMatchObject({ aggregated: n, failed: 0, maps: [15], remaining: 0, dirtyMaps: 0 });
    expect(r.spentMs).toBeLessThanOrEqual(RUN_MS);
    expect(r.d1Calls).toBeLessThanOrEqual(RUN_D1_CALLS);
    expect(await count("SELECT COUNT(*) AS n FROM upload_items")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM observations WHERE aggregated_at IS NULL")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM observation_ships WHERE est_at IS NULL")).toBe(0);
    expect(await lock()).toBe("0");
    expect((await runJobs(h.db, deps)).idle).toBe(true);
  });

  test("a run stops at its budget and the next run resumes", async () => {
    const n = await stage(6);
    const first = await runJobs(h.db, deps, { budgetMs: 8 });
    expect(first.busy).toBe(false);
    expect(first.passes).toBeGreaterThanOrEqual(1);
    expect(first.spentMs).toBeLessThanOrEqual(8 + 0.05); // the last queue probe may follow the last pass
    expect(first.ingest!.ingested).toBeGreaterThan(0);
    expect(first.ingest!.remaining + first.aggregation!.remaining).toBeGreaterThan(0);
    expect(await lock()).toBe("0");

    h.clock.t += 3_600_000;
    const second = await runJobs(h.db, deps);
    expect(first.ingest!.ingested + second.ingest!.ingested).toBe(n);
    expect(second.aggregation).toMatchObject({ remaining: 0, dirtyMaps: 0 });
    expect((await runJobs(h.db, deps)).idle).toBe(true);
  });

  test("a run while another holds the lease reports busy and does nothing", async () => {
    await stage(1);
    await h.db.prepare("UPDATE kv_state SET value = ?1 WHERE key = 'jobs_lock_until'").bind(String(h.clock.t + 60_000)).run();
    expect(await runJobs(h.db, deps)).toMatchObject({ busy: true, passes: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM upload_items")).toBe(50);
  });
});
