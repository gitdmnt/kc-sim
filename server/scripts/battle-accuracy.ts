// Battle accuracy against real battles recorded by KCNav (docs/VALIDATION.md §4).
//
// Every stored KCNav battle (D1 kcnav_battles, src/kcnav/battles.ts) becomes a sim-core BattleInput the way the web
// UI builds one (shared/sim/adapter): the player's fleet from KCNav's displayed stats (buildFriendShips: naked =
// displayed − equipment − fit bonus; FP/TP/AA/AR from the packet's naked api_fParam), the enemy from the battle
// packet (buildEnemyShips with the data API's hidden-stat estimates), the observed formations and engagement, the
// land-base waves that flew and the HP at the start of the battle. It is simulated --runs times (plus --logged runs
// with event logs for the per-phase damage) and scored against what happened.
//
//   bun scripts/battle-accuracy.ts [--runs 2000] [--logged 100] [--offline] [--no-doc] [--debuffs] [--no-pursuit]
//
// Online it reads D1 (production with D1_REMOTE=1, read-only) and GET /api/v1/ships/{id} on DATA_API (default
// https://kc-sim.udama.net), and saves the inputs to .tmp/battle-accuracy-input.json; --offline reuses that file
// (to compare engine versions on the same battles). Rewrites the generated block of docs/VALIDATION.md §4 and
// sim-core/validation/battle-accuracy-summary.json, printing the change against the previous summary.
// Needs sim-core/pkg (`bun run build:wasm`).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { parseArgs } from "node:util";
import { initSync, runBattle, simulateBattle } from "../../sim-core/pkg/sim_core";
import type { BattleInput, Engagement, Formation, FriendFleetInput, LandBaseWave, ShipInput, SimulationSummary, SupportInput, SupportType } from "../../sim-core/pkg/sim_core";
import type { CompShip, ShipDetail } from "../../shared/data/types";
import { COMBINED_FLAG_TYPES } from "../../shared/fleet/poiImport";
import type { Preset, PresetAirBase, PresetEquip, PresetShip } from "../../shared/fleet/types";
import { type EventBonusResponse, type NodeBonus, bonusAt, buildBonuses, debuffsAt } from "../../shared/sim/bonuses";
import { ENEMY_FORMATION_BY_ID, buildEnemyShips, buildFriendShips, buildSquadrons, friendFleet } from "../../shared/sim/adapter";
import type { FitEntry } from "../../shared/sim/fit";
import { type BattleOutcome, type BattleSetupShip, type OutcomePhase, parseBattleSetup } from "../src/kcnav/battles";
import { type EquipRow, type ShipRow, loadFitBonuses, loadMaster, masterFromRows } from "../src/master";
import { openD1 } from "./lib/d1-database";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { runs: { type: "string" }, logged: { type: "string" }, offline: { type: "boolean" }, "no-doc": { type: "boolean" }, debuffs: { type: "boolean" }, "no-pursuit": { type: "boolean" } },
});
const RUNS = Number(values.runs ?? 2000);
const LOGGED = Number(values.logged ?? 100);
const ROOT = new URL("../../", import.meta.url).pathname;
const INPUT = new URL("../.tmp/battle-accuracy-input.json", import.meta.url).pathname;
const SUMMARY = `${ROOT}sim-core/validation/battle-accuracy-summary.json`;
const DOC = `${ROOT}docs/VALIDATION.md`;
const API = process.env.DATA_API ?? "https://kc-sim.udama.net";
const BOOT = 1000;

initSync({ module: readFileSync(new URL("../../sim-core/pkg/sim_core_bg.wasm", import.meta.url)) });

// ------------------------------------------------------------------ input ----

interface Row {
  id: number; map_id: number; node_letter: string; battle_at: string; kind: string; api_name: string; fleet_type: number;
  enemy_combined: number; formation: number | null; enemy_formation: number | null; engagement: number | null;
  air_state: number | null; support: number; friend_fleet: number; lbas_waves: number; rank: string; verified: number | null;
  outcome: string; raw: string;
}
interface Input { savedAt: string; rows: Row[]; ships: ShipRow[]; equips: EquipRow[]; fit: FitEntry[]; details: Record<number, ShipDetail>;
  /** Event maps: GET /api/v1/maps/{map}/bonuses by map id. */
  eventBonuses: Record<number, EventBonusResponse>;
  /** Hidden stats of the event friend-fleet ships (kancolle-replay kcSHIPDATA, MIT): Lv1 and Lv99 EV / ASW / LoS, luck. */
  friendStats: Record<number, FriendStats> }
interface FriendStats { EV: number; EVbase: number; ASW: number; ASWbase: number; LOS: number; LOSbase: number; LUK: number }

async function loadOnline(): Promise<Input> {
  const db = openD1();
  const rows: Row[] = [];
  for (let after = 0; ;) {
    const { results } = await db.prepare(
      `SELECT id, map_id, node_letter, battle_at, kind, api_name, fleet_type, enemy_combined, formation, enemy_formation, engagement,
         air_state, support, friend_fleet, lbas_waves, rank, verified, outcome, raw FROM kcnav_battles WHERE id > ?1 ORDER BY id LIMIT 100`,
    ).bind(after).all<Row>();
    rows.push(...results);
    if (results.length < 100) break;
    after = results.at(-1)!.id;
  }
  const shipIds = new Set<number>();
  const enemyIds = new Set<number>();
  const equipIds = new Set<number>();
  for (const r of rows) {
    const s = parseBattleSetup(JSON.parse(r.raw));
    for (const sh of [...s.fleet.fleet1, ...(s.fleet.fleet2 ?? [])]) {
      shipIds.add(sh.id);
      sh.equips.forEach((e) => equipIds.add(e));
    }
    s.fleet.lbas?.forEach((b) => b.planes.forEach((p) => equipIds.add(p)));
    const ke = [...s.rawapi.api_ship_ke, ...(s.rawapi.api_ship_ke_combined ?? [])];
    ke.forEach((id) => (shipIds.add(id), enemyIds.add(id)));
    [...s.rawapi.api_eSlot, ...(s.rawapi.api_eSlot_combined ?? [])].flat().forEach((e) => equipIds.add(e));
  }
  const master = await loadMaster(db, shipIds, equipIds);
  const details: Record<number, ShipDetail> = {};
  const eventBonuses: Record<number, EventBonusResponse> = {};
  for (const mapId of new Set(rows.map((r) => r.map_id).filter((m) => m > 100))) {
    // Our own data API; the web UI reads the same JSON as EventBonusResponse (web/src/data/api.ts). 404: no bonuses.
    const bonus = await apiGet<EventBonusResponse>(`/api/v1/maps/${Math.floor(mapId / 10)}-${mapId % 10}/bonuses`, true);
    if (bonus) eventBonuses[mapId] = bonus;
  }
  for (const id of [...enemyIds].filter((x) => x > 0).sort((a, b) => a - b)) {
    // Our own data API; the web UI reads the same JSON as ShipDetail (web/src/data/api.ts). A missing detail would
    // silently put the enemy on hiddenFallback's ship-type medians, so every one is required.
    details[id] = (await apiGet<ShipDetail>(`/api/v1/ships/${id}`, false))!;
  }
  const input: Input = {
    savedAt: new Date().toISOString(), rows, ships: [...master.ships.values()], equips: [...master.equips.values()],
    fit: await loadFitBonuses(db), details, eventBonuses, friendStats: await loadFriendStats(rows),
  };
  mkdirSync(new URL("../.tmp/", import.meta.url).pathname, { recursive: true });
  writeFileSync(INPUT, JSON.stringify(input));
  return input;
}

