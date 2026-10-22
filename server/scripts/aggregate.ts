// poi-observed aggregation CLI. Talks to the running worker's admin API (docs/API.md §4). Usage:
//   bun scripts/aggregate.ts rebuild [--maps 1-5,7-4]   clear the aggregates and mark every stored observation pending
//   bun scripts/aggregate.ts run [--budget-ms 5] [--all] fold pending observations (one budgeted step, or until none left)
//   bun scripts/aggregate.ts status                     observation counts, layouts, mismatch counts
//   bun scripts/aggregate.ts delete --client <clientId> delete a client's observations and reset their maps
// Rebuilds and deletions only reset; the cron (or `run --all`) refolds in budgeted steps.
import { parseArgs } from "node:util";
import { call } from "./lib/admin";

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { maps: { type: "string" }, client: { type: "string" }, "budget-ms": { type: "string" }, all: { type: "boolean" } },
});

const budget = values["budget-ms"] ? `?budgetMs=${Number(values["budget-ms"])}` : "";
switch (positionals[0]) {
  case "rebuild": {
    const maps = values.maps?.split(",").map((m) => m.trim()).filter(Boolean);
    console.log(JSON.stringify(await call("POST", "/admin/aggregate/rebuild", maps ? { maps } : {}), null, 1));
    break;
  }
  case "run":
    for (;;) {
      const r = (await call("POST", `/admin/aggregate/run${budget}`)) as { aggregated: number; failed: number; maps: number[]; remaining: number; dirtyMaps: number };
      console.log(JSON.stringify(r));
      if (!values.all || (r.remaining === 0 && r.dirtyMaps === 0) || r.aggregated + r.failed + r.maps.length === 0) break;
    }
    break;
  case "status":
    console.log(JSON.stringify(await call("GET", "/admin/aggregate/status"), null, 1));
    break;
  case "delete": {
    if (!values.client) throw new Error("--client <clientId> is required");
    console.log(JSON.stringify(await call("DELETE", `/admin/observations?clientId=${encodeURIComponent(values.client)}`), null, 1));
    break;
  }
  default:
    console.error("usage: bun scripts/aggregate.ts rebuild [--maps 1-5] | run [--budget-ms 5] [--all] | status | delete --client <clientId>");
    process.exit(1);
}
