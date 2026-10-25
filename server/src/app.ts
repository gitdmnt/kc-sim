// The Hono app, built from injectable dependencies (tests pass a test clock, grid function and JWKS fetch).
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { cacheGets } from "./cache";
import { read } from "./routes/read";
import { views } from "./routes/views";
import { WRITE_ORIGINS, WRITE_PATHS, writeRoutes } from "./routes/write";
import { adminRoutes, type AdminDeps } from "./routes/admin";

/** `cache` replaces caches.default (tests). */
export function createApp(deps: AdminDeps & { cache?: Cache }) {
  const app = new Hono<{ Bindings: Env }>();
  // Reads: open CORS. Writes (POST /api/v1/clients, /observations): only the poi plugin's renderer origin (a file://
  // page: Origin "null", or "file://" in some Electron builds), POST only, a fixed header list, so a web page cannot
  // read a registration or preflight an upload. Server-side checks of Origin and User-Agent: routes/write.ts.
  const readCors = cors({
    origin: "*", exposeHeaders: ["Retry-After", "ETag", "X-Cache", "X-Routing-Provenance", "X-Routing-Generated-At", "X-Routing-Sortie-Count"], maxAge: 86400,
  });
  const writeCors = cors({
    origin: (o) => (WRITE_ORIGINS.includes(o) ? o : null), allowMethods: ["POST"], allowHeaders: ["Authorization", "Content-Type"],
    exposeHeaders: ["Retry-After"], maxAge: 86400,
  });
  app.use("/api/*", (c, next) => (WRITE_PATHS.includes(c.req.path) ? writeCors(c, next) : readCors(c, next)));
  app.use("/api/v1/*", cacheGets(deps.cache));
  app.route("/api/v1", read);
  app.route("/api/v1", views);
  app.route("/api/v1", writeRoutes(deps));
  app.route("/admin", adminRoutes(deps));
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal error", message: err.message }, 500);
  });
  return app;
}
