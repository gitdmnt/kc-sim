/**
 * 捕捉した戦闘 (CapturedBattle + 攻撃イベント) → 命中判定の観測 (Observation)。
 *
 * 戦闘ごとに、sim-core の battle/mod.rs と同じ規則で戦闘中の状態を復元する:
 * - HP: 戦闘パケットの api_f_nowhps / api_e_nowhps (夜戦パケットは夜戦開始時) から、イベントの
 *   ダメージ (と支援射撃) を順に引く。雷撃はフェーズ開始時の HP で火力 (→ 命中) が決まる。
 * - 戦意: スナップショットは戦闘前の値。昼戦は (< 30 なら −6) −3、夜戦マスは −2、昼戦に続く夜戦は
 *   さらに −2 (撃沈艦を除く)。
 * - 燃料: スナップショットの supply があればそれ、無ければ同じ出撃で先に戦ったマスの数から
 *   (1 マス 20%、夜戦マス 10%、潜水艦のみ 8%) 見積もる。出撃開始時は満タンとみなす。
 * - 陣形・交戦形態はパケットの api_formation、夜戦の照明弾・接触は api_flare_pos / api_touch_plane、
 *   探照灯は撃沈されていない艦の装備 (sim-core と同じく艦隊内に 1 つでもあれば点灯)。
 * 使わないイベント (理由は SkipReason): 航空戦 (miss が記録されない)、かばう、モデルが曖昧な特殊攻撃、
 * 連合艦隊・夜昼戦・航空戦マスなど sim-core の対象外の戦闘。
 */
import type { AttackQuery, Engagement, Formation, NightContext, QueryKind, ShipInput, SpecialAttack } from "@sim-core";
import type { AttackEvent, AttackPhase, CapturedBattle, Side } from "../capture/types";
import type { CompShip } from "../data/types";
import type { MasterData, Preset } from "../fleet/types";
import { buildEnemyShips, buildFriendShips, ENEMY_FORMATION_BY_ID } from "../sim/adapter";
import type { EnemyLookup } from "../sim/adapter";
import type { FitEntry } from "../sim/fit";
import { canonicalQuery } from "./forward";
import type { BattleRecord, Observation, SkipCounts, SkipReason } from "./types";

export interface ObserveContext {
  /** 味方艦・装備のマスター (poi の state.const) */
  master: MasterData;
  /** 深海棲艦・深海装備 (API)。detail は使わない。 */
  lookup: EnemyLookup;
  /** 装備ボーナス (/api/v1/fit-bonuses)。無ければ装備分だけ引いた値を素のステータスとする。 */
  fitBonuses?: FitEntry[];
  /** false なら通常攻撃と連撃だけを使う。既定 true (sim-core がモデル化しているカットインも使う)。 */
  includeCutins?: boolean;
}

export interface ObserveResult {
  observations: Observation[];
  skipped: SkipCounts;
  /** 観測を 1 つ以上生んだ戦闘の数 */
  battles: number;
}

/** 戦闘パケットの種類。 */
export type CapturedKind = "day" | "nightAfterDay" | "nightOnly";

export const capturedKind = (path: string): CapturedKind | null => {
  switch (path) {
    case "api_req_sortie/battle":
      return "day";
    case "api_req_battle_midnight/battle":
      return "nightAfterDay";
    case "api_req_battle_midnight/sp_midnight":
      return "nightOnly";
    default:
      return null;
  }
};

export const ENGAGEMENT_BY_ID: Record<number, Engagement> = { 1: "sameCourse", 2: "headOn", 3: "tAdvantage", 4: "tDisadvantage" };

/** 昼戦 api_at_type → sim-core。7 (空母カットイン) と 100 以上 (特殊砲撃など) は扱わない。 */
export const DAY_SPECIAL: Record<number, SpecialAttack> = {
  0: "normal", 2: "doubleAttack", 3: "cutinMainSecondary", 4: "cutinMainRadar", 5: "cutinMainAp", 6: "cutinMainMain",
};

