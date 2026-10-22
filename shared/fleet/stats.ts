/**
 * プリセット艦の表示ステータスを求める。
 *
 * 限界 (start2 の仕様による):
 * - 実測値 (`observed`, poi 取り込み時) があればそれを最優先で使う。装備・改修込みの合計値。
 * - 手入力艦は master から計算する。艦娘の api_kaih/api_tais/api_saku は start2 に無いことが多く、
 *   [lv1, lv99] の2要素配列で存在するときだけ線形補間 floor(min + (max-min)*lv/99) する。無ければ unknown。
 * - 耐久は Lv 毎の成長表が master に無く、補間すると実値とずれるため observed が無ければ unknown。
 * - 火力/雷装/対空/装甲は api_xxx[0] (近代化・固有ボーナス前) + 装備合計。改修(★)の火力補正は含まない。
 */
import type { EquipMaster, MasterData, ObservedShipStats, PresetShip } from "./types";

/** nowHp は戦闘開始時の状態なので解決対象外。 */
export type StatKey = Exclude<keyof ObservedShipStats, "nowHp">;
export type StatSource = "observed" | "computed" | "unknown";
export interface ResolvedStat {
  value: number | null;
  source: StatSource;
}
export type ResolvedStats = Record<StatKey, ResolvedStat>;

export interface EquipTotals {
  firepower: number;
  torpedo: number;
  bombing: number;
  antiAir: number;
  armor: number;
  asw: number;
  evasion: number;
  accuracy: number;
  los: number;
  range: number;
}

export const sumEquipStats = (ship: PresetShip, master?: MasterData): EquipTotals => {
  const totals: EquipTotals = {
    firepower: 0, torpedo: 0, bombing: 0, antiAir: 0, armor: 0,
    asw: 0, evasion: 0, accuracy: 0, los: 0, range: 0,
  };
  const all = [...ship.equips, ship.exSlot];
  for (const e of all) {
    const m: EquipMaster | undefined = e ? master?.equips[e.masterId] : undefined;
    if (!m) continue;
    totals.firepower += m.api_houg ?? 0;
    totals.torpedo += m.api_raig ?? 0;
    totals.bombing += m.api_baku ?? 0;
    totals.antiAir += m.api_tyku ?? 0;
    totals.armor += m.api_souk ?? 0;
    totals.asw += m.api_tais ?? 0;
    totals.evasion += m.api_houk ?? 0;
    totals.accuracy += m.api_houm ?? 0;
    totals.los += m.api_saku ?? 0;
    totals.range = Math.max(totals.range, m.api_leng ?? 0);
  }
  return totals;
};

const UNKNOWN: ResolvedStat = { value: null, source: "unknown" };
const computed = (value: number): ResolvedStat => ({ value, source: "computed" });

/** [lv1, lv99] を level で補間。1要素なら固定値、それ以外は null。 */
const scaleByLevel = (range: number[] | undefined, level: number): number | null => {
  if (!Array.isArray(range) || range.length === 0) return null;
  const [min, max] = range as [number, ...number[]];
  if (max === undefined) return min;
  return Math.floor(min + ((max - min) * Math.min(level, 99)) / 99);
};

export const resolveShipStats = (ship: PresetShip, master?: MasterData): ResolvedStats => {
  const m = master?.ships[ship.masterId];
  const eq = sumEquipStats(ship, master);
  const level = ship.level;

  const fromBase = (base: number[] | undefined, equip: number): ResolvedStat =>
    base && typeof base[0] === "number" ? computed(base[0] + equip) : UNKNOWN;
  const fromScaled = (range: number[] | undefined, equip: number, mod = 0): ResolvedStat => {
    const v = scaleByLevel(range, level);
    return v === null ? UNKNOWN : computed(v + equip + mod);
  };

  const result: ResolvedStats = {
    maxHp: UNKNOWN,
    firepower: fromBase(m?.api_houg, eq.firepower),
    torpedo: fromBase(m?.api_raig, eq.torpedo),
    antiAir: fromBase(m?.api_tyku, eq.antiAir),
    armor: fromBase(m?.api_souk, eq.armor),
    evasion: fromScaled(m?.api_kaih, eq.evasion),
    asw: fromScaled(m?.api_tais, eq.asw, ship.aswMod),
    los: fromScaled(m?.api_saku, eq.los),
    luck:
      m?.api_luck && typeof m.api_luck[0] === "number"
        ? computed(m.api_luck[0] + ship.luckMod)
        : UNKNOWN,
    range:
      m && typeof m.api_leng === "number"
        ? computed(Math.max(m.api_leng, eq.range))
        : UNKNOWN,
    speed: m && typeof m.api_soku === "number" ? computed(m.api_soku) : UNKNOWN,
  };

  for (const [key, value] of Object.entries(ship.observed ?? {})) {
    if (typeof value === "number" && key in result) {
      result[key as StatKey] = { value, source: "observed" };
    }
  }
  return result;
};
