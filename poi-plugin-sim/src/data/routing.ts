/** ROUTING_DSL (docs/ROUTING_DSL.md) を日本語の説明に変換する。表示専用の純粋関数。 */
import type { Predicate, Rule } from "./types";

const TYPE_NAME: Record<string, string> = {
  DE: "海防艦", DD: "駆逐艦", CL: "軽巡", CLT: "重雷装巡洋艦", CA: "重巡", CAV: "航空巡洋艦",
  CVL: "軽空母", FBB: "高速戦艦", BB: "低速戦艦", BBV: "航空戦艦", CV: "正規空母", XBB: "超弩級戦艦",
  SS: "潜水艦", SSV: "潜水空母", AP: "補給艦", AV: "水上機母艦", LHA: "揚陸艦", CVB: "装甲空母",
  AR: "工作艦", AS: "潜水母艦", CT: "練習巡洋艦", AO: "給油艦",
  BB_CLASS: "戦艦級", BATTLESHIP: "戦艦(航戦除く)", CV_CLASS: "空母系", STD_CV: "正規空母(装甲含む)",
  CA_CLASS: "重巡級", CL_CT: "軽巡+練巡", CL_CLASS: "軽巡級", DD_DE: "駆逐+海防", SS_CLASS: "潜水系",
};

const SPEED_NAME: Record<string, string> = { slow: "低速", fast: "高速", fastPlus: "高速+", fastest: "最速" };
const FLEET_TYPE_NAME: Record<string, string> = {
  single: "通常艦隊", ctf: "空母機動部隊", stf: "水上打撃部隊", tcf: "輸送護衛部隊", striking: "遊撃部隊",
};
const DIFFICULTY_NAME: Record<number, string> = { 0: "通常", 1: "丁", 2: "丙", 3: "乙", 4: "甲" };
const EQUIP_GROUP_NAME: Record<string, string> = {
  RADAR: "電探", SURFACE_RADAR: "水上電探(索敵5以上)", DRUM: "ドラム缶", LANDING_CRAFT: "上陸用舟艇", SONAR: "ソナー",
};
const FLEET_NAME: Record<string, string> = { main: "本隊", escort: "護衛隊", all: "" };

const OPS: [string, string][] = [
  ["eq", "="], ["ne", "≠"], ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"],
];

export const typeNames = (types: unknown): string =>
  (Array.isArray(types) ? types : [types]).map((t) => TYPE_NAME[String(t)] ?? String(t)).join("・");

const value = (metric: string | undefined, v: unknown): string => {
  if (metric === "speed" && typeof v === "string") return SPEED_NAME[v] ?? v;
  if (metric === "speed" && typeof v === "number") return SPEED_NAME[{ 5: "slow", 10: "fast", 15: "fastPlus", 20: "fastest" }[v] ?? ""] ?? String(v);
  if (metric === "fleetType") return FLEET_TYPE_NAME[String(v)] ?? String(v);
  if (metric === "difficulty" && typeof v === "number") return DIFFICULTY_NAME[v] ?? String(v);
  if (metric === "flagship") return typeNames(v);
  return String(v);
};

/** `eq`, `gte` … を「≥ 2」のように並べる。boolean 指標で演算子が無ければ空文字。 */
const comparison = (p: Predicate): string => {
  const parts: string[] = [];
  for (const [key, sym] of OPS) {
    if (p[key] !== undefined) parts.push(`${sym} ${value(p.m, p[key])}`);
  }
  if (Array.isArray(p.in)) parts.push(`∈ {${p.in.map((v) => value(p.m, v)).join(", ")}}`);
  return parts.join(" ");
};

const equipSelector = (e: any): string => {
  if (!e || typeof e !== "object") return "装備";
  if (e.group) return EQUIP_GROUP_NAME[e.group] ?? String(e.group);
  if (Array.isArray(e.types)) return `装備種別[${e.types.join(",")}]${e.minLos ? ` (索敵${e.minLos}以上)` : ""}`;
  if (Array.isArray(e.ids)) return `装備ID[${e.ids.join(",")}]`;
  return "装備";
};

