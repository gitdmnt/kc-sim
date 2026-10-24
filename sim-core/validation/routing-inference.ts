// Synthetic recovery test for routing rule inference (docs/ROUTING_INFERENCE.md §4).
//
// Ground truth = the hand-written seed rules (server/seed/routing). Random fleets (half archetypes from
// fleets.ts, half random compositions; random LoS gear, drums, landing craft, radar, sonar, ship ids)
// sail one routing-only sortie each through the sim-core evaluator (wasm). The inferrer
// (server/scripts/lib/routing-infer.ts) sees only (fleet, path) pairs, like real poi uploads, and its
// document is scored against the truth on held-out fleets:
//   - node agreement: 1 − TV distance between the true and inferred next-node distributions at every
//     branching decision of held-out sorties (exact, via nextDistribution; player selects skipped);
//   - path agreement: 1 − TV distance between the true and inferred full-path distributions, both run
//     through the wasm evaluator (Monte Carlo), so the inferred JSON is checked end to end.
//
//   bun validation/routing-inference.ts [--maps 1-5,2-5] [--sizes 100,300,1000] [--test 300] [--mc 1000] [--skew-n 3000] [--no-doc]
//
// Needs `wasm-pack build --target web` (pkg/). Sends no network request and does not touch D1.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { initSync, simulateSortie } from "../pkg/sim_core.js";
import type { EquipmentInput, RoutingDocument, ShipInput } from "../pkg/sim_core.js";
import { inferRouting, nextDistribution, parseStart2Ships, shipFamilies, type RouteShip, type SortieSample } from "../../server/scripts/lib/routing-infer.ts";
import { countRules, validateRoutingDoc, type Edge } from "../../server/src/routing/validate.ts";
import type { RoutingDoc } from "../../server/src/routing/schema.ts";
import { normalizeLetter } from "../../server/src/maps.ts";
import { COMPS, NAKED_LOS, SPEEDS, STYPE, speedsFor, type Code } from "./fleets.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const DOC = `${ROOT}docs/ROUTING_INFERENCE.md`;
const OUT_DIR = `${ROOT}server/.tmp/inferred-synthetic`;
const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    maps: { type: "string", default: "1-5,2-5,4-5,5-3,5-5,6-5,7-3" },
    sizes: { type: "string", default: "100,300,1000,3000,10000" },
    test: { type: "string", default: "300" },
    mc: { type: "string", default: "1000" },
    "skew-n": { type: "string", default: "3000" },
    "no-doc": { type: "boolean", default: false },
  },
});
const MAPS = args.maps.split(",");
const SIZES = args.sizes.split(",").map(Number);
const TEST = Number(args.test);
/** Monte-Carlo sorties per (fleet, document) for the path agreement. */
const MC = Number(args.mc);
/** Training sorties of the skewed-population coverage run. */
const SKEW_N = Number(args["skew-n"]);
const HQ = 120;

initSync({ module: readFileSync(new URL("../pkg/sim_core_bg.wasm", import.meta.url)) });

// ------------------------------------------------------------------ data ----

type EdgeFixture = Record<string, Record<string, [string, string]>>;
const fixture = JSON.parse(readFileSync(`${ROOT}server/test/fixtures/edges-normal-kcnav.json`, "utf8")) as EdgeFixture;
function edgesOf(map: string): Edge[] {
  const raw = Object.values(fixture[`World ${map}`] ?? {});
  const multi = raw.flat().some((l) => /^Start ?\d+$/.test(l));
  return raw.map(([a, b]) => ({ from: normalizeLetter(a, multi), to: normalizeLetter(b, multi) }));
}

/** Player ship families (remodel chains, api_aftershipid) by stype, from the npm api_start2 snapshot when installed. */
function loadFamilies(): { families: number[][]; byStype: Map<number, { ids: number[] }[]> } {
  const file = `${ROOT}web/node_modules/@kancolle/data/api/api_start2.json`;
  if (!existsSync(file)) return { families: [], byStype: new Map() };
  const ships = parseStart2Ships(JSON.parse(readFileSync(file, "utf8")));
  const families = shipFamilies(ships);
  const stype = new Map(ships.map((s) => [s.api_id, s.api_stype]));
  const byStype = new Map<number, { ids: number[] }[]>();
  for (const ids of families) {
    for (const t of new Set(ids.map((id) => stype.get(id)!))) {
      byStype.set(t, [...(byStype.get(t) ?? []), { ids: ids.filter((id) => stype.get(id) === t) }]);
    }
  }
  return { families, byStype };
}
const FAMILIES = loadFamilies();

