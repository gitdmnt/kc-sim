// Hand-authored quest overrides (shared/quest/overrides.json, private notes QUEST_OVERRIDES): our own structured clear
// conditions, prerequisites and rewards for quests whose upstream data is missing or stale, authored with
// zekamashi.net (ぜかましねっと艦これ) as the reference (private notes DATA_SOURCES §14). Validated strictly so typos fail the
// ingest and the tests instead of silently not counting. The requirement shape is the kcwiki-quest-data vocabulary
// plus the override-only fields of shared/quest/types.ts.
import { join } from "node:path";
import * as z from "zod";

export const QUEST_OVERRIDES_PATH = join(import.meta.dir, "..", "..", "shared", "quest", "overrides.json");

const id = z.number().int().positive();
const ids = z.array(id).min(1);
const count = z.number().int().min(1);
const RANK = z.enum(["S", "A", "B", "C"]);
const MAP = z.string().regex(/^\d+-\d+$/, "map is W-M, e.g. 2-5");
const note = z.string().min(1).max(200).optional();
/** fuel, ammo, steel, bauxite */
const resources = z.array(z.number().int().min(0)).length(4).optional();

const group = z.strictObject({
  ship: z.union([z.string(), z.array(z.string())]).optional(),
  shipclass: z.union([z.string(), z.array(z.string())]).optional(),
  /** at least n, or [min, max]; [0, 0] = none of these may be in the fleet */
  amount: z.union([count, z.tuple([z.number().int().min(0), z.number().int().min(0)])]).optional(),
  flagship: z.literal(true).optional(),
  lv: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
  select: count.optional(),
  place: z.number().int().min(1).max(7).optional(),
  note,
  shipIds: ids.optional(),
  stypes: ids.optional(),
  ctypes: ids.optional(),
  escort: z.literal(true).optional(),
}).refine((g) => g.shipIds || g.stypes || g.ctypes, "a group needs shipIds, stypes or ctypes (names are display only)");

const item = z.strictObject({
  name: z.string().min(1),
  amount: count.optional(),
  category: z.enum(["装備", "艦娘", "家具", "アイテム"]).optional(),
  equipIds: ids.optional(),
  equipTypes: ids.optional(),
});

/** Constraints on the fleet a sortie / exercise / expedition is counted with. */
const fleet = {
  groups: z.array(group).optional(),
  fleetid: z.number().int().min(1).max(4).optional(),
  maxShips: z.number().int().min(1).max(7).optional(),
  minShips: z.number().int().min(1).max(7).optional(),
  onlyGroups: z.literal(true).optional(),
};

const sortie = z.strictObject({
  category: z.literal("sortie"),
  map: z.union([MAP, z.array(MAP).min(1)]),
  times: count,
  total: z.literal(true).optional(),
  boss: z.literal(true).optional(),
  cells: ids.optional(),
  node: z.string().optional(),
  gauge: count.optional(),
  result: RANK.optional(),
  ...fleet,
  note,
}).refine((r) => r.boss || r.cells, "a sortie goal needs boss: true or cells");

const exercise = z.strictObject({
  category: z.literal("excercise"),
  times: count,
  victory: z.literal(true).optional(),
  result: RANK.optional(),
  daily: z.literal(true).optional(),
  ...fleet,
  note,
});

const expedition = z.strictObject({
  category: z.literal("expedition"),
  objects: z.array(z.strictObject({ id: z.union([id, ids]).optional(), name: z.string().optional(), times: count })).min(1),
  resources,
  ...fleet,
  note,
});

const simple = z.strictObject({
  category: z.literal("simple"),
  subcategory: z.enum(["equipment", "ship", "scrapequipment", "scrapship", "modernization", "improvement", "resupply", "repair", "battle", "remodel"]),
  times: count,
  batch: z.boolean().optional(),
  note,
});

const remodel = z.strictObject({ category: z.literal("remodel"), times: count, target: group, note });

const fleetReq = z.strictObject({ category: z.literal("fleet"), ...fleet, groups: z.array(group).min(1), note });

const equipexchange = z.strictObject({
  category: z.literal("equipexchange"),
  equipments: z.array(item).optional(),
  scraps: z.array(item).optional(),
  consumptions: z.array(item).optional(),
  resources,
  note,
});

const scrapequipment = z.strictObject({ category: z.literal("scrapequipment"), list: z.array(item).min(1), note });

const modelconversion = z.strictObject({
  category: z.literal("modelconversion"),
  slots: z.array(z.strictObject({
    slot: z.number().int().min(0).max(5),
    equipment: z.string().min(1),
    equipIds: ids.optional(),
    fullyskilled: z.literal(true).optional(),
    maxmodified: z.literal(true).optional(),
    /** minimum improvement (★) when not max */
    level: z.number().int().min(1).max(10).optional(),
    count: count.optional(),
  })).optional(),
  equipment: z.union([z.string(), z.array(z.string())]).optional(),
  secretary: z.union([z.string(), z.array(z.string())]).optional(),
  secretaryIds: ids.optional(),
  scraps: z.array(item).optional(),
  consumptions: z.array(item).optional(),
  resources,
  note,
});

const modernization = z.strictObject({
  category: z.literal("modernization"),
  times: count,
  ship: z.string().optional(),
  target: group.optional(),
  consumptions: z.array(z.strictObject({
    ship: z.array(z.string()).optional(),
    amount: count,
    shipIds: ids.optional(),
    stypes: ids.optional(),
    ctypes: ids.optional(),
  })).optional(),
  resources,
  note,
});

const sink = z.strictObject({ category: z.literal("sink"), amount: count, ship: z.string(), note });
/** Anything the schema cannot express: shown as text, never counted. */
const other = z.strictObject({ category: z.literal("other"), note: z.string().min(1).max(200) });

const leaf = z.union([sortie, exercise, expedition, simple, remodel, fleetReq, equipexchange, scrapequipment, modelconversion, modernization, sink, other]);
type Leaf = z.infer<typeof leaf>;
type Requirement = Leaf | { category: "and" | "then" | "or"; list: Requirement[]; note?: string };
const requirement: z.ZodType<Requirement> = z.lazy(() =>
  z.union([z.strictObject({ category: z.enum(["and", "then", "or"]), list: z.array(requirement).min(1), note }), leaf]),
);

const rewards = z.strictObject({
  resources,
  items: z.array(z.strictObject({ name: z.string().min(1), amount: count.optional(), choice: count.optional() })).optional(),
});

export const questOverride = z.strictObject({
  id,
  /** Wiki code, for readers (and the code of quests the upstream lists lack) */
  code: z.string().optional(),
  /** Only for quests the upstream lists lack */
  name: z.string().optional(),
  detail: z.string().optional(),
  source: z.url().refine((u) => u.startsWith("https://"), "https source URL"),
  author: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note,
  /** The complete prerequisite list (replaces the upstream edges) */
  pre: z.array(id).optional(),
  requirements: requirement.optional(),
  rewards: rewards.optional(),
}).refine((o) => o.pre || o.requirements || o.rewards || o.name, "an override must set pre, requirements, rewards or name");
export type QuestOverride = z.infer<typeof questOverride>;

/** The override file (a JSON array, one entry per quest id). Throws with the offending path on any error. */
export function parseQuestOverrides(json: unknown): QuestOverride[] {
  const list = z.array(questOverride).parse(json);
  const seen = new Set<number>();
  for (const o of list) {
    if (seen.has(o.id)) throw new Error(`quest override ${o.id} appears twice`);
    seen.add(o.id);
  }
  return list;
}
