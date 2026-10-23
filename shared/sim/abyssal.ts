/**
 * 深海棲艦のメカニクス用フラグ (サーバの ships.flags = kancolle-replay kcSHIPDATA のキー) を
 * sim-core の ShipInput に変換する。陸上型・PT 小鬼群・集積地・特効対象 (夏姫等)・夜戦攻撃・先制対潜。
 * あわせて、隠しステータスの推定値が無い艦の代替値 (艦種別の中央値) を返す。
 */
import type { InstallationKind, ShipInput, TargetGroup } from "../../sim-core/pkg/sim_core";

/** kcSHIPDATA `installtype` 1..6 */
const INSTALLATION_KIND: Record<number, InstallationKind> = {
  1: "softSkinned",
  2: "artillery",
  3: "supplyDepot",
  4: "isolatedIsland",
  5: "northernmost",
  6: "harbourSummer",
};

const TARGET_GROUP: [string, TargetGroup][] = [
  ["isSummerBB", "summerBattleship"],
  ["isSummerCA", "summerHeavyCruiser"],
  ["isSummerCV", "summerCarrier"],
  ["isFrenchBB", "frenchBattleship"],
  ["isEuroWP", "europeanPrincess"],
  ["isAnchorage", "anchorage"],
  ["isDock", "dock"],
];

export type AbyssalTraits = Pick<
  ShipInput,
  "installationKind" | "ptImp" | "supplyDepot" | "divebombWeak" | "lbWeak" | "targetGroup" | "nightAttacker" | "alwaysOpeningAsw"
>;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** ships.flags (kcSHIPDATA の追加キー) → ShipInput のフラグ。該当が無いキーは付けない。 */
export const abyssalTraits = (flags: unknown): AbyssalTraits => {
  if (!flags || typeof flags !== "object") return {};
  const f = flags as Record<string, unknown>;
  const out: AbyssalTraits = {};
  const kind = INSTALLATION_KIND[num(f.installtype) ?? 0];
  if (kind) out.installationKind = kind;
  if (f.isPT === true) out.ptImp = true;
  if (f.isSupplyDepot === true) out.supplyDepot = true;
  const dbw = num(f.divebombWeak);
  if (dbw !== undefined && dbw !== 1) out.divebombWeak = dbw;
  const lbw = num(f.LBWeak);
  if (lbw !== undefined && lbw !== 1) out.lbWeak = lbw;
  const group = TARGET_GROUP.find(([k]) => f[k] === true);
  if (group) out.targetGroup = group[1];
  // nightattack 1..3: 夜戦で通常攻撃する空母 (3 は kcsim では探照灯がある時だけ水上艦を狙うが、未対応で 1 と同じ扱い)
  if ((num(f.nightattack) ?? 0) > 0) out.nightAttacker = true;
  if (f.alwaysOASW === true) out.alwaysOpeningAsw = true;
  return out;
};

/**
 * 隠しステータス (回避, 対潜, 索敵, 運) の推定値が無いときの代替値: kcSHIPDATA の深海棲艦を
 * 艦種 (api_stype) と HP 150 以上 (姫・鬼級) で分けた中央値 (2026-10 時点、912 隻)。
 */
const HIDDEN_FALLBACK: Record<string, [ev: number, asw: number, los: number, luck: number]> = {
  "2:0": [70, 85, 20, 60],
  "2:1": [100, 100, 90, 100],
  "3:0": [28, 70, 20, 10],
  "3:1": [95, 88, 90, 100],
  "4:0": [30, 40, 10, 10],
  "5:0": [50, 0, 48, 20],
  "5:1": [100, 0, 80, 90],
  "6:0": [15, 0, 0, 60],
  "6:1": [100, 0, 100, 120],
  "7:0": [40, 30, 40, 30],
  "7:1": [55, 90, 100, 100],
  "8:0": [37, 0, 80, 20],
  "8:1": [100, 0, 100, 100],
  "9:0": [9, 0, 20, 50],
  "9:1": [50, 0, 100, 90],
  "10:0": [5, 0, 10, 1],
  "10:1": [25, 0, 90, 70],
  "11:0": [45, 0, 50, 30],
  "11:1": [80, 0, 100, 100],
  "13:0": [20, 0, 20, 50],
  "13:1": [49, 0, 40, 80],
  "15:0": [6, 0, 0, 10],
  "15:1": [40, 0, 10, 40],
  "16:1": [63, 98, 120, 85],
  "18:0": [59, 0, 89, 8],
  "18:1": [75, 0, 100, 120],
};

export const HIDDEN_FALLBACK_SOURCE = "fallback:stype-median";

/** 艦種と最大 HP からの代替値 [回避, 対潜, 索敵, 運]。表に無い艦種はもう一方の HP 区分、それも無ければ null */
export const hiddenFallback = (stype: number, maxHp: number): [number, number, number, number] | null => {
  const boss = maxHp >= 150 ? 1 : 0;
  return HIDDEN_FALLBACK[`${stype}:${boss}`] ?? HIDDEN_FALLBACK[`${stype}:${1 - boss}`] ?? null;
};
