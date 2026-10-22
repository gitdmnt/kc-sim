/**
 * sim-core の runBattle (options.log) の結果を、CaptureSession が保存するのと同じ形
 * (CapturedBattle + 攻撃イベント) に変換する。推定器の合成データ検証 (recovery.test.ts) 用。
 *
 * 実際の捕捉と同じく: 昼戦と夜戦は別レコード (同じ visitId)、航空攻撃は命中したものだけ、
 * 戦闘前の艦隊スナップショット (観測値 = 素 + 装備)、HP は各パケットの開始時の値。
 * 照明弾・接触はエンジンの結果に無いので「無し」として書く (検証用の艦隊はそれらを積まない)。
 */
import type { AttackEvent as SimEvent, BattleInput, Engagement, EquipmentInput, Formation, RunBattleOutput, ShipInput, SpecialAttack } from "../../sim-core/pkg/sim_core";
import type { AttackEvent, AttackPhase, CapturedBattle, CapturedEnemyShip } from "../capture/types";
import type { ApiEquipment, ApiShip } from "../data/types";
import type { EquipMaster, MasterData, PresetEquip, PresetShip, ShipMaster } from "../fleet/types";
import type { EnemyLookup } from "../sim/adapter";
import { DAY_SPECIAL, ENGAGEMENT_BY_ID, NIGHT_SPECIAL } from "./observe";
import type { BattleRecord } from "./types";

const PHASE: Record<SimEvent["phase"], AttackPhase> = {
  airStrike: "air", openingAsw: "opening_asw", openingTorpedo: "opening_torpedo",
  shelling1: "shelling1", shelling2: "shelling2", closingTorpedo: "closing_torpedo", night: "night",
};

const FORMATION_ID: Record<Formation, number> = { lineAhead: 1, doubleLine: 2, diamond: 3, echelon: 4, lineAbreast: 5, vanguard: 6 };

const invert = <K extends string>(m: Record<number, K>): Partial<Record<K, number>> => {
  const out: Partial<Record<K, number>> = {};
  for (const [k, v] of Object.entries(m)) out[v] = Number(k);
  return out;
};
const ENGAGEMENT_ID = invert<Engagement>(ENGAGEMENT_BY_ID);
const DAY_AT = { ...invert<SpecialAttack>(DAY_SPECIAL), cvciFba: 7, cvciBba: 7, cvciBa: 7 };
// 7 以上は観測側で使わないので番号は区別だけできればよい
const NIGHT_SP = {
  ...invert<SpecialAttack>(NIGHT_SPECIAL),
  ddciGunTorpRadar: 7, ddciLookoutTorpRadar: 8, ddciTorpLookoutTorp: 9, ddciTorpLookoutDrum: 10,
  ddciGunTorpRadarDouble: 11, ddciLookoutTorpRadarDouble: 12, ddciTorpLookoutTorpDouble: 13, ddciTorpLookoutDrumDouble: 14,
};

const equipAll = (s: ShipInput): EquipmentInput[] => [...s.slots, s.exSlot ?? null].filter((e): e is EquipmentInput => !!e);

/**
 * 検証用の艦・装備から、捕捉側の変換 (buildFriendShips / buildEnemyShips) が同じ ShipInput を
 * 復元できるマスターとルックアップを作る。艦の `id` は master id として一意であること
 * (敵の同型艦は同じ id)。装備の `id` も内容ごとに一意であること。
 */
