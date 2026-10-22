// SQL text builders for ingest jobs (executed with `wrangler d1 execute --local --file`).

export type SqlValue = string | number | boolean | null | undefined | object;

/** SQL literal. Objects/arrays become JSON text. */
export function lit(v: SqlValue): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`non-finite number in SQL: ${v}`);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "1" : "0";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return `'${s.replaceAll("'", "''")}'`;
}

/** Raw SQL fragment (e.g. a sub-select) inserted verbatim instead of as a literal. */
export class Raw {
  constructor(readonly sql: string) {}
}

/** `(SELECT id FROM sources WHERE key = …)` */
export const sourceRef = (key: string) => new Raw(`(SELECT id FROM sources WHERE key = ${lit(key)})`);

// D1 rejects statements over 100 KB; stay well below.
const MAX_STATEMENT_BYTES = 90_000;

/**
 * Multi-row INSERT … ON CONFLICT(conflict) statements. `update` overwrites every non-key column,
 * `ignore` keeps existing rows. Rows must share the same keys (taken from the first row).
 */
export function upsert(
  table: string,
  rows: Record<string, SqlValue | Raw>[],
  conflict: string[],
  onConflict: "update" | "ignore" = "update",
): string[] {
  if (rows.length === 0) return [];
  const cols = Object.keys(rows[0]!);
  const updates = cols.filter((c) => !conflict.includes(c)).map((c) => `${c} = excluded.${c}`);
  const head = `INSERT INTO ${table} (${cols.join(", ")}) VALUES\n`;
  const tail = onConflict === "update" && updates.length
    ? `\nON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ${updates.join(", ")};`
    : `\nON CONFLICT (${conflict.join(", ")}) DO NOTHING;`;
  const out: string[] = [];
  let tuples: string[] = [];
  let size = head.length + tail.length;
  for (const row of rows) {
    const t = `(${cols.map((c) => { const v = row[c]; return v instanceof Raw ? v.sql : lit(v); }).join(", ")})`;
    if (tuples.length > 0 && size + t.length + 2 > MAX_STATEMENT_BYTES) {
      out.push(head + tuples.join(",\n") + tail);
      tuples = [];
      size = head.length + tail.length;
    }
    tuples.push(t);
    size += t.length + 2;
  }
  out.push(head + tuples.join(",\n") + tail);
  return out;
}

export function sourceUpsert(s: { key: string; name: string; url: string; licence: string; revision: string }): string {
  return upsert("sources", [{ ...s, fetched_at: new Date().toISOString() }], ["key"])[0]!;
}
