// KCNav per-battle records: `GET /api/routing/maps/{m}/edges/{e,…}/battles?start&end&page&perPage`
// (docs/DATA_SOURCES.md §1 "Battles"). One page holds up to 50 battles of the edges' node, each with the
// player's fleet (ships with level, equipment, displayed stats, fuel/ammo/morale; land bases) and the raw
// game packets of the day and night battle. The outcome is recomputed from the packets: KCNav's own
// `results` miss damage (2026-10-23: 7-4 P day results disagreed with the night packet's starting HP in
// 5 of 9 battles; the packets agreed in all 32 checked).
import * as z from "zod";
import { extractAttackEvents } from "../../../shared/capture/parser";
import type { AttackPhase } from "../../../shared/capture/types";
import type { QueueRow } from "./tick";

const nums = z.array(z.number());
const stage3 = z.object({ api_edam: nums.nullish() }).loose();
const support = z.object({
  api_support_hourai: z.object({ api_damage: nums }).loose().nullish(),
  api_support_airatack: z.object({ api_stage3: stage3.nullish(), api_stage3_combined: stage3.nullish() }).loose().nullish(),
}).loose();
/** The fields of a battle packet (`rawapi` / `yasen_rawapi`) the outcome needs; the rest goes to extractAttackEvents. */
const packetSchema = z.object({
  api_f_maxhps: nums, api_f_nowhps: nums, api_e_maxhps: nums, api_e_nowhps: nums,
  api_f_maxhps_combined: nums.nullish(), api_f_nowhps_combined: nums.nullish(),
  api_e_maxhps_combined: nums.nullish(), api_e_nowhps_combined: nums.nullish(),
  api_formation: nums.nullish(),
  api_search: nums.nullish(),
  api_kouku: z.object({ api_stage1: z.object({ api_disp_seiku: z.number().nullish() }).loose().nullish() }).loose().nullish(),
  api_support_flag: z.number().nullish(),
  api_support_info: support.nullish(),
  api_n_support_flag: z.number().nullish(),
  api_n_support_info: support.nullish(),
  api_air_base_attack: z.array(z.unknown()).nullish(),
  api_air_base_injection: z.unknown().nullish(),
  api_friendly_info: z.unknown().nullish(),
  api_friendly_kouku: z.unknown().nullish(),
  api_friendly_battle: z.object({ api_hougeki: z.unknown() }).loose().nullish(),
}).loose();
type Packet = z.infer<typeof packetSchema>;

const fleetShip = z.object({ id: z.number().int(), lvl: z.number().int(), equips: nums }).loose();
const entrySchema = z.object({
  battle: z.object({
    id: z.number().int().positive(),
    map: z.string(),
    node: z.number().int(),
    datetime: z.string(),
    apiname: z.string(),
    yasen_apiname: z.string().nullish(),
    rawapi: z.record(z.string(), z.unknown()),
    yasen_rawapi: z.record(z.string(), z.unknown()).nullish(),
    fleet: z.object({ fleettype: z.number().int(), fleet1: z.array(fleetShip).min(1), fleet2: z.array(fleetShip).nullish() }).loose(),
  }).loose(),
}).loose();
export type BattleEntry = z.infer<typeof entrySchema>;

const pageSchema = z.object({
  result: z.object({
    battles: z.array(z.unknown()).nullish(),
    pageCount: z.number().int().nullish(),
    entryCount: z.number().int().nullish(),
    perPage: z.number().int().nullish(),
    /** Set when the cached body was replaced by this stub after the battles were stored (see storeBattles). */
    storedIn: z.literal("kcnav_battles").nullish(),
    ids: z.array(z.number().int()).nullish(),
  }).loose(),
}).loose();

/** sim-core `BattleKind` of a packet pair, or null for kinds the engine does not model (radar ambush, night-to-day). */
export type BattleKindName = "day" | "dayNight" | "nightOnly" | "airBattle" | "airRaid";

