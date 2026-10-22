/**
 * 機関部強化 (タービン・缶) による速力の計算。
 * 出典: wikiwiki「速力」(潜在艦速特性の表と各群の分類)、kcwiki「航速」。装備 ID は kancolle-replay `kcEQDATA.js`
 * (33 改良型艦本式タービン / 34 強化型艦本式缶 / 87 新型高温高圧缶)。群の分類は艦名に基づく近似で、
 * 一覧に無い艦は速力に応じた既定群 (高速 B2 / 低速 B) に入れ `guessed` を立てる。[unverified: 新艦・改装形態の漏れ]
 */
import type { PresetEquip, ShipMaster } from "./types";

type Group = "A" | "B1" | "B2" | "C" | "lowA" | "lowB" | "lowSpecialB" | "lowC" | "lowD" | "lowE";

const TURBINE = 33;
const ENHANCED_BOILER = 34;
const NEW_BOILER = 87;
const STAR_BOILER = 7;

/** [タービン, 新型缶, 強化缶, 新型缶は★7以上, A, B1, B2, C, 低A, 低B, 低C, 低D, 低E] (速力: 5 低速 / 10 高速 / 15 高速+ / 20 最速, 0 = 不可) */
const ROWS: [number, number, number, boolean, number[]][] = [
  [0, 1, 0, true, [15, 10, 10, 10, 5, 5, 5, 10, 10]],
  [0, 2, 0, true, [20, 10, 10, 10, 5, 5, 5, 10, 10]],
  [1, 0, 1, false, [15, 15, 15, 15, 10, 10, 10, 10, 10]],
  [1, 0, 2, false, [20, 15, 15, 15, 10, 10, 10, 10, 10]],
  [1, 0, 3, false, [20, 15, 20, 15, 10, 15, 10, 15, 10]],
  [1, 0, 4, false, [20, 15, 20, 15, 10, 15, 10, 0, 10]],
  [1, 1, 0, true, [20, 15, 15, 15, 15, 10, 10, 15, 15]],
  [1, 1, 0, false, [20, 15, 15, 15, 10, 10, 10, 15, 15]],
  [1, 1, 1, false, [20, 20, 15, 15, 15, 10, 10, 15, 15]],
  [1, 1, 2, false, [20, 20, 20, 15, 20, 15, 10, 15, 20]],
  [1, 1, 3, false, [20, 20, 20, 15, 20, 15, 10, 0, 20]],
  [1, 2, 0, true, [20, 20, 20, 15, 20, 15, 10, 15, 20]],
  [1, 2, 0, false, [20, 20, 20, 15, 15, 15, 10, 15, 20]],
  [1, 2, 1, false, [20, 20, 20, 15, 20, 15, 10, 15, 20]],
  [1, 2, 2, false, [20, 20, 20, 15, 20, 15, 10, 0, 20]],
  [1, 3, 0, false, [20, 20, 20, 15, 20, 15, 10, 15, 20]],
  [1, 3, 1, false, [20, 20, 20, 15, 20, 15, 10, 0, 20]],
  [1, 4, 0, false, [20, 20, 20, 15, 20, 15, 10, 0, 20]],
];
const GROUP_COL: Group[] = ["A", "B1", "B2", "C", "lowA", "lowB", "lowC", "lowD", "lowE"];

/** 艦名と素の速力から速力グループを引く。`guessed`: 一覧に無く既定群にした。 */
export const speedGroupOf = (m: ShipMaster): { group: Group; guessed: boolean } => {
  const name = m.api_name ?? "";
  const fast = (m.api_soku ?? 5) >= 10;
  const stype = m.api_stype ?? 0;
  if (fast) {
    if (name === "飛龍改三" || name === "天津風改二" || (name.startsWith("吹雪改三") && name.includes("護")) || /^(翔鶴|瑞鶴|大鳳|最上|三隈|鈴谷|熊野|利根|筑摩|島風|Ташкент|Vautour|Visby)/.test(name))
      return { group: "A", guessed: false };
    if (/^(蒼龍|飛龍|雲龍|天城|金剛|比叡|榛名|霧島|Iowa|大和改二|Algérie|北上改三|阿賀野|能代|矢矧|酒匂|天津風|吹雪改三)/.test(name))
      return { group: "B1", guessed: false };
    if (/^(加賀|Samuel\ B\.Roberts\ Mk\.II)/.test(name) || /^夕張改?$/.test(name) || stype === 16) return { group: "C", guessed: false };
    return { group: "B2", guessed: true };
  }
  if (name.startsWith("Samuel B.Roberts") || name === "夕張改二特") return { group: "lowSpecialB", guessed: false };
  if (/^(伊201|伊203|稲木改二)/.test(name)) return { group: "lowD", guessed: false };
  if (name.startsWith("鳳翔改二")) return { group: "lowE", guessed: false };
  if (/^(長門改二|陸奥改二|大和|武蔵)/.test(name)) return { group: "lowA", guessed: false };
  if (stype === 13 || stype === 14 || /^(Béarn|あきつ丸|明石|速吸)/.test(name)) return { group: "lowC", guessed: false };
  return { group: "lowB", guessed: true };
};

/** 艦と装備から機関部強化後の速力 (5/10/15/20) を返す。素の速力 `base` を下回らない。 */
export const boostedSpeed = (base: number, group: Group, equips: Pick<PresetEquip, "masterId" | "improvement">[]): number => {
  const turbines = equips.filter((e) => e.masterId === TURBINE).length;
  const boilers = equips.filter((e) => e.masterId === NEW_BOILER);
  const enhanced = equips.filter((e) => e.masterId === ENHANCED_BOILER).length;
  const t = turbines > 0 ? 1 : 0;
  const col = group === "lowSpecialB" ? 5 : GROUP_COL.indexOf(group);
  let best = group === "lowSpecialB" && t ? 10 : base;
  for (const [rt, rb, re, star, res] of ROWS) {
    if (t < rt) continue;
    const ok = star ? boilers.filter((b) => b.improvement >= STAR_BOILER).length >= rb : boilers.length >= rb && boilers.length + enhanced >= rb + re;
    if (ok && res[col] > best) best = res[col];
  }
  return best;
};

export const hasSpeedEquip = (equips: Pick<PresetEquip, "masterId">[]): boolean =>
  equips.some((e) => e.masterId === TURBINE || e.masterId === ENHANCED_BOILER || e.masterId === NEW_BOILER);

/** 手入力の艦の速力 (装備補正込み)。 */
export const shipBoostedSpeed = (m: ShipMaster, equips: Pick<PresetEquip, "masterId" | "improvement">[]): { value: number; guessed: boolean } => {
  const base = m.api_soku ?? 0;
  if (!hasSpeedEquip(equips)) return { value: base, guessed: false };
  const { group, guessed } = speedGroupOf(m);
  return { value: boostedSpeed(base, group, equips), guessed };
};
