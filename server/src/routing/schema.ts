// Routing rule DSL (private notes ROUTING_DSL). This zod schema is the single source of truth;
// `bun scripts/routing-schema.ts` emits the JSON Schema used by the Rust evaluator's tests.
import * as z from "zod";

/** Base ship types (api_mst_stype ids in private notes ROUTING_DSL §3). */
export const SHIP_TYPES = {
  DE: 1, DD: 2, CL: 3, CLT: 4, CA: 5, CAV: 6, CVL: 7, FBB: 8, BB: 9, BBV: 10,
  CV: 11, XBB: 12, SS: 13, SSV: 14, AP: 15, AV: 16, LHA: 17, CVB: 18, AR: 19,
  AS: 20, CT: 21, AO: 22,
} as const;
export type ShipTypeCode = keyof typeof SHIP_TYPES;

/** Standard groups; a ship counts once even if several listed groups contain its type. */
export const SHIP_GROUPS = {
  BB_CLASS: ["FBB", "BB", "BBV", "XBB"],
  BATTLESHIP: ["FBB", "BB", "XBB"],
  CV_CLASS: ["CV", "CVB", "CVL"],
  STD_CV: ["CV", "CVB"],
  CA_CLASS: ["CA", "CAV"],
  CL_CT: ["CL", "CT"],
  CL_CLASS: ["CL", "CT", "CLT"],
  DD_DE: ["DD", "DE"],
  SS_CLASS: ["SS", "SSV"],
} as const satisfies Record<string, readonly ShipTypeCode[]>;
export type ShipGroupCode = keyof typeof SHIP_GROUPS;

/** Equipment groups by api_type[2] (category) unless stated (private notes ROUTING_DSL §4). */
export const EQUIP_GROUPS = {
  RADAR: { types: [12, 13, 93] },
  SURFACE_RADAR: { types: [12, 13, 93], minLos: 5 },
  DRUM: { ids: [75] },
  LANDING_CRAFT: { types: [24, 46] },
  SONAR: { types: [14, 40] },
} as const;

const shipTypeCode = z.enum(Object.keys(SHIP_TYPES) as [ShipTypeCode, ...ShipTypeCode[]]);
const shipGroupCode = z.enum(Object.keys(SHIP_GROUPS) as [ShipGroupCode, ...ShipGroupCode[]]);
export const typeOrGroup = z.union([shipTypeCode, shipGroupCode]);
const nodeLetter = z.string().regex(/^[A-Z][A-Z0-9]*$|^Start[0-9]*$/, "node letter like A, B1, ZZ, Start, Start2");
const fleetSel = z.enum(["main", "escort", "all"]);
export const SPEEDS = { slow: 5, fast: 10, fastPlus: 15, fastest: 20 } as const;
const speedName = z.enum(["slow", "fast", "fastPlus", "fastest"]);

// Comparison operators. A leaf holds iff every present operator holds.
const num = z.number();
const numCmp = {
  eq: num.optional(), ne: num.optional(), gt: num.optional(), gte: num.optional(),
  lt: num.optional(), lte: num.optional(), in: z.array(num).optional(),
};
const speedVal = z.union([speedName, z.number()]);
const speedCmp = {
  eq: speedVal.optional(), ne: speedVal.optional(), gt: speedVal.optional(), gte: speedVal.optional(),
  lt: speedVal.optional(), lte: speedVal.optional(),
};

const equipSel = z.union([
  z.object({ group: z.enum(Object.keys(EQUIP_GROUPS) as [keyof typeof EQUIP_GROUPS, ...(keyof typeof EQUIP_GROUPS)[]]) }).strict(),
  z.object({ types: z.array(z.int()).min(1), minLos: z.int().optional() }).strict(),
  z.object({ ids: z.array(z.int()).min(1) }).strict(),
]);

