/**
 * 装備ボーナス (fit bonus) の計算。データは data API `/api/v1/fit-bonuses`
 * (ElectronicObserver FitBonuses.json 形式。kancolle-replay `mst_slotitem_bonus.json` も同形式) をそのまま使う。
 *
 * 意味は EO `FitBonusExtensions.GetTheoreticalFitBonus` に合わせる:
 * - エントリは艦が ids/types のどれかの装備を載せていれば対象。bonuses の各定義は独立に判定し、成立したもの全てを加算する
 *   (level の段階ボーナスもそれぞれ加算される)。
 * - 艦条件: shipX (艦 ID)、shipS (改装系列の初期艦 ID)、shipClass、shipType、shipNationality (EO の国籍コード)。
 * - 対象装備 = ids/types に一致し改修値 ≥ level の装備。num も requires/requiresType も無ければ bonus × 対象装備数、
 *   どれかがあれば対象装備数 ≥ num (既定 1) のとき 1 回だけ。
 *   [EO と相違] EO は requires があると level を見ずに 1 回加算するが、北方迷彩 ★7 などの意図どおり level を満たす装備を要求する。
 * - requires: 全装備 (対象装備自身も含む) のうち ids に一致し改修値 ≥ requiresLevel のものが requiresNum (既定 1) 個以上。
 *   requiresType: 種別 (api_type[2]) が一致するものが requiresNumType (既定 1) 個以上。両方あれば両方必要。
 * - bonusSR/bonusAR/bonusAccR: 定義が成立し、艦が電探 (type 12/13/93) のうち索敵 ≥ 5 / 対空 ≥ 2 / 命中 ≥ 8 のものを
 *   1 つでも載せていれば、それぞれ 1 回加算する (装備数で倍にしない)。
 * 加算しなかった定義のうち、未知のキーを含むもの、または必要な艦情報 (ctype・初期艦 ID・国籍) が master に無いものは
 * `unresolved` に数える。
 */
import type { EquipmentStats } from "../../sim-core/pkg/sim_core";
import type { MasterData, PresetEquip } from "../fleet/types";

export type FitKey = "houg" | "raig" | "tyku" | "souk" | "kaih" | "tais" | "saku" | "houm" | "baku" | "leng";
export type FitStats = Partial<Record<FitKey, number>>;

export interface FitBonusDef {
  shipX?: number[];
  shipS?: number[];
  shipClass?: number[];
  shipType?: number[];
  shipNationality?: number[];
  num?: number;
  level?: number;
  requires?: number[];
  requiresLevel?: number;
  requiresNum?: number;
  requiresType?: number[];
  requiresNumType?: number;
  bonus?: FitStats;
  bonusSR?: FitStats;
  bonusAR?: FitStats;
  bonusAccR?: FitStats;
}

export interface FitEntry {
  id: number;
  ids: number[] | null;
  types: number[] | null;
  bonuses: FitBonusDef[];
}

export interface FitShip {
  masterId: number;
  stype: number;
  ctype?: number;
  /** 改装系列の初期艦 ID (`shipS`)。 */
  baseId?: number;
  /** EO の国籍コード: 1 日 2 独 3 伊 4 米 5 英 6 仏 7 露 8 タイ 9 ノルウェー 10 スウェーデン 11 蘭 12 豪、0 不明 (深海棲艦)。 */
  nationality?: number;
}

export interface FitEquip {
  masterId: number;
  /** api_type[2] */
  type2: number;
  improvement: number;
  /** 装備マスターの索敵・対空・命中 (bonusSR/AR/AccR の電探判定)。無ければ 0 扱い。 */
  saku?: number;
  tyku?: number;
  houm?: number;
}

export interface FitResult {
  bonus: FitStats;
  /** 未知のキーを含む、または艦情報が足りず評価できなかった定義の数 */
  unresolved: number;
}

const KNOWN_KEYS: Record<keyof FitBonusDef, true> = {
  shipX: true, shipS: true, shipClass: true, shipType: true, shipNationality: true, num: true, level: true, requires: true,
  requiresLevel: true, requiresNum: true, requiresType: true, requiresNumType: true, bonus: true, bonusSR: true, bonusAR: true,
  bonusAccR: true,
};
/** 電探 (小型・大型・大型 II) の api_type[2] */
const RADAR_TYPES = new Set([12, 13, 93]);
/** 艦条件の判定: 条件なし/一致 → true、不一致 → false、艦側の値が不明 → null */
const shipMatches = (list: number[] | undefined, v: number | undefined): boolean | null =>
  !list ? true : v === undefined ? null : list.includes(v);

