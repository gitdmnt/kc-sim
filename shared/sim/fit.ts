/**
 * 装備ボーナス (fit bonus) の計算。データは data API `/api/v1/fit-bonuses`
 * (kancolle-replay `mst_slotitem_bonus.json` 形式) をそのまま使う。
 *
 * 対応する条件: 装備 ids/types、艦 shipX(マスターID)/shipS(改装系列の元の艦ID)/shipNationality/shipClass/shipType、
 *   num(個数)、level(改修値)、requires/requiresType/requiresLevel/requiresNum/requiresNumType(併載装備と個数)、
 *   bonusSR/bonusAR/bonusAccR(対水上・対空・命中電探を載せているときの加算)。
 * 意味は kancolle-replay (MIT) `getBonusStats` に合わせた: shipS = `shipBase`、shipNationality = `shipCountry`、
 *   bonusSR/AR/AccR = 電探 (type2 12/13/93) の索敵≥5 / 対空≥2 / 命中≥8 を艦が装備しているとき。
 *   国籍コードは EO FitBonuses.json と replay の同一エントリの突き合わせで確認できた 1 JP 2 DE 3 IT 4 US 5 GB 6 FR 10 AU のみ。
 * 評価に必要な情報が無い場合 (`baseId`・`ctype`・電探の素の能力値が未指定、未知の国籍コード) は `skipped` に数えて加算しない。
 * [INFERENCE] 同一エントリ内で複数の bonuses が成立したら加算 (level/num の段階ボーナスは累積と解釈)。
 */
import type { EquipmentStats } from "../../sim-core/pkg/sim_core";

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
  requiresType?: number[];
  requiresNum?: number;
  requiresNumType?: number;
  bonus?: Partial<Record<FitKey, number>>;
  bonusSR?: Partial<Record<FitKey, number>>;
  bonusAR?: Partial<Record<FitKey, number>>;
  bonusAccR?: Partial<Record<FitKey, number>>;
}

export type FitKey = "houg" | "raig" | "tyku" | "souk" | "kaih" | "tais" | "saku" | "houm" | "baku" | "leng";

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
  /** 改装系列の元の艦 ID (`shipS` 用)。master の api_aftershipid を辿って求める。 */
  baseId?: number;
}
export interface FitEquip {
  masterId: number;
  /** api_type[2] */
  type2: number;
  improvement: number;
  /** 装備マスターの素の能力値。`bonusSR/AR/AccR` の電探判定に使う。 */
  saku?: number;
  tyku?: number;
  houm?: number;
}

export interface FitResult {
  bonus: Partial<Record<FitKey, number>>;
  /** 未対応条件のため評価できなかった bonus 定義の数 */
  skipped: number;
}

/** 艦の ctype から EO の国籍コード (kancolle-replay `country_ctype.json` 由来、確認できたコードのみ)。 */
const NATIONALITY_CTYPES: Record<number, number[]> = {
  1: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 49, 50, 51, 52, 53, 54, 56, 59, 60, 62, 66, 71, 72, 74, 75, 76, 77, 85, 86, 90, 94, 97, 100, 101, 103, 104, 109, 111, 115, 117, 119, 120, 123, 126, 127, 130, 132, 136],
  2: [47, 48, 55, 57, 63],
  3: [58, 61, 64, 68, 80, 92, 113, 124],
  4: [65, 69, 83, 84, 87, 91, 93, 95, 99, 102, 105, 106, 107, 110, 114, 116, 118, 121, 122, 125],
  5: [67, 78, 82, 88, 108, 112, 134, 135],
  6: [70, 79, 128, 129, 138, 139, 141],
  10: [96],
};
const RADAR_TYPES = [12, 13, 93];

const prevCache = new WeakMap<object, Map<number, number> | null>();

/**
 * 改装系列の元の艦 ID。api_aftershipid の前進リンク (より大きい ID への改装) を逆に辿る。
 * master に api_aftershipid が無ければ undefined (`shipS` は評価できない)。
 */
