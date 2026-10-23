// zod validation for write / admin request bodies (docs/API.md §3, §4).
import * as z from "zod";
import { parseMapKey } from "./maps";

const mapRef = z.union([z.int().positive(), z.string()]).transform((v, ctx) => {
  const m = parseMapKey(String(v));
  if (!m) {
    ctx.addIssue({ code: "custom", message: `bad map "${v}" (use "1-5" or 15)` });
    return z.NEVER;
  }
  return m.id;
});
const letter = z.string().regex(/^[A-Z][A-Z0-9]*$|^Start[0-9]*$/);
const json = z.json();

const cellNo = z.int().min(0).max(999);
const clientObsId = z.string().min(1).max(100);

const shipId = z.int().min(1).max(9999);
/** Position in the sortie fleet (main 1-6, escort 7-12). */
const fleetIdx = z.int().min(1).max(12);
const label = z.string().max(64);

/** shared/capture/types CapturedEscape: FCF retreat offered by a battle result (api_escape). */
const escape = z.object({
  idx: z.array(fleetIdx).max(12),
  towIdx: z.array(fleetIdx).max(12),
  shipIds: z.array(shipId).max(12),               // masterIds of idx / towIdx in the sortie's fleet snapshot
  towShipIds: z.array(shipId).max(12),
  type: z.int().min(0).max(9).nullish(),          // api_escape_type
  retreated: z.boolean(),                         // goback_port seen: the ships left after this cell
}).strict();

/** shared/capture/types CapturedCellResult: the battleresult of a cell. */
export const cellResult = z.object({
  rank: z.enum(["S", "A", "B", "C", "D", "E"]).nullable(),   // api_win_rank
  drop: z.object({ shipId, name: label.optional() }).strict().nullable(),   // api_get_ship
  useItem: z.object({ id: z.int().min(0).max(99999), name: label.optional() }).strict().optional(),   // api_get_useitem
  eventItems: z.array(z.object({ type: z.int().min(0).max(99), id: z.int().min(0).max(99999), value: z.int().min(0).max(1_000_000) }).strict()).max(8).optional(),
  escapeFlag: z.int().min(0).max(9),
  escape: escape.optional(),
}).strict();
export type CellResult = z.infer<typeof cellResult>;

/** shared/capture/types CapturedGauge: the sortied map's mapinfo entry at the start, game values as they are. */
const gauge = z.object({
  gaugeNum: z.int().min(0).max(99).nullish(),
  gaugeType: z.int().min(0).max(99).nullish(),
  nowHp: z.int().min(0).max(9_999_999).nullish(),
  maxHp: z.int().min(0).max(9_999_999).nullish(),
  state: z.int().min(0).max(99).nullish(),
  rank: z.int().min(0).max(4).nullish(),
  cleared: z.int().min(0).max(9).nullish(),
  defeatCount: z.int().min(0).max(99999).nullish(),
}).strict();

/** One visited cell of a sortie (api_req_map/start or next). */
const sortieCell = z.object({
  no: cellNo,                                          // api_no
  from: cellNo.nullish(),                              // api_from_no when the game sends it
  colorNo: z.int().nullish(),
  eventId: z.int().nullish(),
  eventKind: z.int().nullish(),
  bossCellNo: cellNo.nullish(),
  next: z.int().min(0).nullish(),                      // api_next: 0 = terminal cell
  selectCells: z.array(cellNo).max(16).nullish(),      // api_select_route.api_select_cells
  battles: z.array(clientObsId).max(8).default([]),    // battle observations at this cell, in order
  result: cellResult.nullish(),                        // battleresult: rank, drop, FCF escape (optional: older plugins)
}).strict();

export const sortieRecord = z.object({
  deckId: z.int().min(1).max(4).nullish(),
  fleetSize: z.int().min(1).max(7).nullish(),          // main fleet ships; 7 in fleet 3 = striking force
  escortSize: z.int().min(0).max(6).nullish(),
  gauge: gauge.nullish(),
  // Derived by the server from the fleet snapshot (a client value is replaced).
  fleetType: z.enum(["single", "ctf", "stf", "tcf", "striking"]).nullish(),
  combined: z.int().min(0).max(3).nullish(),
  endKind: z.enum(["boss", "end_node", "retreat", "unknown"]),
  endedAt: z.iso.datetime({ offset: true }).nullish(),
  cells: z.array(sortieCell).min(1).max(64),
  cellData: z.array(z.object({
    no: cellNo, colorNo: z.int().nullish(), passed: z.int().nullish(), distance: z.int().nullish(),
  }).strict()).max(128).nullish(),
  features: json.nullish(),
}).strict();
export type SortieRecord = z.infer<typeof sortieRecord>;

