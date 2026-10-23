/**
 * poi の redux state から艦隊プリセットを作る。
 * 使うパス: state.info.{fleets,ships,equips,airbase}, state.const.{$ships,$equips}, state.combinedFlag。
 * 未ログインなどで欠けている場合は例外を投げず null / 空を返す。
 */
import type {
  AirBaseMode,
  MasterData,
  ObservedShipStats,
  Preset,
  PresetAirBase,
  PresetEquip,
  PresetFleetType,
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

/** poi の state のうちここで読む形。値はどれも未検証 (unknown) で、使う前に確かめる */
interface PoiView {
  info?: { basic?: { api_level?: unknown }; fleets?: { api_name?: unknown; api_ship?: unknown }[]; airbase?: unknown };
  combinedFlag?: unknown;
}
// 形を確かめずに読める型にするだけ (各フィールドは unknown のまま)
const view = (state: unknown): PoiView => (state && typeof state === "object" ? (state as PoiView) : {});

const fleetShips = (state: unknown, fleetIndex: number): PresetShip[] => {
  const ids = view(state).info?.fleets?.[fleetIndex]?.api_ship;
  if (!Array.isArray(ids)) return [];
  return ids
    .filter((id): id is number => typeof id === "number" && id > 0)
    .map((id) => shipFromPoi(id, state))
    .filter((s): s is PresetShip => s !== null);
};

const newPreset = (state: unknown, name: string, opts: ImportFromPoiOptions, body: Pick<Preset, "fleetType" | "formation" | "ships"> & Partial<Preset>): Preset => {
  const now = opts.now ?? Date.now();
  const hq = view(state).info?.basic?.api_level;
  return {
    id: opts.id ?? `p_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: opts.name ?? name,
    createdAt: now,
    updatedAt: now,
    ...body,
    ...(typeof hq === "number" ? { hqLevel: hq } : {}),
    source: "poi",
  };
};

/** @param fleetIndex 0 始まりの艦隊番号 (第1艦隊 = 0)。取得できなければ null。 */
export const importFromPoi = (
  state: any,
  fleetIndex: number,
  opts: ImportFromPoiOptions = {}
): Preset | null => {
  const ships = fleetShips(state, fleetIndex);
  if (ships.length === 0) return null;
  const fleetName = view(state).info?.fleets?.[fleetIndex]?.api_name;
  return newPreset(state, typeof fleetName === "string" && fleetName ? fleetName : `Fleet ${fleetIndex + 1}`, opts, {
    // 7 隻の艦隊 (第3艦隊の遊撃部隊) は遊撃部隊
    fleetType: ships.length > 6 ? "striking_force" : "single",
    formation: "line_ahead",
    ships,
  });
};

/** poi の api_combined_flag → 連合艦隊の種別 (0 や不明は null) */
export const COMBINED_FLAG_TYPES: Record<number, PresetFleetType> = { 1: "carrier_task_force", 2: "surface_task_force", 3: "transport_escort" };

export const combinedTypeFromPoi = (state: unknown): PresetFleetType | null => {
  const flag = view(state).combinedFlag;
  return typeof flag === "number" ? (COMBINED_FLAG_TYPES[flag] ?? null) : null;
};

/**
 * 第1 (主力) + 第2 (随伴) 艦隊を連合艦隊のプリセットにする。種別は poi の連合艦隊フラグ、組んでいなければ `fallbackType`。
 * どちらかの艦隊が空なら null。
 */
export const importCombinedFromPoi = (
  state: unknown,
  fallbackType: Exclude<PresetFleetType, "single" | "striking_force"> = "carrier_task_force",
  opts: ImportFromPoiOptions = {}
): Preset | null => {
  const ships = fleetShips(state, 0);
  const escort = fleetShips(state, 1);
  if (ships.length === 0 || escort.length === 0) return null;
  return newPreset(state, "連合艦隊", opts, {
    fleetType: combinedTypeFromPoi(state) ?? fallbackType,
    formation: "combined_battle",
    ships,
    escort,
  });
};

const AIR_BASE_ACTIONS: Record<number, AirBaseMode> = { 1: "sortie", 2: "defense" };

interface PoiAirBase {
  api_area_id: number;
  api_rid?: unknown;
  api_action_kind?: unknown;
  api_plane_info?: unknown;
}
interface PoiSquadron {
  api_squadron_id?: unknown;
  api_state?: unknown;
  api_slotid?: unknown;
  api_count?: unknown;
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * poi の基地航空隊 (state.info.airbase) のうち `areaId` の海域の隊 (最大 3)。その海域に無ければ、隊のある海域で番号の
 * 最も大きい海域 (イベント海域) の隊。中隊は配備済み (api_state 1) のものだけ、搭載数は今の機数。目標マスは空。
 */
export const airBasesFromPoi = (state: unknown, areaId?: number): PresetAirBase[] => {
  const raw = view(state).info?.airbase;
  const all = (Array.isArray(raw) ? raw : []).filter((b): b is PoiAirBase => isObject(b) && typeof b.api_area_id === "number");
  if (all.length === 0) return [];
  const area = all.some((b) => b.api_area_id === areaId) ? areaId : Math.max(...all.map((b) => b.api_area_id));
  return all
    .filter((b) => b.api_area_id === area)
    .sort((a, b) => numOr(a.api_rid, 0) - numOr(b.api_rid, 0))
    .slice(0, 3)
    .map((b): PresetAirBase => {
      const info = (Array.isArray(b.api_plane_info) ? b.api_plane_info : []).filter((p): p is PoiSquadron => isObject(p));
      const squadrons = [0, 1, 2, 3].map((i) => {
        const sq = info.find((p) => p.api_squadron_id === i + 1);
        return sq?.api_state === 1 ? equipFromInstance(sq.api_slotid, state, numOr(sq.api_count, 18)) : null;
      });
      return { mode: AIR_BASE_ACTIONS[numOr(b.api_action_kind, 0)] ?? "standby", squadrons, targets: ["", ""] };
    });
};