export function battleKind(apiName: string, yasen: boolean): BattleKindName | null {
  const name = apiName.slice(apiName.lastIndexOf("/") + 1);
  if (name.includes("night_to_day") || name === "ld_shooting") return null;
  if (name.includes("sp_midnight")) return "nightOnly";
  if (name === "ld_airbattle") return "airRaid";
  if (name === "airbattle") return "airBattle";
  if (name.endsWith("battle") || name.endsWith("battle_water")) return yasen ? "dayNight" : "day";
  return null;
}

/** Where HP went: AttackPhase from the packets, plus land bases, support expeditions and event friend fleets. */
export type OutcomePhase = AttackPhase | "lbas" | "support" | "nightSupport" | "friendFleet";

export interface BattleOutcome {
  /** [max, before, after] per ship (after ≥ 0); main fleet first, then the escort from index `friendMain`. */
  friend: [number, number, number][];
  friendMain: number;
  enemy: [number, number, number][];
  enemyMain: number;
  /** HP after the day phases, when a night battle followed. */
  dayEnd: { friend: number[]; enemy: number[] } | null;
  /** HP removed per phase: [from the enemy, from the friend fleet] (overkill included). */
  phases: Partial<Record<OutcomePhase, [number, number]>>;
  /** Day result equals the night packet's starting HP; null without a night battle (nothing to check). */
  verified: boolean | null;
}

export type Rank = "SS" | "S" | "A" | "B" | "C" | "D" | "E";

export interface NormalizedBattle {
  id: number;
  map: string;
  edgeId: number;
  battleAt: string;
  apiName: string;
  yasenApiName: string | null;
  kind: BattleKindName | null;
  fleetType: number;
  enemyCombined: boolean;
  formation: number | null;
  enemyFormation: number | null;
  engagement: number | null;
  airState: number | null;
  detection: number | null;
  support: boolean;
  friendFleet: boolean;
  lbasWaves: number;
  rank: Rank;
  outcome: BattleOutcome;
}

/** Concatenated HP list of a side: main fleet, then the escort (if any). */
const sideHp = (main: number[], escort: number[] | null | undefined): number[] => [...main, ...(escort ?? [])];

/** Index into a side's concatenated list: escort ships are 6–11 in the packets (7-ship single fleets use 6 for the 7th). */
const slot = (idx: number, main: number, hasEscort: boolean): number => (hasEscort && idx >= 6 ? main + idx - 6 : idx);

class Ledger {
  phases: Partial<Record<OutcomePhase, [number, number]>> = {};
  constructor(public friend: number[], public enemy: number[], readonly fMain: number, readonly eMain: number,
    readonly fEscort: boolean, readonly eEscort: boolean) {}

  hit(side: "friend" | "enemy", idx: number, damage: number, phase: OutcomePhase) {
    const list = side === "friend" ? this.friend : this.enemy;
    const i = side === "friend" ? slot(idx, this.fMain, this.fEscort) : slot(idx, this.eMain, this.eEscort);
    if (i < 0 || i >= list.length || damage <= 0) return;
    list[i]! -= damage;
    const t = (this.phases[phase] ??= [0, 0]);
    t[side === "enemy" ? 0 : 1] += damage;
  }

  events(body: unknown, path: string, as?: OutcomePhase, sides: ("friend" | "enemy")[] = ["friend", "enemy"]) {
    for (const e of extractAttackEvents(body, path)) {
      if (sides.includes(e.defenderSide)) this.hit(e.defenderSide, e.defenderIdx, e.damage, as ?? e.phase);
    }
  }

  support(s: z.infer<typeof support> | null | undefined, phase: OutcomePhase) {
    s?.api_support_hourai?.api_damage.forEach((d, i) => this.hit("enemy", i, Math.floor(d), phase));
    const air = s?.api_support_airatack;
    air?.api_stage3?.api_edam?.forEach((d, i) => this.hit("enemy", i, Math.floor(d), phase));
    air?.api_stage3_combined?.api_edam?.forEach((d, i) => this.hit("enemy", i + 6, Math.floor(d), phase));
  }
}

