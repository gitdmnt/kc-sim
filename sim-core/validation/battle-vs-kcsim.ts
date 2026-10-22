// Realistic-fleet sorties + per-node battle cross-check against kancolle-replay's kcsim
// (docs/VALIDATION.md §3).
//
// Friend fleets are built from kcSHIPDATA Lv99 stats with real equipment (data API); enemies, map and
// routing come from the plugin's own pipeline (loadMapData + buildSortieInput), exactly as in the UI.
// For every battle node a fleet reaches, the same battle (from full HP, day only) is run N times in
// sim-core and in a headless kcsim (js/kcsim.js, unmodified), and the taiha / S-rank / damage-taken
// rates are compared.
//
//   KCR_DIR=/path/to/kancolle-replay bun validation/battle-vs-kcsim.ts
//
// Needs `wasm-pack build --target web` (pkg/), the local server on :8787 and a checkout of
// https://github.com/KC3Kai/kancolle-replay (MIT) in KCR_DIR.
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { importFromPoi, masterFromPoi } from "../../shared/fleet/poiImport";
import { DataApi } from "../../web/src/data/api";
import { MemoryStorage } from "../../web/src/fleet/storage";
import { loadMapData } from "../../web/src/data/mapData";
import { buildSortieInput } from "../../web/src/sim/sortieAdapter";
import { initSync, runBattle, simulateSortie } from "../pkg/sim_core.js";
import type { EquipmentInput, EquipmentStats, FleetInput, Formation, ShipInput, SortieInput, SortieSummary } from "../pkg/sim_core.js";

const KCR = process.env.KCR_DIR;
if (!KCR) throw new Error("set KCR_DIR to a kancolle-replay checkout (https://github.com/KC3Kai/kancolle-replay)");
const ROOT = new URL("../../", import.meta.url).pathname;
const DOC = `${ROOT}docs/VALIDATION.md`;
const API = process.env.DATA_API ?? "http://127.0.0.1:8787";
const BATTLES = 2000;
const SORTIES = 10000;

initSync({ module: readFileSync(new URL("../pkg/sim_core_bg.wasm", import.meta.url)) });

// ------------------------------------------------------------- friend fleets ----

/** kcSHIPDATA player row (fields used here). */
interface ShipRow {
  nameJP?: string; type: string; sclass?: number; HP: number;
  FP: number; TP: number; AA: number; AR: number; EV: number; ASW: number; LOS: number; LUK: number;
  RNG: number; SPD: number; SLOTS: number[]; fuel?: number; ammo?: number;
}
interface ApiEquip {
  id: number; name: string; type: number[];
  fp: number; tp: number; aa: number; ar: number; ev: number; asw: number; los: number; acc: number; bomb: number; luck: number; range: number;
}

const kcsimCtx: Record<string, unknown> = { console, Math, Date, JSON, Object, Array, Number, String, Boolean, Set, Map, parseInt, parseFloat, isNaN };
kcsimCtx.self = kcsimCtx;
kcsimCtx.window = kcsimCtx;
vm.createContext(kcsimCtx);
for (const f of ["kcEQDATA.js", "kcSHIPDATA.js", "shared.js", "simulator-ui/common.js", "kcships.js", "kcsim.js"]) {
  vm.runInContext(readFileSync(`${KCR}/js/${f}`, "utf8"), kcsimCtx, { filename: f });
}
vm.runInContext("C = false;", kcsimCtx);
// The data files are plain scripts (`var SHIPDATA = {...}`); read the table from the vm.
const SHIPDATA = vm.runInContext("SHIPDATA", kcsimCtx) as Record<number, ShipRow>;
const EQUIPS = ((await (await fetch(`${API}/api/v1/equipments?abyssal=0`)).json()) as { equipments: ApiEquip[] }).equipments;

const STYPE: Record<string, number> = { DE: 1, DD: 2, CL: 3, CLT: 4, CA: 5, CAV: 6, CVL: 7, FBB: 8, BB: 9, BBV: 10, CV: 11, SS: 13, SSV: 14, AV: 16, LHA: 17, CVB: 18, AR: 19, AS: 20, CT: 21, AO: 22 };
const AIRCRAFT = new Set([6, 7, 8, 9, 10, 11, 25, 26, 41, 45, 47, 48, 49, 56, 57, 58, 59, 94]);
const STAT_KEYS: [keyof ApiEquip, keyof EquipmentStats][] = [
  ["fp", "firepower"], ["tp", "torpedo"], ["aa", "antiAir"], ["ar", "armor"], ["ev", "evasion"], ["asw", "asw"],
  ["los", "los"], ["acc", "accuracy"], ["bomb", "bombing"], ["luck", "luck"], ["range", "range"],
];

