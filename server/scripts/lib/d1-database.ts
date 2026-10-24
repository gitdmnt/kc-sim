// D1Database for scripts that run the server's background code outside the worker (GitHub Actions jobs,
// private deployment notes §5; routing inference): production D1 through the D1 HTTP API (D1_REMOTE=1), or the local
// wrangler D1 file through bun:sqlite. Covers what the server code uses: prepare().bind().first/all/run and batch().
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import * as z from "zod";
import wranglerToml from "../../wrangler.toml" with { type: "toml" };

type Param = string | number | null;

/** D1 binds numbers, strings and null; booleans become 1 / 0 as in D1. */
function param(v: unknown): Param {
  if (v === null || typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new Error(`unsupported D1 parameter: ${typeof v}`);
}

// ------------------------------------------------------------- bun:sqlite ----

class SqliteStmt {
  constructor(private readonly db: Database, readonly sql: string, private readonly params: Param[] = []) {}
  bind(...params: unknown[]) {
    return new SqliteStmt(this.db, this.sql, params.map(param));
  }
  allSync() {
    return this.db.query(this.sql).all(...this.params);
  }
  runSync() {
    const r = this.db.query(this.sql).run(...this.params);
    return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }
  async first<T>(): Promise<T | null> {
    return (this.db.query(this.sql).get(...this.params) as T | null) ?? null;
  }
  async all<T>() {
    return { results: this.allSync() as T[], success: true, meta: { changes: 0 } };
  }
  async run() {
    return this.runSync();
  }
}

/** D1Database over a bun:sqlite database; batch() runs in one transaction, like D1. */
export function sqliteD1(db: Database): D1Database {
  const d1 = {
    prepare: (sql: string) => new SqliteStmt(db, sql),
    batch: async (stmts: SqliteStmt[]) =>
      db.transaction(() => stmts.map((s) => (/^\s*SELECT/i.test(s.sql) ? { results: s.allSync(), success: true } : s.runSync())))(),
  };
  // Structural: only the members above are used by the server code.
  return d1 as unknown as D1Database;
}

/**
 * The local D1 of `wrangler dev` / `wrangler d1 execute --local` (one sqlite file per database), or the sqlite
 * file `D1_LOCAL_FILE` names (e.g. a copy to experiment on).
 */
export function openLocalD1(): D1Database {
  let file = process.env.D1_LOCAL_FILE;
  if (!file) {
    const dir = new URL("../../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url).pathname;
    const files = readdirSync(dir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
    if (files.length !== 1) throw new Error(`expected one local D1 sqlite file in ${dir}, found ${files.length} (run \`bun run migrate\` first)`);
    file = dir + files[0];
  }
  const db = new Database(file);
  db.exec("PRAGMA busy_timeout = 5000");
  return sqliteD1(db);
}

// ------------------------------------------------------------- HTTP API ----

const apiResult = z.object({
  results: z.array(z.record(z.string(), z.unknown())).default([]),
  success: z.boolean(),
  meta: z.object({ changes: z.number().default(0), last_row_id: z.number().default(0) }).loose().default({ changes: 0, last_row_id: 0 }),
});
const apiResponse = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ code: z.number().optional(), message: z.string() }).loose()).default([]),
  result: z.array(apiResult).nullish(),
});

export interface HttpD1Options {
  accountId: string;
  databaseId: string;
  token: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Minimum time between two requests; the Cloudflare API allows 1200 requests per 5 min per user. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Statuses retried (with 2^n s backoff, 4 attempts): rate limit and gateway errors. */
const RETRY = new Set([429, 502, 503, 504]);

/**
 * D1Database over the D1 HTTP API (`POST …/d1/database/{id}/query`, `{sql, params}` or `{batch: […]}`).
 * A batch is one request. Requests go out one at a time, `minIntervalMs` apart, even when the caller runs
 * queries concurrently. Every multi-statement write of the server code is guarded so that re-running it is a
 * no-op (e.g. `aggregated_at IS NULL`), which covers retries whose first attempt did execute.
 */
export function httpD1(o: HttpD1Options): D1Database {
  const url = `https://api.cloudflare.com/client/v4/accounts/${o.accountId}/d1/database/${o.databaseId}/query`;
  const doFetch = o.fetch ?? ((u: string, init: RequestInit) => fetch(u, init));
  const sleep = o.sleep ?? Bun.sleep;
  const minInterval = o.minIntervalMs ?? 250;
  let last = 0;
  const request = async (body: unknown) => {
    for (let attempt = 1; ; attempt++) {
      const wait = last + minInterval - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      let res: Response | null = null;
      try {
        res = await doFetch(url, { method: "POST", headers: { Authorization: `Bearer ${o.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } catch (e) {
        if (attempt >= 4) throw e;
      }
      if (res && !RETRY.has(res.status)) {
        const parsed = apiResponse.safeParse(await res.json().catch(() => null));
        if (!res.ok || !parsed.success || !parsed.data.success || !parsed.data.result) {
          const why = parsed.success ? parsed.data.errors.map((e) => e.message).join("; ") : "unexpected response";
          throw new Error(`D1 HTTP API ${res.status}: ${why}`);
        }
        return parsed.data.result;
      }
      if (attempt >= 4) throw new Error(`D1 HTTP API ${res?.status}: giving up after ${attempt} attempts`);
      await sleep(1000 * 2 ** attempt);
    }
  };
  let queue: Promise<unknown> = Promise.resolve();
  const send = (body: unknown) => {
    const next = queue.then(() => request(body));
    queue = next.catch(() => undefined);
    return next;
  };
  class HttpStmt {
    constructor(readonly sql: string, readonly params: Param[] = []) {}
    bind(...params: unknown[]) {
      return new HttpStmt(this.sql, params.map(param));
    }
    async all<T>() {
      const [r] = await send({ sql: this.sql, params: this.params });
      return { ...r!, results: r!.results as T[] };
    }
    async first<T>(): Promise<T | null> {
      return ((await this.all<T>()).results[0] as T | undefined) ?? null;
    }
    async run() {
      return this.all();
    }
  }
  const d1 = {
    prepare: (sql: string) => new HttpStmt(sql),
    batch: async (stmts: HttpStmt[]) => (stmts.length ? send({ batch: stmts.map((s) => ({ sql: s.sql, params: s.params })) }) : []),
  };
  return d1 as unknown as D1Database;
}

// ------------------------------------------------------------- selection ----

const wranglerConfig = z.object({
  env: z.object({
    production: z.object({
      d1_databases: z.array(z.object({ binding: z.string(), database_id: z.string() }).loose()),
      vars: z.record(z.string(), z.string()),
    }).loose(),
  }).loose(),
}).loose();

/** `[env.production]` of wrangler.toml: the production D1 id and vars (KCNav base URL and interval). */
export function productionConfig(): { databaseId: string; vars: Record<string, string> } {
  const p = wranglerConfig.parse(wranglerToml).env.production;
  const db = p.d1_databases.find((d) => d.binding === "DB");
  if (!db) throw new Error("wrangler.toml: no [[env.production.d1_databases]] with binding DB");
  return { databaseId: db.database_id, vars: p.vars };
}

/**
 * Production D1 over HTTP when D1_REMOTE=1 (CLOUDFLARE_API_TOKEN with D1 edit, CLOUDFLARE_ACCOUNT_ID; the
 * database id from wrangler.toml), else the local wrangler D1 file.
 */
export function openD1(): D1Database {
  if (process.env.D1_REMOTE !== "1") return openLocalD1();
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) throw new Error("D1_REMOTE=1 needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
  return httpD1({ accountId, databaseId: productionConfig().databaseId, token });
}