const clamp = (hp: number[]) => hp.map((v) => Math.max(0, v));
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Day phases (or the whole night-only / air battle) of the first packet. */
function dayPhases(l: Ledger, raw: Record<string, unknown>, p: Packet, apiName: string) {
  const lbas = [...(p.api_air_base_injection ? [p.api_air_base_injection] : []), ...(p.api_air_base_attack ?? [])];
  if (lbas.length) l.events({ api_air_base_attack: lbas }, apiName, "lbas");
  if (p.api_friendly_kouku) l.events({ api_kouku: p.api_friendly_kouku }, apiName, "friendFleet", ["enemy"]);
  l.support(p.api_support_info, "support");
  l.support(p.api_n_support_info, "nightSupport");
  if (p.api_friendly_battle) l.events({ api_hougeki: p.api_friendly_battle.api_hougeki }, "midnight", "friendFleet", ["enemy"]);
  l.events({ ...raw, api_air_base_attack: undefined, api_air_base_injection: undefined, api_friendly_kouku: undefined }, apiName);
}

/**
 * Battle rank by sim-core's rules (KC3Kai / ElectronicObserver kcmemo; sim-core `compute_rank`), from HP before and
 * after the whole battle. Air raids rank by the friend HP-loss rate. KCNav keeps no api_win_rank, so the observed rank
 * is computed with the engine's own rules: a difference then comes from the HP outcome, not from the rank rules.
 */
export function battleRank(friend: [number, number, number][], enemy: [number, number, number][], airRaid = false): Rank {
  const tally = (ships: [number, number, number][]) => {
    let count = 0, sunk = 0, start = 0, end = 0;
    for (const [, before, after] of ships) {
      if (before <= 0) continue;
      count++;
      if (after <= 0) sunk++;
      start += before;
      end += Math.max(0, after);
    }
    return { count, sunk, start, end };
  };
  const gauge = (start: number, end: number) => (start <= 0 ? 0 : Math.max(0, Math.floor(((start - end) / start) * 100)));
  const f = tally(friend);
  const e = tally(enemy);
  const friendGauge = gauge(f.start, f.end);
  if (airRaid) {
    return friendGauge === 0 ? "SS" : friendGauge < 10 ? "A" : friendGauge < 20 ? "B" : friendGauge < 50 ? "C" : friendGauge < 80 ? "D" : "E";
  }
  const enemyGauge = gauge(e.start, e.end);
  const flag = enemy[0];
  const enemyFlagSunk = !!flag && flag[1] > 0 && flag[2] <= 0;
  const friendFlag = friend[0];
  const friendFlagHeavy = !!friendFlag && friendFlag[2] / Math.max(1, friendFlag[0]) <= 0.25;
  if (f.sunk === 0 && e.sunk === e.count) return f.end >= f.start ? "SS" : "S";
  if (f.sunk === 0 && e.count > 1 && e.sunk >= Math.floor(e.count * 0.7)) return "A";
  if (enemyFlagSunk && f.sunk < e.sunk) return "B";
  if (f.count === 1 && friendFlagHeavy) return "D";
  if (enemyGauge > 2.5 * friendGauge) return "B";
  if (enemyGauge > 0.9 * friendGauge) return "C";
  if (f.sunk > 0 && f.count - f.sunk === 1) return "E";
  return "D";
}

