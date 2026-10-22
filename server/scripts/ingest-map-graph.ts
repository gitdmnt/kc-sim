// KC3Kai edges.json + nodes.json (MIT) and kcwiki db/node_types-{57..62}.json -> maps (stubs), nodes, edges.
import { execStatements, query } from "./lib/d1";
import { fetchGithub } from "./lib/fetch";
import { lit, sourceRef, sourceUpsert, upsert } from "./lib/sql";
import { nodeTypeFromEvent, normalizeLetter, parseMapKey } from "../src/maps";

const KC3 = { owner: "KC3Kai", repo: "KC3Kai", ref: "develop" };
const KCWIKI = { owner: "kcwiki", repo: "kancolle-data", ref: "master" };
const EVENT_NODE_TYPE_FILES = [57, 58, 59, 60, 61, 62];

type Kc3Edges = Record<string, Record<string, [string, string]>>;
type Kc3Nodes = Record<string, { letters?: Record<string, [number, number]> }>;
type KcwikiNodeTypes = Record<string, Record<string, { color: number; id: number; kind: number; type: string }>>;

export interface GraphNode { letter: string; x: number | null; y: number | null; color_no: number | null; event_id: number | null; event_kind: number | null; node_type: string | null; is_boss: boolean }
export interface GraphMap { mapId: number; edges: { edge_id: number; from: string; to: string }[]; nodes: GraphNode[] }

/** Pure: builds per-map graphs from the three raw documents. */
export function buildGraphs(edges: Kc3Edges, coords: Kc3Nodes, types: KcwikiNodeTypes): GraphMap[] {
  const out: GraphMap[] = [];
  for (const [key, raw] of Object.entries(edges)) {
    const m = /^World (\d+-\d+)$/.exec(key);
    const parsed = m && parseMapKey(m[1]!);
    if (!parsed) continue;
    const labels = Object.values(raw).flat();
    const multipleStarts = labels.some((l) => /^Start ?\d+$/.test(l));
    const e = Object.entries(raw).map(([id, [a, b]]) => ({
      edge_id: Number(id), from: normalizeLetter(a, multipleStarts), to: normalizeLetter(b, multipleStarts),
    }));
    const letters = new Set(e.flatMap((x) => [x.from, x.to]));
    const xy = coords[key]?.letters ?? {};
    const t = types[String(parsed.id)] ?? {};
    const nodes = [...letters].map((letter): GraphNode => {
      const nt = t[letter];
      return {
        letter,
        x: xy[letter]?.[0] ?? null, y: xy[letter]?.[1] ?? null,
        color_no: nt?.color ?? null, event_id: nt?.id ?? null, event_kind: nt?.kind ?? null,
        node_type: letter.startsWith("Start") ? "start" : nt ? nodeTypeFromEvent(nt.id, nt.kind) : null,
        is_boss: nt?.type === "Boss",
      };
    });
    out.push({ mapId: parsed.id, edges: e, nodes });
  }
  return out;
}

export async function ingestMapGraph(): Promise<void> {
  const edgesF = await fetchGithub({ ...KC3, path: "src/data/edges.json" });
  const nodesF = await fetchGithub({ ...KC3, path: "src/data/nodes.json" });
  const typeDocs = await Promise.all(EVENT_NODE_TYPE_FILES.map((n) => fetchGithub({ ...KCWIKI, path: `db/node_types-${n}.json` })));
  const types: KcwikiNodeTypes = Object.assign({}, ...typeDocs.map((d) => JSON.parse(d.text)));
  const graphs = buildGraphs(JSON.parse(edgesF.text), JSON.parse(nodesF.text), types);
  const now = new Date().toISOString();
  const kc3 = sourceRef("kc3-edges");
  const kcwiki = sourceRef("kcwiki-node-types");

  const statements = [
    sourceUpsert({ key: "kc3-edges", name: "KC3Kai src/data/edges.json + nodes.json", url: edgesF.url, licence: "MIT", revision: `${edgesF.revision} ${nodesF.revision}` }),
    sourceUpsert({ key: "kcwiki-node-types", name: "kcwiki/kancolle-data db/node_types-{57..62}.json", url: typeDocs[0]!.url.replace("-57", "-*"), licence: "MIT (package.json)", revision: typeDocs.map((d) => d.revision.slice(0, 12)).join(" ") }),
    ...upsert("maps", graphs.map((g) => ({
      id: g.mapId, world: Math.floor(g.mapId / 10), no: g.mapId % 10, is_event: g.mapId >= 100, source_id: kc3, updated_at: now,
    })), ["id"], "ignore"),
  ];
  // Maps whose graph came from a KCNav map job (live game data) are authoritative; leave them alone.
  const kcnavMaps = new Set((await query<{ map_id: number }>(
    "SELECT DISTINCT map_id FROM edges WHERE source_id = (SELECT id FROM sources WHERE key = 'kcnav')",
  )).map((r) => r.map_id));
  for (const g of graphs.filter((x) => !kcnavMaps.has(x.mapId))) {
    statements.push(`DELETE FROM edges WHERE map_id = ${g.mapId};`);
    statements.push(...upsert("edges", g.edges.map((e) => ({
      map_id: g.mapId, edge_id: e.edge_id, from_letter: e.from, to_letter: e.to, source_id: kc3,
    })), ["map_id", "edge_id"]));
    // Keep values already set by other sources (KCNav map endpoint) when this source has none.
    for (const n of g.nodes) {
      const fromKcwiki = n.event_id !== null;
      statements.push(`INSERT INTO nodes (map_id, letter, x, y, color_no, event_id, event_kind, node_type, is_boss, source_id)
VALUES (${g.mapId}, ${lit(n.letter)}, ${lit(n.x)}, ${lit(n.y)}, ${lit(n.color_no)}, ${lit(n.event_id)}, ${lit(n.event_kind)}, ${lit(n.node_type)}, ${lit(n.is_boss)}, ${(fromKcwiki ? kcwiki : kc3).sql})
ON CONFLICT (map_id, letter) DO UPDATE SET x = COALESCE(excluded.x, nodes.x), y = COALESCE(excluded.y, nodes.y),
color_no = COALESCE(excluded.color_no, nodes.color_no), event_id = COALESCE(excluded.event_id, nodes.event_id),
event_kind = COALESCE(excluded.event_kind, nodes.event_kind), node_type = COALESCE(excluded.node_type, nodes.node_type),
is_boss = MAX(excluded.is_boss, nodes.is_boss);`);
    }
  }
  await execStatements("map-graph", statements);
  console.log(`map graph: ${graphs.length} maps (${kcnavMaps.size} kept from KCNav), ${graphs.reduce((s, g) => s + g.edges.length, 0)} edges, ${graphs.reduce((s, g) => s + g.nodes.length, 0)} nodes`);
}

if (import.meta.main) await ingestMapGraph();
