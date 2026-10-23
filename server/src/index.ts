// Worker entry: only handlers may be exported here (workerd rejects other named exports). Background jobs do not
// run in the worker: GitHub Actions runs them (scripts/run-jobs.ts, docs/DEPLOY.md §5).
import { createApp } from "./app";
import type { Env } from "./env";
import { simCoreGrid } from "./estimator/wasm";

const app = createApp({ gridFn: simCoreGrid, now: () => Date.now() });

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