/** One `battles[]` entry → the stored row's fields. Throws on a shape this parser does not know. */
export function normalizeBattle(json: unknown): NormalizedBattle {
  const b = entrySchema.parse(json).battle;
  const p = packetSchema.parse(b.rawapi);
  const y = b.yasen_rawapi ? packetSchema.parse(b.yasen_rawapi) : null;
  const kind = battleKind(b.apiname, !!y);
  const fEscort = !!p.api_f_nowhps_combined?.length;
  const eEscort = !!p.api_e_nowhps_combined?.length;
  const fMain = p.api_f_nowhps.length;
  const eMain = p.api_e_nowhps.length;
  const fMax = sideHp(p.api_f_maxhps, p.api_f_maxhps_combined);
  const eMax = sideHp(p.api_e_maxhps, p.api_e_maxhps_combined);
  const fBefore = sideHp(p.api_f_nowhps, p.api_f_nowhps_combined);
  const eBefore = sideHp(p.api_e_nowhps, p.api_e_nowhps_combined);

  const l = new Ledger([...fBefore], [...eBefore], fMain, eMain, fEscort, eEscort);
  dayPhases(l, b.rawapi, p, b.apiname);
  let dayEnd: BattleOutcome["dayEnd"] = null;
  let verified: boolean | null = null;
  if (y && b.yasen_rawapi) {
    dayEnd = { friend: clamp(l.friend), enemy: clamp(l.enemy) };
    const yf = sideHp(y.api_f_nowhps, y.api_f_nowhps_combined);
    const ye = sideHp(y.api_e_nowhps, y.api_e_nowhps_combined);
    verified = same(dayEnd.friend.slice(0, yf.length), yf) && same(dayEnd.enemy.slice(0, ye.length), ye);
    // The night starts from the game's own numbers.
    yf.forEach((v, i) => (l.friend[i] = v));
    ye.forEach((v, i) => (l.enemy[i] = v));
    l.support(y.api_n_support_info, "nightSupport");
    if (y.api_friendly_battle) l.events({ api_hougeki: y.api_friendly_battle.api_hougeki }, "midnight", "friendFleet", ["enemy"]);
    l.events({ ...b.yasen_rawapi, api_friendly_battle: undefined }, b.yasen_apiname ?? "midnight", "night");
  }
  const friend = fMax.map((m, i): [number, number, number] => [m, fBefore[i] ?? 0, Math.max(0, l.friend[i] ?? 0)]);
  const enemy = eMax.map((m, i): [number, number, number] => [m, eBefore[i] ?? 0, Math.max(0, l.enemy[i] ?? 0)]);
  const formation = p.api_formation ?? [];
  return {
    id: b.id,
    map: b.map,
    edgeId: b.node,
    battleAt: b.datetime,
    apiName: b.apiname,
    yasenApiName: y ? (b.yasen_apiname ?? null) : null,
    kind,
    fleetType: b.fleet.fleettype,
    enemyCombined: eEscort,
    formation: formation[0] ?? null,
    enemyFormation: formation[1] ?? null,
    engagement: formation[2] ?? null,
    airState: p.api_kouku?.api_stage1?.api_disp_seiku ?? null,
    detection: p.api_search?.[0] ?? null,
    support: (p.api_support_flag ?? 0) > 0 || (p.api_n_support_flag ?? 0) > 0 || (y?.api_n_support_flag ?? 0) > 0,
    friendFleet: !!(p.api_friendly_info || p.api_friendly_kouku || y?.api_friendly_info),
    lbasWaves: (p.api_air_base_attack?.length ?? 0) + (p.api_air_base_injection ? 1 : 0),
    rank: battleRank(friend, enemy, kind === "airRaid"),
    outcome: { friend, friendMain: fMain, enemy, enemyMain: eMain, dayEnd, phases: l.phases, verified },
  };
}

/** Pages a node can have at most in the queue (enqueue's `pages` limit); pending pages past pageCount are dropped. */
const MAX_PAGES = 100;

const UPSERT = `INSERT INTO kcnav_battles (id, map_id, node_letter, edge_id, difficulty, battle_at, kind, api_name, yasen_api_name,
    fleet_type, enemy_combined, formation, enemy_formation, engagement, air_state, detection, support, friend_fleet, lbas_waves,
    rank, verified, outcome, raw, cache_id, fetched_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)
  ON CONFLICT (id) DO UPDATE SET map_id = excluded.map_id, node_letter = excluded.node_letter, edge_id = excluded.edge_id,
    difficulty = excluded.difficulty, battle_at = excluded.battle_at, kind = excluded.kind, api_name = excluded.api_name,
    yasen_api_name = excluded.yasen_api_name, fleet_type = excluded.fleet_type, enemy_combined = excluded.enemy_combined,
    formation = excluded.formation, enemy_formation = excluded.enemy_formation, engagement = excluded.engagement,
    air_state = excluded.air_state, detection = excluded.detection, support = excluded.support,
    friend_fleet = excluded.friend_fleet, lbas_waves = excluded.lbas_waves, rank = excluded.rank,
    verified = excluded.verified, outcome = excluded.outcome, raw = excluded.raw`;