/**
 * GET on the data API, one request at a time: 429 / 5xx / network errors are retried with backoff (Retry-After when
 * given), anything else that is not ok throws. `allow404`: a 404 returns null.
 */
async function apiGet<T>(path: string, allow404: boolean): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`).catch((e: unknown) => e);
    if (res instanceof Response) {
      if (res.ok) return (await res.json()) as T;
      if (res.status === 404 && allow404) return null;
      if (res.status !== 429 && res.status < 500) throw new Error(`GET ${path}: HTTP ${res.status}`);
    }
    if (attempt === 6) throw new Error(`GET ${path}: ${res instanceof Response ? `HTTP ${res.status}` : String(res)} after ${attempt + 1} attempts`);
    const after = res instanceof Response ? Number(res.headers.get("retry-after")) : NaN;
    await Bun.sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
  }
}

/** kcSHIPDATA entries of the ships that appear in event friend fleets (the packet has no EV / ASW / LoS / luck). */
async function loadFriendStats(rows: Row[]): Promise<Record<number, FriendStats>> {
  const ids = new Set<number>();
  for (const r of rows) {
    if (!r.friend_fleet) continue;
    const b = JSON.parse(r.raw).battle;
    for (const id of b.yasen_rawapi?.api_friendly_info?.api_ship_id ?? b.rawapi?.api_friendly_info?.api_ship_id ?? []) ids.add(id);
  }
  if (!ids.size) return {};
  const src = await (await fetch("https://raw.githubusercontent.com/KC3Kai/kancolle-replay/master/js/kcSHIPDATA.js")).text();
  const ctx = vm.createContext({});
  vm.runInContext(`${src}\n;globalThis.__S = SHIPDATA;`, ctx);
  // kcSHIPDATA is a plain-data script (var SHIPDATA = {...}); read its table from the sandbox.
  const all = (ctx as { __S: Record<number, FriendStats> }).__S;
  return Object.fromEntries([...ids].flatMap((id) => (all[id] ? [[id, all[id]!]] : [])));
}

// Written by loadOnline above.
const input: Input = values.offline ? (JSON.parse(readFileSync(INPUT, "utf8")) as Input) : await loadOnline();
const master = masterFromRows(input.ships, input.equips);
const lookup = { ...master.lookup, detail: (id: number) => input.details[id] };

// ------------------------------------------------------------------ build ----

const FRIEND_FORMATION: Record<number, Formation> = {
  1: "lineAhead", 2: "doubleLine", 3: "diamond", 4: "echelon", 5: "lineAbreast", 6: "vanguard",
  11: "combinedAntiSub", 12: "combinedForward", 13: "combinedDiamond", 14: "combinedBattle",
};
const ENGAGEMENT: Record<number, Engagement> = { 1: "sameCourse", 2: "headOn", 3: "tAdvantage", 4: "tDisadvantage" };

/** KCNav ship → preset ship with its displayed stats as `observed` (what poi would import). */
function presetShip(s: BattleSetupShip, maxHp: number, nowHp: number): PresetShip {
  const slotNum = master.data.ships[s.id]?.api_slot_num ?? 4;
  const normal = Math.max(slotNum, 4);
  const equip = (j: number): PresetEquip | null => {
    const id = s.equips[j] ?? -1;
    if (id <= 0) return null;
    return { masterId: id, improvement: Math.max(0, s.improvements?.[j] ?? 0), proficiency: Math.max(0, s.proficiency?.[j] ?? 0), slotSize: s.slots?.[j] };
  };
  const st = s.stats;
  return {
    masterId: s.id, level: s.lvl, luckMod: 0, hpMod: 0, aswMod: 0, morale: s.morale ?? 49,
    equips: Array.from({ length: slotNum }, (_, j) => equip(j)),
    exSlot: s.equips.length === normal + 1 ? equip(normal) : null,
    observed: { maxHp, nowHp, firepower: st.fp, torpedo: st.tp, antiAir: st.aa, armor: st.ar, evasion: st.ev, asw: st.as, los: st.ls, luck: st.lk },
  };
}

interface Built { input: BattleInput; nakedDiff: number[][]; warnings: string[] }

/** One stored battle → BattleInput, or the reason it is not simulated. */
function build(r: Row): Built | string {
  if (r.kind === "unsupported") return `battle type ${r.api_name.split("/")[1]} (not modelled)`;
  if (r.verified === 0) return "day result disagrees with the night packet";
  const s = parseBattleSetup(JSON.parse(r.raw));
  const p = s.rawapi;
  const fleetType = COMBINED_FLAG_TYPES[s.fleet.fleettype] ?? "single";
  const main = s.fleet.fleet1.map((sh, i) => presetShip(sh, p.api_f_maxhps[i] ?? 0, p.api_f_nowhps[i] ?? 0));
  const escort = (s.fleet.fleet2 ?? []).map((sh, i) => presetShip(sh, p.api_f_maxhps_combined?.[i] ?? 0, p.api_f_nowhps_combined?.[i] ?? 0));
  if (fleetType !== "single" && !escort.length) return "combined fleet without escort data";
  const unknown = [...main, ...escort].filter((x) => !master.data.ships[x.masterId]);
  if (unknown.length) return "ship missing from master data";
  const friend = buildFriendShips(
    { id: String(r.id), name: "", createdAt: 0, updatedAt: 0, fleetType, formation: "line_ahead", ships: main, escort },
    master.data, { fitBonuses: input.fit },
  );
  const nakedDiff: number[][] = [];
  const setShip = (ship: ShipInput, k: BattleSetupShip, hp: number, param: number[] | undefined) => {
    ship.hp = hp;
    if (param) {
      // api_fParam is naked (no equipment, no fit bonus), so displayed − equipment − api_fParam is the game's own visible
      // bonus. buildFriendShips split displayed − equipment into naked + our fit-bonus data; move the difference
      // into equipBonus so naked and total FP/TP/AA/AR are both the game's.
      const [fp = 0, tp = 0, aa = 0, ar = 0] = param;
      const d = [ship.stats.firepower - fp, ship.stats.torpedo - tp, ship.stats.antiAir - aa, ship.stats.armor - ar] as const;
      nakedDiff.push([...d]);
      const b = ship.equipBonus ?? {};
      const bonus = { ...b, firepower: (b.firepower ?? 0) + d[0], torpedo: (b.torpedo ?? 0) + d[1], antiAir: (b.antiAir ?? 0) + d[2], armor: (b.armor ?? 0) + d[3] };
      ship.equipBonus = bonus;
      ship.stats = { ...ship.stats, firepower: fp, torpedo: tp, antiAir: aa, armor: ar };
    }
    if (k.fuel != null && ship.fuelMax) ship.fuel = Math.min(k.fuel, ship.fuelMax);
    if (k.ammo != null && ship.ammoMax) ship.ammo = Math.min(k.ammo, ship.ammoMax);
  };
  friend.input.forEach((sh, i) => setShip(sh, s.fleet.fleet1[i]!, p.api_f_nowhps[i] ?? sh.maxHp, p.api_fParam[i]));
  friend.escort?.forEach((sh, i) => setShip(sh, s.fleet.fleet2![i]!, p.api_f_nowhps_combined?.[i] ?? sh.maxHp, p.api_fParam_combined?.[i]));

  const enemyFleet = (ke: number[], lv: number[] | null | undefined, param: number[][] | null | undefined, slots: number[][] | null | undefined,
    maxhps: number[] | null | undefined, nowhps: number[] | null | undefined) => {
    const comp: CompShip[] = ke.flatMap((id, i) => id > 0 ? [{
      shipId: id, level: lv?.[i] ?? 1, hp: maxhps?.[i] ?? 1,
      fp: param?.[i]?.[0] ?? 0, tp: param?.[i]?.[1] ?? 0, aa: param?.[i]?.[2] ?? 0, ar: param?.[i]?.[3] ?? 0,
      equips: slots?.[i] ?? [],
    }] : []);
    const built = buildEnemyShips(comp, lookup);
    built.input.forEach((sh, i) => (sh.hp = nowhps?.[i] ?? sh.maxHp));
    return built;
  };
  const enemy = enemyFleet(p.api_ship_ke, p.api_ship_lv, p.api_eParam, p.api_eSlot, p.api_e_maxhps, p.api_e_nowhps);
  const enemyEscort = p.api_ship_ke_combined?.length
    ? enemyFleet(p.api_ship_ke_combined, p.api_ship_lv_combined, p.api_eParam_combined, p.api_eSlot_combined, p.api_e_maxhps_combined, p.api_e_nowhps_combined)
    : null;

  // Land-base waves as they flew. KCNav lists only the sortied bases, so a wave's base is found by its planes; the
  // squadron sizes are the counts its base launched in its first wave of this battle (KCNav's slots can be older).
  const lbas: LandBaseWave[] = [];
  const lbasBases: PresetAirBase[] = [];
  const firstWave = new Map<number, { id: number; count: number }[]>();
  for (const w of p.api_air_base_attack ?? []) {
    const planes = (w.api_squadron_plane ?? []).flatMap((q) => (q && q.api_mst_id > 0 ? [{ id: q.api_mst_id, count: q.api_count }] : []));
    if (!firstWave.has(w.api_base_id)) firstWave.set(w.api_base_id, planes);
    const launched = firstWave.get(w.api_base_id)!;
    const key = launched.map((q) => q.id).join(",");
    const base = s.fleet.lbas?.find((b) => b.planes.filter((id) => id > 0).join(",") === key);
    if (!base) return "land base missing from KCNav's fleet";
    const slotOf = base.planes.flatMap((id, j) => (id > 0 ? [j] : []));
    const preset: PresetAirBase = {
      mode: "sortie", targets: [r.node_letter, r.node_letter],
      squadrons: launched.map((q, k) => {
        const j = slotOf[k]!;
        return { masterId: q.id, improvement: Math.max(0, base.improvements[j] ?? 0), proficiency: Math.max(0, base.proficiency[j] ?? 0), slotSize: q.count };
      }),
    };
    const squadrons = buildSquadrons(preset, master.data);
    if (squadrons.length) {
      lbas.push({ squadrons });
      lbasBases.push(preset);
    }
  }

  // Support expedition that arrived (api_support_flag / api_n_support_flag): KCNav's `fleet.support` ships, forced to
  // arrive with the observed type. Their HP does not matter (enemies do not shoot back) and is the master's level-1 HP.
  const SUPPORT_TYPE: Record<number, SupportType> = { 1: "air", 2: "shelling", 3: "torpedo", 4: "asw" };
  const flag = p.api_support_flag || p.api_n_support_flag || s.yasen_rawapi?.api_n_support_flag || 0;
  let support: SupportInput | undefined;
  const warnings: string[] = [];
  if (flag > 0) {
    if (!s.fleet.support?.length) return "support arrived but KCNav has no support fleet";
    const ships = s.fleet.support.map((sh) => {
      const hp = master.data.ships[sh.id]?.api_taik?.[0] ?? 1;
      return presetShip(sh, hp, hp);
    });
    if (ships.some((x) => !master.data.ships[x.masterId])) return "ship missing from master data";
    const built = buildFriendShips({ id: "", name: "", createdAt: 0, updatedAt: 0, fleetType: "single", formation: "line_ahead", ships }, master.data, { fitBonuses: input.fit });
    warnings.push(...built.warnings);
    support = { fleet: { ships: built.input }, type: SUPPORT_TYPE[flag], chance: 1 };
  }

  // Event friend fleet (api_friendly_info): FP/TP/AA/AR naked from api_Param, equipment from api_Slot (improvements
  // unknown: 0), HP as sent. EV/ASW/LoS (scaled to the level) and luck from kancolle-replay kcSHIPDATA.
  let friendFleetIn: FriendFleetInput | undefined;
  const fi = s.yasen_rawapi?.api_friendly_info ?? p.api_friendly_info;
  if (fi) {
    const ships: PresetShip[] = fi.api_ship_id.map((id, i) => {
      const slotNum = master.data.ships[id]?.api_slot_num ?? 4;
      const eq = (e: number | undefined): PresetEquip | null => (e && e > 0 ? { masterId: e, improvement: 0, proficiency: 7 } : null);
      return {
        masterId: id, level: fi.api_ship_lv[i] ?? 1, luckMod: 0, hpMod: 0, aswMod: 0, morale: 49,
        equips: Array.from({ length: slotNum }, (_, j) => eq(fi.api_Slot[i]?.[j])),
        exSlot: eq(fi.api_slot_ex?.[i]),
      };
    });
    if (ships.some((x) => !master.data.ships[x.masterId])) return "friend fleet ship missing from master data";
    const built = buildFriendShips({ id: "", name: "", createdAt: 0, updatedAt: 0, fleetType: "single", formation: "line_ahead", ships }, master.data);
    built.input.forEach((sh, i) => {
      const [fp = 0, tp = 0, aa = 0, ar = 0] = fi.api_Param[i] ?? [];
      sh.maxHp = fi.api_maxhps[i] ?? sh.maxHp;
      sh.hp = fi.api_nowhps[i] ?? sh.maxHp;
      const k = input.friendStats?.[sh.id ?? 0];
      const lv = (base: number, max: number) => Math.floor(base + ((max - base) * (sh.level ?? 1)) / 99);
      sh.stats = {
        ...sh.stats, firepower: fp, torpedo: tp, antiAir: aa, armor: ar,
        ...(k ? { evasion: lv(k.EVbase, k.EV), asw: lv(k.ASWbase, k.ASW), los: lv(k.LOSbase, k.LOS), luck: k.LUK } : {}),
      };
      delete sh.equipBonus;
    });
    friendFleetIn = { fleet: { ships: built.input }, chance: 1 };
  }

  // Event historical bonuses at this node (kancolle-replay data via GET /maps/{map}/bonuses); debuffs only with
  // --debuffs, since whether the player had cleared the armor gimmick is not in the data.
  const res = input.eventBonuses[r.map_id];
  const bonusIn: Partial<BattleInput> = {};
  if (res) {
    const preset: Preset = { id: "", name: "", createdAt: 0, updatedAt: 0, fleetType, formation: "line_ahead", ships: main, escort };
    const b = buildBonuses(preset, res, master.data, { lbas: lbasBases });
    warnings.push(...b.warnings);
    const at = <T extends object>(xs: (NodeBonus<T> | null)[] | undefined) => xs?.map((x) => bonusAt(x, r.node_letter));
    if (b.bonuses.some((x) => bonusAt(x, r.node_letter))) bonusIn.bonuses = at(b.bonuses);
    if (b.escortBonuses?.some((x) => bonusAt(x, r.node_letter))) bonusIn.escortBonuses = at(b.escortBonuses);
    if (b.lbasBonuses?.some((x) => bonusAt(x, r.node_letter))) bonusIn.lbasBonuses = at(b.lbasBonuses);
    if (values.debuffs) {
      const d = debuffsAt(res, r.node_letter);
      if (d.length) bonusIn.debuffs = d;
    }
  }
  const formation = FRIEND_FORMATION[r.formation ?? 1];
  const engagement = ENGAGEMENT[r.engagement ?? 0];
  // Night pursuit is the player's choice, and only offered while an enemy is afloat. A day-only battle that ended with
  // every enemy sunk says nothing about that choice; simulating it as `day` would score the model on battles selected
  // for a good day result (6-5 M: 27 such battles, S 100% observed vs 82% simulated as day-only). At boss nodes, where
  // players pursue, such battles are simulated as `dayNight` (the night only happens when the simulation leaves an
  // enemy afloat); elsewhere, and whenever an enemy survived the day, as observed. [inference: boss pursuit policy]
  const annihilated = JSON.parse(r.outcome).enemy.every(([, before, after]: [number, number, number]) => before <= 0 || after <= 0);
  // KCNav marks boss battles on the entry (`is_boss`).
  const isBoss = (JSON.parse(r.raw) as { is_boss?: boolean }).is_boss === true;
  const kind = r.kind === "day" && isBoss && annihilated && !values["no-pursuit"] ? "dayNight" : r.kind;
  return {
    input: {
      friend: friendFleet(friend, formation),
      // Enemy combined fleets use the combined cruising formations (api_formation 11–14), single fleets 1–6.
      enemy: enemyEscort
        ? { ships: enemy.input, escort: enemyEscort.input, formation: FRIEND_FORMATION[r.enemy_formation ?? 14] ?? "combinedBattle" }
        : { ships: enemy.input, formation: ENEMY_FORMATION_BY_ID[r.enemy_formation ?? 1] ?? "lineAhead" },
      // The kind is a sim-core BattleKind here (unsupported kinds returned above).
      options: { kind: kind as NonNullable<BattleInput["options"]>["kind"], ...(engagement ? { engagement } : {}) },
      ...(lbas.length ? { lbas } : {}),
      ...(support ? { support } : {}),
      ...(friendFleetIn ? { friendFleet: friendFleetIn } : {}),
      ...bonusIn,
    },
    nakedDiff,
    warnings: [...friend.warnings, ...enemy.warnings, ...(enemyEscort?.warnings ?? []), ...warnings],
  };
}

// --------------------------------------------------------------- simulate ----

const RANKS = ["S", "A", "B", "C", "D", "E"] as const;
const rankIdx = (r: string) => (r === "SS" ? 0 : Math.max(0, RANKS.indexOf(r as (typeof RANKS)[number])));
/** End-state index: 0 sunk, 1 heavy (≤ 25%), 2 moderate (≤ 50%), 3 light (≤ 75%), 4 healthy (sim-core DamageState). */
const stateIdx = (hp: number, max: number) => (hp <= 0 ? 0 : hp / max <= 0.25 ? 1 : hp / max <= 0.5 ? 2 : hp / max <= 0.75 ? 3 : 4);
const PHASES: [string, OutcomePhase][] = [
  ["landBase", "lbas"], ["airStrike", "air"], ["openingAsw", "opening_asw"], ["openingTorpedo", "opening_torpedo"],
  ["shelling1", "shelling1"], ["shelling2", "shelling2"], ["shelling3", "shelling3"], ["closingTorpedo", "closing_torpedo"], ["night", "night"],
  ["support", "support"], ["friendFleet", "friendFleet"],
];
const AIR: Record<number, keyof SimulationSummary["airStateRates"]> = { 0: "parity", 1: "supremacy", 2: "superiority", 3: "denial", 4: "incapability" };

interface ShipScore { p: number[]; o: number; start: number; hpPred: number; hpAct: number; max: number; before: number }
interface Scored {
  row: Row; node: string; fleet: string; lbas: boolean;
  rankP: number[]; rankO: number;
  friend: ShipScore[]; enemy: ShipScore[];
  phasePred: Partial<Record<OutcomePhase, [number, number]>>; phaseAct: Partial<Record<OutcomePhase, [number, number]>>;
  airP: number | null; airHit: boolean | null;
}

const skipped = new Map<string, number>();
const nakedDiffs: number[][] = [];
let warnings = 0;
const scored: Scored[] = [];
const t0 = performance.now();
for (const r of input.rows) {
  let b: Built | string;
  try {
    b = build(r);
  } catch (e) {
    b = `input error: ${String(e).slice(0, 80)}`;
  }
  if (typeof b === "string") {
    skipped.set(b, (skipped.get(b) ?? 0) + 1);
    continue;
  }
  const sum = simulateBattle(b.input, RUNS, r.id);
  // Stored by src/kcnav/battles.ts normalizeBattle.
  const out = JSON.parse(r.outcome) as BattleOutcome;
  if (out.friend.length !== sum.friend.length || out.enemy.length !== sum.enemy.length) {
    skipped.set("fleet size differs from the packet", (skipped.get("fleet size differs from the packet") ?? 0) + 1);
    continue;
  }
  nakedDiffs.push(...b.nakedDiff);
  warnings += b.warnings.length;
  const rr = sum.rankRates;
  const ship = (s: SimulationSummary["friend"][number], [max, before, after]: [number, number, number]): ShipScore => ({
    p: [s.sunkRate, s.heavyRate, s.moderateRate, s.lightRate, s.healthyRate], o: stateIdx(after, max), start: stateIdx(before, max),
    hpPred: s.hpMean, hpAct: after, max, before,
  });
  const phasePred: Scored["phasePred"] = {};
  for (let k = 0; k < LOGGED; k++) {
    const run = runBattle({ ...b.input, options: { ...b.input.options, log: true } }, r.id * 1000 + k);
    for (const e of run.result.events ?? []) {
      const ph = PHASES.find(([sim]) => sim === e.phase)?.[1];
      if (!ph) continue;
      const t = (phasePred[ph] ??= [0, 0]);
      t[e.attackerSide === "friend" ? 0 : 1] += e.damage / LOGGED;
    }
  }
  const air = r.air_state === null ? null : AIR[r.air_state];
  scored.push({
    row: r, node: `${Math.floor(r.map_id / 10)}-${r.map_id % 10} ${r.node_letter}`, fleet: r.fleet_type ? "combined" : "single", lbas: r.lbas_waves > 0,
    rankP: [rr.SS + rr.S, rr.A, rr.B, rr.C, rr.D, rr.E], rankO: rankIdx(r.rank),
    friend: sum.friend.map((s, i) => ship(s, out.friend[i]!)).filter((s) => s.before > 0),
    enemy: sum.enemy.map((s, i) => ship(s, out.enemy[i]!)).filter((s) => s.before > 0),
    phasePred, phaseAct: out.phases,
    airP: air ? sum.airStateRates[air] : null,
    airHit: air ? Object.entries(sum.airStateRates).sort((a, c) => c[1] - a[1])[0]![0] === air : null,
  });
}
const simSeconds = (performance.now() - t0) / 1000;

// ---------------------------------------------------------------- scoring ----

const brier = (p: number[], o: number) => p.reduce((s, v, k) => s + (v - (k === o ? 1 : 0)) ** 2, 0);
/** −ln p of the outcome, the model's p smoothed as (p·N + ½)/(N + ½K) so a 0 from finite runs stays finite. */
const logLoss = (p: number[], o: number, n: number) => -Math.log(((p[o] ?? 0) * n + 0.5) / (n + 0.5 * p.length));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Leave-one-out class frequencies of `items` grouped by `key` (fallback: all items) for item i. */
function looFreq<T>(items: T[], cls: (t: T) => number, k: number, key: (t: T) => string, minGroup = 10): number[][] {
  const all = new Array(k).fill(0);
  const byKey = new Map<string, number[]>();
  for (const t of items) {
    all[cls(t)]++;
    const g = byKey.get(key(t)) ?? new Array(k).fill(0);
    g[cls(t)]++;
    byKey.set(key(t), g);
  }
  return items.map((t) => {
    const g = byKey.get(key(t))!;
    const own = cls(t);
    const n = g.reduce((a, b) => a + b, 0) - 1;
    const src = n >= minGroup ? g : all;
    const tot = src.reduce((a, b) => a + b, 0) - 1;
    return src.map((c, j) => (c - (j === own ? 1 : 0) + 0.5) / (tot + 0.5 * k));
  });
}

// Baselines over every scored battle: rank frequencies at the node (≥ 10 other battles there, else everywhere) and
// everywhere; ship end states given the ship's damage state at the start; enemy sinking at the node.
const rankNode = looFreq(scored, (s) => s.rankO, 6, (s) => s.node);
const rankAll = looFreq(scored, (s) => s.rankO, 6, () => "");
const friendShips = scored.flatMap((s, i) => s.friend.map((f) => ({ f, i })));
const friendBase = looFreq(friendShips, (x) => x.f.o, 5, (x) => String(x.f.start), 1);
const enemyShips = scored.flatMap((s, i) => s.enemy.map((e) => ({ e, i })));
const enemyBase = looFreq(enemyShips, (x) => (x.e.o === 0 ? 1 : 0), 2, (x) => scored[x.i]!.node);
/** Naive HP baseline: the share of starting HP a ship keeps on average (leave-one-out, per side). */
const keepShare = (xs: ShipScore[]) => {
  const tot = xs.reduce((a, s) => a + s.hpAct / s.before, 0);
  return (s: ShipScore) => (s.before * (tot - s.hpAct / s.before)) / (xs.length - 1);
};
const friendKeep = keepShare(friendShips.map((x) => x.f));
const enemyKeep = keepShare(enemyShips.map((x) => x.e));

interface Metric { model: number; base: number }
interface Stats {
  n: number; ships: number; obsS: number; predS: number; obsAp: number; predAp: number;
  rank: Metric; rankGlobal: number; rankLog: Metric; skill: [number, number, number]; skillGlobal: number;
  state: Metric; stateSkill: [number, number, number]; taiha: Metric; enemySunk: Metric;
  hpFriend: Metric; hpEnemy: Metric; biasFriend: number; biasEnemy: number; air: number; airHit: number;
}

let seed = 12345;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** Skill 1 − Σmodel/Σbase with a battle-level bootstrap 95% interval. */
function skillCi(model: number[], base: number[]): [number, number, number] {
  const point = 1 - model.reduce((a, b) => a + b, 0) / base.reduce((a, b) => a + b, 0);
  if (model.length < 2) return [point, NaN, NaN];
  const reps: number[] = [];
  for (let b = 0; b < BOOT; b++) {
    let m = 0, s = 0;
    for (let i = 0; i < model.length; i++) {
      const j = Math.floor(rand() * model.length);
      m += model[j]!;
      s += base[j]!;
    }
    reps.push(1 - m / s);
  }
  reps.sort((a, b) => a - b);
  return [point, reps[Math.floor(0.025 * BOOT)]!, reps[Math.floor(0.975 * BOOT)]!];
}

function stats(idx: number[]): Stats {
  const S = idx.map((i) => scored[i]!);
  const set = new Set(idx);
  const fs = friendShips.map((x, j) => ({ ...x, j })).filter((x) => set.has(x.i));
  const es = enemyShips.map((x, j) => ({ ...x, j })).filter((x) => set.has(x.i));
  const rankM = S.map((s) => brier(s.rankP, s.rankO));
  const rankB = idx.map((i) => brier(rankNode[i]!, scored[i]!.rankO));
  // Ship states: per battle sums, so the bootstrap resamples battles.
  const perBattle = (xs: typeof fs, f: (x: (typeof fs)[number]) => number) => idx.map((i) => xs.filter((x) => x.i === i).reduce((a, x) => a + f(x), 0));
  const stateM = perBattle(fs, (x) => brier(x.f.p, x.f.o));
  const stateB = perBattle(fs, (x) => brier(friendBase[x.j]!, x.f.o));
  const taihaP = (p: number[]) => (p[0] ?? 0) + (p[1] ?? 0);
  const taiha = (x: (typeof fs)[number], p: number[]) => (taihaP(p) - (x.f.o <= 1 ? 1 : 0)) ** 2;
  const air = S.filter((s) => s.airP !== null);
  return {
    n: S.length, ships: fs.length,
    obsS: mean(S.map((s) => (s.rankO === 0 ? 1 : 0))), predS: mean(S.map((s) => s.rankP[0]!)),
    obsAp: mean(S.map((s) => (s.rankO <= 1 ? 1 : 0))), predAp: mean(S.map((s) => s.rankP[0]! + s.rankP[1]!)),
    rank: { model: mean(rankM), base: mean(rankB) },
    rankGlobal: mean(idx.map((i) => brier(rankAll[i]!, scored[i]!.rankO))),
    rankLog: { model: mean(S.map((s) => logLoss(s.rankP, s.rankO, RUNS))), base: mean(idx.map((i) => -Math.log(rankNode[i]![scored[i]!.rankO]!))) },
    skill: skillCi(rankM, rankB),
    skillGlobal: 1 - mean(rankM) / mean(idx.map((i) => brier(rankAll[i]!, scored[i]!.rankO))),
    state: { model: mean(fs.map((x) => brier(x.f.p, x.f.o))), base: mean(fs.map((x) => brier(friendBase[x.j]!, x.f.o))) },
    stateSkill: skillCi(stateM, stateB),
    taiha: { model: mean(fs.map((x) => taiha(x, x.f.p))), base: mean(fs.map((x) => taiha(x, friendBase[x.j]!))) },
    enemySunk: {
      model: mean(es.map((x) => (x.e.p[0]! - (x.e.o === 0 ? 1 : 0)) ** 2)),
      base: mean(es.map((x) => (enemyBase[x.j]![1]! - (x.e.o === 0 ? 1 : 0)) ** 2)),
    },
    hpFriend: { model: mean(fs.map((x) => Math.abs(x.f.hpPred - x.f.hpAct))), base: mean(fs.map((x) => Math.abs(friendKeep(x.f) - x.f.hpAct))) },
    hpEnemy: { model: mean(es.map((x) => Math.abs(x.e.hpPred - x.e.hpAct))), base: mean(es.map((x) => Math.abs(enemyKeep(x.e) - x.e.hpAct))) },
    biasFriend: mean(fs.map((x) => x.f.hpPred - x.f.hpAct)), biasEnemy: mean(es.map((x) => x.e.hpPred - x.e.hpAct)),
    air: mean(air.map((s) => s.airP!)), airHit: mean(air.map((s) => (s.airHit ? 1 : 0))),
  };
}

/** Wilson 95% interval of k successes in n. */
function wilson(k: number, n: number): [number, number] {
  if (!n) return [NaN, NaN];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function reliability(points: { p: number; y: number }[]): string[] {
  const rows: string[] = ["| predicted | n | mean predicted | observed [95% CI] |", "|---|---|---|---|"];
  for (let b = 0; b < 10; b++) {
    const lo = b / 10, hi = (b + 1) / 10;
    const inBin = points.filter((x) => x.p >= lo && (x.p < hi || (b === 9 && x.p <= 1)));
    if (!inBin.length) continue;
    const k = inBin.filter((x) => x.y).length;
    const [l, h] = wilson(k, inBin.length);
    rows.push(`| ${pct(lo, 0)}–${pct(hi, 0)} | ${inBin.length} | ${pct(mean(inBin.map((x) => x.p)))} | ${pct(k / inBin.length)} [${pct(l)}, ${pct(h)}] |`);
  }
  return rows;
}

// ---------------------------------------------------------------- report ----

const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(100 * x).toFixed(d)}%` : "–");
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "–");
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "–");
const ci = ([p, l, h]: [number, number, number]) => `${f3(p)} [${f3(l)}, ${f3(h)}]`;
const all = scored.map((_, i) => i);
const head = stats(all);
const engine = Bun.spawnSync(["git", "log", "-1", "--format=%h %cs", "--", "sim-core/src"], { cwd: ROOT }).stdout.toString().trim();
const maps = [...new Set(input.rows.map((r) => `${Math.floor(r.map_id / 10)}-${r.map_id % 10}`))].sort();
const dates = input.rows.map((r) => r.battle_at.slice(0, 10)).sort();