type Gear = (planes: number) => EquipmentInput;

/** Player equipment by name; aircraft get the slot's plane count and max proficiency. */
function eq(name: string): Gear {
  const e = EQUIPS.find((x) => x.name === name);
  if (!e) throw new Error(`equipment ${name} not found`);
  const stats: EquipmentStats = {};
  for (const [k, v] of STAT_KEYS) if (e[k]) stats[v] = e[k] as number;
  return (planes) => ({ id: e.id, types: e.type, stats, ...(AIRCRAFT.has(e.type[2]!) ? { planes, proficiency: 7 } : {}) });
}

/** Lv99 player ship (kcSHIPDATA, last form with that name). */
function ship(nameJP: string, gear: Gear[]): ShipInput {
  const ids = Object.keys(SHIPDATA).map(Number).filter((id) => id < 1500 && SHIPDATA[id]!.nameJP === nameJP);
  if (!ids.length) throw new Error(`ship ${nameJP} not found`);
  const id = ids[ids.length - 1]!;
  const d = SHIPDATA[id]!;
  return {
    id, name: nameJP, shipType: STYPE[d.type]!, shipClass: d.sclass, level: 99, maxHp: d.HP, speed: d.SPD, range: d.RNG,
    fuelMax: d.fuel, ammoMax: d.ammo,
    stats: { firepower: d.FP, torpedo: d.TP, antiAir: d.AA, armor: d.AR, evasion: d.EV, asw: d.ASW, los: d.LOS, luck: d.LUK },
    slots: gear.map((g, i) => g(d.SLOTS[i] ?? 0)),
  };
}

const yamato = (n: string) => ship(n, [eq("46cm三連装砲"), eq("46cm三連装砲"), eq("零式水上観測機"), eq("一式徹甲弾")]);
const nagato = (n: string) => ship(n, [eq("41cm三連装砲改二"), eq("41cm三連装砲改二"), eq("零式水上観測機"), eq("一式徹甲弾")]);
const cv = (n: string) => ship(n, [eq("烈風 一一型"), eq("流星改"), eq("烈風 一一型"), eq("彩雲")]);
const akizuki = () => ship("秋月改", [eq("10cm連装高角砲+高射装置"), eq("10cm連装高角砲+高射装置"), eq("13号対空電探改")]);
const isuzu = () => ship("五十鈴改二", [eq("10cm連装高角砲"), eq("三式水中探信儀"), eq("三式爆雷投射機")]);
const oaswDD = (n: string) => ship(n, [eq("四式水中聴音機"), eq("三式水中探信儀"), eq("三式爆雷投射機")]);
const losDD = (n: string) => ship(n, [eq("12.7cm連装砲B型改二"), eq("12.7cm連装砲B型改二"), eq("22号対水上電探改四(後期調整型)")]);
const sonarDD = (n: string) => ship(n, [eq("12.7cm連装砲B型改二"), eq("三式水中探信儀"), eq("22号対水上電探改四(後期調整型)")]);

interface Case { map: string; label: string; ships: ShipInput[] }
const CASES: Case[] = [
  { map: "2-5", label: "下ルート C-E-I-O: CV + CVL + CL + 3 DD (fast, Cn1 ≥ 34)", ships: [
    ship("赤城改", [eq("烈風 一一型"), eq("流星改"), eq("彗星一二型甲"), eq("彩雲")]),
    ship("龍驤改二", [eq("烈風 一一型"), eq("流星改"), eq("彩雲"), eq("烈風 一一型")]),
    ship("神通改二", [eq("15.2cm連装砲改"), eq("15.2cm連装砲改"), eq("零式水上偵察機")]),
    losDD("夕立改二"), losDD("時雨改二"), losDD("綾波改二"),
  ] },
  { map: "5-5", label: "中央下ルート B-F-D-H-N-O-S: 2 BB + CV + 秋月 (AACI) + DD + 速吸 (AO)", ships: [
    nagato("長門改二"), nagato("陸奥改二"), cv("加賀改"), akizuki(), sonarDD("夕立改二"),
    ship("速吸改", [eq("流星改"), eq("零式水上観測機"), eq("零式水上観測機")]),
  ] },
  { map: "6-5", label: "A-C-D-G-M: BB + 2 CV + OASW CL + OASW DD + 秋月 (AACI)", ships: [
    yamato("大和改"), cv("赤城改"), cv("加賀改"), isuzu(), oaswDD("時雨改二"), akizuki(),
  ] },
  { map: "6-5", label: "A-C-E-H-G-M: 2 BB + 2 CV + OASW CL + OASW DD", ships: [
    yamato("大和改"), yamato("武蔵改"), cv("赤城改"), cv("加賀改"), isuzu(), oaswDD("時雨改二"),
  ] },
];

