// GET /api/v1/* response cache (docs/API.md "Conventions"). Every write that changes API output bumps
// kv_state.data_version; the version is part of the cache key, so an entry written before a bump is never
// served after it. Clients get Cache-Control max-age=300 and ETag "dv<version>" (304 on If-None-Match): a
// 200 body is determined by (URL, version), so no body hash is needed.
import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";

export const CLIENT_CACHE_CONTROL = "public, max-age=300";
/** How long the edge keeps a versioned entry; versioning, not expiry, keeps it fresh. */
const EDGE_TTL_S = 24 * 60 * 60;
/**
 * The jobs run (src/jobs.ts) publishes derived data (re-materialised comp sets, estimator summaries; each bumps data_version) once
 * its queues are caught up, or after this long under a steady stream of uploads. Every bump makes the next GET
 * of each URL a cache miss that re-reads its rows (D1 Free: 5 M rows read a day).
 */
export const PUBLISH_EVERY_MS = 30 * 60_000;

export const bumpDataVersion = (db: D1Database): D1PreparedStatement =>
  db.prepare("UPDATE kv_state SET value = CAST(value AS INTEGER) + 1 WHERE key = 'data_version'");

export async function dataVersion(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM kv_state WHERE key = 'data_version'").first<{ value: string }>();
  return Number(row?.value ?? 0);
}

/** Cache key: the request URL plus the data version (a fresh URL, never fetched upstream). */
export const cacheKey = (url: string, version: number): Request => {
  const u = new URL(url);
  u.searchParams.set("__dv", String(version));
  return new Request(u.toString(), { method: "GET" });
};

const notModified = (etag: string | null, ifNoneMatch: string | undefined) =>
  !!etag && !!ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim() === etag || t.trim() === "*");

/** `cache` defaults to `caches.default` (absent outside workerd, e.g. in bun tests: caching is then skipped). */
export const cacheGets = (cache?: Cache): MiddlewareHandler<{ Bindings: Env }> => async (c, next) => {
  if (c.req.method !== "GET") return next();
  const store = cache ?? (typeof caches === "undefined" ? undefined : caches.default);
  const version = await dataVersion(c.env.DB);
  const key = cacheKey(c.req.url, version);
  const hit = store ? await store.match(key) : undefined;
  let res: Response;
  if (hit) {
    res = new Response(hit.body, hit);
    res.headers.set("X-Cache", "HIT");
  } else {
    await next();
    if (c.res.status !== 200) return;
    res = new Response(c.res.body, c.res);
    res.headers.set("ETag", `"dv${version}"`);
    if (store) {
      const stored = res.clone(); // tee: the body is streamed to both, not copied into JS
      stored.headers.set("Cache-Control", `public, max-age=${EDGE_TTL_S}`);
      const put = store.put(key, stored);
      try {
        c.executionCtx.waitUntil(put);
      } catch {
        await put; // no execution context (tests)
      }
    }
    res.headers.set("X-Cache", "MISS");
  }
  res.headers.set("Cache-Control", CLIENT_CACHE_CONTROL);
  if (notModified(res.headers.get("ETag"), c.req.header("If-None-Match"))) {
    c.res = new Response(null, { status: 304, headers: res.headers });
    return;
  }
  c.res = res;
};