const groupTable = (title: string, key: (s: Scored) => string, minN = 1): string[] => {
  const groups = new Map<string, number[]>();
  scored.forEach((s, i) => groups.set(key(s), [...(groups.get(key(s)) ?? []), i]));
  const lines = [
    `#### By ${title}`, "",
    `| ${title} | n | S obs / pred | A+ obs / pred | rank Brier model / node base | rank skill [95% CI] | ship-state skill [95% CI] | HP MAE friend / enemy |`,
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const [k, idx] of [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    if (idx.length < minN) continue;
    const s = stats(idx);
    lines.push(`| ${k} | ${s.n} | ${pct(s.obsS)} / ${pct(s.predS)} | ${pct(s.obsAp)} / ${pct(s.predAp)} | ${f3(s.rank.model)} / ${f3(s.rank.base)} | ${ci(s.skill)} | ${ci(s.stateSkill)} | ${f1(s.hpFriend.model)} / ${f1(s.hpEnemy.model)} |`);
  }
  return [...lines, ""];
};

const phaseLines = (): string[] => {
  const lines = [
    "| phase | HP removed from the enemy: observed / simulated (ratio) | from the player: observed / simulated (ratio) |",
    "|---|---|---|",
  ];
  for (const [, ph] of PHASES) {
    const total = (pick: (s: Scored) => [number, number] | undefined, k: 0 | 1) => scored.reduce((a, s) => a + (pick(s)?.[k] ?? 0), 0);
    const act = [total((s) => s.phaseAct[ph], 0), total((s) => s.phaseAct[ph], 1)] as const;
    const pred = [total((s) => s.phasePred[ph], 0), total((s) => s.phasePred[ph], 1)] as const;
    if (!act[0] && !act[1] && !pred[0] && !pred[1]) continue;
    const per = (x: number) => f1(x / scored.length);
    const ratio = (p: number, a: number) => (a > 0 ? (p / a).toFixed(2) : "–");
    lines.push(`| ${ph} | ${per(act[0])} / ${per(pred[0])} (${ratio(pred[0], act[0])}) | ${per(act[1])} / ${per(pred[1])} (${ratio(pred[1], act[1])}) |`);
  }
  return lines;
};

const nd = nakedDiffs.length;
const exact = (k: number) => nakedDiffs.filter((d) => d[k] === 0).length / nd;
const skippedLines = [...skipped].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("; ") || "none";
const rankCal = RANKS.map((r, k) => `${r} ${pct(mean(scored.map((s) => (s.rankO === k ? 1 : 0))))} / ${pct(mean(scored.map((s) => s.rankP[k]!)))}`).join(" · ");

const out: string[] = [
  `Generated by \`bun scripts/battle-accuracy.ts\` (server/) on ${new Date().toISOString().slice(0, 10)}: engine = sim-core/src at ${engine || "?"}, ${RUNS} runs per battle (${LOGGED} with event logs for the phases), seeds = KCNav battle ids${values.debuffs ? ", event armor debuffs on" : ""}${values["no-pursuit"] ? ", no boss night pursuit" : ""}. Inputs saved ${input.savedAt.slice(0, 16)}Z.`,
  "",
  `Data: ${input.rows.length} KCNav battles (${maps.join(", ")}; ${dates[0] ?? "–"} … ${dates.at(-1) ?? "–"}). **Scored: ${scored.length} battles, ${head.ships} player ships.** Not simulated: ${skippedLines}.`,
  "",
  "Baselines are leave-one-out frequencies over the scored battles: ranks at the same node (≥ 10 other battles there, else all nodes), ship end states given the ship's state at the start, enemy sinking at the node, HP as the average kept share of the starting HP. Skill = 1 − model / baseline (> 0 beats the baseline); 95% intervals bootstrap the battles.",
  "",
  "| | model | baseline | skill |",
  "|---|---|---|---|",
  `| rank Brier (6 classes, SS+S merged) | ${f3(head.rank.model)} | ${f3(head.rank.base)} node · ${f3(head.rankGlobal)} all | ${ci(head.skill)} vs node · ${f3(head.skillGlobal)} vs all |`,
  `| rank log-loss | ${f3(head.rankLog.model)} | ${f3(head.rankLog.base)} | – |`,
  `| player ship end state Brier (5 classes) | ${f3(head.state.model)} | ${f3(head.state.base)} | ${ci(head.stateSkill)} |`,
  `| P(player ship heavily damaged or sunk) Brier | ${f3(head.taiha.model)} | ${f3(head.taiha.base)} | ${f3(1 - head.taiha.model / head.taiha.base)} |`,
  `| P(enemy ship sunk) Brier | ${f3(head.enemySunk.model)} | ${f3(head.enemySunk.base)} | ${f3(1 - head.enemySunk.model / head.enemySunk.base)} |`,
  `| player HP after: MAE (bias sim − real) | ${f1(head.hpFriend.model)} HP (${f1(head.biasFriend)}) | ${f1(head.hpFriend.base)} HP | ${f3(1 - head.hpFriend.model / head.hpFriend.base)} |`,
  `| enemy HP after: MAE (bias sim − real) | ${f1(head.hpEnemy.model)} HP (${f1(head.biasEnemy)}) | ${f1(head.hpEnemy.base)} HP | ${f3(1 - head.hpEnemy.model / head.hpEnemy.base)} |`,
  `| air state: mean P(observed) · most likely = observed | ${pct(head.air)} · ${pct(head.airHit)} | – | – |`,
  "",
  `Rank, observed / mean predicted: ${rankCal}.`,
  "",
  "#### Reliability: P(S or SS)",
  "",
  ...reliability(scored.map((s) => ({ p: s.rankP[0]!, y: s.rankO === 0 ? 1 : 0 }))),
  "",
  "#### Reliability: P(A or better)",
  "",
  ...reliability(scored.map((s) => ({ p: s.rankP[0]! + s.rankP[1]!, y: s.rankO <= 1 ? 1 : 0 }))),
  "",
  "#### Reliability: P(player ship heavily damaged or sunk)",
  "",
  ...reliability(friendShips.map((x) => ({ p: x.f.p[0]! + x.f.p[1]!, y: x.f.o <= 1 ? 1 : 0 }))),
  "",
  "#### Reliability: P(enemy ship sunk)",
  "",
  ...reliability(enemyShips.map((x) => ({ p: x.e.p[0]!, y: x.e.o === 0 ? 1 : 0 }))),
  "",
  ...groupTable("outcome spread", (s) => {
    const atNode = scored.filter((x) => x.node === s.node);
    const top = Math.max(...RANKS.map((_, k) => atNode.filter((x) => x.rankO === k).length)) / atNode.length;
    return top > 0.9 ? "decided node (one rank > 90%)" : "contested node (no rank > 90%)";
  }),
  ...groupTable("map", (s) => s.node.split(" ")[0]!),
  ...groupTable("node", (s) => s.node),
  ...groupTable("battle type", (s) => s.row.kind),
  ...groupTable("fleet", (s) => `${s.fleet}${s.lbas ? " + land bases" : ""}`),
  ...groupTable("enemy fleet", (s) => (s.row.enemy_combined ? "combined (12 ships)" : "single")),
  ...groupTable("extra fleets", (s) => [s.row.support ? "support" : "", s.row.friend_fleet ? "friend fleet" : ""].filter(Boolean).join(" + ") || "none"),
  "#### HP removed per phase (mean per battle; overkill included)",
  "",
  ...phaseLines(),
  "",
  `Inputs: player FP/TP/AA/AR are naked from the packet's api_fParam, with the visible equipment bonus taken as displayed − equipment − api_fParam (the game's own). Our fit-bonus data (kancolle-replay mst_slotitem_bonus.json, shared/sim/fit.ts) gave that same bonus for ${pct(exact(0))} / ${pct(exact(1))} / ${pct(exact(2))} / ${pct(exact(3))} of ${nd} ships (FP / TP / AA / AR); the web UI, which has only displayed stats, would mis-split the rest. EV / ASW / LoS use our fit data for the split (totals are the displayed ones). ${warnings} adapter warnings. Simulation took ${simSeconds.toFixed(0)} s.`,
];

// ---------------------------------------------------------------- outputs ----

interface Summary {
  generatedAt: string; engine: string; runs: number; scored: number;
  rankBrier: number; rankSkillNode: number; rankLogLoss: number; stateBrier: number; taihaBrier: number; enemySunkBrier: number;
  hpMaeFriend: number; hpMaeEnemy: number; predS: number; obsS: number;
}
const summary: Summary = {
  generatedAt: new Date().toISOString(), engine, runs: RUNS, scored: scored.length,
  rankBrier: head.rank.model, rankSkillNode: head.skill[0], rankLogLoss: head.rankLog.model, stateBrier: head.state.model,
  taihaBrier: head.taiha.model, enemySunkBrier: head.enemySunk.model, hpMaeFriend: head.hpFriend.model, hpMaeEnemy: head.hpEnemy.model,
  predS: head.predS, obsS: head.obsS,
};
if (existsSync(SUMMARY)) {
  // Written by this script.
  const prev = JSON.parse(readFileSync(SUMMARY, "utf8")) as Summary;
  const rows: [string, keyof Summary, (x: number) => string][] = [
    ["scored battles", "scored", String], ["rank Brier", "rankBrier", f3], ["rank skill vs node", "rankSkillNode", f3],
    ["rank log-loss", "rankLogLoss", f3], ["ship end state Brier", "stateBrier", f3], ["P(heavy or sunk) Brier", "taihaBrier", f3],
    ["P(enemy sunk) Brier", "enemySunkBrier", f3], ["player HP MAE", "hpMaeFriend", f1], ["enemy HP MAE", "hpMaeEnemy", f1],
    ["P(S) predicted / observed", "predS", pct],
  ];
  console.log(`vs previous summary (${prev.generatedAt.slice(0, 16)}, engine ${prev.engine}, ${prev.scored} battles):`);
  for (const [, k] of rows) console.log(`  ${k}: ${prev[k]} → ${summary[k]}`);
  // An engine change on the same battles (e.g. --offline after a sim-core merge) goes into the document.
  if (prev.engine !== engine && prev.scored === summary.scored) {
    out.push("", `#### Change against the previous engine (sim-core/src at ${prev.engine}, same ${prev.scored} battles)`, "",
      "| | before | now |", "|---|---|---|",
      ...rows.map(([label, k, f]) => `| ${label} | ${f(Number(prev[k]))}${k === "predS" ? ` / ${pct(prev.obsS)}` : ""} | ${f(Number(summary[k]))}${k === "predS" ? ` / ${pct(summary.obsS)}` : ""} |`));
  }
}
writeFileSync(SUMMARY, `${JSON.stringify(summary, null, 2)}\n`);
if (!values["no-doc"]) {
  const begin = "<!-- battle-accuracy:begin -->";
  const end = "<!-- battle-accuracy:end -->";
  const doc = readFileSync(DOC, "utf8");
  const i = doc.indexOf(begin);
  const j = doc.indexOf(end);
  if (i < 0 || j < 0) throw new Error(`markers missing in ${DOC}`);
  writeFileSync(DOC, `${doc.slice(0, i + begin.length)}\n${out.join("\n")}\n${doc.slice(j)}`);
}
console.log(out.join("\n"));