export const syntheticWorld = (friend: ShipInput[], enemy: ShipInput[]): { master: MasterData; lookup: EnemyLookup } => {
  const ships: Record<number, ShipMaster> = {};
  const equips: Record<number, EquipMaster> = {};
  for (const s of friend) {
    if (s.id === undefined) throw new Error("synthetic friend ship needs an id");
    ships[s.id] = {
      api_id: s.id, api_name: s.name ?? `#${s.id}`, api_stype: s.shipType, api_leng: s.range,
      api_maxeq: s.slots.map((e) => e?.planes ?? 0), api_fuel_max: s.fuelMax ?? 100, api_bull_max: s.ammoMax ?? 100,
    };
    for (const e of equipAll(s)) {
      const st = e.stats ?? {};
      equips[e.id] = {
        api_id: e.id, api_type: e.types, api_houg: st.firepower, api_raig: st.torpedo, api_baku: st.bombing,
        api_tyku: st.antiAir, api_souk: st.armor, api_tais: st.asw, api_houm: st.accuracy, api_houk: st.evasion,
        api_saku: st.los, api_leng: st.range,
      };
    }
  }
  const apiShips = new Map<number, ApiShip>();
  const apiEquips = new Map<number, ApiEquipment>();
  for (const s of enemy) {
    if (s.id === undefined) throw new Error("synthetic enemy ship needs an id");
    apiShips.set(s.id, {
      id: s.id, name: s.name ?? `#${s.id}`, nameEn: null, yomi: null, stype: s.shipType, ctype: null, speed: s.speed ?? null,
      range: s.range ?? null, slotNum: s.slots.length, isAbyssal: true, hp: s.maxHp, fp: s.stats.firepower, tp: s.stats.torpedo,
      aa: s.stats.antiAir, ar: s.stats.armor, luck: null, maxStats: null, slots: s.slots.map((e) => e?.planes ?? 0),
      equips: s.slots.map((e) => e?.id ?? -1), flags: null,
    });
    for (const e of equipAll(s)) {
      const st = e.stats ?? {};
      apiEquips.set(e.id, {
        id: e.id, name: `#${e.id}`, type: e.types, typeId: e.types[2] ?? 0, icon: e.types[3] ?? null, fp: st.firepower ?? 0, tp: st.torpedo ?? 0,
        aa: st.antiAir ?? 0, ar: st.armor ?? 0, bomb: st.bombing ?? 0, asw: st.asw ?? 0, los: st.los ?? 0, acc: st.accuracy ?? 0,
        ev: st.evasion ?? 0, luck: st.luck ?? 0, range: st.range ?? null, radius: null, cost: null, isAbyssal: true,
      });
    }
  }
  return {
    master: { ships, equips },
    lookup: { ship: (id) => apiShips.get(id), equip: (id) => apiEquips.get(id), detail: () => undefined },
  };
};

const presetEquip = (e: EquipmentInput | null | undefined): PresetEquip | null =>
  e ? { masterId: e.id, improvement: e.improvement ?? 0, proficiency: e.proficiency ?? 0, ...(e.planes !== undefined ? { slotSize: e.planes } : {}) } : null;

/** 戦闘前の艦隊スナップショット (poi の表示値 = 素 + 装備 + 装備ボーナス)。 */
const presetShip = (s: ShipInput): PresetShip => {
  const eq = equipAll(s);
  const sum = (k: "firepower" | "torpedo" | "antiAir" | "armor" | "evasion" | "asw" | "los") =>
    eq.reduce((t, e) => t + (e.stats?.[k] ?? 0), s.equipBonus?.[k] ?? 0);
  const range = Math.max(s.range ?? 0, ...eq.map((e) => e.stats?.range ?? 0));
  return {
    masterId: s.id ?? 0,
    level: s.level ?? 1,
    luckMod: 0,
    hpMod: 0,
    aswMod: 0,
    morale: s.morale ?? 49,
    equips: s.slots.map(presetEquip),
    exSlot: presetEquip(s.exSlot),
    observed: {
      maxHp: s.maxHp,
      nowHp: s.hp ?? s.maxHp,
      firepower: s.stats.firepower + sum("firepower"),
      torpedo: s.stats.torpedo + sum("torpedo"),
      antiAir: s.stats.antiAir + sum("antiAir"),
      armor: s.stats.armor + sum("armor"),
      evasion: (s.stats.evasion ?? 0) + sum("evasion"),
      asw: (s.stats.asw ?? 0) + sum("asw"),
      los: (s.stats.los ?? 0) + sum("los"),
      luck: s.stats.luck ?? 0,
      range,
      speed: s.speed ?? 10,
    },
  };
};

const enemyShip = (s: ShipInput, idx: number, hp: number): CapturedEnemyShip => ({
  idx,
  masterId: s.id ?? 0,
  level: s.level ?? 1,
  maxHp: s.maxHp,
  nowHp: hp,
  slots: s.slots.map((e) => e?.id ?? -1),
  params: [s.stats.firepower, s.stats.torpedo, s.stats.antiAir, s.stats.armor],
});

