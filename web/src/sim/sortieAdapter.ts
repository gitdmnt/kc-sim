/** プリセット + 海域データ → sim-core の SortieInput。 */
import type {
  EnemyComp as SimComp,
  FleetInput,
  Formation,
  GaugeMorale,
  Advance,
  LandBase,
  NightPolicy,
  RepairPolicy,
  ResourceAmounts,
  RetreatPolicy,
  RoutingDocument,
  SortieBaseRaid,
  SortieInput,
  SortieMap,
  SortieNode,
} from "@sim-core";
import type { MapData } from "../data/mapData";
import { describeRule } from "../data/routing";
import type { EnemyCompSet, NodeType, RoutingDoc, Rule, Predicate } from "@shared/data/types";
import type { MasterData, Preset, PresetAirBase } from "@shared/fleet/types";
import { buildEnemyFleet, buildFriendShips, buildSquadrons, friendFleet, isCombinedFormation } from "@shared/sim/adapter";
import type { BuildEnemyOptions, EnemyBuild, EnemyLookup, FriendBuild, FriendOptions } from "@shared/sim/adapter";
import { bonusAt, buildBonuses, debuffsAt } from "@shared/sim/bonuses";
import type { AccEvaMode, EventBonusResponse } from "@shared/sim/bonuses";
import type { FitEntry } from "@shared/sim/fit";
import { isBalloonNode } from "@shared/sim/nodeEffects";
import { applyNodeEffects, buildGauge } from "./sortieOptions";
import type { GaugeSettings, NodeEffect } from "./sortieOptions";

/** イベント特効の入力 (`GET /maps/{map}/bonuses` の応答と設定)。 */
export interface EventBonusSettings {
  response: EventBonusResponse;
  /** 推測値 (`unconfirmed`) も使う */
  unconfirmed?: boolean;
  accEva?: AccEvaMode;
  /** 装甲破砕 (デバフ) 済みとして敵の装甲を下げる */
  debuff: boolean;
}

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

/** 敵編成 → sim-core。随伴のある編成は敵連合艦隊 (主力 + 随伴) */
export const toSimComps = (
  set: EnemyCompSet,
  data: Pick<MapData, "ships" | "equips">,
  opts: BuildEnemyOptions = {}
): { comps: SimComp[]; builds: EnemyBuild[] } => {
  const lookup = mapLookup(data);
  const built = set.comps.map((c) => buildEnemyFleet(c, lookup, opts));
  return { builds: built.map((b) => b.build), comps: set.comps.map((c, i) => ({ weight: c.weight, fleet: built[i].fleet })) };
};

/** 戦闘のあるマスの種類 (API の nodes[].type) */
export const BATTLE_NODE_TYPES: NodeType[] = ["battle", "boss", "night_battle", "air_battle", "air_raid", "night_to_day"];

/** 支援艦隊・友軍艦隊のプリセットの欄と、警告に付ける艦隊名 */
export const EXTRA_FLEETS = { supportNode: "道中支援", supportBoss: "決戦支援", friendFleet: "友軍" } as const;
export type ExtraFleetKey = keyof typeof EXTRA_FLEETS;

