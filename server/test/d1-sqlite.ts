// Minimal D1Database test double over bun:sqlite with the real migrations applied.
// Covers what the worker uses: prepare().bind().first/all/run and batch() (atomic, like D1).
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";

type Param = string | number | null | boolean;

class Stmt {
  constructor(private readonly db: Database, readonly sql: string, private readonly params: Param[] = []) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params as Param[]);
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

export function createTestD1(): D1Database {
  const db = new Database(":memory:");
  const dir = new URL("../migrations/", import.meta.url).pathname;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(dir + f, "utf8"));
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) =>
      db.transaction(() => stmts.map((s) => (/^\s*SELECT/i.test(s.sql) ? { results: s.allSync(), success: true } : s.runSync())))(),
  };
  // Structural test double: only the members above are used by the code under test.
  return d1 as unknown as D1Database;
}
