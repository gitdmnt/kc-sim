// seed/routing/*.json (hand-authored ROUTING_DSL documents) -> routing_maps + routing_rules.
// Each document is validated against the map's edges already in D1 (run ingest-map-graph first).
import { Glob } from "bun";
import { execStatements, query } from "./lib/d1";
import { lit, sourceRef, sourceUpsert, upsert } from "./lib/sql";
import { parseMapKey } from "../src/maps";
import { countRules, validateRoutingDoc } from "../src/routing/validate";

const DIR = new URL("../seed/routing/", import.meta.url).pathname;
const KEY = "seed-routing";

export async function ingestRouting(): Promise<void> {
  const files = [...new Glob("*.json").scanSync(DIR)].filter((f) => f !== "routing.schema.json").sort();
  const edges = await query<{ map_id: number; from_letter: string; to_letter: string }>(
    "SELECT map_id, from_letter, to_letter FROM edges",
  );
  const hasher = new Bun.CryptoHasher("sha256");
  const now = new Date().toISOString();
  const src = sourceRef(KEY);
  const statements: string[] = [];
  const failures: string[] = [];
  const summary: string[] = [];
  for (const file of files) {
    const text = await Bun.file(DIR + file).text();
    hasher.update(text);
    const json = JSON.parse(text);
    const map = parseMapKey(String(json.map));
    if (!map) {
      failures.push(`${file}: bad map key`);
      continue;
    }
    const mapEdges = edges.filter((e) => e.map_id === map.id).map((e) => ({ from: e.from_letter, to: e.to_letter }));
    if (mapEdges.length === 0) {
      failures.push(`${file}: no edges for map ${json.map} in D1 (run ingest-map-graph)`);
      continue;
    }
    const { doc, errors } = validateRoutingDoc(json, mapEdges);
    if (!doc || errors.length) {
      failures.push(`${file}:\n  ${errors.join("\n  ")}`);
      continue;
    }
    const counts = countRules(doc);
    statements.push(`DELETE FROM routing_rules WHERE map_id = ${map.id};`);
    statements.push(...upsert("routing_maps", [{
      map_id: map.id, layout: doc.layout ?? null, sources: doc.sources, defaults: doc.defaults ?? null, start: doc.start ?? null,
      rule_count: counts.total, uncertain_count: counts.uncertain, source_id: src, updated_at: now,
    }], ["map_id"]));
    statements.push(...upsert("routing_rules", Object.entries(doc.nodes).map(([letter, node], ord) => ({
      map_id: map.id, from_letter: letter, ord, node,
    })), ["map_id", "from_letter"]));
    summary.push(`${doc.map}: ${counts.total} rules (${counts.uncertain} uncertain)`);
  }
  if (failures.length) throw new Error(`routing seed validation failed:\n${failures.join("\n")}`);
  const revision = `sha256:${hasher.digest("hex")}`;
  const seeded = files.map((f) => lit(parseMapKey(f.replace(".json", ""))?.id ?? -1)).join(", ");
  const stale = `SELECT map_id FROM routing_maps WHERE source_id = ${src.sql} AND map_id NOT IN (${seeded})`;
  await execStatements("routing", [
    sourceUpsert({ key: KEY, name: "kc-sim hand-authored routing seeds", url: "server/seed/routing", licence: "project", revision }),
    `DELETE FROM routing_rules WHERE map_id IN (${stale});`,
    `DELETE FROM routing_maps WHERE map_id IN (${stale});`,
    ...statements,
  ]);
  console.log(`routing: ${files.length} maps\n  ${summary.join("\n  ")}`);
}

if (import.meta.main) await ingestRouting();
