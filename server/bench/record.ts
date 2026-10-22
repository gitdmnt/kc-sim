// Recording D1 double over bun:sqlite (bench only): executes like test/d1-sqlite.ts and logs every call with the
// response the D1 service would send (bench/d1.ts wire format). `recording` is null while seeding.
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wireParams, type D1Entry, type WireResult } from "./d1";

type Param = string | number | bigint | boolean | null | Uint8Array;

export class RecordingD1 {
  recording: D1Entry[] | null = null;
  /** rows changed per table, and the same weighted by 1 + the table's index count (D1 bills index rows too) */
  readonly writes = new Map<string, { rows: number; billed: number }>();
  /** column lists of each table's indexes */
  private readonly indexes = new Map<string, string[][]>();
  constructor(readonly sqlite: Database) {}

  /** In-memory database with the migrations applied; `file` = a wrangler D1 SQLite file to start from (copied). */
  static open(file?: string): RecordingD1 {
    let db = new Database(":memory:");
    if (file) {
      // a temp copy: wrangler's files are in WAL mode, which an in-memory deserialized database cannot open
      const copy = join(mkdtempSync(join(tmpdir(), "kcsim-bench-db-")), "db.sqlite");
      copyFileSync(file, copy);
      db = new Database(copy);
    }
    const applied = file ? (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM d1_migrations").get()?.n ?? 0) : 0;
    const dir = new URL("../migrations/", import.meta.url).pathname;
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.slice(applied)) db.exec(readFileSync(dir + f, "utf8"));
    return new RecordingD1(db);
  }

  exec(sql: string, params: unknown[]): WireResult {
    const q = this.sqlite.query(sql);
    const args = wireParams(params).map((p) => (Array.isArray(p) ? Uint8Array.from(p as number[]) : p)) as Param[];
    if (q.columnNames.length) {
      const rows = q.values(...args) as unknown[][];
      const out = rows.map((r) => r.map((v) => (v instanceof Uint8Array ? Array.from(v) : v)));
      return { results: { columns: q.columnNames, rows: out }, success: true, meta: { changes: 0, last_row_id: 0, rows_read: out.length, rows_written: 0 } };
    }
    const r = q.run(...args);
    const m = /^\s*(INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/i.exec(sql);
    if (m && r.changes) {
      const table = m[2]!;
      if (!this.indexes.has(table)) {
        const names = this.sqlite.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?1").all(table);
        this.indexes.set(table, names.map((i) => this.sqlite.query<{ name: string }, []>(`PRAGMA index_info(${JSON.stringify(i.name)})`).all().map((c) => c.name)));
      }
      // an UPDATE rewrites the indexes of the columns it sets; INSERT (incl. upserts, an upper bound) and DELETE all of them
      const setClause = /^\s*UPDATE/i.test(sql) ? /\bSET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(sql)?.[1] ?? "" : null;
      const set = setClause === null ? null : new Set([...setClause.matchAll(/(\w+)\s*=/g)].map((x) => x[1]!));
      const touched = this.indexes.get(table)!.filter((cols) => !set || cols.some((c) => set.has(c))).length;
      const w = this.writes.get(table) ?? { rows: 0, billed: 0 };
      w.rows += r.changes;
      w.billed += r.changes * (1 + touched);
      this.writes.set(table, w);
    }
    return { results: { columns: [], rows: [] }, success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid), rows_read: 0, rows_written: r.changes } };
  }

  prepare(sql: string) {
    return new RecordingStatement(this, sql);
  }

  async batch(statements: RecordingStatement[]) {
    const out = this.sqlite.transaction(() => statements.map((s) => this.exec(s.sql, s.params)))();
    this.recording?.push({ kind: "batch", statements: statements.map((s) => ({ sql: s.sql, params: wireParams(s.params) })), response: JSON.stringify(out) });
    return out.map(objects);
  }
}

const objects = (w: WireResult) => ({
  results: w.results.rows.map((row) => Object.fromEntries(w.results.columns.map((c, i) => [c, row[i]]))),
  success: true,
  meta: w.meta,
});

class RecordingStatement {
  constructor(private readonly d: RecordingD1, readonly sql: string, readonly params: unknown[] = []) {}
  bind(...params: unknown[]) {
    return new RecordingStatement(this.d, this.sql, params);
  }
  private call(kind: "all" | "first" | "run") {
    const w = this.d.exec(this.sql, this.params);
    this.d.recording?.push({ kind, sql: this.sql, params: wireParams(this.params), response: JSON.stringify(w) });
    return objects(w);
  }
  async all() {
    return this.call("all");
  }
  async first() {
    return this.call("first").results[0] ?? null;
  }
  async run() {
    return this.call("run");
  }
}
