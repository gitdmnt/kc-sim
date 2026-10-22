// Worker entry: only handlers may be exported here (workerd rejects other named exports).
import { createApp, JOBS_CRON } from "./app";
import type { Env } from "./env";
import { simCoreGrid } from "./estimator/wasm";
import { runScheduled } from "./jobs";
import { tick } from "./kcnav/tick";

const deps = { gridFn: simCoreGrid, now: () => Date.now() };
const app = createApp(deps);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const result = event.cron === JOBS_CRON ? await runScheduled(env, deps) : await tick(env);
    console.log(JSON.stringify({ cron: event.cron, result }));
  },
} satisfies ExportedHandler<Env>;