// ---- POST /api/v1/observations (docs/API.md §3) ----
// The request only stages the body's items (SQLite checks the envelope: ingest/upload.ts stageUpload). The
// jobs run checks each staged observation on its own with `observationInput`, so one malformed observation is
// rejected (rule "schema") without failing the others. Other envelope keys (a legacy `clientId`) are ignored.

const presetEquip = z.object({
  masterId: z.int().positive(),
  improvement: z.int().min(0).max(10).default(0),
  proficiency: z.int().min(0).max(7).default(0),
  slotSize: z.int().min(0).max(999).optional(),
});
const stat = z.number().finite();
/** shared/fleet/types PresetShip (the poi snapshot; display values incl. equipment). Unknown keys are dropped. */
const presetShip = z.object({
  masterId: z.int().positive(),
  level: z.int(),
  luckMod: z.int().default(0),
  hpMod: z.int().default(0),
  aswMod: z.int().default(0),
  morale: z.int().min(0).max(100),
  equips: z.array(presetEquip.nullable()).max(6),
  exSlot: presetEquip.nullish(),
  observed: z.object({
    maxHp: stat, nowHp: stat, firepower: stat, torpedo: stat, antiAir: stat, armor: stat, evasion: stat, asw: stat, los: stat,
    luck: stat, range: stat, speed: stat,
  }).partial().optional(),
});
/** shared/capture/types CapturedFleet */
export const capturedFleet = z.object({
  deckId: z.int().min(1).max(4),
  ships: z.array(presetShip).min(1).max(7),
  escort: z.array(presetShip).max(6).optional(),
  supply: z.array(z.object({
    fuel: z.int().min(0), fuelMax: z.int().min(0), ammo: z.int().min(0), ammoMax: z.int().min(0),
  }).nullable()).max(7).optional(),
});
export type FleetInput = z.infer<typeof capturedFleet>;

const packetBody = z.record(z.string(), z.unknown());
const observationBase = {
  clientObsId,
  observedAt: z.iso.datetime({ offset: true }),
  map: mapRef,
  // api_cell_data api_no list of the sortie (map layout); order does not matter.
  layout: z.array(cellNo).max(128).nullish(),
  difficulty: z.int().min(0).max(4).nullish(),
  fleet: capturedFleet.nullish(),
};
export const battleObservation = z.object({
  ...observationBase,
  kind: z.literal("battle"),
  cell: cellNo,
  // The raw battle response is the only battle data the server trusts; `raw.events` and `enemy` are
  // re-derived from it (`enemy` is kept only for a cross-check).
  raw: z.object({
    path: z.string().max(64),
    visitId: z.string().min(1).max(100),
    sortieId: z.string().max(100).nullish(),
    raw: packetBody,
    result: json.nullish(),
  }),
  enemy: z.unknown().optional(),
});
export const sortieObservation = z.object({
  ...observationBase,
  kind: z.literal("sortie"),
  sortie: sortieRecord,
  // api_req_map/start + every api_req_map/next response, in visit order: cells and cellData are re-derived.
  raw: z.object({
    packets: z.array(z.object({ path: z.enum(["api_req_map/start", "api_req_map/next"]), body: packetBody })).min(1).max(64),
  }).nullish(),
});
export const observationInput = z.discriminatedUnion("kind", [battleObservation, sortieObservation]);
export type BattleObservationInput = z.infer<typeof battleObservation>;
export type SortieObservationInput = z.infer<typeof sortieObservation>;
export type ObservationInput = z.infer<typeof observationInput>;

export const enqueueRequest = z.object({
  maps: z.array(mapRef).min(1).max(50),
  kinds: z.array(z.enum(["map", "enemycomps", "nodesummary", "battles"])).min(1),
  nodes: z.array(letter).optional(),
  edges: z.array(z.int().positive()).max(200).optional(),
  batch: z.boolean().optional(),
  difficulty: z.int().min(1).max(4).optional(),
  start: z.iso.date().optional(),
  end: z.iso.date().optional(),
  filters: z.record(z.string().regex(/^[A-Za-z]+$/), z.string().max(200)).optional(),
  priority: z.int().min(0).max(1000).optional(),
  refresh: z.boolean().optional(),
  pages: z.int().min(1).max(100).optional(),
  perPage: z.int().min(1).max(100).optional(),
}).strict();

/** POST /admin/estimate/run */
export const estimateRunRequest = z.object({
  rebuild: z.boolean().optional(),
  shipIds: z.array(z.int().positive()).max(5000).optional(),
  /** CPU budget of this run in the cost model (src/budget.ts); default RUN_MS. */
  budgetMs: z.number().positive().max(60_000).optional(),
}).strict();

/** POST /admin/clients/{id}/ban */
export const banRequest = z.object({ reason: z.string().max(200).optional() }).strict();
