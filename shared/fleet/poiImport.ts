/**
 * poi の redux state から艦隊プリセットを作る。
 * 使うパス: state.info.{fleets,ships,equips}, state.const.{$ships,$equips}。
 * 未ログインなどで欠けている場合は例外を投げず null / 空を返す。
 */
import type {
  MasterData,
  ObservedShipStats,
  Preset,
  PresetEquip,
  PresetShip,
} from "./types";

const first = (v: unknown, fallback = 0): number =>
  Array.isArray(v) && typeof v[0] === "number" ? v[0] : fallback;

const numOr = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

export const masterFromPoi = (state: any): MasterData => ({
  ships: state?.const?.$ships ?? {},
  equips: state?.const?.$equips ?? {},
});

const equipFromInstance = (
  instanceId: unknown,
  state: any,
  slotSize: number | undefined
): PresetEquip | null => {
  if (typeof instanceId !== "number" || instanceId <= 0) return null;
  const inst = state?.info?.equips?.[instanceId];
  const masterId = inst?.api_slotitem_id;
  if (typeof masterId !== "number") return null;
  const equip: PresetEquip = {
    masterId,
    improvement: numOr(inst.api_level, 0),
    proficiency: numOr(inst.api_alv, 0),
  };
  if (slotSize !== undefined) equip.slotSize = slotSize;
  return equip;
};

export const shipFromPoi = (instanceId: number, state: any): PresetShip | null => {
  const s = state?.info?.ships?.[instanceId];
  if (!s || typeof s.api_ship_id !== "number") return null;

  const slots: unknown[] = Array.isArray(s.api_slot) ? s.api_slot : [];
  const onslot: number[] = Array.isArray(s.api_onslot) ? s.api_onslot : [];
  // 装備が空のスロット (-1) も位置を保つため null として残す。
  // 存在しない (slot_num を超えた) 末尾の -1 は余計なので落とす。
  const slotNum = numOr(s.api_slotnum, slots.length);
  const equips = slots
    .slice(0, slotNum)
    .map((id, i) => equipFromInstance(id, state, onslot[i]));

  const kyouka: number[] = Array.isArray(s.api_kyouka) ? s.api_kyouka : [];
  const observed: ObservedShipStats = {
    maxHp: numOr(s.api_maxhp, 0),
    nowHp: numOr(s.api_nowhp, 0),
    firepower: first(s.api_karyoku),
    torpedo: first(s.api_raisou),
    antiAir: first(s.api_taiku),
    armor: first(s.api_soukou),
    evasion: first(s.api_kaihi),
    asw: first(s.api_taisen),
    los: first(s.api_sakuteki),
    luck: first(s.api_lucky),
    range: numOr(s.api_leng, 0),
    speed: numOr(s.api_soku, 0),
  };

  const ship: PresetShip = {
    masterId: s.api_ship_id,
    level: numOr(s.api_lv, 1),
    luckMod: numOr(kyouka[4], 0),
    hpMod: numOr(kyouka[5], 0),
    aswMod: numOr(kyouka[6], 0),
    morale: numOr(s.api_cond, 49),
    equips,
    observed,
  };
  // api_slot_ex: -1=未開放, 0=開放済み空き, >0=装備インスタンス
  ship.exSlot = equipFromInstance(s.api_slot_ex, state, 0);
  return ship;
};

export interface ImportFromPoiOptions {
  name?: string;
  id?: string;
  now?: number;
}

/** @param fleetIndex 0 始まりの艦隊番号 (第1艦隊 = 0)。取得できなければ null。 */
export const importFromPoi = (
  state: any,
  fleetIndex: number,
  opts: ImportFromPoiOptions = {}
): Preset | null => {
  const fleet = state?.info?.fleets?.[fleetIndex];
  if (!fleet || !Array.isArray(fleet.api_ship)) return null;

  const ships = fleet.api_ship
    .filter((id: unknown) => typeof id === "number" && id > 0)
    .map((id: number) => shipFromPoi(id, state))
    .filter((s: PresetShip | null): s is PresetShip => s !== null);
  if (ships.length === 0) return null;

  const now = opts.now ?? Date.now();
  const hq = state?.info?.basic?.api_level;
  return {
    id: opts.id ?? `p_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name:
      opts.name ??
      (typeof fleet.api_name === "string" && fleet.api_name
        ? fleet.api_name
        : `Fleet ${fleetIndex + 1}`),
    createdAt: now,
    updatedAt: now,
    fleetType: "single",
    formation: "line_ahead",
    ships,
    ...(typeof hq === "number" ? { hqLevel: hq } : {}),
    source: "poi",
  };
};