/** 夜戦 api_sp_list → sim-core。6 (夜間空母攻撃) と 7 以上 (駆逐カットインなど) は扱わない。 */
export const NIGHT_SPECIAL: Record<number, SpecialAttack> = {
  0: "normal", 1: "nightDoubleAttack", 2: "nightCutinMixed", 3: "nightCutinTorpedo", 4: "nightCutinGunSecondary", 5: "nightCutinGunMain",
};

/** includeCutins: false でも使う攻撃 (命中補正なし) */
const PLAIN: Partial<Record<SpecialAttack, true>> = { normal: true, doubleAttack: true, nightDoubleAttack: true };
const SEARCHLIGHT_CATEGORIES = new Set([29, 42]);
const isSub = (stype: number) => stype === 13 || stype === 14;

/** 未検証の JSON を辿る。 */
const at = (v: unknown, ...keys: (string | number)[]): unknown =>
  keys.reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string | number, unknown>)[k] : undefined), v);

/** 艦ごとの配列 (旧形式は先頭に −1 が入る)。値が無い位置は null。 */
const perShip = (v: unknown, n: number): (number | null)[] | null => {
  if (!Array.isArray(v)) return null;
  const arr: unknown[] = v.length > n && v[0] === -1 ? v.slice(1) : v;
  return Array.from({ length: n }, (_, i) => {
    const x = arr[i];
    return typeof x === "number" && x >= 0 ? Math.floor(x + 1e-9) : null;
  });
};

const pair = (v: unknown): [number, number] => {
  const a = Array.isArray(v) ? v : [];
  return [typeof a[0] === "number" ? a[0] : -1, typeof a[1] === "number" ? a[1] : -1];
};

/** sim-core battle/mod.rs の戦闘前の戦意コスト (+ 夜戦突入)。 */
export const battleMorale = (morale: number, kind: CapturedKind): number => {
  if (kind === "nightOnly") return Math.max(0, morale - 2);
  let m = Math.max(0, (morale < 30 ? morale - 6 : morale) - 3);
  if (kind === "nightAfterDay") m = Math.max(0, m - 2);
  return m;
};

/** 1 マスで消費する燃料の割合 (sim-core の補給規則)。 */
const visitFuelRate = (r: BattleRecord, lookup: EnemyLookup): number => {
  if (capturedKind(r.battle.path) === "nightOnly") return 0.1;
  const ships = r.battle.enemy.ships;
  if (ships.length > 0 && ships.every((s) => isSub(lookup.ship(s.masterId)?.stype ?? 0))) return 0.08;
  return 0.2;
};

/**
 * 戦闘ごとに、同じ出撃で先に戦ったマスの燃料消費率の列。records は capturedAt 順。
 * 出撃の区切り: マップ・艦隊が変わる、またはマスの通し番号 (step) が戻る / 同じ番号で別のマス。
 */
export const sortieFuelRates = (records: BattleRecord[], lookup: EnemyLookup): Map<string, number[]> => {
  const out = new Map<string, number[]>();
  let cur: { map: string; deck: number | undefined; step: number; visits: Map<string, { step: number; rate: number }> } | null = null;
  for (const r of records) {
    const b = r.battle;
    if (!b.map) {
      cur = null;
      continue;
    }
    const deck = b.fleet?.deckId;
    const step = b.map.step;
    if (!cur || cur.map !== b.map.map || cur.deck !== deck || step < cur.step || (step === cur.step && !cur.visits.has(b.visitId))) {
      cur = { map: b.map.map, deck, step, visits: new Map() };
    }
    out.set(b.id, [...cur.visits.values()].filter((v) => v.step < step).map((v) => v.rate));
    if (!cur.visits.has(b.visitId)) cur.visits.set(b.visitId, { step, rate: visitFuelRate(r, lookup) });
    cur.step = step;
  }
  return out;
};