/** プリセットの支援艦隊・友軍艦隊 → sim-core の艦隊 (通常艦隊)。艦がいなければ null で、`warnings` に理由を足す */
export const extraFleet = (preset: Preset, key: ExtraFleetKey, master: MasterData, opts: FriendOptions, warnings: string[]): FleetInput | null => {
  const ships = preset[key] ?? [];
  if (ships.length === 0) {
    warnings.push(`${EXTRA_FLEETS[key]}艦隊に艦がいません (来ません)`);
    return null;
  }
  const b = buildFriendShips({ ...preset, fleetType: "single", ships }, master, { ...opts, prefix: EXTRA_FLEETS[key] });
  warnings.push(...b.warnings);
  return { ships: b.input };
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

/**
 * 出撃に渡す能動分岐の選択 (ノード → 行き先)。保存した選択が今の選択肢にあればそれ。無ければ既定
 * (`defaults.select` → 先頭) だが、目標マスがあって既定の行き先から届かないときは届く最初の選択肢にする。
 */
export const resolveSelects = (doc: RoutingDoc | null, saved: Record<string, string>, target?: string): Record<string, string> => {
  const next = new Map(Object.entries(doc?.nodes ?? {}).map(([n, node]) => [n, (node.rules ?? []).flatMap((r) => describeRule(r).targets)]));
  // 選択ノード自身には戻らない (戻っても同じ選択になる)
  const reaches = (from: string, node: string) => {
    const seen = new Set([node, from]);
    for (const n of seen) {
      if (n === target) return true;
      if (n !== node) next.get(n)?.forEach((m) => seen.add(m));
    }
    return false;
  };
  const out: Record<string, string> = {};
  for (const [node, options] of Object.entries(selectNodes(doc))) {
    const preset = doc?.defaults?.select?.[node];
    const fallback = preset && options.includes(preset) ? preset : options[0];
    out[node] = options.includes(saved[node])
      ? saved[node]
      : target && !reaches(fallback, node)
        ? (options.find((o) => reaches(o, node)) ?? fallback)
        : fallback;
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
  gaugeInput?: GaugeSettings;
  /** マス → 撤退 / 強行 (無いマスは retreat に従う)。海域に無いマスは無視 */
  advance?: Record<string, Advance>;
  /** 洋上補給・戦闘糧食を使う (省略は使う) */
  underway?: boolean;
  rations?: boolean;
  /** 煙幕を試みるマス (1 出撃 1 回)。海域に無いマスは無視 */
  smoke?: string[];
  /** マス → 資源・渦潮の効果 */
  nodeEffects?: Record<string, NodeEffect>;
  repair?: RepairPolicy;
  /** エンジンが数えない費用 (ほかの艦隊の遠征など、1 出撃あたり)。支援艦隊の費用はエンジンが数える */
  extraPerSortie?: ResourceAmounts;
  /** 連続出撃 (士気を出撃間で持ち越す) */
  consecutive?: GaugeMorale;
  hqLevel: number;
  applyFit: boolean;
  /** 支援艦隊を出すか (道中 = 目標マス以外の戦闘マス、決戦 = 目標マス)。艦はプリセットの supportNode / supportBoss */
  support?: { node: boolean; boss: boolean };
  /** 友軍艦隊 (プリセットの friendFleet): 来る確率 0..1 と来るマス (空は目標マス) */
  friendFleet?: { chance: number; nodes: string[] };
  /** 基地空襲: `node` に着いたとき確率 `chance` (0..1) で、`compNode` の敵編成が基地を空襲する */
  baseRaid?: { node: string; chance: number; compNode: string };
}

export interface SortieBuild {
  input: SortieInput;
  warnings: string[];
  friend: FriendBuild;
  enemyBuilds: EnemyBuild[];
  uncertain: Set<string>;
  /** ノード → シミュレーションに使った編成セット (出典表示用) */
  compSets: Record<string, EnemyCompSet>;
  /** input.lbas の各基地の番号 (第n基地)。基地空襲の被害の表示用 */
  baseNumbers: number[];
}

export const buildSortieInput = (
  preset: Preset,
  master: MasterData,
  data: MapData,
  s: SortieSettings,
  opts: BuildEnemyOptions & { fitBonuses?: FitEntry[]; topPaths?: number; eventBonus?: EventBonusSettings } = {}
): SortieBuild => {
  const warnings: string[] = [];
  const routing = data.detail.routing;
  if (!routing) throw new Error("この海域のルーティングルールは未登録です");

  const friendOpts: FriendOptions = { fitBonuses: opts.fitBonuses, applyFit: s.applyFit };
  const friend = buildFriendShips(preset, master, friendOpts);
  if (friend.input.length === 0) throw new Error("味方艦がいません");
  if (friend.combined && (friend.escort?.length ?? 0) === 0) throw new Error("随伴艦隊に艦がいません");

  const enemyBuilds: EnemyBuild[] = [];
  const compSets: Record<string, EnemyCompSet> = {};
  const nodes: Record<string, SortieNode> = {};
  for (const n of data.detail.nodes) {
    nodes[n.letter] = {
      kind: (n.type === "night_to_day" ? "nightToDay" : (n.type ?? undefined)) as SortieNode["kind"],
      boss: n.isBoss,
      ...(typeof n.lbasDistance === "number" ? { lbasDistance: n.lbasDistance } : {}),
    };
    if (isBalloonNode(data.detail.map.world, data.detail.map.no, n.letter)) nodes[n.letter].balloons = true;
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
  const noComps = data.detail.nodes.filter((n) => BATTLE_NODE_TYPES.includes(n.type) && !nodes[n.letter].comps);
  if (noComps.length) warnings.push(`敵編成データが無いため空きマス扱い: ${noComps.map((n) => n.letter).join(", ")}`);
  if (bossNode && !nodes[bossNode]?.comps) warnings.push("ボスマスの敵編成データがありません");

  if (s.nodeEffects) applyNodeEffects(nodes, s.nodeEffects);
  const gauge = s.gaugeInput && buildGauge(s.gaugeInput, (set) => toSimComps(set, data, opts).comps);
  const advance = Object.fromEntries(Object.entries(s.advance ?? {}).filter(([l]) => Object.hasOwn(nodes, l)));
  const smoke = (s.smoke ?? []).filter((l) => Object.hasOwn(nodes, l));

  // 基地空襲: 空襲する編成は選んだマスの敵編成
  const raid = s.baseRaid && Object.hasOwn(nodes, s.baseRaid.node) ? s.baseRaid : undefined;
  const raidComps = raid && nodes[raid.compNode]?.comps;
  if (raid && !raidComps) warnings.push(`基地空襲: ${raid.compNode} マスの敵編成データが無いため空襲なし`);
  const baseRaids: SortieBaseRaid[] = raid && raidComps ? [{ node: raid.node, chance: raid.chance, comps: raidComps }] : [];

  // 基地航空隊: 出撃の隊のうち、この海域のマスを目標にした波。基地空襲があれば防空・待機の隊も (空襲を受ける)。
  // `lbasBases` / `baseNumbers` はエンジンの基地の順
  const lbasBases: PresetAirBase[] = [];
  const baseNumbers: number[] = [];
  const lbas: LandBase[] = [];
  (preset.lbas ?? []).forEach((b, i) => {
    const squadrons = buildSquadrons(b, master);
    const targets = b.mode === "sortie" ? b.targets.filter((t) => Object.hasOwn(nodes, t)) : [];
    if (b.mode === "sortie" && (targets.length === 0 || squadrons.length === 0)) {
      warnings.push(`第${i + 1}基地航空隊: ${squadrons.length === 0 ? "中隊がありません" : "この海域の目標マスが未設定"} (出撃しません)`);
    }
    if (squadrons.length === 0 || (targets.length === 0 && baseRaids.length === 0)) return;
    lbas.push({ squadrons, targets, ...(b.mode === "defense" ? { defense: true } : {}) });
    lbasBases.push(b);
    baseNumbers.push(i + 1);
  });
  if (baseRaids.length > 0 && lbas.length === 0) warnings.push("基地空襲: 中隊のある基地航空隊がありません");

  const support = {
    ...(s.support?.node && { node: extraFleet(preset, "supportNode", master, friendOpts, warnings) }),
    ...(s.support?.boss && { boss: extraFleet(preset, "supportBoss", master, friendOpts, warnings) }),
  };
  const friendFleetInput = s.friendFleet && extraFleet(preset, "friendFleet", master, friendOpts, warnings);
  const combined = !!friend.combined;

  // イベント特効: 戦闘のあるマスごとに、艦・基地の値とデバフ
  if (opts.eventBonus) {
    const e = opts.eventBonus;
    const b = buildBonuses(preset, e.response, master, { unconfirmed: e.unconfirmed, accEva: e.accEva, lbas: lbasBases });
    for (const [letter, n] of Object.entries(nodes)) {
      if (!n.comps) continue;
      const ships = b.bonuses.map((x) => bonusAt(x, letter));
      if (ships.some((x) => x)) n.bonuses = ships;
      const escort = combined ? (b.escortBonuses ?? []).map((x) => bonusAt(x, letter)) : [];
      if (escort.some((x) => x)) n.escortBonuses = escort;
      const bases = (b.lbasBonuses ?? []).map((x) => bonusAt(x, letter));
      if (bases.some((x) => x)) n.lbasBonuses = bases;
      const debuffs = e.debuff ? debuffsAt(e.response, letter) : [];
      if (debuffs.length) n.debuffs = debuffs;
    }
    warnings.push(...b.warnings);
  }
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
    policy: {
      night: s.night,
      retreat: s.retreat,
      formations,
      ...(Object.keys(advance).length > 0 ? { advance } : {}),
      ...(smoke.length > 0 ? { smoke } : {}),
      ...(s.underway !== undefined ? { underway: s.underway } : {}),
      ...(s.rations !== undefined ? { rations: s.rations } : {}),
    },
    topPaths: opts.topPaths ?? 200,
    ...(gauge ? { gauge } : {}),
    ...(lbas.length > 0 ? { lbas } : {}),
    // 遊撃部隊 (7 隻の単艦隊はエンジンが自動で遊撃部隊にする)
    ...(preset.fleetType === "striking_force" && !combined ? { striking: true } : {}),
    ...(s.repair?.bucketAboveSec !== undefined ? { repair: s.repair } : {}),
    ...(s.extraPerSortie && Object.values(s.extraPerSortie).some((v) => v) ? { extraPerSortie: s.extraPerSortie } : {}),
    ...(s.consecutive ? { consecutive: s.consecutive } : {}),
    ...(support.node || support.boss
      ? { support: { ...(support.node && { node: { fleet: support.node } }), ...(support.boss && { boss: { fleet: support.boss } }) } }
      : {}),
    ...(friendFleetInput && s.friendFleet
      ? { friendFleet: { fleet: friendFleetInput, chance: s.friendFleet.chance, ...(s.friendFleet.nodes.length > 0 ? { nodes: s.friendFleet.nodes } : {}) } }
      : {}),
    ...(baseRaids.length > 0 ? { baseRaids } : {}),
  };
  return { input, warnings: [...warnings, ...friend.warnings], friend, enemyBuilds, uncertain: uncertainNodes(routing), compSets, baseNumbers };
};
