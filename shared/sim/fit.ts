/**
 * 装備ボーナス (fit bonus) の計算。データは data API `/api/v1/fit-bonuses` = kancolle-replay
 * `js/data/mst_slotitem_bonus.json` (KC3Kai/kancolle-replay、MIT) をそのまま使い、意味も kancolle-replay
 * `getBonusStats` (js/kcEQDATA.js) に合わせる。ElectronicObserver の FitBonuses.json は 2025-03 で更新が止まり、KCNav の
 * 実戦 716 通りの艦 + 装備で、ゲームの装備ボーナス (表示値 − 装備 − api_fParam) と火力が 79% しか合わなかった
 * (こちらは表示値に特殊効果アイテムを足して FP/TP/AA/AR とも 99.9% 以上、docs/VALIDATION.md §4)。
 *
 * - エントリは艦が ids/types (api_type[2]) のどれかの装備を載せていれば対象。対象装備数 n、その改修値の一覧を集める。
 * - bonuses の各定義は独立に判定し、成立したもの全てを加算する。
 * - 艦条件: shipId、shipBase (改装系列の初期艦 ID)、shipClass (api_ctype)、shipType (api_stype)、shipCountry (国コード)。
 * - requiresSR / requiresAR / requiresAccR: 電探 (type 12/13/93) のうち索敵 ≥ 5 / 対空 ≥ 2 / 命中 ≥ 8 のものを載せている。
 * - requiresId (+ requiresIdNum 既定 1, requiresIdLevel): 全装備のうち ids に一致し (改修値 ≥ level の) ものの数。
 *   requiresType (+ requiresTypeNum 既定 1): 種別の一致数。requiresEquipList はこの組の一覧で、全て満たす必要がある。
 * - level があれば n = 対象装備のうち改修値 ≥ level の数 (0 なら不成立)。num があれば n ≥ num のとき 1 回、無ければ n 回。
 * 加算しなかった定義のうち、未知のキーを含むもの、または必要な艦情報 (ctype・初期艦 ID・国) が無いものは
 * `unresolved` に数える。
 */
import type { EquipmentStats } from "../../sim-core/pkg/sim_core";
import type { MasterData, PresetEquip } from "../fleet/types";

export type FitKey = "houg" | "raig" | "tyku" | "souk" | "kaih" | "tais" | "saku" | "houm" | "baku" | "leng";
export type FitStats = Partial<Record<FitKey, number>>;

/** 装備の必要条件 (定義そのもの、または requiresEquipList の 1 要素)。 */
export interface FitRequirement {
  requiresId?: number[];
  requiresIdNum?: number;
  requiresIdLevel?: number;
  requiresType?: number[];
  requiresTypeNum?: number;
}

export interface FitBonusDef extends FitRequirement {
  shipId?: number[];
  shipBase?: number[];
  shipClass?: number[];
  shipType?: number[];
  /** kancolle-replay `country_ctype.json` の国コード (JP, US, GB, …) */
  shipCountry?: string[];
  requiresSR?: boolean;
  requiresAR?: boolean;
  requiresAccR?: boolean;
  requiresEquipList?: FitRequirement[];
  num?: number;
  level?: number;
  bonus?: FitStats;
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
  /** 改装系列の初期艦 ID (`shipBase`)。 */
  baseId?: number;
  /** 国コード (`shipCountry`)。深海棲艦は ""。 */
  country?: string;
}

export interface FitEquip {
  masterId: number;
  /** api_type[2] */
  type2: number;
  improvement: number;
  /** 装備マスターの索敵・対空・命中 (requiresSR/AR/AccR の電探判定)。無ければ 0 扱い。 */
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
  shipId: true, shipBase: true, shipClass: true, shipType: true, shipCountry: true, requiresSR: true, requiresAR: true,
  requiresAccR: true, requiresId: true, requiresIdNum: true, requiresIdLevel: true, requiresType: true, requiresTypeNum: true,
  requiresEquipList: true, num: true, level: true, bonus: true,
};
/** 電探 (小型・大型・大型 II) の api_type[2] */
const RADAR_TYPES = new Set([12, 13, 93]);
/** 艦条件の判定: 条件なし/一致 → true、不一致 → false、艦側の値が不明 → null */
const shipMatches = <T>(list: T[] | undefined, v: T | undefined): boolean | null =>
  !list ? true : v === undefined ? null : list.includes(v);

