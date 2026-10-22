import type { Env } from "../env";
import { mapName } from "../maps";
import { COMBAT_NODE_TYPES } from "./parse";

export type JobKind = "map" | "enemycomps" | "nodesummary";

export interface EnqueueRequest {
  maps: number[];
  kinds: JobKind[];
  /** enemycomps: one job per node (`/nodes/{n}/enemycomps`). */
  nodes?: string[];
  /** enemycomps: one batched job for exactly these edges (`/edges/{e,…}/enemycomps`). */
  edges?: number[];
  /** enemycomps: one batched job per map covering every edge into a combat (or untyped) node. */
  batch?: boolean;
  difficulty?: number;
  start?: string;
  end?: string;
  /** nodesummary: extra KCNav filters (e.g. {"minSpeed":"10"}); part of the dedupe key. */
  filters?: Record<string, string>;
  priority?: number;
  refresh?: boolean;
}

interface PathOptions { node?: string; edges?: number[]; difficulty?: number; start?: string; end?: string; filters?: Record<string, string> }

/** KCNav path (+ query) for a job; also the queue's dedupe key. */
export function jobPath(kind: JobKind, mapId: number, o: PathOptions = {}): string {
  const base = `/api/routing/maps/${mapName(mapId)}`;
  if (kind === "map") return base;
  if (!o.start) throw new Error(`${kind} job needs start`);
  const q = new URLSearchParams({ start: o.start });
  if (o.end) q.set("end", o.end);
  if (o.difficulty) q.set("difficulty", String(o.difficulty));
  if (kind === "nodesummary") {
    for (const k of Object.keys(o.filters ?? {}).sort()) q.set(k, o.filters![k]!);
    return `${base}/nodesummary?${q}`;
  }
  if (o.edges?.length) return `${base}/edges/${[...o.edges].sort((a, b) => a - b).join(",")}/enemycomps?${q}`;
  if (!o.node) throw new Error("enemycomps job needs node or edges");
  return `${base}/nodes/${encodeURIComponent(o.node)}/enemycomps?${q}`;
}

/** Default comp window: the 60 days before `now`. */
export function defaultStart(now: number): string {
  return new Date(now - 60 * 86_400_000).toISOString().slice(0, 10);
}

export interface EnqueueResult { enqueued: string[]; existing: string[]; notes: string[] }

const DEFAULT_PRIORITY: Record<JobKind, number> = { map: 10, enemycomps: 100, nodesummary: 200 };

/** Up to three D1 calls however many maps and jobs (Workers Free: 50 per invocation). */
export async function enqueue(env: Env, req: EnqueueRequest, now = Date.now()): Promise<EnqueueResult> {
  const db = env.DB;
  const result: EnqueueResult = { enqueued: [], existing: [], notes: [] };
  const jobs: { kind: JobKind; path: string; mapId: number; node: string | null; difficulty: number }[] = [];
  const start = req.start ?? defaultStart(now);
  const common = { difficulty: req.difficulty, start, end: req.end };
  const maps = JSON.stringify(req.maps);
  const combat = COMBAT_NODE_TYPES.map((_, i) => `?${i + 2}`).join(", ");
  const comps = req.kinds.includes("enemycomps");
  // edges into combat (or untyped) nodes for batched jobs; combat nodes for per-node jobs; all maps at once
  const [edgeRows, nodeRows] = await Promise.all([
    comps && req.batch && !req.edges?.length
      ? db.prepare(
        `SELECT e.map_id, e.edge_id FROM edges e LEFT JOIN nodes n ON n.map_id = e.map_id AND n.letter = e.to_letter
         WHERE e.map_id IN (SELECT value FROM json_each(?1)) AND e.to_letter NOT LIKE 'Start%' AND (n.node_type IS NULL OR n.node_type IN (${combat}))
         ORDER BY e.map_id, e.edge_id`,
      ).bind(maps, ...COMBAT_NODE_TYPES).all<{ map_id: number; edge_id: number }>().then((r) => r.results)
      : [],
    comps && !req.batch && !req.edges?.length && !req.nodes?.length
      ? db.prepare(
        `SELECT map_id, letter FROM nodes WHERE map_id IN (SELECT value FROM json_each(?1)) AND node_type IN (${combat}) ORDER BY map_id, letter`,
      ).bind(maps, ...COMBAT_NODE_TYPES).all<{ map_id: number; letter: string }>().then((r) => r.results)
      : [],
  ]);
  for (const mapId of req.maps) {
    for (const kind of req.kinds) {
      if (kind === "map") {
        jobs.push({ kind, path: jobPath(kind, mapId), mapId, node: null, difficulty: 0 });
      } else if (kind === "nodesummary") {
        jobs.push({ kind, path: jobPath(kind, mapId, { ...common, filters: req.filters }), mapId, node: null, difficulty: req.difficulty ?? 0 });
      } else if (req.edges?.length || req.batch) {
        const edges = req.edges?.length ? req.edges : edgeRows.filter((r) => r.map_id === mapId).map((r) => r.edge_id);
        if (!edges.length) {
          result.notes.push(`${mapName(mapId)}: no edges into combat nodes (run ingest:graph / the map job first)`);
          continue;
        }
        jobs.push({ kind, path: jobPath(kind, mapId, { ...common, edges }), mapId, node: null, difficulty: req.difficulty ?? 0 });
      } else {
        const nodes = req.nodes?.length ? req.nodes : nodeRows.filter((r) => r.map_id === mapId).map((r) => r.letter);
        if (!nodes.length) {
          result.notes.push(`${mapName(mapId)}: node types unknown; enqueue kind "map" first, pass nodes, or use batch`);
          continue;
        }
        for (const node of nodes) {
          jobs.push({ kind, path: jobPath(kind, mapId, { ...common, node }), mapId, node, difficulty: req.difficulty ?? 0 });
        }
      }
    }
  }
  if (!jobs.length) return result;
  const conflict = req.refresh
    ? "ON CONFLICT (path) DO UPDATE SET status = 'pending', attempts = 0, next_run_at = excluded.next_run_at, last_error = NULL, updated_at = excluded.updated_at WHERE kcnav_queue.status IN ('done', 'failed')"
    : "ON CONFLICT (path) DO NOTHING";
  const res = await db.batch(jobs.map((j) => db.prepare(
    `INSERT INTO kcnav_queue (kind, path, map_id, node_letter, difficulty, priority, status, attempts, next_run_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, ?7, ?7, ?7) ${conflict}`,
  ).bind(j.kind, j.path, j.mapId, j.node, j.difficulty, req.priority ?? DEFAULT_PRIORITY[j.kind], now)));
  jobs.forEach((j, i) => (res[i]?.meta.changes ? result.enqueued : result.existing).push(j.path));
  return result;
}
