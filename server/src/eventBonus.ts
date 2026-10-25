// Event bonus files (kancolle-replay js/data/bonus/{W-M}.json, MIT, and the manual server/data/event-bonuses.json)
// -> flat rows for GET /maps/{map}/bonuses (private notes API §2).
import * as z from "zod";

const nodeFilter = { nodes: z.array(z.string()).optional(), nodesExclude: z.array(z.string()).optional() };
const entry = z.record(z.string(), z.unknown());

/** One map's file. Bonus / debuff entries keep every source key. */
export const eventBonusDoc = z.object({
  world: z.number().int().positive(),
  mapnum: z.number().int().min(1).max(9),
  date: z.string().optional(),
  note: z.string().optional(),
  listBonus: z.array(z.object({ ...nodeFilter, bonuses: z.array(entry) })).optional(),
  listBonusLBAS: z.array(z.object({ ...nodeFilter, bonuses: z.array(entry) })).optional(),
  listDebuff: z.array(z.object({ ...nodeFilter, debuffs: z.array(entry) })).optional(),
}).loose();
export type EventBonusDoc = z.infer<typeof eventBonusDoc>;

/** One bonus or debuff with its node filter folded in; every source key is kept verbatim. */
export type FlatEntry = { nodes: string[] | null; nodesExclude: string[] | null } & Record<string, unknown>;

type Item = { nodes?: string[]; nodesExclude?: string[] };
const flat = <K extends string>(list: (Item & Record<K, Record<string, unknown>[]>)[] | undefined, key: K): FlatEntry[] =>
  (list ?? []).flatMap((item) => item[key].map((b) => ({ nodes: item.nodes ?? null, nodesExclude: item.nodesExclude ?? null, ...b })));

/** One map's flattened file (one `event_bonuses` row). */
export interface FlatEventBonus {
  mapId: number;
  date: string | null;
  note: string | null;
  bonuses: FlatEntry[];
  lbasBonuses: FlatEntry[];
  debuffs: FlatEntry[];
}

export function flattenEventBonus(doc: EventBonusDoc): FlatEventBonus {
  return {
    mapId: doc.world * 10 + doc.mapnum,
    date: doc.date ?? null,
    note: doc.note ?? null,
    bonuses: flat(doc.listBonus, "bonuses"),
    lbasBonuses: flat(doc.listBonusLBAS, "bonuses"),
    debuffs: flat(doc.listDebuff, "debuffs"),
  };
}

/** Replay files first, then the manual ones: a manual file replaces the replay file of the same map. */
export function mergeEventBonuses(replay: FlatEventBonus[], manual: FlatEventBonus[]): (FlatEventBonus & { manual: boolean })[] {
  const out = new Map<number, FlatEventBonus & { manual: boolean }>();
  for (const f of replay) out.set(f.mapId, { ...f, manual: false });
  for (const f of manual) out.set(f.mapId, { ...f, manual: true });
  return [...out.values()].sort((a, b) => a.mapId - b.mapId);
}
