// D1 rows written per uploaded battle, end to end (stage, ingest, aggregation, estimator count / fold / summary),
// for the capacity estimate (docs/DEPLOY.md "Capacity"). Counts the rows each statement
// changed per table, and the same weighted by 1 + the table's index count (D1 also bills index rows; an upper
// bound, since an UPDATE only rewrites the indexes of the columns it changes).
//
//   bun bench/quota.ts [battles=120] [mixed|farm]
import { bunGrid } from "../scripts/lib/sim-core";
import { createApp } from "../src/app";
import { seedEdges15, seedMaster, seedSynthetic, T0 } from "../test/helpers";
import { ENEMIES, FRIEND, simulate, uploadItem } from "./fixtures";
import { RecordingD1 } from "./record";
import { benchEnv } from "./replay";

const battles = Number(process.argv[2] ?? 120);
const mode = process.argv[3] === "farm" ? "farm" : "mixed";
bunGrid(); // sim-core for the synthetic battles
const d1 = RecordingD1.open();
const db = d1 as unknown as D1Database;
await seedSynthetic(db, FRIEND, ENEMIES);
await seedMaster(db, { maps: [{ id: 15 }] });
await seedEdges15(db);
let clock = T0;
const app = createApp({ gridFn: bunGrid, now: () => clock });
const call = async (method: string, path: string, body?: string, headers: Record<string, string> = {}) => {
  const res = await app.request(`http://localhost${path}`, { method, body, headers: { "CF-Connecting-IP": "203.0.113.7", ...headers } }, benchEnv(db));
  return JSON.parse(await res.text()) as Record<string, unknown>;
};
const { token } = (await call("POST", "/api/v1/clients")) as { token: string };
d1.writes.clear();
const usedBytes = () => {
  const q = (p: string) => d1.sqlite.query<Record<string, number>, []>(`PRAGMA ${p}`).get()![p]!;
  return (q("page_count") - q("freelist_count")) * q("page_size");
};
const bytes0 = usedBytes();

const records = simulate(battles, 3, T0 - 48 * 3_600_000, mode);
const requests = { uploads: 0, jobs: 0 };
for (let i = 0; i < records.length; i += 60) {
  clock += 61_000;
  requests.uploads++;
  await call("POST", "/api/v1/observations", JSON.stringify({ observations: records.slice(i, i + 60).map(uploadItem) }), { Authorization: `Bearer ${token}` });
}
// hourly jobs runs until every queue is empty (production budget per run; the last one finds nothing to do)
for (let i = 0; i < 20_000; i++) {
  clock += 3_600_000;
  requests.jobs++;
  if ((await call("POST", "/admin/jobs/run")).idle) break;
}
const stored = d1.sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM observations").get()!.n;
let rows = 0;
let billed = 0;
console.log("| table | rows written | billed (with index rows) | per observation |\n|---|---:|---:|---:|");
for (const [t, w] of [...d1.writes].sort((a, b) => b[1].billed - a[1].billed)) {
  rows += w.rows;
  billed += w.billed;
  console.log(`| ${t} | ${w.rows} | ${w.billed} | ${(w.billed / stored).toFixed(1)} |`);
}
console.log(`| total (${stored} observations, ${requests.uploads} uploads, ${requests.jobs} jobs runs) | ${rows} | ${billed} | ${(billed / stored).toFixed(1)} |`);
console.log(`\nstorage: ${((usedBytes() - bytes0) / stored / 1024).toFixed(1)} KiB per observation (tables + indexes, SQLite pages in use)`);
