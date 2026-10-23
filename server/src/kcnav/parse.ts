// Pure parsers for KCNav (tsunkit.net) responses. Shapes: docs/DATA_SOURCES.md §1.
import * as z from "zod";
import { nodeTypeFromEvent, normalizeLetter } from "../maps";

const opt = <T extends z.ZodType>(t: T) => t.nullish();
const kcnavShip = z.object({
  id: z.number(), lvl: opt(z.number()), hp: opt(z.number()), fp: opt(z.number()), torp: opt(z.number()),
  aa: opt(z.number()), armor: opt(z.number()), equips: opt(z.array(z.number())),
});
const enemyCompsResponse = z.object({
  result: z.object({
    entries: z.array(z.object({
      node: opt(z.string()), mainFleet: opt(z.array(kcnavShip)), escortFleet: opt(z.array(kcnavShip)),
      formation: opt(z.number()), count: opt(z.number()), airpower: opt(z.array(z.number())),
      lbasAirpower: opt(z.array(z.number())), difficulty: opt(z.number()), masterId: opt(z.number()),
    })),
  }),
});
const mapResponse = z.object({
  result: z.object({
    route: z.record(z.string(), z.tuple([z.string().nullable(), z.string(), z.number(), z.number()])),
    spots: opt(z.record(z.string(), z.tuple([z.number(), z.number()]).rest(z.unknown()))),
  }),
});

export interface ParsedCompShip { fleet: 0 | 1; position: number; shipId: number; level: number | null; hp: number | null; fp: number | null; tp: number | null; aa: number | null; ar: number | null; equips: number[] }
export interface ParsedComp { kcnavMasterId: number | null; formation: number | null; count: number; weight: number; airpower: number[] | null; lbasAirpower: number[] | null; ships: ParsedCompShip[] }
export interface ParsedCompSet { node: string; difficulty: number; totalCount: number; comps: ParsedComp[] }

const ships = (fleet: 0 | 1, list: z.infer<typeof kcnavShip>[] | null | undefined): ParsedCompShip[] =>
  (list ?? []).map((s, position) => ({
    // KCNav omits stat keys whose value is 0 (e.g. submarine fp/aa), so absent stats are 0.
    fleet, position, shipId: s.id, level: s.lvl ?? null, hp: s.hp ?? null, fp: s.fp ?? 0, tp: s.torp ?? 0,
    aa: s.aa ?? 0, ar: s.armor ?? 0, equips: s.equips ?? [],
  }));

/**
 * `/api/routing/maps/{m}/(nodes/{n}|edges/{e,…})/enemycomps` -> one set per (node, difficulty) with
 * weights = count / Σcount. `fallbackNode` / `fallbackDifficulty` apply when entries omit them.
 */
export function parseEnemyComps(json: unknown, fallbackNode: string | null, fallbackDifficulty: number): ParsedCompSet[] {
  const { entries } = enemyCompsResponse.parse(json).result;
  const groups = new Map<string, ParsedCompSet>();
  for (const e of entries) {
    const node = e.node ?? fallbackNode;
    if (!node) throw new Error("enemycomps entry without node");
    const difficulty = e.difficulty ?? fallbackDifficulty;
    const key = `${node}\u0000${difficulty}`;
    let set = groups.get(key);
    if (!set) {
      set = { node, difficulty, totalCount: 0, comps: [] };
      groups.set(key, set);
    }
    const count = e.count ?? 0;
    set.totalCount += count;
    set.comps.push({
      kcnavMasterId: e.masterId ?? null, formation: e.formation ?? null, count, weight: 0,
      airpower: e.airpower ?? null, lbasAirpower: e.lbasAirpower ?? null,
      ships: [...ships(0, e.mainFleet), ...ships(1, e.escortFleet)],
    });
  }
  for (const set of groups.values()) {
    for (const c of set.comps) c.weight = set.totalCount > 0 ? c.count / set.totalCount : 0;
  }
  return [...groups.values()];
}

export interface ParsedMapNode { letter: string; x: number | null; y: number | null; colorNo: number | null; eventId: number | null; nodeType: string | null; isBoss: boolean }
export interface ParsedMap { edges: { edgeId: number; from: string; to: string }[]; nodes: ParsedMapNode[] }

/**
 * `/api/routing/maps/{m}`: route {edgeId: [from, to, colorNo, eventId]} (last two inferred to be
 * api_color_no / api_event_id), spots {label: [x, y, …]}. Edge 0 ([null, start]) is dropped.
 */
export function parseMap(json: unknown): ParsedMap {
  const r = mapResponse.parse(json).result;
  const spots = r.spots ?? {};
  const multipleStarts = Object.keys(spots).filter((k) => /^\d+$/.test(k)).length > 1;
  const nodes = new Map<string, ParsedMapNode>();
  for (const [label, [x, y]] of Object.entries(spots)) {
    const letter = normalizeLetter(label, multipleStarts);
    nodes.set(letter, { letter, x, y, colorNo: null, eventId: null, nodeType: letter.startsWith("Start") ? "start" : null, isBoss: false });
  }
  const edges: ParsedMap["edges"] = [];
  for (const [id, [from, to, colorNo, eventId]] of Object.entries(r.route)) {
    const toLetter = normalizeLetter(to, multipleStarts);
    const n = nodes.get(toLetter) ?? { letter: toLetter, x: null, y: null, colorNo: null, eventId: null, nodeType: null, isBoss: false };
    if (!toLetter.startsWith("Start")) {
      n.colorNo = colorNo;
      n.eventId = eventId;
      n.nodeType = nodeTypeFromEvent(eventId);
      n.isBoss = eventId === 5;
    }
    nodes.set(toLetter, n);
    if (from !== null) edges.push({ edgeId: Number(id), from: normalizeLetter(from, multipleStarts), to: toLetter });
  }
  return { edges, nodes: [...nodes.values()] };
}

/** Node types for which enemy comps exist. */
export const COMBAT_NODE_TYPES = ["battle", "boss", "night_battle", "air_battle", "air_raid", "night_to_day"];

const nodeSummaryResponse = z.object({
  // KCNav omits zero values: `runs` is absent when no sortie passed the edge (seen with minSpeed=20).
  result: z.record(z.string().regex(/^\d+$/), z.object({ runs: z.number().int().nonnegative().optional() }).loose()),
});

/** `/api/routing/maps/{m}/nodesummary`: run count per edge id (edge 0 = sortie start). */
export function parseNodeSummary(json: unknown): { edgeId: number; runs: number }[] {
  return Object.entries(nodeSummaryResponse.parse(json).result)
    .map(([id, v]) => ({ edgeId: Number(id), runs: v.runs ?? 0 }))
    .sort((a, b) => a.edgeId - b.edgeId);
}
