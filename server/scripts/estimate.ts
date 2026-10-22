// Server estimator CLI (docs/ESTIMATOR.md "Server job"). Talks to the worker's admin API. Usage:
//   bun scripts/estimate.ts run [--budget-ms 5] [--all]   one budgeted run; --all repeats until nothing is left
//   bun scripts/estimate.ts rebuild [--ships 1501,1502]   forget grids (all or some ships), then refold
//   bun scripts/estimate.ts status
import { parseArgs } from "node:util";
import { call } from "./lib/admin";

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { "budget-ms": { type: "string" }, all: { type: "boolean" }, ships: { type: "string" } },
});

interface RunResult { busy: boolean; observations: number; gridCalls: number; summarized: number; remaining: { observations: number; signatures: number; dirtyShips: number } }

const run = async (body: Record<string, unknown>) => {
  for (;;) {
    const r = (await call("POST", "/admin/estimate/run", body)) as RunResult;
    console.log(JSON.stringify(r));
    const left = r.remaining;
    if (!values.all || r.busy || left.observations + left.signatures + left.dirtyShips === 0) return;
    body = { budgetMs: body.budgetMs };
  }
};

const budgetMs = values["budget-ms"] ? Number(values["budget-ms"]) : undefined;
switch (positionals[0]) {
  case "run":
    await run({ budgetMs });
    break;
  case "rebuild":
    values.all = true;
    await run({ rebuild: true, budgetMs, ...(values.ships ? { shipIds: values.ships.split(",").map(Number) } : {}) });
    break;
  case "status":
    console.log(JSON.stringify(await call("GET", "/admin/estimate/status"), null, 1));
    break;
  default:
    console.error("usage: bun scripts/estimate.ts run [--budget-ms 5] [--all] | rebuild [--ships 1501,…] | status");
    process.exit(1);
}