const fuelOf = (b: CapturedBattle, i: number, masterId: number, rates: number[], master: MasterData) => {
  const s = b.fleet?.supply?.[i];
  if (s) return { fuel: s.fuel, fuelMax: s.fuelMax };
  const max = master.ships[masterId]?.api_fuel_max ?? 100;
  let fuel = max;
  for (const r of rates) fuel -= Math.max(1, Math.floor(max * r));
  return { fuel: Math.max(0, fuel), fuelMax: max };
};

const hasSearchlight = (s: ShipInput) =>
  [...s.slots, s.exSlot ?? null].some((e) => e !== null && SEARCHLIGHT_CATEGORIES.has(e.types[2]));

const SIDE_INDEX: Record<Side, 0 | 1> = { friend: 0, enemy: 1 };

/** 1 戦闘分の状態。 */
interface BattleState {
  kind: CapturedKind;
  ships: [(ShipInput | null)[], (ShipInput | null)[]];
  /** 敵艦 master id (推定対象) */
  enemyIds: number[];
  hp: [number[], number[]];
  formation: [Formation, Formation];
  engagement: Engagement | undefined;
  night: [NightContext, NightContext] | undefined;
}

type Prepared = { ok: true; state: BattleState } | { ok: false; reason: SkipReason };

const prepare = (b: CapturedBattle, fuelRates: number[], ctx: ObserveContext): Prepared => {
  const kind = capturedKind(b.path);
  const e = b.enemy;
  if (!kind || e.escort.length > 0) return { ok: false, reason: "unsupportedBattle" };
  const fleet = b.fleet;
  if (!fleet || fleet.ships.length === 0 || (fleet.escort?.length ?? 0) > 0) return { ok: false, reason: "friendData" };
  const ff = ENEMY_FORMATION_BY_ID[e.friendFormation ?? 0];
  const ef = ENEMY_FORMATION_BY_ID[e.enemyFormation ?? 0];
  if (!ff || !ef) return { ok: false, reason: e.friendFormation !== null && e.friendFormation > 10 ? "unsupportedBattle" : "enemyData" };

  // 味方: 観測値 − 装備 − 装備ボーナス = 素のステータス
  const preset: Preset = {
    id: b.id, name: "", createdAt: 0, updatedAt: 0, fleetType: "single", formation: "line_ahead", ships: fleet.ships,
  };
  const fb = buildFriendShips(preset, ctx.master, { fitBonuses: ctx.fitBonuses });
  if (fb.warnings.length > 0) return { ok: false, reason: "friendData" };
  const fHp0 = perShip(at(b.raw, "api_f_nowhps"), fb.input.length);
  const friend = fb.input.map((s, i): ShipInput => {
    const hp = fHp0?.[i] ?? (kind === "day" ? fleet.ships[i].observed?.nowHp : undefined) ?? s.maxHp;
    return { ...s, hp, morale: hp > 0 ? battleMorale(s.morale ?? 49, kind) : s.morale, ...fuelOf(b, i, fleet.ships[i].masterId, fuelRates, ctx.master) };
  });

  // 敵: 戦闘パケットの eParam / eSlot / Lv + API のマスター。隠しステータスはグリッドで上書きする。
  const n = e.ships.reduce((m, s) => Math.max(m, s.idx + 1), 0);
  const enemy: (ShipInput | null)[] = Array(n).fill(null);
  const enemyIds: number[] = Array(n).fill(0);
  const eHp: number[] = Array(n).fill(0);
  for (const s of e.ships) {
    enemyIds[s.idx] = s.masterId;
    eHp[s.idx] = s.nowHp ?? s.maxHp ?? 0;
    const known = !!ctx.lookup.ship(s.masterId) && !!s.params && (s.slots ?? []).every((id) => id <= 0 || !!ctx.lookup.equip(id));
    if (!known) continue;
    const p = s.params ?? [];
    const comp: CompShip = {
      shipId: s.masterId, level: s.level ?? 1, hp: s.maxHp ?? 0,
      fp: p[0] ?? 0, tp: p[1] ?? 0, aa: p[2] ?? 0, ar: p[3] ?? 0, equips: s.slots ?? [],
    };
    enemy[s.idx] = buildEnemyShips([comp], ctx.lookup, (ship) => ship).input[0];
  }

  let night: BattleState["night"];
  if (kind !== "day") {
    const flare = pair(at(b.raw, "api_flare_pos"));
    const touch = pair(at(b.raw, "api_touch_plane"));
    const contact = [
      touch[0] > 0 ? ctx.master.equips[touch[0]]?.api_houm ?? 0 : undefined,
      touch[1] > 0 ? ctx.lookup.equip(touch[1])?.acc ?? 0 : undefined,
    ];
    const lit = [
      friend.some((s) => (s.hp ?? s.maxHp) > 0 && hasSearchlight(s)),
      enemy.some((s, i) => s !== null && eHp[i] > 0 && hasSearchlight(s)),
    ];
    const side = (k: 0 | 1): NightContext => ({
      ownStarshell: flare[k] >= 0,
      enemyStarshell: flare[1 - k] >= 0,
      ownSearchlight: lit[k],
      enemySearchlight: lit[1 - k],
      ...(contact[k] !== undefined ? { nightContactAccuracy: contact[k] } : {}),
    });
    night = [side(0), side(1)];
  }

  return {
    ok: true,
    state: {
      kind,
      ships: [friend, enemy],
      enemyIds,
      hp: [friend.map((s) => s.hp ?? s.maxHp), eHp],
      formation: [ff, ef],
      engagement: ENGAGEMENT_BY_ID[e.engagement ?? 0],
      night,
    },
  };
};

