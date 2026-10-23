// Master data (ships, equipments) from D1 in the shapes the shared code expects: poi-style MasterData for
// friend ships (shared/fleet), API-style ApiShip / ApiEquipment for enemies (shared/sim/adapter EnemyLookup).
import type { ApiEquipment, ApiShip } from "../../shared/data/types";
import type { EquipMaster, MasterData, ShipMaster } from "../../shared/fleet/types";
import type { EnemyLookup } from "../../shared/sim/adapter";
import type { FitEntry } from "../../shared/sim/fit";

export interface ShipRow {
  id: number; name: string; name_en: string | null; yomi: string | null; stype: number; ctype: number | null; speed: number | null;
  range: number | null; slot_num: number | null; is_abyssal: number; hp: number | null; fp: number | null; tp: number | null;
  aa: number | null; ar: number | null; luck: number | null; max_stats: string | null; slots: string | null; equips: string | null;
  flags: string | null; fuel_max: number | null; ammo_max: number | null;
}
export interface EquipRow {
  id: number; name: string; type: string; type_id: number; icon: number | null; fp: number | null; tp: number | null; aa: number | null;
  ar: number | null; bomb: number | null; asw: number | null; los: number | null; acc: number | null; ev: number | null; luck: number | null;
  range: number | null; radius: number | null; cost: number | null; is_abyssal: number;
}

const SHIP_SQL = `SELECT id, name, name_en, yomi, stype, ctype, speed, range, slot_num, is_abyssal, hp, fp, tp, aa, ar, luck, max_stats,
  slots, equips, flags, fuel_max, ammo_max FROM ships WHERE id IN (SELECT value FROM json_each(?1))`;
const EQUIP_SQL = `SELECT id, name, type, type_id, icon, fp, tp, aa, ar, bomb, asw, los, acc, ev, luck, range, radius, cost, is_abyssal
  FROM equipments WHERE id IN (SELECT value FROM json_each(?1))`;

const json = <T>(s: string | null): T | null => (s === null ? null : (JSON.parse(s) as T));

export interface Master {
  ships: Map<number, ShipRow>;
  equips: Map<number, EquipRow>;
  /** poi-style master for friend ships (buildFriendShips, summarizeFleet) */
  data: MasterData;
  /** API-style lookup for enemy ships (buildEnemyShips); `detail` is unused by the estimator */
  lookup: EnemyLookup;
}

const shipMaster = (r: ShipRow): ShipMaster => {
  const max = json<Record<string, number | undefined>>(r.max_stats) ?? {};
  const pair = (v: number | null, m: number | undefined) => (v === null ? undefined : [v, m ?? v]);
  return {
    api_id: r.id, api_name: r.name, api_stype: r.stype, api_ctype: r.ctype ?? undefined,
    api_taik: pair(r.hp, max.hp), api_houg: pair(r.fp, max.fp), api_raig: pair(r.tp, max.tp), api_tyku: pair(r.aa, max.aa),
    api_souk: pair(r.ar, max.ar), api_luck: pair(r.luck, max.luck), api_leng: r.range ?? undefined, api_soku: r.speed ?? undefined,
    api_maxeq: json<number[]>(r.slots) ?? undefined, api_fuel_max: r.fuel_max ?? undefined, api_bull_max: r.ammo_max ?? undefined,
    api_slot_num: r.slot_num ?? undefined,
  };
};

const equipMaster = (r: EquipRow): EquipMaster => ({
  api_id: r.id, api_name: r.name, api_type: json<number[]>(r.type) ?? undefined, api_houg: r.fp ?? 0, api_raig: r.tp ?? 0,
  api_baku: r.bomb ?? 0, api_tyku: r.aa ?? 0, api_souk: r.ar ?? 0, api_tais: r.asw ?? 0, api_houm: r.acc ?? 0, api_houk: r.ev ?? 0,
  api_saku: r.los ?? 0, api_leng: r.range ?? 0, api_luck: r.luck ?? 0,
});

export const apiShip = (r: ShipRow): ApiShip => ({
  id: r.id, name: r.name, nameEn: r.name_en, yomi: r.yomi, stype: r.stype, ctype: r.ctype, speed: r.speed, range: r.range,
  slotNum: r.slot_num, isAbyssal: !!r.is_abyssal, hp: r.hp, fp: r.fp, tp: r.tp, aa: r.aa, ar: r.ar, luck: r.luck,
  maxStats: json(r.max_stats), slots: json<number[]>(r.slots), equips: json<number[]>(r.equips), flags: json(r.flags),
});

export const apiEquip = (r: EquipRow): ApiEquipment => ({
  id: r.id, name: r.name, type: json<number[]>(r.type) ?? [0, 0, 0, 0, 0], typeId: r.type_id, icon: r.icon, fp: r.fp ?? 0,
  tp: r.tp ?? 0, aa: r.aa ?? 0, ar: r.ar ?? 0, bomb: r.bomb ?? 0, asw: r.asw ?? 0, los: r.los ?? 0, acc: r.acc ?? 0, ev: r.ev ?? 0,
  luck: r.luck ?? 0, range: r.range, radius: r.radius, cost: r.cost, isAbyssal: !!r.is_abyssal,
});

/** Loads the given ship and equipment ids (unknown ids are simply absent). */
export async function loadMaster(db: D1Database, shipIds: Iterable<number>, equipIds: Iterable<number>): Promise<Master> {
  const ids = (s: Iterable<number>) => JSON.stringify([...new Set(s)].filter((x) => Number.isInteger(x) && x > 0));
  const [ships, equips] = await Promise.all([
    db.prepare(SHIP_SQL).bind(ids(shipIds)).all<ShipRow>(),
    db.prepare(EQUIP_SQL).bind(ids(equipIds)).all<EquipRow>(),
  ]);
  return masterFromRows(ships.results, equips.results);
}

/** Master over already loaded rows (e.g. a saved snapshot). */
export function masterFromRows(ships: ShipRow[], equips: EquipRow[]): Master {
  const data: MasterData = { ships: {}, equips: {} };
  for (const r of ships) data.ships[r.id] = shipMaster(r);
  for (const r of equips) data.equips[r.id] = equipMaster(r);
  const apiShips = new Map(ships.map((r) => [r.id, apiShip(r)]));
  const apiEquips = new Map(equips.map((r) => [r.id, apiEquip(r)]));
  return {
    ships: new Map(ships.map((r) => [r.id, r])), equips: new Map(equips.map((r) => [r.id, r])), data,
    lookup: { ship: (id) => apiShips.get(id), equip: (id) => apiEquips.get(id), detail: () => undefined },
  };
}

export async function loadFitBonuses(db: D1Database): Promise<FitEntry[]> {
  const { results } = await db.prepare("SELECT id, equip_ids, equip_types, bonuses FROM fit_bonuses ORDER BY id")
    .all<{ id: number; equip_ids: string | null; equip_types: string | null; bonuses: string }>();
  return results.map((r) => ({ id: r.id, ids: json<number[]>(r.equip_ids), types: json<number[]>(r.equip_types), bonuses: json(r.bonuses) ?? [] }));
}