// ---------------------------------------------------------------- fleets ----

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPE_WEIGHTS: [Code, number][] = [
  ["DD", 30], ["CL", 8], ["DE", 6], ["CA", 6], ["CAV", 4], ["CLT", 3], ["CT", 2], ["CVL", 5], ["CV", 5], ["CVB", 2],
  ["FBB", 3], ["BB", 5], ["BBV", 3], ["SS", 4], ["AV", 2], ["AO", 2],
];
const TOTAL_WEIGHT = TYPE_WEIGHTS.reduce((s, [, w]) => s + w, 0);

interface Fleet { ships: ShipInput[]; selects: Record<string, string> }

function randomShip(r: () => number, code: Code, speed: number): ShipInput {
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const slots: EquipmentInput[] = [];
  if (code === "CV" || code === "CVB" || code === "CVL") {
    for (let i = int(0, 2); i > 0; i--) slots.push({ id: 61, types: [0, 0, 9, 9, 0], stats: { los: 7 }, planes: 18, improvement: r() < 0.3 ? int(1, 10) : 0 });
    for (let i = int(1, 2); i > 0; i--) slots.push({ id: 16, types: [0, 0, 8, 8, 0], stats: { los: int(0, 2) }, planes: 18 });
  } else if (["CA", "CAV", "BBV", "AV", "FBB", "BB"].includes(code)) {
    for (let i = int(0, 2); i > 0; i--) slots.push({ id: 25, types: [0, 0, 10, 10, 0], stats: { los: [3, 4, 5, 6, 8, 9][int(0, 5)]! }, planes: 2, improvement: r() < 0.3 ? int(1, 10) : 0 });
  }
  if (["DD", "CL", "CT", "CLT", "DE"].includes(code)) {
    if (r() < 0.35) slots.push({ id: 28, types: [0, 0, 12, 11, 0], stats: { los: [1, 2, 3, 5, 6, 7, 8][int(0, 6)]! }, improvement: r() < 0.3 ? int(1, 10) : 0 });
    if (r() < 0.25) slots.push({ id: 46, types: [0, 0, 14, 18, 0], stats: {} });
    if (r() < 0.3) for (let i = int(1, 2); i > 0; i--) slots.push({ id: 75, types: [0, 0, 30, 25, 0], stats: {} });
  }
  if (["DD", "CL", "AV"].includes(code) && r() < 0.12) slots.push({ id: 68, types: [0, 0, 24, 20, 0], stats: {} });
  const fams = FAMILIES.byStype.get(STYPE[code]);
  const fam = fams?.[int(0, fams.length - 1)];
  return {
    id: fam ? fam.ids[int(0, fam.ids.length - 1)] : undefined,
    shipType: STYPE[code], level: 99, maxHp: 50, speed,
    stats: { firepower: 50, torpedo: 50, antiAir: 50, armor: 50, evasion: 60, asw: 50, los: NAKED_LOS[code] + int(-8, 12), luck: 20 },
    slots: slots.slice(0, 5),
  };
}

const ZIPF = COMPS.map((_, k) => 1 / (k + 1) ** 1.2);
const ZIPF_TOTAL = ZIPF.reduce((a, b) => a + b, 0);

/**
 * One random fleet. Mixed population (default): half archetypes (uniform), half random compositions.
 * Skewed population (`popular` = archetype indices by popularity): 90 % archetypes drawn Zipf(1.2) by
 * rank, like a real player base concentrated on a few meta comps; 10 % random compositions.
 */
