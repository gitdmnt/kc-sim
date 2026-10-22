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

const HIT_CODE: Record<AttackEvent["hit"], number> = { miss: 0, hit: 1, crit: 2 };
const rawDamage = (e: AttackEvent) => e.damage + (e.protected ? 0.1 : 0);

/** 砲撃・夜戦 (api_hougeki*): 1 イベント = 1 手番。 */
const hougeki = (evs: AttackEvent[], night: boolean) => ({
  api_at_eflag: evs.map((e) => (e.attackerSide === "enemy" ? 1 : 0)),
  api_at_list: evs.map((e) => e.attackerIdx),
  [night ? "api_sp_list" : "api_at_type"]: evs.map((e) => e.attackType ?? 0),
  api_df_list: evs.map((e) => [e.defenderIdx]),
  api_si_list: evs.map(() => [-1]),
  api_cl_list: evs.map((e) => [HIT_CODE[e.hit]]),
  api_damage: evs.map((e) => [rawDamage(e)]),
});

/** 雷撃 (api_opening_atack / api_raigeki) の *_list_items 形式。 */
const torpedo = (evs: AttackEvent[], n: [number, number]) => {
  const side = (s: "friend" | "enemy", size: number) => {
    const rai: (number[] | null)[] = Array(size).fill(null);
    const cl: (number[] | null)[] = Array(size).fill(null);
    const dam: (number[] | null)[] = Array(size).fill(null);
    for (const e of evs.filter((x) => x.attackerSide === s)) {
      rai[e.attackerIdx] = [e.defenderIdx];
      cl[e.attackerIdx] = [HIT_CODE[e.hit]];
      dam[e.attackerIdx] = [rawDamage(e)];
    }
    return { rai, cl, dam };
  };
  const f = side("friend", n[0]);
  const e = side("enemy", n[1]);
  return {
    api_frai_list_items: f.rai, api_fcl_list_items: f.cl, api_fydam_list_items: f.dam,
    api_erai_list_items: e.rai, api_ecl_list_items: e.cl, api_eydam_list_items: e.dam,
  };
};

/** 航空戦 stage3: 被弾した艦ごとにフラグと合計ダメージ (ゲームと同じく miss は残らない)。 */
const stage3 = (evs: AttackEvent[], n: [number, number]) => {
  const side = (defender: "friend" | "enemy", size: number) => {
    const bak = Array<number>(size).fill(0);
    const cl = Array<number>(size).fill(0);
    const dam = Array<number>(size).fill(0);
    for (const e of evs.filter((x) => x.defenderSide === defender)) {
      bak[e.defenderIdx] = 1;
      if (e.hit === "crit") cl[e.defenderIdx] = 1;
      dam[e.defenderIdx] = (dam[e.defenderIdx] ?? 0) + rawDamage(e);
    }
    return { rai: Array<number>(size).fill(0), bak, cl, dam };
  };
  const f = side("friend", n[0]);
  const e = side("enemy", n[1]);
  return {
    api_frai_flag: f.rai, api_fbak_flag: f.bak, api_fcl_flag: f.cl, api_fdam: f.dam,
    api_erai_flag: e.rai, api_ebak_flag: e.bak, api_ecl_flag: e.cl, api_edam: e.dam,
  };
};

/**
 * 捕捉したイベントを、ゲームの戦闘応答 (api_data) の形に書き戻す。shared/capture/parser の
 * extractEnemy / extractAttackEvents で同じ敵とイベントが取り出せる (航空戦は艦ごとに合算、雷撃は味方→敵の順)。
 */
export const battlePacket = (o: {
  path: string; formation: number[]; friend: ShipInput[]; enemy: ShipInput[]; startHp: number[][]; events: AttackEvent[];
}): Record<string, unknown> => {
  const n: [number, number] = [o.friend.length, o.enemy.length];
  const phase = (p: AttackPhase) => o.events.filter((e) => e.phase === p);
  const night = o.path.includes("midnight");
  const parts: [string, AttackEvent[], unknown][] = [
    ["api_kouku", phase("air"), { api_stage3: stage3(phase("air"), n) }],
    ["api_opening_taisen", phase("opening_asw"), hougeki(phase("opening_asw"), false)],
    ["api_opening_atack", phase("opening_torpedo"), torpedo(phase("opening_torpedo"), n)],
    ["api_hougeki1", phase("shelling1"), hougeki(phase("shelling1"), false)],
    ["api_hougeki2", phase("shelling2"), hougeki(phase("shelling2"), false)],
    ["api_raigeki", phase("closing_torpedo"), torpedo(phase("closing_torpedo"), n)],
    ["api_hougeki", night ? phase("night") : [], hougeki(phase("night"), true)],
  ];
  return {
    api_deck_id: 1,
    api_formation: o.formation,
    api_f_nowhps: o.startHp[0],
    api_f_maxhps: o.friend.map((s) => s.maxHp),
    api_ship_ke: o.enemy.map((s) => s.id ?? 0),
    api_ship_lv: o.enemy.map((s) => s.level ?? 1),
    api_e_nowhps: o.startHp[1],
    api_e_maxhps: o.enemy.map((s) => s.maxHp),
    api_eSlot: o.enemy.map((s) => [...s.slots.map((e) => e?.id ?? -1), -1, -1, -1, -1, -1].slice(0, 5)),
    api_eParam: o.enemy.map((s) => [s.stats.firepower, s.stats.torpedo, s.stats.antiAir, s.stats.armor]),
    api_flare_pos: [-1, -1],
    api_touch_plane: [-1, -1],
    ...Object.fromEntries(parts.filter(([, evs]) => evs.length > 0).map(([key, , value]) => [key, value])),
  };
};

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
      raw: battlePacket({ path, formation, friend, enemy, startHp, events: captured }),
    };
    return { battle, events: captured, source };
  };

  if (night) return [record(opts.id, "api_req_battle_midnight/sp_midnight", events)];
  const day = record(opts.id, "api_req_sortie/battle", events.filter((e) => e.phase !== "night"));
  const nightEvents = events.filter((e) => e.phase === "night");
  return r.nightBattle ? [day, record(`${opts.id}-n`, "api_req_battle_midnight/battle", nightEvents)] : [day];
};
