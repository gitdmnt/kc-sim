// Write API (private notes API §3): client registration and observation uploads. Every write passes the per-IP
// limit; uploads need a client bearer token, are admitted at most once per 60 s per client and are only staged
// here (the jobs run validates and stores them: src/jobs.ts, scripts/run-jobs.ts).
import { Hono } from "hono";
import type { Env } from "../env";
import { claimPostSlot, issueClient, limitWritesPerIp, requestIpHash, requireClient, type ClientVars } from "../auth/clients";
import { checkQuota, MAX_BODY_BYTES, MAX_OBSERVATIONS_PER_REQUEST, stageUpload } from "../ingest/upload";

/** Env flags are strings; "1" and "true" turn them on. */
export const flagOn = (v: string | undefined) => v === "1" || v === "true";

export interface WriteDeps { now: () => number }

/** The request body as text, or null once it exceeds `max` bytes (the rest is not read). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("Content-Length") ?? 0) > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export function writeRoutes(deps: WriteDeps) {
  const write = new Hono<{ Bindings: Env; Variables: ClientVars }>();
  write.use("*", async (c, next) => {
    if (!flagOn(c.env.WRITES_DISABLED)) return next();
    c.header("Retry-After", "3600");
    return c.json({ error: "writes are disabled for maintenance", retryAfter: 3600 }, 503);
  });
  write.use("*", limitWritesPerIp);

  write.post("/clients", async (c) => {
    const ipHash = await requestIpHash(c.env, c.req.header("CF-Connecting-IP"));
    if (!ipHash) return c.json({ error: "server misconfigured: IP_HASH_SALT is not set" }, 500);
    const r = await issueClient(c.env.DB, ipHash, deps.now());
    if (!r.ok) {
      c.header("Retry-After", String(r.retryAfter));
      return c.json({ error: "too many clients registered from this address", retryAfter: r.retryAfter }, 429);
    }
    return c.json({ clientId: r.clientId, token: r.token }, 201);
  });

  write.post("/observations", requireClient, async (c) => {
    const now = deps.now();
    const clientId = c.var.clientId;
    const wait = await claimPostSlot(c.env.DB, clientId, now);
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "one upload per 60 s per client", retryAfter: wait }, 429);
    }
    const quota = await checkQuota(c.env.DB, clientId, now);
    if (!quota.ok) {
      c.header("Retry-After", String(quota.retryAfter));
      return c.json({ error: quota.error, retryAfter: quota.retryAfter }, quota.status);
    }
    const text = await readCapped(c.req.raw, MAX_BODY_BYTES);
    if (text === null) return c.json({ error: "body too large", maxBytes: MAX_BODY_BYTES }, 413);
    const r = await stageUpload(c.env.DB, clientId, text, now);
    if (!r.ok) {
      if (r.error === "not_json") return c.json({ error: "body is not JSON" }, 400);
      const message = `expected an array of 1–${MAX_OBSERVATIONS_PER_REQUEST} observations, got ${r.observations ?? "none"}`;
      return c.json({ error: "validation failed", issues: [{ path: "observations", message }] }, 400);
    }
    // Validation, storage and aggregation run in the jobs (src/jobs.ts); rejections land in observation_rejections.
    // The request does not ingest itself: uploads mostly land on fresh isolates, where the first ingest also pays
    // V8's compilation of the whole validation path (cold uploads measured 30 ms with it, 9 ms without, private deployment notes
    // §10), while a jobs run pays it once for every upload it ingests.
    return c.json({ queued: r.queued, duplicates: r.duplicates, pending: r.pending }, 202);
  });

  return write;
}