export const computeFitBonus = (ship: FitShip, equips: FitEquip[], entries: FitEntry[]): FitResult => {
  const total: FitStats = {};
  let unresolved = 0;
  const radars = equips.filter((e) => RADAR_TYPES.has(e.type2));
  const radar = {
    requiresSR: radars.some((e) => (e.saku ?? 0) >= 5),
    requiresAR: radars.some((e) => (e.tyku ?? 0) >= 2),
    requiresAccR: radars.some((e) => (e.houm ?? 0) >= 8),
  };
  /** requiresId / requiresType の組を満たすか */
  const meets = (r: FitRequirement): boolean => {
    if (r.requiresId) {
      const n = equips.filter((e) => r.requiresId!.includes(e.masterId) && e.improvement >= (r.requiresIdLevel ?? 0)).length;
      if (n < (r.requiresIdNum ?? 1)) return false;
    }
    if (r.requiresType) {
      const n = equips.filter((e) => r.requiresType!.includes(e.type2)).length;
      if (n < (r.requiresTypeNum ?? 1)) return false;
    }
    return true;
  };

  for (const entry of entries) {
    const matched = equips.filter((e) => !!entry.ids?.includes(e.masterId) || !!entry.types?.includes(e.type2));
    if (matched.length === 0) continue;

    for (const b of entry.bonuses) {
      if ((b.requiresSR && !radar.requiresSR) || (b.requiresAR && !radar.requiresAR) || (b.requiresAccR && !radar.requiresAccR)) continue;
      const shipOk = [
        shipMatches(b.shipClass, ship.ctype),
        shipMatches(b.shipCountry, ship.country),
        shipMatches(b.shipId, ship.masterId),
        shipMatches(b.shipBase, ship.baseId),
        shipMatches(b.shipType, ship.stype),
      ];
      if (shipOk.includes(false)) continue;
      if (shipOk.includes(null) || Object.keys(b).some((k) => !(k in KNOWN_KEYS))) {
        unresolved++;
        continue;
      }
      if (!(b.requiresEquipList ?? [b]).every(meets)) continue;

      const n = b.level ? matched.filter((e) => e.improvement >= b.level!).length : matched.length;
      if (n === 0 || (b.num && n < b.num)) continue;
      const times = b.num ? 1 : n;
      for (const [k, v] of Object.entries(b.bonus ?? {})) total[k as FitKey] = (total[k as FitKey] ?? 0) + (v ?? 0) * times;
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

/**
 * 艦の国コード (kancolle-replay `country_ctype.json` の JP / DE / IT / US / GB / FR / RU / TH / NO / SE / NL / AU)。
 * api_sort_id の範囲 (EO `ShipDataExtensions.Nationality`) で決め、kancolle-replay が艦型 (api_ctype) で別の国に
 * 置く艦型だけ上書きする。2026-10-23 の start2 で 866 隻中 861 隻が範囲どおり、残る 5 隻 (U-511改、伊504、
 * UIT-25、UIT-24、伊503) が下の 3 艦型。深海棲艦は ""。
 */
export const shipCountry = (sortId: number | undefined, masterId: number, ctype?: number): string | undefined => {
  if (masterId > 1500) return "";
  if (ctype !== undefined && CTYPE_COUNTRY[ctype]) return CTYPE_COUNTRY[ctype];
  if (sortId === undefined) return undefined;
  const upper: [number, string][] = [
    [1000, ""], [30000, "JP"], [31000, "DE"], [32000, "IT"], [33000, "US"], [34000, "GB"], [35000, "FR"], [36000, "RU"],
    [36060, "TH"], [36100, "NO"], [37000, "SE"], [38000, "NL"], [39000, "AU"],
  ];
  return upper.find(([u]) => sortId < u)?.[1] ?? "";
};
/** kancolle-replay が sort_id の範囲と違う国に置く艦型: 57 (U-511 / 呂500) → DE、80 と 124 (伊504、UIT-25、UIT-24、伊503) → IT */
const CTYPE_COUNTRY: Record<number, string> = { 57: "DE", 80: "IT", 124: "IT" };

/** master から computeFitBonus の艦。 */
export const fitShipOf = (masterId: number, master: Pick<MasterData, "ships">): FitShip => {
  const m = master.ships[masterId];
  return {
    masterId,
    stype: m?.api_stype ?? 0,
    ctype: m?.api_ctype,
    baseId: shipBaseId(masterId, master),
    country: shipCountry(m?.api_sort_id, masterId, m?.api_ctype),
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
