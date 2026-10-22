// Thin wrappers over `wrangler d1 execute kc-sim`. Local D1 by default; D1_REMOTE=1 targets the production
// database (`--remote --env production`, docs/DEPLOY.md).
import { mkdirSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url).pathname;
const DB = "kc-sim";
const TARGET = process.env.D1_REMOTE === "1" ? ["--remote", "--env", "production"] : ["--local"];

async function wrangler(args: string[]): Promise<string> {
  const proc = Bun.spawn(["bunx", "wrangler", "d1", "execute", DB, ...TARGET, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`wrangler d1 execute failed (${code}):\n${err}\n${out}`);
  return out;
}

/**
 * Writes statements to .tmp/<label>.sql and executes the file. The file ends by bumping
 * kv_state.data_version, so the worker's GET cache never serves data from before the ingest.
 */
export async function execStatements(label: string, statements: string[]): Promise<void> {
  mkdirSync(`${ROOT}.tmp`, { recursive: true });
  const file = `${ROOT}.tmp/${label}.sql`;
  const bump = "UPDATE kv_state SET value = CAST(value AS INTEGER) + 1 WHERE key = 'data_version';";
  await Bun.write(file, [...statements, bump].join("\n") + "\n");
  await wrangler(["--file", file, "--yes"]);
}

/**
 * Runs one read query and returns its rows. Retries twice: the local D1 is shared with a running
 * `wrangler dev` (and other engineers' processes), and wrangler occasionally fails with
 * "Failed to get session commit token" under concurrent access.
 */
export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = await wrangler(["--command", sql, "--json"]);
      return (JSON.parse(out) as { results: T[] }[]).flatMap((r) => r.results);
    } catch (e) {
      if (attempt >= 3) throw e;
      await Bun.sleep(1000 * attempt);
    }
  }
}