/** 支援射撃・支援航空攻撃の敵へのダメージ (開幕対潜より前)。 */
const supportDamage = (raw: unknown, n: number): number[] => {
  const out: number[] = Array(n).fill(0);
  for (const v of [at(raw, "api_support_info", "api_support_hourai", "api_damage"), at(raw, "api_support_info", "api_support_airatack", "api_stage3", "api_edam")]) {
    perShip(v, n)?.forEach((d, i) => (out[i] += d ?? 0));
  }
  return out;
};

const queryKind = (phase: AttackPhase, defenderIsSub: boolean): QueryKind | null => {
  switch (phase) {
    case "opening_asw":
      return defenderIsSub ? "openingAsw" : null;
    case "shelling1":
    case "shelling2":
      return defenderIsSub ? "asw" : "shelling";
    case "opening_torpedo":
    case "closing_torpedo":
      return "torpedo";
    case "night":
      return defenderIsSub ? "asw" : "night";
    default:
      return null;
  }
};

type Built = { ok: true; obs: Observation } | { ok: false; reason: SkipReason };

const observe = (
  ev: AttackEvent, st: BattleState, phaseStartHp: [number[], number[]], b: CapturedBattle, includeCutins: boolean
): Built => {
  if (ev.phase === "air") return { ok: false, reason: "air" };
  if (ev.attackerSide === ev.defenderSide) return { ok: false, reason: "sameSide" };
  if (ev.protected) return { ok: false, reason: "protected" };
  const a = SIDE_INDEX[ev.attackerSide];
  const d = SIDE_INDEX[ev.defenderSide];
  const attacker = st.ships[a][ev.attackerIdx];
  const defender = st.ships[d][ev.defenderIdx];
  if (attacker === undefined || defender === undefined) return { ok: false, reason: "inconsistent" };
  if (!attacker || !defender) return { ok: false, reason: a === 1 || d === 1 ? "enemyData" : "friendData" };
  if (st.hp[a][ev.attackerIdx] <= 0 || st.hp[d][ev.defenderIdx] <= 0) return { ok: false, reason: "inconsistent" };

  const kind = queryKind(ev.phase, isSub(defender.shipType));
  if (!kind) return { ok: false, reason: ev.phase === "shelling3" ? "unsupportedBattle" : "inconsistent" };
  let special: SpecialAttack | undefined = "normal";
  if (kind === "shelling") special = DAY_SPECIAL[ev.attackType ?? 0];
  else if (kind === "night") special = NIGHT_SPECIAL[ev.attackType ?? 0];
  else if (kind !== "torpedo" && (ev.attackType ?? 0) !== 0) special = undefined;
  if (!special || (!includeCutins && !PLAIN[special])) return { ok: false, reason: "cutin" };
  if (kind === "torpedo" && !st.engagement) return { ok: false, reason: "enemyData" };

  const role = a === 0 ? "evasion" : "accuracy";
  const query: AttackQuery = {
    kind,
    attacker: { ...attacker, hp: kind === "torpedo" ? phaseStartHp[a][ev.attackerIdx] : st.hp[a][ev.attackerIdx] },
    defender: { ...defender, hp: st.hp[d][ev.defenderIdx] },
    attackerSide: ev.attackerSide,
    attackerFormation: st.formation[a],
    defenderFormation: st.formation[d],
    attackerIndex: ev.attackerIdx,
    attackerFleetSize: st.ships[a].length,
    defenderIndex: ev.defenderIdx,
    defenderFleetSize: st.ships[d].length,
    engagement: st.engagement,
    special,
    ...(kind === "night" && st.night ? { night: st.night[a] } : {}),
  };
  return {
    ok: true,
    obs: {
      shipId: st.enemyIds[role === "evasion" ? ev.defenderIdx : ev.attackerIdx],
      role,
      query: canonicalQuery(query, role),
      outcome: ev.hit,
      battleId: b.id,
      seq: ev.seq,
    },
  };
};