function randomFleet(r: () => number, selectNodes: Record<string, string[]>, popular?: number[]): Fleet {
  let codes: Code[];
  if (popular && r() < 0.9) {
    let u = r() * ZIPF_TOTAL;
    const rank = ZIPF.findIndex((w) => (u -= w) < 0);
    codes = COMPS[popular[rank < 0 ? 0 : rank]!]!.split(" ") as Code[];
  } else if (!popular && r() < 0.5) codes = COMPS[Math.floor(r() * COMPS.length)]!.split(" ") as Code[];
  else {
    const n = r() < 0.6 ? 6 : 1 + Math.floor(r() * 6);
    codes = Array.from({ length: n }, () => {
      let u = r() * TOTAL_WEIGHT;
      for (const [c, w] of TYPE_WEIGHTS) if ((u -= w) < 0) return c;
      return "DD";
    });
  }
  const speeds = speedsFor(codes);
  const speed = SPEEDS[speeds[Math.floor(r() * speeds.length)]!];
  const selects = Object.fromEntries(Object.entries(selectNodes).map(([n, o]) => [n, o[Math.floor(r() * o.length)]!]));
  return { ships: codes.map((c) => randomShip(r, c, speed)), selects };
}

const toRoute = (s: ShipInput): RouteShip => ({
  stype: s.shipType, id: s.id ?? 0, speed: s.speed ?? 10, nakedLos: s.stats.los ?? 0,
  equips: s.slots.flatMap((e) => (e ? [{ id: e.id, cat: e.types[2] ?? 0, los: e.stats?.los ?? 0, level: e.improvement ?? 0 }] : [])),
});

/** Top-level unconditional `select` nodes: the game offers the choice (api_select_route) whenever the fleet is there. */
function selectNodes(doc: RoutingDoc): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [n, d] of Object.entries(doc.nodes)) {
    if (!("rules" in d)) continue;
    const r = d.rules[0]!;
    if ("select" in r && !r.when) out[n] = r.select;
    else if (JSON.stringify(d.rules).includes('"select"')) throw new Error(`${n}: conditional select not modelled by the harness`);
  }
  return out;
}

// ------------------------------------------------------------ simulation ----

function paths(doc: RoutingDoc, f: Fleet, count: number, seed: number): Map<string, number> {
  const s = simulateSortie(
    { friend: { ships: f.ships }, hqLevel: HQ, map: { routing: doc as unknown as RoutingDocument, nodes: {} }, config: { selects: f.selects }, topPaths: 100000 },
    count, seed,
  );
  return new Map(s.paths.map((p) => [p.path.join("-"), p.rate]));
}

const tv = (a: Map<string, number> | Record<string, number>, b: Map<string, number> | Record<string, number>) => {
  const A = a instanceof Map ? a : new Map(Object.entries(a));
  const B = b instanceof Map ? b : new Map(Object.entries(b));
  let d = 0;
  for (const k of new Set([...A.keys(), ...B.keys()])) d += Math.abs((A.get(k) ?? 0) - (B.get(k) ?? 0));
  return d / 2;
};

interface Decision { s: SortieSample; node: string; visited: Set<string>; selects: Record<string, string> }

/** Branching decisions along one sortie (start choice included), skipping player selects. */
function decisions(s: SortieSample, multiStart: boolean, sel: Record<string, string[]>, fleet: Fleet, out: Record<string, string[]>): Decision[] {
  const ds: Decision[] = [];
  if (multiStart) ds.push({ s, node: "@start", visited: new Set(), selects: fleet.selects });
  const visited = new Set<string>();
  for (let j = 0; j + 1 < s.path.length; j++) {
    const n = s.path[j]!;
    visited.add(n);
    if (!sel[n] && (out[n]?.length ?? 0) > 1) ds.push({ s, node: n, visited: new Set(visited), selects: fleet.selects });
  }
  return ds;
}

function nodeScore(truth: RoutingDoc, doc: RoutingDoc, decs: Decision[]): { mean: number; within5: number; perNode: Map<string, number[]> } {
  const perNode = new Map<string, number[]>();
  let sum = 0;
  let within5 = 0;
  for (const d of decs) {
    const a = 1 - tv(nextDistribution(truth, d.node, d.s, d.visited, { selects: d.selects }), nextDistribution(doc, d.node, d.s, d.visited, { selects: d.selects }));
    sum += a;
    if (a >= 0.95) within5++;
    perNode.set(d.node, [...(perNode.get(d.node) ?? []), a]);
  }
  return { mean: sum / decs.length, within5: within5 / decs.length, perNode };
}

// ------------------------------------------------------------------ main ----