const leaf = (p: Predicate): string => {
  const cmp = comparison(p);
  const fleet = p.fleet && p.fleet !== "all" ? `${FLEET_NAME[String(p.fleet)] ?? p.fleet}の` : "";
  switch (p.m) {
    case "ships": return `${fleet}艦数 ${cmp}`;
    case "count": {
      const speed = p.maxSpeed ? `${SPEED_NAME[String(p.maxSpeed)] ?? p.maxSpeed}以下の` : "";
      return `${fleet}${speed}${typeNames(p.types)} ${cmp}`;
    }
    case "onlyTypes": return `${fleet}${typeNames(p.types)}のみ${p.eq === false ? "ではない" : ""}`;
    case "countIds": return `${fleet}指定艦(${Array.isArray(p.ids) ? p.ids.length : "?"}種) ${cmp}`;
    case "equipShips": return `${equipSelector(p.equip)}装備艦 ${cmp}`;
    case "equipCount": return `${equipSelector(p.equip)}総数 ${cmp}`;
    case "speed": return `速力 ${cmp}`;
    case "los": return `索敵(Cn${p.cn}) ${cmp}`;
    case "fleetType": return `艦隊種別 ${cmp}`;
    case "flagship": return `旗艦 ${cmp}`;
    case "difficulty": return `難易度 ${cmp}`;
    case "phase": return `フェーズ ${cmp}`;
    case "gauge": return `ゲージ ${cmp}`;
    case "hq": return `司令部Lv ${cmp}`;
    case "visited": return `${p.node} 通過済み${p.eq === false ? "でない" : ""}`;
    case "flag": return `フラグ「${p.name}」${p.eq === false ? "が無効" : ""}`;
    default: return `${p.m ?? "?"} ${cmp}`;
  }
};

export const describePredicate = (p: Predicate, nested = false): string => {
  if (p.all) {
    const s = p.all.map((c) => describePredicate(c, true)).join(" かつ ");
    return nested ? `(${s})` : s;
  }
  if (p.any) {
    const s = p.any.map((c) => describePredicate(c, true)).join(" または ");
    return nested ? `(${s})` : s;
  }
  if (p.not) return `(${describePredicate(p.not, true)}) ではない`;
  return leaf(p).trim();
};

const percent = (p: number) => `${Math.round(p * 1000) / 10}%`;

export interface RuleView {
  /** 条件の説明。無条件なら null (「上記以外」) */
  condition: string | null;
  /** 行き先の説明 (ネストの場合は空) */
  action: string;
  targets: string[];
  uncertain: boolean;
  note?: string;
  children: RuleView[];
}

export const describeRule = (rule: Rule): RuleView => {
  const view: RuleView = {
    condition: rule.when ? describePredicate(rule.when) : null,
    action: "",
    targets: [],
    uncertain: !!rule.uncertain,
    note: rule.note,
    children: [],
  };
  if (rule.to) {
    view.action = `→ ${rule.to}`;
    view.targets = [rule.to];
  } else if (rule.random) {
    view.action = `ランダム: ${rule.random.map((r) => `${r.to} ${percent(r.p)}`).join(" / ")}`;
    view.targets = rule.random.map((r) => r.to);
  } else if (rule.los) {
    const l = rule.los;
    const bands = l.thresholds.map((t) => `≥ ${t.min} → ${t.to}`);
    view.action = `索敵(Cn${l.cn}) ${bands.join(" / ")} / 未満 → ${l.below}${
      l.interpolate === false ? "" : " (線形補間)"
    }`;
    view.targets = [...l.thresholds.map((t) => t.to), l.below];
  } else if (rule.select) {
    view.action = `プレイヤー選択: ${rule.select.join(" / ")}`;
    view.targets = [...rule.select];
  } else if (rule.rules) {
    view.children = rule.rules.map(describeRule);
    view.targets = view.children.flatMap((c) => c.targets);
  }
  view.targets = [...new Set(view.targets)];
  return view;
};

export const countUncertain = (views: RuleView[]): number =>
  views.reduce((n, v) => n + (v.uncertain ? 1 : 0) + countUncertain(v.children), 0);

export const FORMATION_NAME: Record<number, string> = {
  1: "単縦陣", 2: "複縦陣", 3: "輪形陣", 4: "梯形陣", 5: "単横陣", 6: "警戒陣",
  11: "第一警戒", 12: "第二警戒", 13: "第三警戒", 14: "第四警戒",
};
