// Background jobs outside the worker (docs/DEPLOY.md §5). GitHub Actions (.github/workflows/jobs.yml) runs this
// against production D1 (D1_REMOTE=1: D1 HTTP API); without D1_REMOTE it works on the local wrangler D1 file.
//   bun scripts/run-jobs.ts run [--minutes 25] [--no-estimator]
//       jobs runs (staged uploads → observations, aggregation, estimator; src/jobs.ts) until every queue is empty,
//       a run makes no progress, or the time is up
//   bun scripts/run-jobs.ts kcnav [--minutes 25] [--only battles | --skip battles] [--max N]
//       the KCNav queue (src/kcnav/tick.ts): one request per call, never sooner than the persisted gate allows
//       (≥ KCNAV_MIN_INTERVAL_MS = 65 s after the previous request, longer after a 429), until the queue (of the
//       selected kinds) is empty, N requests were sent, or the next request would start after the time is up
//   bun scripts/run-jobs.ts enqueue '<json>'
//       queues KCNav jobs straight into D1 (src/kcnav/enqueue.ts; same body as POST /admin/kcnav/enqueue)
// All append a summary to $GITHUB_STEP_SUMMARY when set.
import { parseArgs } from "node:util";
import { RUN_D1_CALLS, RUN_MS } from "../src/budget";
import { runJobs, type JobsResult } from "../src/jobs";
import { enqueue } from "../src/kcnav/enqueue";
import { tick } from "../src/kcnav/tick";
import type { Env } from "../src/env";
import { enqueueRequest } from "../src/schemas";
import { openD1, productionConfig } from "./lib/d1-database";
import { appendSummary } from "./lib/summary";

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    minutes: { type: "string" }, "no-estimator": { type: "boolean" },
    only: { type: "string" }, skip: { type: "string" }, max: { type: "string" },
  },
});
const stamp = () => new Date().toISOString();
const db = openD1();
const target = process.env.D1_REMOTE === "1" ? "production D1" : "local D1";

switch (positionals[0]) {
  case "run": {
    const deadline = Date.now() + Number(values.minutes ?? 25) * 60_000;
    // Only the estimator needs sim-core's wasm; `kcnav` / `enqueue` run without sim-core/pkg (kcnav-crawl workflow).
    const { bunGrid } = await import("./lib/sim-core");
    const runs: JobsResult[] = [];
    while (Date.now() < deadline) {
      const r = await runJobs(db, { gridFn: bunGrid, now: () => Date.now() }, { estimator: !values["no-estimator"] });
      console.log(stamp(), JSON.stringify(r));
      runs.push(r);
      // Another run holds the lease, nothing is queued, or the run ended before its caps: nothing more to do now.
      const capped = r.spentMs >= 0.9 * RUN_MS || r.d1Calls >= RUN_D1_CALLS - 20;
      if (r.busy || r.idle || !capped) break;
    }
    const sum = (f: (r: JobsResult) => number | undefined) => runs.reduce((n, r) => n + (f(r) ?? 0), 0);
    const last = runs.at(-1);
    appendSummary([
      `### Jobs (${target})`,
      "",
      `${runs.length} run(s)${last?.busy ? ", stopped: another run holds the jobs lease" : last?.idle && runs.length === 1 ? ", nothing queued" : ""}.`,
      "",
      "| stage | done | left |",
      "|---|---|---|",
      `| ingest | ${sum((r) => r.ingest?.ingested)} stored, ${sum((r) => r.ingest?.rejected)} rejected, ${sum((r) => r.ingest?.duplicates)} duplicates | ${last?.ingest?.remaining ?? 0} |`,
      `| aggregation | ${sum((r) => r.aggregation?.aggregated)} folded, ${sum((r) => r.aggregation?.failed)} failed | ${last?.aggregation?.remaining ?? 0} (dirty maps ${last?.aggregation?.dirtyMaps ?? 0}) |`,
      `| estimator | ${sum((r) => r.estimator?.observations)} observations, ${sum((r) => r.estimator?.gridCalls)} grids, ${sum((r) => r.estimator?.summarized)} ships summarized | – |`,
      "",
      `D1 calls: ${sum((r) => r.d1Calls)}.`,
    ].join("\n"));
    break;
  }
  case "kcnav": {
    const deadline = Date.now() + Number(values.minutes ?? 25) * 60_000;
    const max = Number(values.max ?? Infinity);
    const list = (s?: string) => s?.split(",").map((x) => x.trim()).filter(Boolean);
    const filter = { only: list(values.only), skip: list(values.skip) };
    const { vars } = productionConfig();
    const env = { DB: db, KCNAV_BASE: vars.KCNAV_BASE!, KCNAV_MIN_INTERVAL_MS: vars.KCNAV_MIN_INTERVAL_MS! };
    const done: string[] = [];
    let stop = "time is up";
    for (;;) {
      const r = await tick(env, undefined, filter);
      console.log(stamp(), JSON.stringify(r));
      if (r.action === "requested") done.push(`- ${r.jobStatus} ${r.url} (${r.status}) ${r.summary}`);
      if (r.action === "idle" && r.waitMs === null) {
        stop = "queue empty";
        break;
      }
      if (done.length >= max) {
        stop = `${max} request(s) sent`;
        break;
      }
      const wait = (r.waitMs ?? 0) + 500;
      if (Date.now() + wait > deadline) break;
      await Bun.sleep(wait);
    }
    const kinds = filter.only ? ` (kinds ${filter.only.join(", ")})` : filter.skip ? ` (all kinds but ${filter.skip.join(", ")})` : "";
    appendSummary([`### KCNav queue${kinds} (${target})`, "", `${done.length} request(s); stopped: ${stop}.`, "", ...done].join("\n"));
    break;
  }
  case "enqueue": {
    const body = enqueueRequest.parse(JSON.parse(positionals[1] ?? "{}"));
    console.log(JSON.stringify(await enqueue({ DB: db } as Env, body), null, 2));
    break;
  }
  default:
    console.error("usage: bun scripts/run-jobs.ts run [--minutes 25] [--no-estimator] | kcnav [--minutes 25] [--only k,… | --skip k,…] [--max N] | enqueue '<json>'");
    process.exit(2);
}