interface Row { map: string; n: number; nodeAgree: number; nodeExact: number; pathAgree: number; pathExact: number; rules: number; uncertain: number; secs: number }
const rows: Row[] = [];
const worst: string[] = [];
const truthRows: string[] = [];
const skewRows: string[] = [];
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
mkdirSync(OUT_DIR, { recursive: true });
const t0 = performance.now();

for (const map of MAPS) {
  const edges = edgesOf(map);
  const truth = JSON.parse(readFileSync(`${ROOT}server/seed/routing/${map}.json`, "utf8")) as RoutingDoc;
  const tv0 = validateRoutingDoc(truth, edges);
  if (tv0.errors.length) throw new Error(`${map} seed invalid: ${tv0.errors.join("; ")}`);
  const sel = selectNodes(truth);
  const out: Record<string, string[]> = {};
  for (const e of edges) (out[e.from] ??= []).push(e.to);
  const multiStart = !!truth.start;
  const mapSeed = map.split("-").reduce((a, x) => a * 31 + Number(x), 7);

  /** Training sorties: one routing-only sortie per fleet, as a poi upload records it. */
  const trainSet = (n: number, seed: number, popular?: number[]): SortieSample[] => {
    const r = rng(seed);
    return Array.from({ length: n }, (_, i) => {
      const f = randomFleet(r, sel, popular);
      const path = [...paths(truth, f, 1, seed * 1000 + i).keys()][0]!.split("-");
      const selects = Object.fromEntries(path.filter((x) => sel[x]).map((x) => [x, sel[x]!]));
      return { main: f.ships.map(toRoute), hq: HQ, difficulty: 0, path, selects };
    });
  };
  /** Held-out fleets: true path distributions (wasm) and the branching decisions along the true paths. */
  const heldOut = (seed: number, popular?: number[]) => {
    const r = rng(seed);
    const test = Array.from({ length: TEST }, () => randomFleet(r, sel, popular));
    const truePaths = test.map((f, i) => paths(truth, f, MC, 500000 + i));
    const decs = test.flatMap((f, i) => {
      const route = f.ships.map(toRoute);
      return [...truePaths[i]!].flatMap(([p, rate]) =>
        rate >= 0.02 ? decisions({ main: route, hq: HQ, difficulty: 0, path: p.split("-") }, multiStart, sel, f, out) : []);
    });
    return { test, truePaths, decs };
  };

  const maxN = Math.max(...SIZES);
  const train = trainSet(maxN, mapSeed);
  const { test, truePaths, decs } = heldOut(mapSeed + 99991);
  const noise = test.map((f, i) => tv(truePaths[i]!, paths(truth, f, MC, 900000 + i)));
  const ct = countRules(tv0.doc!);
  truthRows.push(`| ${map} | ${ct.total} | ${ct.uncertain} | ${decs.length} | ${pct(1 - noise.reduce((a, b) => a + b, 0) / noise.length)} |`);

  const infer = (samples: SortieSample[], label: string) => {
    const res = inferRouting(map, edges, samples, { families: FAMILIES.families });
    if (res.errors.length) throw new Error(`${map} ${label}: inferred document invalid: ${res.errors.join("; ")}`);
    writeFileSync(`${OUT_DIR}/${map}.${label}.json`, JSON.stringify(res.doc, null, 1));
    return res.doc;
  };

  for (const n of SIZES) {
    const t1 = performance.now();
    const doc = infer(train.slice(0, n), `n${n}`);
    const secs = (performance.now() - t1) / 1000;
    const score = nodeScore(truth, doc, decs);
    const pathAgree = test.map((f, i) => 1 - tv(truePaths[i]!, paths(doc, f, MC, 500000 + i)));
    const cr = countRules(doc);
    rows.push({
      map, n, nodeAgree: score.mean, nodeExact: score.within5,
      pathAgree: pathAgree.reduce((a, b) => a + b, 0) / pathAgree.length,
      pathExact: pathAgree.filter((a, i) => a >= 1 - Math.max(0.05, 2 * noise[i]!)).length / pathAgree.length,
      rules: cr.total, uncertain: cr.uncertain, secs,
    });
    if (n === maxN) {
      const low = [...score.perNode].map(([node, a]) => ({ node, n: a.length, agree: a.reduce((x, y) => x + y, 0) / a.length }))
        .sort((a, b) => a.agree - b.agree).slice(0, 3);
      worst.push(`- **${map}**: ${low.map((x) => `${x.node} ${pct(x.agree)} (判断 ${x.n} 件)`).join(", ")}`);
    }
    console.log(JSON.stringify(rows.at(-1)));
  }

  // Coverage: train on a population concentrated on a few comps, score on it and on the mixed population.
  const rp = rng(mapSeed + 7);
  const popular = COMPS.map((_, k) => [rp(), k] as const).sort((a, b) => a[0] - b[0]).map(([, k]) => k);
  const skewDoc = infer(trainSet(SKEW_N, mapSeed + 13, popular), `skewed${SKEW_N}`);
  const skewTest = heldOut(mapSeed + 77777, popular);
  const onSkew = nodeScore(truth, skewDoc, skewTest.decs);
  const onMixed = nodeScore(truth, skewDoc, decs);
  const top = popular.slice(0, 3).map((k) => `\`${COMPS[k]}\``).join(", ");
  skewRows.push(`| ${map} | ${top} | ${pct(onSkew.mean)} | ${pct(onSkew.within5)} | ${pct(onMixed.mean)} | ${pct(onMixed.within5)} |`);
}

