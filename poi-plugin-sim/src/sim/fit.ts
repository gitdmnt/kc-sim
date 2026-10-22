/**
 * 装備ボーナス (fit bonus) の計算。データは data API `/api/v1/fit-bonuses`
 * (kancolle-replay `mst_slotitem_bonus.json` 形式) をそのまま使う。
 *
 * 対応する条件: 装備 ids/types、艦 shipX(マスターID)/shipClass/shipType、num(個数)、level(改修値)、
 *   requires/requiresType/requiresLevel(併載装備)。
 * [INFERENCE] 同一エントリ内で複数の bonuses が成立したら加算 (level/num の段階ボーナスは累積と解釈)。
 * 未対応: shipS・shipNationality・requiresNum(Type)・bonusSR/AR/AccR のみのエントリ。
 *   これらは `skipped` として数えるだけで加算しない。結果は本物のゲーム内の値と一致するとは限らない。
 */
import type { EquipmentStats } from "@sim-core";

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
  bonusSR?: unknown;
  bonusAR?: unknown;
  bonusAccR?: unknown;
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
}
export interface FitEquip {
  masterId: number;
  /** api_type[2] */
  type2: number;
  improvement: number;
}

export interface FitResult {
  bonus: Partial<Record<FitKey, number>>;
  /** 未対応条件のため評価できなかった bonus 定義の数 */
  skipped: number;
}

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
      if (b.shipS || b.shipNationality || b.requiresNum !== undefined || b.requiresNumType !== undefined || (!b.bonus && (b.bonusSR || b.bonusAR || b.bonusAccR))) {
        skipped++;
        continue;
      }
      if (b.shipX && !b.shipX.includes(ship.masterId)) continue;
      if (b.shipClass && !has(b.shipClass, ship.ctype)) continue;
      if (b.shipType && !b.shipType.includes(ship.stype)) continue;

      const level = b.level ?? 0;
      const count = matched.filter((e) => e.improvement >= level).length;
      if (count < (b.num ?? 1)) continue;

      if (b.requires || b.requiresType) {
        const others = equips.filter((e) => !matched.includes(e));
        const ok = others.some(
          (e) =>
            (has(b.requires, e.masterId) || has(b.requiresType, e.type2)) && e.improvement >= (b.requiresLevel ?? 0)
        );
        if (!ok) continue;
      }
      if (b.bonus) add(b.bonus);
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