export const computeFitBonus = (ship: FitShip, equips: FitEquip[], entries: FitEntry[]): FitResult => {
  const total: FitStats = {};
  let unresolved = 0;
  const add = (b: FitStats, times = 1) => {
    for (const [k, v] of Object.entries(b)) total[k as FitKey] = (total[k as FitKey] ?? 0) + (v ?? 0) * times;
  };
  const radars = equips.filter((e) => RADAR_TYPES.has(e.type2));
  const surfaceRadar = radars.some((e) => (e.saku ?? 0) >= 5);
  const airRadar = radars.some((e) => (e.tyku ?? 0) >= 2);
  const accRadar = radars.some((e) => (e.houm ?? 0) >= 8);

  for (const entry of entries) {
    const matched = equips.filter((e) => !!entry.ids?.includes(e.masterId) || !!entry.types?.includes(e.type2));
    if (matched.length === 0) continue;

    for (const b of entry.bonuses) {
      const shipOk = [
        shipMatches(b.shipX, ship.masterId),
        shipMatches(b.shipS, ship.baseId),
        shipMatches(b.shipClass, ship.ctype),
        shipMatches(b.shipType, ship.stype),
        shipMatches(b.shipNationality, ship.nationality),
      ];
      if (shipOk.includes(false)) continue;
      if (shipOk.includes(null) || Object.keys(b).some((k) => !(k in KNOWN_KEYS))) {
        unresolved++;
        continue;
      }

      if (b.requires) {
        const n = equips.filter((e) => b.requires!.includes(e.masterId) && e.improvement >= (b.requiresLevel ?? 0)).length;
        if (n < (b.requiresNum ?? 1)) continue;
      }
      if (b.requiresType) {
        const n = equips.filter((e) => b.requiresType!.includes(e.type2)).length;
        if (n < (b.requiresNumType ?? 1)) continue;
      }
      const count = matched.filter((e) => e.improvement >= (b.level ?? 0)).length;
      const once = b.num !== undefined || !!b.requires || !!b.requiresType;
      const times = once ? (count >= (b.num ?? 1) ? 1 : 0) : count;
      if (times === 0) continue;

      if (b.bonus) add(b.bonus, times);
      if (b.bonusSR && surfaceRadar) add(b.bonusSR);
      if (b.bonusAR && airRadar) add(b.bonusAR);
      if (b.bonusAccR && accRadar) add(b.bonusAccR);
    }
  }
  return { bonus: total, unresolved };
};

/** 艦 ID → 改装系列の初期艦 ID。master.ships ごとに 1 度だけ作る。 */
const baseIdCache = new WeakMap<object, Map<number, number> | null>();

/**
 * 改装系列の初期艦 ID (EO `BaseShip`)。api_aftershipid で繋がる艦の集まりのうち、どの艦の改装先でもない艦。
 * 全員が改装先になっている循環系列 (宗谷) は api_sort_id 最小の艦。master に api_aftershipid が無ければ undefined。
 */
export const shipBaseId = (masterId: number, master: Pick<MasterData, "ships">): number | undefined => {
  let table = baseIdCache.get(master.ships);
  if (table === undefined) {
    const ships = Object.values(master.ships).filter((m) => !!m);
    if (!ships.some((m) => m!.api_aftershipid !== undefined)) table = null;
    else {
      const parent = new Map(ships.map((m) => [m!.api_id, m!.api_id]));
      const find = (x: number): number => {
        while (parent.get(x) !== x) x = parent.get(x)!;
        return x;
      };
      const isAfter = new Set<number>();
      for (const m of ships) {
        const after = Number(m!.api_aftershipid ?? 0);
        if (after > 0 && parent.has(after)) {
          isAfter.add(after);
          parent.set(find(after), find(m!.api_id));
        }
      }
      // 改装先でない艦を優先し、次に api_sort_id (無ければ艦 ID) の小さい艦
      const rank = (id: number) => (isAfter.has(id) ? 1e9 : 0) + (master.ships[id]?.api_sort_id ?? id);
      const best = new Map<number, number>();
      for (const m of ships) {
        const root = find(m!.api_id);
        const cur = best.get(root);
        if (cur === undefined || rank(m!.api_id) < rank(cur)) best.set(root, m!.api_id);
      }
      table = new Map(ships.map((m) => [m!.api_id, best.get(find(m!.api_id))!]));
    }
    baseIdCache.set(master.ships, table);
  }
  return table?.get(masterId);
};

/** api_sort_id の範囲から EO の国籍コード (EO `ShipDataExtensions.Nationality`)。 */
export const shipNationality = (sortId: number | undefined, masterId: number): number | undefined => {
  if (masterId > 1500) return 0;
  if (sortId === undefined) return undefined;
  const upper: [number, number][] = [
    [1000, 0], [30000, 1], [31000, 2], [32000, 3], [33000, 4], [34000, 5], [35000, 6], [36000, 7], [36060, 8], [36100, 9],
    [37000, 10], [38000, 11], [39000, 12],
  ];
  return upper.find(([u]) => sortId < u)?.[1] ?? 0;
};

/** master から computeFitBonus の艦。 */
export const fitShipOf = (masterId: number, master: Pick<MasterData, "ships">): FitShip => {
  const m = master.ships[masterId];
  return {
    masterId,
    stype: m?.api_stype ?? 0,
    ctype: m?.api_ctype,
    baseId: shipBaseId(masterId, master),
    nationality: shipNationality(m?.api_sort_id, masterId),
  };
};

/** master から computeFitBonus の装備。 */
export const fitEquipOf = (e: Pick<PresetEquip, "masterId" | "improvement">, master: Pick<MasterData, "equips">): FitEquip => {
  const m = master.equips[e.masterId];
  return { masterId: e.masterId, type2: m?.api_type?.[2] ?? 0, improvement: e.improvement, saku: m?.api_saku, tyku: m?.api_tyku, houm: m?.api_houm };
};

/** master の略号 (houg…) を sim-core の EquipmentStats に変換する。射程 (leng) は含めない (ShipInput.range に足す)。 */
export const fitToEquipmentStats = (bonus: FitStats): EquipmentStats => {
  const out: EquipmentStats = {};
  const map: [FitKey, keyof EquipmentStats][] = [
    ["houg", "firepower"], ["raig", "torpedo"], ["tyku", "antiAir"], ["souk", "armor"], ["kaih", "evasion"],
    ["tais", "asw"], ["saku", "los"], ["houm", "accuracy"], ["baku", "bombing"],
  ];
  for (const [from, to] of map) if (bonus[from]) out[to] = bonus[from];
  return out;
};
