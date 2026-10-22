// The Hono app, built from injectable dependencies (tests pass a test clock, grid function and JWKS fetch).
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { cacheGets } from "./cache";
import { read } from "./routes/read";
import { writeRoutes } from "./routes/write";
import { adminRoutes, type AdminDeps } from "./routes/admin";

/** wrangler.toml [triggers] crons: the jobs (src/jobs.ts) run on this schedule; any other cron runs one KCNav step. */
export const JOBS_CRON = "* * * * *";

/** `cache` replaces caches.default (tests). */
export function createApp(deps: AdminDeps & { cache?: Cache }) {
  const app = new Hono<{ Bindings: Env }>();
  // CORS is open: GETs are public, and writes are gated by bearer tokens, not by origin (docs/API.md).
  app.use("/api/*", cors({ origin: "*", exposeHeaders: ["Retry-After", "ETag", "X-Cache"], maxAge: 86400 }));
  app.use("/api/v1/*", cacheGets(deps.cache));
  app.route("/api/v1", read);
  app.route("/api/v1", writeRoutes(deps));
  app.route("/admin", adminRoutes(deps));
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal error", message: err.message }, 500);
  });
  return app;
}