export interface CaptureOptions {
  /** 戦闘 id の接頭辞 (昼戦は `${id}`、夜戦は `${id}-n`) */
  id: string;
  capturedAt: number;
  map?: string;
  /** 出撃内のマス番号 (既定 1) */
  step?: number;
}

/** 捕捉レコードと、各イベントの元になったエンジンのイベント (`source[k]` ↔ `events[k]`)。 */
export type SyntheticRecord = BattleRecord & { source: SimEvent[] };

/** runBattle(input with options.log) の結果を昼戦・夜戦の捕捉レコードに変換する。 */
export const captureFromRun = (input: BattleInput, out: RunBattleOutput, opts: CaptureOptions): SyntheticRecord[] => {
  const r = out.result;
  const events = r.events ?? [];
  const friend = input.friend.ships;
  const enemy = input.enemy.ships;
  const hp = [friend.map((s) => s.hp ?? s.maxHp), enemy.map((s) => s.hp ?? s.maxHp)];
  const night = input.options?.kind === "nightOnly";
  const formation = [FORMATION_ID[input.friend.formation ?? "lineAhead"], FORMATION_ID[input.enemy.formation ?? "lineAhead"], ENGAGEMENT_ID[r.engagement] ?? 1];

  const record = (id: string, path: string, evs: SimEvent[]): SyntheticRecord => {
    const startHp = hp.map((h) => [...h]);
    const captured: AttackEvent[] = [];
    const source: SimEvent[] = [];
    for (const e of evs) {
      const side = e.attackerSide === "friend" ? 0 : 1;
      hp[1 - side]![e.defender] = e.defenderHpAfter;
      // 航空戦 stage3 は命中した対象しか分からない
      if (e.kind === "air" && e.hit === "miss") continue;
      source.push(e);
      const phase = PHASE[e.phase];
      const special: Partial<Record<SpecialAttack, number>> = phase === "night" ? NIGHT_SP : DAY_AT;
      captured.push({
        seq: captured.length,
        phase,
        attackerSide: e.attackerSide,
        attackerIdx: e.kind === "air" ? -1 : e.attacker,
        defenderSide: e.attackerSide === "friend" ? "enemy" : "friend",
        defenderIdx: e.defender,
        attackType: e.kind === "torpedo" || e.kind === "air" ? null : special[e.special] ?? 0,
        hit: e.hit === "critical" ? "crit" : e.hit,
        damage: e.damage,
        protected: e.covered,
        ...(e.kind === "air" ? { airKind: "bomb" as const } : {}),
      });
    }
    const battle: CapturedBattle = {
      id,
      capturedAt: opts.capturedAt + (path.includes("midnight") && !night ? 1 : 0),
      path,
      visitId: `${opts.id}-visit`,
      map: { map: opts.map ?? "1-1", area: 1, mapNo: 1, cellId: opts.step ?? 1, node: "A", difficulty: null, eventId: null, eventKind: null, step: opts.step ?? 1 },
      fleet: {
        deckId: 1,
        ships: friend.map(presetShip),
        supply: friend.map((s) => ({ fuel: s.fuel ?? s.fuelMax ?? 100, fuelMax: s.fuelMax ?? 100, ammo: s.ammo ?? s.ammoMax ?? 100, ammoMax: s.ammoMax ?? 100 })),
      },
      enemy: {
        ships: enemy.map((s, i) => enemyShip(s, i, startHp[1]![i]!)),
        escort: [],
        friendFormation: formation[0] ?? null,
        enemyFormation: formation[1] ?? null,
        engagement: formation[2] ?? null,
      },
      enemyMasterIds: [...new Set(enemy.map((s) => s.id ?? 0))],
      pending: 1,
      raw: { api_formation: formation, api_f_nowhps: startHp[0], api_e_nowhps: startHp[1], api_flare_pos: [-1, -1], api_touch_plane: [-1, -1] },
    };
    return { battle, events: captured, source };
  };

  if (night) return [record(opts.id, "api_req_battle_midnight/sp_midnight", events)];
  const day = record(opts.id, "api_req_sortie/battle", events.filter((e) => e.phase !== "night"));
  const nightEvents = events.filter((e) => e.phase === "night");
  return r.nightBattle ? [day, record(`${opts.id}-n`, "api_req_battle_midnight/battle", nightEvents)] : [day];
};
