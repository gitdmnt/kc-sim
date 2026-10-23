// D1 replay for CPU benchmarks (bench/run.ts). A recording holds every D1 call of one handler invocation with
// the response the D1 service sent. Replaying it does in the worker what the workerd D1 binding does there:
// serialize the request (JSON, BLOB parameters as number arrays), parse the response (JSON rows + columns, BLOBs
// as number arrays) and build the row objects. SQL runs elsewhere and is not worker CPU, so it is not replayed.
// Runs in bun and in workerd (no Node or bun APIs).

export interface WireStatement { sql: string; params: unknown[] }
/** One D1 call: a single statement (`all` / `first` / `run`) or a batch; `response` is the service's JSON text. */
export type D1Entry =
  | { kind: "all" | "first" | "run"; sql: string; params: unknown[]; response: string }
  | { kind: "batch"; statements: WireStatement[]; response: string };

/** What the D1 service returns per statement (resultsFormat ROWS_AND_COLUMNS). */
export interface WireResult { results: { columns: string[]; rows: unknown[][] }; success: true; meta: { changes: number; last_row_id: number; rows_read: number; rows_written: number } }

/** Parameters as the binding sends them: ArrayBuffer views become number arrays. */
export const wireParams = (params: unknown[]): unknown[] =>
  params.map((p) => (ArrayBuffer.isView(p) ? Array.from(new Uint8Array(p.buffer, p.byteOffset, p.byteLength))
    : p instanceof ArrayBuffer ? Array.from(new Uint8Array(p)) : p));

/** Rows + columns → the row objects the binding returns. */
const toD1Result = (w: WireResult) => ({
  results: w.results.rows.map((row) => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < w.results.columns.length; i++) o[w.results.columns[i]!] = row[i];
    return o;
  }),
  success: true,
  meta: w.meta,
});

class ReplayStatement {
  constructor(private readonly r: ReplayD1, readonly sql: string, readonly params: unknown[] = []) {}
  bind(...params: unknown[]) {
    return new ReplayStatement(this.r, this.sql, params);
  }
  async all() {
    return toD1Result(this.r.next("all", this) as WireResult);
  }
  async first() {
    return toD1Result(this.r.next("first", this) as WireResult).results[0] ?? null;
  }
  async run() {
    return toD1Result(this.r.next("run", this) as WireResult);
  }
}

/** Plays `log` back in order; throws when the handler issues a different statement than recorded. */
export class ReplayD1 {
  private i = 0;
  /** Serialized request bytes, for reporting. */
  requestBytes = 0;
  constructor(private readonly log: D1Entry[]) {}

  prepare(sql: string) {
    return new ReplayStatement(this, sql);
  }

  async batch(statements: ReplayStatement[]) {
    const out = this.next("batch", statements) as WireResult[];
    return out.map(toD1Result);
  }

  /** @internal */
  next(kind: D1Entry["kind"], s: ReplayStatement | ReplayStatement[]): WireResult | WireResult[] {
    const e = this.log[this.i++];
    const sqls = Array.isArray(s) ? s.map((x) => x.sql) : [s.sql];
    const recorded = !e ? [] : e.kind === "batch" ? e.statements.map((x) => x.sql) : [e.sql];
    if (!e || (e.kind === "batch") !== (kind === "batch") || sqls.join("\n;") !== recorded.join("\n;")) {
      throw new Error(`D1 replay out of sync at call ${this.i}: got ${kind} ${sqls[0]?.slice(0, 80)}, recorded ${e?.kind} ${recorded[0]?.slice(0, 80)}`);
    }
    const body = Array.isArray(s)
      ? JSON.stringify(s.map((x) => ({ sql: x.sql, params: wireParams(x.params) })))
      : JSON.stringify({ sql: s.sql, params: wireParams(s.params) });
    this.requestBytes += body.length;
    return JSON.parse(e.response) as WireResult | WireResult[];
  }

  get done() {
    return this.i === this.log.length;
  }
}

/** A recorded handler invocation: how to call it and the D1 traffic it caused. */
export interface Recording {
  name: string;
  /** "http": app.request(path); "scheduled": one jobs run (src/jobs.ts runJobs) */
  kind: "http" | "scheduled";
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  /** recorded `fetch` responses (KCNav), in call order */
  fetches?: { url: string; status: number; body: string }[];
  clock: number;
  log: D1Entry[];
  /** what the recorded run reported (status + a short summary), for the table */
  note: string;
}