// ------------------------------------------------------------- plugin pipeline ----

const state: unknown = JSON.parse(readFileSync(`${ROOT}web/src/sampleState.json`, "utf8"));
const master = masterFromPoi(state);
const api = new DataApi({ baseUrl: () => API, storage: new MemoryStorage() });

/** The plugin's SortieInput for `map` (enemies, routing, policy) with `ships` as the friend fleet. */
async function sortieInput(map: string, ships: ShipInput[]): Promise<SortieInput> {
  const preset = importFromPoi(state, 0, { now: 0, id: "validation" });
  if (!preset) throw new Error("sample state has no fleet 1");
  const b = buildSortieInput(preset, master, await loadMapData(map, { api }), {
    selects: {}, flags: {}, difficulty: 0, night: "bossOnly",
    retreat: { onHeavy: true, allowDamecon: true, onModerate: false }, formations: {}, hqLevel: 120, applyFit: false,
  });
  b.input.friend.ships = ships;
  return b.input;
}

// ------------------------------------------------------------- kcsim ----

const KC_TYPE: Record<number, string> = Object.fromEntries(Object.entries(STYPE).map(([k, v]) => [v, k]));
const FORMATION_ID: Record<Formation, number> = { lineAhead: 1, doubleLine: 2, diamond: 3, echelon: 4, lineAbreast: 5, vanguard: 6 };

/** Plain data handed to the vm, which builds kcsim objects from it. */
interface KShip { mid: number; type: string; side: number; level: number; hp: number; fp: number; tp: number; aa: number; ar: number; ev: number; asw: number; los: number; luck: number; rng: number; slots: number[]; equips: number[]; improves: number[]; profs: number[]; tacc: number | null }

function kship(s: ShipInput, side: number): KShip {
  const gear = s.slots.filter((e): e is EquipmentInput => !!e && e.id > 0);
  const row = SHIPDATA[s.id ?? 0];
  return {
    mid: s.id ?? 0, type: row?.type ?? KC_TYPE[s.shipType] ?? "DD", side, level: s.level ?? 1, hp: s.maxHp,
    fp: s.stats.firepower, tp: s.stats.torpedo, aa: s.stats.antiAir, ar: s.stats.armor, ev: s.stats.evasion ?? 0,
    asw: s.stats.asw ?? 0, los: s.stats.los ?? 0, luck: s.stats.luck ?? 0, rng: s.range ?? row?.RNG ?? 1,
    slots: s.slots.map((e) => e?.planes ?? 0), equips: gear.map((e) => e.id), improves: gear.map((e) => e.improvement ?? 0),
    profs: gear.map((e) => e.proficiency ?? 0), tacc: s.torpedoAccuracy ?? null,
  };
}

vm.runInContext(`
function __mkFleet(side, ships, formation) {
  var list = ships.map(function (d) {
    var s = new self[d.type](d.mid, 'x', d.side, d.level, d.hp, d.fp, d.tp, d.aa, d.ar, d.ev, d.asw, d.los, d.luck, d.rng, d.slots.slice());
    if (d.tacc != null) s.TACC = d.tacc;
    s.loadEquips(d.equips, d.improves, d.profs, true);
    for (var i = s.PLANESLOTS.length; i < s.equips.length; i++) { s.PLANESLOTS.push(0); s.planecount.push(0); }
    return s;
  });
  var F = new Fleet(side);
  F.loadShips(list);
  F.setFormation(formation, 1);
  F.reset();
  return F;
}
function __battle(F1, F2) {
  F1.reset(); F2.reset();
  for (var i = 0; i < F1.ships.length; i++) { F1.ships[i].HP = F1.ships[i].maxHP; F1.ships[i].morale = 49; }
  for (var i = 0; i < F2.ships.length; i++) F2.ships[i].HP = F2.ships[i].maxHP;
  var r = sim(F1, F2, null, [], false, false, false, false, false, undefined, true);
  return { rank: r.rank, friend: F1.ships.map(function (s) { return s.HP; }) };
}`, kcsimCtx);
const mkFleet = kcsimCtx.__mkFleet as (side: number, ships: KShip[], formation: number) => unknown;
const kcsimBattle = kcsimCtx.__battle as (f1: unknown, f2: unknown) => { rank: string; friend: number[] };

// ------------------------------------------------------------- comparison ----

interface NodeStats { taiha: number; sRank: number; dmg: number }