export const leaf = z.discriminatedUnion("m", [
  z.object({ m: z.literal("ships"), fleet: fleetSel.optional(), ...numCmp }).strict(),
  z.object({ m: z.literal("count"), types: z.array(typeOrGroup).min(1), fleet: fleetSel.optional(), maxSpeed: speedName.optional(), ...numCmp }).strict(),
  z.object({ m: z.literal("countIds"), ids: z.array(z.int()).min(1), fleet: fleetSel.optional(), ...numCmp }).strict(),
  z.object({ m: z.literal("equipShips"), equip: equipSel, fleet: fleetSel.optional(), ...numCmp }).strict(),
  z.object({ m: z.literal("equipCount"), equip: equipSel, fleet: fleetSel.optional(), ...numCmp }).strict(),
  z.object({ m: z.literal("speed"), ...speedCmp }).strict(),
  z.object({ m: z.literal("los"), cn: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), ...numCmp }).strict(),
  z.object({ m: z.literal("fleetType"), in: z.array(z.enum(["single", "ctf", "stf", "tcf", "striking"])).min(1) }).strict(),
  z.object({ m: z.literal("flagship"), in: z.array(typeOrGroup).min(1), fleet: z.enum(["main", "escort"]).optional() }).strict(),
  z.object({ m: z.literal("difficulty"), ...numCmp }).strict(),
  z.object({ m: z.literal("phase"), ...numCmp }).strict(),
  z.object({ m: z.literal("gauge"), ...numCmp }).strict(),
  z.object({ m: z.literal("onlyTypes"), types: z.array(typeOrGroup).min(1), fleet: fleetSel.optional(), eq: z.boolean().optional() }).strict(),
  z.object({ m: z.literal("hq"), ...numCmp }).strict(),
  z.object({ m: z.literal("visited"), node: nodeLetter, eq: z.boolean().optional() }).strict(),
  z.object({ m: z.literal("flag"), name: z.string().min(1), eq: z.boolean().optional() }).strict(),
]);
export type Leaf = z.infer<typeof leaf>;

export type Predicate = Leaf | { all: Predicate[] } | { any: Predicate[] } | { not: Predicate };
export const predicate: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    leaf,
    z.object({ all: z.array(predicate).min(1) }).strict(),
    z.object({ any: z.array(predicate).min(1) }).strict(),
    z.object({ not: predicate }).strict(),
  ]),
);

const randomEntry = z.object({ to: nodeLetter, p: z.number().gt(0).lte(1) }).strict();
const losAction = z.object({
  cn: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  thresholds: z.array(z.object({ min: z.number(), to: nodeLetter }).strict()).min(1),
  below: nodeLetter,
  interpolate: z.boolean().optional(),
}).strict();

const ruleMeta = {
  when: predicate.optional(),
  note: z.string().optional(),
  uncertain: z.boolean().optional(),
  source: z.string().optional(),
};

export type Rule = {
  when?: Predicate; note?: string; uncertain?: boolean; source?: string;
} & (
  | { to: string }
  | { random: { to: string; p: number }[] }
  | { los: z.infer<typeof losAction> }
  | { select: string[] }
  | { rules: Rule[] }
);
export const rule: z.ZodType<Rule> = z.lazy(() =>
  z.union([
    z.object({ ...ruleMeta, to: nodeLetter }).strict(),
    z.object({ ...ruleMeta, random: z.array(randomEntry).min(2) }).strict(),
    z.object({ ...ruleMeta, los: losAction }).strict(),
    z.object({ ...ruleMeta, select: z.array(nodeLetter).min(2) }).strict(),
    z.object({ ...ruleMeta, rules: z.array(rule).min(1) }).strict(),
  ]),
);

export const nodeDef = z.union([
  z.object({ rules: z.array(rule).min(1), note: z.string().optional() }).strict(),
  z.object({ end: z.literal(true), note: z.string().optional() }).strict(),
]);

export const routingDoc = z.object({
  $schema: z.string().optional(),
  map: z.string().regex(/^\d+-\d+$/),
  layout: z.string().optional(),
  sources: z.array(z.object({ id: z.string(), note: z.string() }).strict()).min(1),
  defaults: z.object({
    select: z.record(z.string(), nodeLetter).optional(),
    flags: z.array(z.string()).optional(),
    phase: z.int().min(1).optional(),
    gauge: z.int().min(1).optional(),
  }).strict().optional(),
  /** Start-point choice for maps with several start points (Start1, Start2, …); required there. */
  start: z.object({ rules: z.array(rule).min(1), note: z.string().optional() }).strict().optional(),
  nodes: z.record(nodeLetter, nodeDef),
}).strict();
export type RoutingDoc = z.infer<typeof routingDoc>;
