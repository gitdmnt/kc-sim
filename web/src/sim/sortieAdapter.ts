/** プリセット + 海域データ → sim-core の SortieInput。 */
import type {
  EnemyComp as SimComp,
  Formation,
  GaugeInput,
  LandBase,
  NightPolicy,
  RetreatPolicy,
  RoutingDocument,
  SortieInput,
  SortieMap,
  SortieNode,
} from "@sim-core";
import type { MapData } from "../data/mapData";
import type { EnemyCompSet, RoutingDoc, Rule, Predicate } from "@shared/data/types";
import type { MasterData, Preset } from "@shared/fleet/types";
import { buildEnemyShips, buildFriendShips, buildSquadrons, enemyFormationOf, friendFleet, isCombinedFormation } from "@shared/sim/adapter";
import type { BuildEnemyOptions, EnemyBuild, EnemyLookup, FriendBuild } from "@shared/sim/adapter";
import type { FitEntry } from "@shared/sim/fit";

/** 指定難易度の最新セットを選ぶ。無ければ最も高い難易度に代替 (fallback=true)。 */
export const pickSet = (sets: EnemyCompSet[], difficulty: number): { set: EnemyCompSet; fallback: boolean } | undefined => {
  const newest = (d: number) => sets.filter((s) => s.difficulty === d).sort((a, b) => b.retrievedAt.localeCompare(a.retrievedAt))[0];
  const exact = newest(difficulty);
  if (exact) return { set: exact, fallback: false };
  const diffs = [...new Set(sets.map((s) => s.difficulty))].sort((a, b) => b - a);
  return diffs.length ? { set: newest(diffs[0]), fallback: true } : undefined;
};

/** 編成データの出典表示: 自分たちの観測は「観測 (n=…)」、KCNav は「KCNav」。 */
export const compSourceLabel = (set: Pick<EnemyCompSet, "source" | "totalCount">): string =>
  set.source === "poi-observed" ? `観測 (n=${set.totalCount.toLocaleString()})` : set.source === "kcnav" ? "KCNav" : set.source;

/** 海域データ (API・静的バンドル) から敵艦の情報を引く。 */
export const mapLookup = (data: Pick<MapData, "ships" | "equips">): EnemyLookup => ({
  ship: (id) => data.ships.get(id)?.ship,
  equip: (id) => data.equips.get(id),
  detail: (id) => data.ships.get(id),
});

export const toSimComps = (
  set: EnemyCompSet,
  data: Pick<MapData, "ships" | "equips">,
  opts: BuildEnemyOptions = {}
): { comps: SimComp[]; builds: EnemyBuild[] } => {
  const lookup = mapLookup(data);
  const builds = set.comps.map((c) => buildEnemyShips(c.main, lookup, opts));
  return {
    builds,
    comps: set.comps.map((c, i) => ({ weight: c.weight, fleet: { ships: builds[i].input, formation: enemyFormationOf(c) } })),
  };
};

// ---- ルーティング文書の走査 (設定 UI 用) ----

export const startNodes = (doc: RoutingDoc | null): string[] => {
  const s = Object.keys(doc?.nodes ?? {}).filter((k) => /^Start\d*$/.test(k));
  return s.length ? s : ["Start"];
};

/** 出撃地点を艦隊から決める規則 (`start.rules`) を持つ海域か。 */
export const hasStartRules = (doc: RoutingDoc | null): boolean => !!doc?.start?.rules.length;

const walkRules = (rules: Rule[] | undefined, f: (r: Rule) => void) => {
  for (const r of rules ?? []) {
    f(r);
    walkRules(r.rules, f);
  }
};
const walkPredicate = (p: Predicate | undefined, f: (leaf: Predicate) => void) => {
  if (!p) return;
  if (p.all) p.all.forEach((c) => walkPredicate(c, f));
  else if (p.any) p.any.forEach((c) => walkPredicate(c, f));
  else if (p.not) walkPredicate(p.not, f);
  else f(p);
};

/** 能動分岐 (select) ノードとその選択肢。 */
export const selectNodes = (doc: RoutingDoc | null): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const [letter, node] of Object.entries(doc?.nodes ?? {})) {
    walkRules(node.rules, (r) => {
      if (r.select) out[letter] = [...new Set([...(out[letter] ?? []), ...r.select])];
    });
  }
  return out;
};

/** ルールが参照するフラグ名 (既定値つき)。 */
export const flagNames = (doc: RoutingDoc | null): { name: string; default: boolean }[] => {
  const names = new Set<string>(doc?.defaults?.flags ?? []);
  for (const node of Object.values(doc?.nodes ?? {})) {
    walkRules(node.rules, (r) =>
      walkPredicate(r.when, (leaf) => {
        if (leaf.m === "flag" && typeof leaf.name === "string") names.add(leaf.name);
      })
    );
  }
  const defaults = new Set(doc?.defaults?.flags ?? []);
  return [...names].sort().map((name) => ({ name, default: defaults.has(name) }));
};

/** `uncertain` なルールを持つノード (経路の信頼性表示用)。 */
export const uncertainNodes = (doc: RoutingDoc | null): Set<string> => {
  const out = new Set<string>();
  for (const [letter, node] of Object.entries(doc?.nodes ?? {})) {
    walkRules(node.rules, (r) => r.uncertain && out.add(letter));
  }
  return out;
};

// ---- 入力の組み立て ----

