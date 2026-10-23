// D1Database test double: an in-memory bun:sqlite database with the real migrations applied, through the same
// adapter the scripts use for the local D1 (scripts/lib/d1-database.ts).
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { sqliteD1 } from "../scripts/lib/d1-database";

export function createTestD1(): D1Database {
  const db = new Database(":memory:");
  const dir = new URL("../migrations/", import.meta.url).pathname;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(dir + f, "utf8"));
  return sqliteD1(db);
}