/** Day battles from full HP against the node's comps (by weight), in sim-core or kcsim. */
function nodeStats(engine: "sim-core" | "kcsim", friend: ShipInput[], comps: { weight: number; fleet: FleetInput }[], formation: Formation): NodeStats {
  const total = comps.reduce((a, c) => a + c.weight, 0);
  const out = { taiha: 0, sRank: 0, dmg: 0, n: 0 };
  let seed = 1;
  const F1 = engine === "kcsim" ? mkFleet(0, friend.map((s) => kship(s, 0)), FORMATION_ID[formation]) : null;
  for (const c of comps) {
    const F2 = engine === "kcsim" ? mkFleet(1, c.fleet.ships.map((s) => kship(s, 1)), FORMATION_ID[c.fleet.formation ?? "lineAhead"]) : null;
    for (let i = 0, k = Math.max(1, Math.round((BATTLES * c.weight) / total)); i < k; i++) {
      let hps: number[];
      let rank: string;
      if (engine === "kcsim") {
        const r = kcsimBattle(F1, F2);
        hps = r.friend;
        rank = r.rank;
      } else {
        const r = runBattle({ friend: { ships: friend, formation }, enemy: c.fleet, options: { kind: "day" } }, seed++);
        hps = r.state.friend.ships.map((s) => s.hp ?? 0);
        rank = r.result.rank === "SS" ? "S" : r.result.rank;
      }
      out.n++;
      if (rank === "S") out.sRank++;
      if (hps.some((hp, j) => hp > 0 && hp / friend[j]!.maxHp <= 0.25)) out.taiha++;
      hps.forEach((hp, j) => (out.dmg += friend[j]!.maxHp - Math.max(0, hp)));
    }
  }
  return { taiha: out.taiha / out.n, sRank: out.sRank / out.n, dmg: out.dmg / out.n };
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const out: string[] = [
  `Generated by \`bun validation/battle-vs-kcsim.ts\` on ${new Date().toISOString().slice(0, 10)}: sorties ${SORTIES} (seed 12345, difficulty 0, night at the boss only, retreat on heavy damage), node battles ${BATTLES} per engine from full HP (day only). Friend formation as in the plugin: line abreast against submarine-only fleets, otherwise line ahead.`,
  "",
];
const flags: string[] = [];
for (const c of CASES) {
  const input = await sortieInput(c.map, c.ships);
  const s: SortieSummary = simulateSortie(input, SORTIES, 12345);
  out.push(`### ${c.map} — ${c.label}`);
  out.push(`Boss reach ${pct(s.boss.reachRate)}, boss A+ ${pct(s.boss.killRate)}, retreat ${pct(s.retreatRate)}; main path ${s.paths[0]?.path.join("-")} (${pct(s.paths[0]?.rate ?? 0)}).\n`);
  out.push("| node | reach | retreat after | taiha≥1 sim-core / kcsim | S rank sim-core / kcsim | HP lost sim-core / kcsim |", "|---|---|---|---|---|---|");
  for (const [node, ns] of Object.entries(s.nodes)) {
    const comps = input.map.nodes[node]?.comps;
    if (!comps?.length || ns.battleRate < 0.02) continue;
    const subsOnly = comps.every((x) => x.fleet.ships.every((e) => e.shipType === 13 || e.shipType === 14));
    const form: Formation = subsOnly ? "lineAbreast" : "lineAhead";
    const a = nodeStats("sim-core", c.ships, comps, form);
    const b = nodeStats("kcsim", c.ships, comps, form);
    if (Math.abs(a.taiha - b.taiha) > 0.05) flags.push(`${c.map} ${node}: taiha ${pct(a.taiha)} vs kcsim ${pct(b.taiha)}`);
    out.push(`| ${node} | ${pct(ns.reachRate)} | ${pct(ns.retreatRate)} | ${pct(a.taiha)} / ${pct(b.taiha)} | ${pct(a.sRank)} / ${pct(b.sRank)} | ${a.dmg.toFixed(1)} / ${b.dmg.toFixed(1)} |`);
  }
  out.push("");
}
out.push("#### Flagged (|Δ taiha| > 5 pt)\n");
out.push(flags.length ? flags.map((f) => `- ${f}`).join("\n") : "- none");

const begin = "<!-- kcsim-crosscheck:begin -->";
const end = "<!-- kcsim-crosscheck:end -->";
const doc = readFileSync(DOC, "utf8");
const i = doc.indexOf(begin);
const j = doc.indexOf(end);
if (i < 0 || j < 0) throw new Error(`markers missing in ${DOC}`);
writeFileSync(DOC, `${doc.slice(0, i + begin.length)}\n${out.join("\n")}\n${doc.slice(j)}`);
console.log(out.join("\n"));