export interface SortieSettings {
  /** 出撃地点。省略時は sim-core が決める (`start.rules` があれば艦隊から、無ければ "Start")。 */
  start?: string;
  /** 目標マス: そこで出撃を終え、主要率 (boss.*) をそのマスで数える。省略はボス */
  target?: string;
  selects: Record<string, string>;
  flags: Record<string, boolean>;
  difficulty: number;
  phase?: number;
  gauge?: number;
  night: NightPolicy;
  retreat: RetreatPolicy;
  /** ノード → 陣形。未指定は自動。艦隊の種類 (通常 / 連合) に合わない陣形は自動に戻す */
  formations: Record<string, Formation>;
  gaugeInput?: { kind: "kill" | "hp"; remaining: number; finalSet?: EnemyCompSet; finalThreshold?: number };
  hqLevel: number;
  applyFit: boolean;
}

export interface SortieBuild {
  input: SortieInput;
  warnings: string[];
  friend: FriendBuild;
  enemyBuilds: EnemyBuild[];
  uncertain: Set<string>;
  /** ノード → シミュレーションに使った編成セット (出典表示用) */
  compSets: Record<string, EnemyCompSet>;
}

export const buildSortieInput = (
  preset: Preset,
  master: MasterData,
  data: MapData,
  s: SortieSettings,
  opts: BuildEnemyOptions & { fitBonuses?: FitEntry[]; topPaths?: number } = {}
): SortieBuild => {
  const warnings: string[] = [];
  const routing = data.detail.routing;
  if (!routing) throw new Error("この海域のルーティングルールは未登録です");

  const friend = buildFriendShips(preset, master, { fitBonuses: opts.fitBonuses, applyFit: s.applyFit });
  if (friend.input.length === 0) throw new Error("味方艦がいません");
  if (friend.combined && (friend.escort?.length ?? 0) === 0) throw new Error("随伴艦隊に艦がいません");

  const enemyBuilds: EnemyBuild[] = [];
  const compSets: Record<string, EnemyCompSet> = {};
  const nodes: Record<string, SortieNode> = {};
  for (const n of data.detail.nodes) {
    nodes[n.letter] = { kind: (n.type ?? undefined) as SortieNode["kind"], boss: n.isBoss };
    const sets = data.comps[n.letter];
    if (!sets?.length) continue;
    const picked = pickSet(sets, s.difficulty);
    if (!picked) continue;
    if (picked.fallback) warnings.push(`ノード ${n.letter}: 難易度 ${s.difficulty} の編成が無く、難易度 ${picked.set.difficulty} で代替`);
    const { comps, builds } = toSimComps(picked.set, data, opts);
    nodes[n.letter].comps = comps;
    compSets[n.letter] = picked.set;
    enemyBuilds.push(...builds);
  }

  const bossNode = data.detail.nodes.find((n) => n.isBoss)?.letter;
  const noComps = data.detail.nodes.filter((n) => ["battle", "boss", "night_battle", "air_battle", "air_raid"].includes(n.type ?? "") && !nodes[n.letter].comps);
  if (noComps.length) warnings.push(`敵編成データが無いため空きマス扱い: ${noComps.map((n) => n.letter).join(", ")}`);
  if (bossNode && !nodes[bossNode]?.comps) warnings.push("ボスマスの敵編成データがありません");

  let gauge: GaugeInput | undefined;
  if (s.gaugeInput) {
    gauge = { kind: s.gaugeInput.kind, remaining: s.gaugeInput.remaining };
    if (s.gaugeInput.kind === "hp") {
      if (s.gaugeInput.finalSet) gauge.finalComps = toSimComps(s.gaugeInput.finalSet, data, opts).comps;
      if (s.gaugeInput.finalThreshold) gauge.finalThreshold = s.gaugeInput.finalThreshold;
    }
  }

  // 基地航空隊: 出撃の隊のうち、この海域のマスを目標にした波だけ
  const lbas: LandBase[] = (preset.lbas ?? []).flatMap((b, i) => {
    if (b.mode !== "sortie") return [];
    const targets = b.targets.filter((t) => Object.hasOwn(nodes, t));
    const squadrons = buildSquadrons(b, master);
    if (targets.length === 0 || squadrons.length === 0) {
      warnings.push(`第${i + 1}基地航空隊: ${squadrons.length === 0 ? "中隊がありません" : "この海域の目標マスが未設定"} (出撃しません)`);
      return [];
    }
    return [{ squadrons, targets }];
  });
  const combined = !!friend.combined;
  const formations = Object.fromEntries(Object.entries(s.formations).filter(([, f]) => isCombinedFormation(f) === combined));

  const map: SortieMap = { routing: routing as unknown as RoutingDocument, nodes };
  const input: SortieInput = {
    friend: friendFleet(friend),
    hqLevel: s.hqLevel,
    map,
    config: {
      ...(s.start ? { start: s.start } : {}),
      ...(s.target ? { target: s.target } : {}),
      selects: s.selects,
      flags: s.flags,
      difficulty: s.difficulty,
      ...(s.phase !== undefined ? { phase: s.phase } : {}),
      ...(s.gauge !== undefined ? { gauge: s.gauge } : {}),
    },
    policy: { night: s.night, retreat: s.retreat, formations },
    topPaths: opts.topPaths ?? 200,
    ...(gauge ? { gauge } : {}),
    ...(lbas.length > 0 ? { lbas } : {}),
  };
  return { input, warnings: [...warnings, ...friend.warnings], friend, enemyBuilds, uncertain: uncertainNodes(routing), compSets };
};