const lines = [
  `\`bun validation/routing-inference.ts\`(\`sim-core/\` から実行)で ${new Date().toISOString().slice(0, 10)} に生成。` +
    `マップごとに取り分けた艦隊 ${TEST} 個、経路は(艦隊, 文書)ごとに ${MC} 回のモンテカルロ出撃、` +
    `${FAMILIES.families.length ? `npm の api_start2 スナップショットから ${FAMILIES.families.length} の改造系列` : "艦 ID なし(api_start2 スナップショット未導入)"}。` +
    `合計 ${((performance.now() - t0) / 1000).toFixed(0)} 秒。`,
  "",
  "正解(初期規則): 規則数、`uncertain` の規則数、採点した取り分けの分岐判断の数、経路の一致度のモンテカルロのノイズ下限(真値 対 真値、別のシード)。",
  "",
  "| マップ | 規則 | uncertain | 判断 | 経路のノイズ下限 |",
  "|---|---|---|---|---|",
  ...truthRows,
  "",
  "学習サイズ別の復元(n = 出撃数)。node = 取り分けた判断での次マス分布の 1 − TV の平均(≤5 pt = 5 ポイント以内の判断の割合)。" +
    "path = wasm 評価器での経路全体の分布の 1 − TV の平均(≤5 pt = max(5 pt, 2 × MC ノイズ) 以内の艦隊の割合)。規則 = 推定した規則数(uncertain)。",
  "",
  "| マップ | n | node | node ≤5 pt | path | path ≤5 pt | 規則 (uncertain) | infer s |",
  "|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.map} | ${r.n} | ${pct(r.nodeAgree)} | ${pct(r.nodeExact)} | ${pct(r.pathAgree)} | ${pct(r.pathExact)} | ${r.rules} (${r.uncertain}) | ${r.secs.toFixed(1)} |`),
  "",
  `最大の n で一致度が低いマス(マスの一致度の平均、取り分けた判断):`,
  "",
  ...worst,
  "",
  `カバー範囲: 偏った母集団の ${SKEW_N} 出撃から規則を推定した(90 % はランダムな人気順に対する Zipf(1.2) で引いた典型編成、10 % はランダムな編成)。` +
    "同じ偏った母集団と、上の混合母集団の取り分けた艦隊で採点する。",
  "",
  "| マップ | 人気上位の編成 | node (偏り) | ≤5 pt (偏り) | node (混合) | ≤5 pt (混合) |",
  "|---|---|---|---|---|---|",
  ...skewRows,
];
console.log(lines.join("\n"));
if (!args["no-doc"]) {
  const begin = "<!-- routing-inference:begin -->";
  const end = "<!-- routing-inference:end -->";
  const doc = readFileSync(DOC, "utf8");
  const i = doc.indexOf(begin);
  const j = doc.indexOf(end);
  if (i < 0 || j < 0) throw new Error(`markers missing in ${DOC}`);
  writeFileSync(DOC, `${doc.slice(0, i + begin.length)}\n${lines.join("\n")}\n${doc.slice(j)}`);
}