const flag = (v: boolean | null) => (v === null ? null : v ? 1 : 0);

/**
 * Stores one battles page: a `kcnav_battles` row per battle (raw entry + normalized fields; the KCNav battle id
 * dedupes across pages and windows), drops pending pages of the same query past `pageCount`, and replaces the
 * cached body by a stub listing the stored ids so the raw JSON is kept once. Re-parsing a stub (reparseCached)
 * re-normalizes those rows from their raw column. An entry this parser rejects is skipped and counted.
 */
export async function storeBattles(db: D1Database, job: QueueRow, json: unknown, cacheId: number, fetchedAt: string): Promise<string> {
  const page = pageSchema.parse(json).result;
  let entries: unknown[];
  if (page.storedIn) {
    const { results } = await db.prepare("SELECT raw FROM kcnav_battles WHERE id IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify(page.ids ?? [])).all<{ raw: string }>();
    entries = results.map((r) => JSON.parse(r.raw));
  } else {
    entries = page.battles ?? [];
  }
  const url = new URL(job.path, "https://x");
  const pageNo = Number(url.searchParams.get("page") ?? 0);
  const stmts: D1PreparedStatement[] = [];
  const ids: number[] = [];
  const kinds = new Map<string, number>();
  let invalid = 0;
  let firstError = "";
  for (const entry of entries) {
    let n: NormalizedBattle;
    try {
      n = normalizeBattle(entry);
    } catch (e) {
      invalid++;
      firstError ||= String(e).slice(0, 200);
      continue;
    }
    ids.push(n.id);
    const k = `${n.kind ?? n.apiName}${n.enemyCombined ? "/ec" : ""}`;
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
    stmts.push(db.prepare(UPSERT).bind(
      n.id, job.map_id, job.node_letter, n.edgeId, job.difficulty, n.battleAt, n.kind ?? "unsupported", n.apiName, n.yasenApiName,
      n.fleetType, n.enemyCombined ? 1 : 0, n.formation, n.enemyFormation, n.engagement, n.airState, n.detection,
      n.support ? 1 : 0, n.friendFleet ? 1 : 0, n.lbasWaves, n.rank, flag(n.outcome.verified), JSON.stringify(n.outcome),
      JSON.stringify(entry), cacheId, fetchedAt,
    ));
  }
  if (!page.storedIn) {
    const stub = { result: { storedIn: "kcnav_battles", ids, pageCount: page.pageCount ?? 0, entryCount: page.entryCount ?? 0, perPage: page.perPage ?? null } };
    stmts.push(db.prepare("UPDATE kcnav_cache SET body = ?1 WHERE id = ?2").bind(JSON.stringify(stub), cacheId));
  }
  const pageCount = page.pageCount ?? 0;
  const beyond: string[] = [];
  for (let p = Math.max(pageCount, pageNo + 1); p < MAX_PAGES; p++) {
    url.searchParams.set("page", String(p));
    beyond.push(`${url.pathname}?${url.searchParams}`);
  }
  stmts.push(db.prepare("DELETE FROM kcnav_queue WHERE status = 'pending' AND kind = 'battles' AND path IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(beyond)));
  const results = await db.batch(stmts);
  const dropped = results.at(-1)?.meta.changes ?? 0;
  const mix = [...kinds].map(([k, v]) => `${k} ${v}`).join(", ");
  return `battles: page ${pageNo + 1}/${pageCount} (${page.entryCount ?? 0} in window): ${ids.length} stored${mix ? ` [${mix}]` : ""}`
    + (invalid ? `, ${invalid} skipped (${firstError})` : "") + (dropped ? `; ${dropped} pending page(s) past the end dropped` : "");
}