/** 捕捉した戦闘群から観測を作る。records の順序は問わない (capturedAt で並べ直す)。 */
export const buildObservations = (records: BattleRecord[], ctx: ObserveContext): ObserveResult => {
  const sorted = [...records].sort((x, y) => x.battle.capturedAt - y.battle.capturedAt);
  const fuel = sortieFuelRates(sorted, ctx.lookup);
  const skipped: SkipCounts = {};
  const skip = (r: SkipReason, k = 1) => (skipped[r] = (skipped[r] ?? 0) + k);
  const observations: Observation[] = [];
  let battles = 0;

  for (const r of sorted) {
    const p = prepare(r.battle, fuel.get(r.battle.id) ?? [], ctx);
    if (!p.ok) {
      skip(p.reason, r.events.length);
      continue;
    }
    const st = p.state;
    const events = [...r.events].sort((x, y) => x.seq - y.seq);
    let supportDone = st.kind !== "day";
    let phase: AttackPhase | null = null;
    let phaseStartHp: [number[], number[]] = [[...st.hp[0]], [...st.hp[1]]];
    const before = observations.length;
    for (const ev of events) {
      if (!supportDone && ev.phase !== "air") {
        supportDamage(r.battle.raw, st.hp[1].length).forEach((dmg, i) => (st.hp[1][i] = Math.max(0, st.hp[1][i] - dmg)));
        supportDone = true;
      }
      if (ev.phase !== phase) {
        phase = ev.phase;
        phaseStartHp = [[...st.hp[0]], [...st.hp[1]]];
      }
      const o = observe(ev, st, phaseStartHp, r.battle, ctx.includeCutins !== false);
      if (o.ok) observations.push(o.obs);
      else skip(o.reason);
      const d = SIDE_INDEX[ev.defenderSide];
      if (ev.defenderIdx >= 0 && ev.defenderIdx < st.hp[d].length) st.hp[d][ev.defenderIdx] = Math.max(0, st.hp[d][ev.defenderIdx] - ev.damage);
    }
    if (observations.length > before) battles++;
  }
  return { observations, skipped, battles };
};
