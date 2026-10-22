/** 観測ログ表示用の日本語ラベル。 */
import type { AttackPhase, HitKind } from "./types";

export const PHASE_LABEL: Record<AttackPhase, string> = {
  air: "航空戦",
  opening_asw: "先制対潜",
  opening_torpedo: "開幕雷撃",
  shelling1: "砲撃1",
  shelling2: "砲撃2",
  shelling3: "砲撃3",
  closing_torpedo: "雷撃戦",
  night: "夜戦",
};

export const HIT_LABEL: Record<HitKind, string> = { miss: "ミス", hit: "命中", crit: "クリティカル" };

export const ENGAGEMENT_LABEL: Record<number, string> = {
  1: "同航戦",
  2: "反航戦",
  3: "T字有利",
  4: "T字不利",
};

export const FORMATION_ID_LABEL: Record<number, string> = {
  1: "単縦陣",
  2: "複縦陣",
  3: "輪形陣",
  4: "梯形陣",
  5: "単横陣",
  6: "警戒陣",
  11: "第一警戒",
  12: "第二警戒",
  13: "第三警戒",
  14: "第四警戒",
};

const KIND: [RegExp, string][] = [
  [/sp_midnight$/, "夜戦(開幕)"],
  [/midnight/, "夜戦"],
  [/night_to_day$/, "夜昼戦"],
  [/ld_airbattle$/, "長距離空襲"],
  [/ld_shooting$/, "長距離レーダー射撃"],
  [/airbattle$/, "航空戦"],
  [/ec_battle$/, "対連合"],
  [/battle_water$/, "水上部隊"],
  [/battle$/, "昼戦"],
];

/** `api_req_sortie/battle` などのパスから戦闘種別を返す。 */
export const battleKindLabel = (path: string): string => {
  const base = KIND.find(([re]) => re.test(path))?.[1] ?? path.split("/").pop() ?? path;
  return path.startsWith("api_req_combined_battle/") ? `連合 ${base}` : base;
};