export const shipBaseId = (masterId: number, master: { ships: Record<number, { api_id: number; api_aftershipid?: string | number } | undefined> }): number | undefined => {
  let prev = prevCache.get(master.ships);
  if (prev === undefined) {
    prev = null;
    for (const m of Object.values(master.ships)) {
      if (!m) continue;
      const after = Number(m.api_aftershipid);
      if (!(after > m.api_id)) continue;
      prev ??= new Map();
      if (!prev.has(after) || m.api_id < prev.get(after)!) prev.set(after, m.api_id);
    }
    prevCache.set(master.ships, prev);
  }
  if (!prev) return undefined;
  let id = masterId;
  for (let guard = 0; prev.has(id) && guard < 10; guard++) id = prev.get(id)!;
  return id;
};

const has = (list: number[] | undefined, v: number | undefined) => v !== undefined && !!list?.includes(v);

export const computeFitBonus = (ship: FitShip, equips: FitEquip[], entries: FitEntry[]): FitResult => {
  const total: Partial<Record<FitKey, number>> = {};
  let skipped = 0;
  const add = (b: Partial<Record<FitKey, number>>) => {
    for (const [k, v] of Object.entries(b)) total[k as FitKey] = (total[k as FitKey] ?? 0) + (v ?? 0);
  };

  for (const entry of entries) {
    const matched = equips.filter((e) => has(entry.ids ?? undefined, e.masterId) || has(entry.types ?? undefined, e.type2));
    if (matched.length === 0) continue;

    for (const b of entry.bonuses) {
      if (b.shipS) {
        if (ship.baseId === undefined) {
          skipped++;
          continue;
        }
        if (!b.shipS.includes(ship.baseId)) continue;
      }
      if (b.shipNationality) {
        const own = Object.entries(NATIONALITY_CTYPES).find(([, ctypes]) => ship.ctype !== undefined && ctypes.includes(ship.ctype));
        if (!own) {
          skipped++;
          continue;
        }
        if (!b.shipNationality.includes(Number(own[0]))) continue;
      }
      if (b.shipX && !b.shipX.includes(ship.masterId)) continue;
      if (b.shipClass && !has(b.shipClass, ship.ctype)) continue;
      if (b.shipType && !b.shipType.includes(ship.stype)) continue;

      const level = b.level ?? 0;
      const count = matched.filter((e) => e.improvement >= level).length;
      if (count < (b.num ?? 1)) continue;

      if (b.requires || b.requiresType) {
        const others = equips.filter((e) => !matched.includes(e) && e.improvement >= (b.requiresLevel ?? 0));
        const ok =
          (!!b.requires && others.filter((e) => has(b.requires, e.masterId)).length >= (b.requiresNum ?? 1)) ||
          (!!b.requiresType && others.filter((e) => has(b.requiresType, e.type2)).length >= (b.requiresNumType ?? 1));
        if (!ok) continue;
      }
      if (b.bonus) add(b.bonus);
      if (b.bonusSR || b.bonusAR || b.bonusAccR) {
        const radars = equips.filter((e) => RADAR_TYPES.includes(e.type2));
        if (radars.some((e) => e.saku === undefined || e.tyku === undefined || e.houm === undefined)) {
          skipped++;
          continue;
        }
        if (b.bonusSR && radars.some((e) => e.saku! >= 5)) add(b.bonusSR);
        if (b.bonusAR && radars.some((e) => e.tyku! >= 2)) add(b.bonusAR);
        if (b.bonusAccR && radars.some((e) => e.houm! >= 8)) add(b.bonusAccR);
      }
    }
  }
  return { bonus: total, skipped };
};

/** master の略号 (houg…) を sim-core の EquipmentStats に変換する。 */
export const fitToEquipmentStats = (bonus: Partial<Record<FitKey, number>>): EquipmentStats => {
  const out: EquipmentStats = {};
  const map: [FitKey, keyof EquipmentStats][] = [
    ["houg", "firepower"], ["raig", "torpedo"], ["tyku", "antiAir"], ["souk", "armor"], ["kaih", "evasion"],
    ["tais", "asw"], ["saku", "los"], ["houm", "accuracy"], ["baku", "bombing"],
  ];
  for (const [from, to] of map) if (bonus[from]) out[to] = bonus[from];
  return out;
};
