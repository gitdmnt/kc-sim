/**
 * プリセット / 敵編成 → sim-core の BattleInput への変換 (純粋関数)。
 * 規約は docs/SIM_INTERFACE.md "Conventions" に従う: 艦の stats は「装備なし・装備ボーナスなし」。
 */
import type {
  BattleInput,
  BattleKind,
  EquipmentInput,
  EquipmentStats,
  Formation,
  ShipInput,
} from "../../sim-core/pkg/sim_core";
import { SERVER_ESTIMATOR_SOURCE } from "../data/types";
import type { ApiEquipment, ApiShip, CompShip, Confidence, EnemyComp, HiddenStat, ShipDetail } from "../data/types";
import { isAircraft } from "../fleet/calc";
import { resolveShipStats } from "../fleet/stats";
import type { EquipMaster, MasterData, Preset, PresetEquip, PresetFormation, PresetShip } from "../fleet/types";
import { computeFitBonus, fitToEquipmentStats } from "./fit";
import type { FitEntry } from "./fit";

export const FORMATION_MAP: Partial<Record<PresetFormation, Formation>> = {
  line_ahead: "lineAhead",
  double_line: "doubleLine",
  diamond: "diamond",
  echelon: "echelon",
  line_abreast: "lineAbreast",
  vanguard: "vanguard",
};

/** 敵編成の formation id (API) → sim-core。連合艦隊用 (11-14) は未対応なので単縦陣。 */
export const ENEMY_FORMATION_BY_ID: Record<number, Formation> = {
  1: "lineAhead", 2: "doubleLine", 3: "diamond", 4: "echelon", 5: "lineAbreast", 6: "vanguard",
};

export const equipStatsFromMaster = (m: EquipMaster): EquipmentStats => {
  const s: EquipmentStats = {};
  if (m.api_houg) s.firepower = m.api_houg;
  if (m.api_raig) s.torpedo = m.api_raig;
  if (m.api_tyku) s.antiAir = m.api_tyku;
  if (m.api_souk) s.armor = m.api_souk;
  if (m.api_houk) s.evasion = m.api_houk;
  if (m.api_tais) s.asw = m.api_tais;
  if (m.api_saku) s.los = m.api_saku;
  if (m.api_houm) s.accuracy = m.api_houm;
  if (m.api_baku) s.bombing = m.api_baku;
  if (m.api_luck) s.luck = m.api_luck;
  if (m.api_leng) s.range = m.api_leng;
  return s;
};

const equipFromMaster = (m: EquipMaster, extra: Partial<EquipmentInput>): EquipmentInput => ({
  id: m.api_id,
  types: m.api_type ?? [0, 0, 0, 0, 0],
  stats: equipStatsFromMaster(m),
  ...extra,
});

// ---- friend ----

export interface FriendOptions {
  fitBonuses?: FitEntry[];
  /** false で装備ボーナスの差し引きをしない (SIM_INTERFACE: 不明なら装備のみ差し引く) */
  applyFit?: boolean;
}

export interface FriendBuild {
  input: ShipInput[];
  warnings: string[];
  /** 未対応条件で評価できなかった装備ボーナス定義の数 (全艦合計) */
  fitSkipped: number;
}

const toPresetEquipInput = (
  e: PresetEquip,
  master: MasterData,
  slotIndex: number,
  shipMaster: MasterData["ships"][number]
): EquipmentInput | null => {
  const m = master.equips[e.masterId];
  if (!m) return null;
  const input = equipFromMaster(m, { improvement: e.improvement, proficiency: e.proficiency });
  if (isAircraft(m)) input.planes = e.slotSize ?? shipMaster?.api_maxeq?.[slotIndex] ?? 0;
  return input;
};

export const buildFriendShips = (preset: Preset, master: MasterData, opts: FriendOptions = {}): FriendBuild => {
  const warnings: string[] = [];
  let fitSkipped = 0;
  const apply = opts.applyFit !== false && !!opts.fitBonuses;

  const input = preset.ships.map((ship, idx): ShipInput => {
    const m = master.ships[ship.masterId];
    const label = `${idx + 1}番艦 (${m?.api_name ?? `#${ship.masterId}`})`;
    if (!m) warnings.push(`${label}: マスターデータが見つかりません`);

    const equipInputs: (EquipmentInput | null)[] = ship.equips.map((e, i) => (e ? toPresetEquipInput(e, master, i, m) : null));
    const exInput = ship.exSlot ? toPresetEquipInput(ship.exSlot, master, 99, m) : null;
    ship.equips.forEach((e, i) => e && !equipInputs[i] && warnings.push(`${label}: 装備#${e.masterId} が不明`));

    // 装備マスター合計と装備ボーナス
    const all = [...ship.equips, ship.exSlot ?? null].filter((e): e is PresetEquip => !!e);
    const sum: EquipmentStats = {};
    for (const e of all) {
      const em = master.equips[e.masterId];
      if (!em) continue;
      for (const [k, v] of Object.entries(equipStatsFromMaster(em))) {
        if (k !== "range") sum[k as keyof EquipmentStats] = (sum[k as keyof EquipmentStats] ?? 0) + (v ?? 0);
      }
    }
    let bonus: EquipmentStats = {};
    if (apply) {
      const fit = computeFitBonus(
        { masterId: ship.masterId, stype: m?.api_stype ?? 0, ctype: m?.api_ctype },
        all.map((e) => ({ masterId: e.masterId, type2: master.equips[e.masterId]?.api_type?.[2] ?? 0, improvement: e.improvement })),
        opts.fitBonuses!
      );
      bonus = fitToEquipmentStats(fit.bonus);
      fitSkipped += fit.skipped;
    }

    // resolveShipStats は観測値(装備込み)か、計算値(基礎+装備)を返す → どちらも装備合計を引けば素の値
    const r = resolveShipStats(ship, master);
    const naked = (key: keyof typeof r, equip: number, fit: number, name: string): number => {
      const v = r[key].value;
      if (v === null) {
        warnings.push(`${label}: ${name} が不明 (0 として扱います)`);
        return 0;
      }
      return Math.max(0, v - equip - fit);
    };

    let maxHp = r.maxHp.value;
    if (maxHp === null) {
      maxHp = (m?.api_taik?.[0] ?? 1) + ship.hpMod;
      warnings.push(`${label}: 耐久が不明なため Lv1 の値で概算 (${maxHp})`);
    }

    const out: ShipInput = {
      id: ship.masterId,
      name: m?.api_name,
      shipType: m?.api_stype ?? 0,
      level: ship.level,
      maxHp,
      stats: {
        firepower: naked("firepower", sum.firepower ?? 0, bonus.firepower ?? 0, "火力"),
        torpedo: naked("torpedo", sum.torpedo ?? 0, bonus.torpedo ?? 0, "雷装"),
        antiAir: naked("antiAir", sum.antiAir ?? 0, bonus.antiAir ?? 0, "対空"),
        armor: naked("armor", sum.armor ?? 0, bonus.armor ?? 0, "装甲"),
        evasion: naked("evasion", sum.evasion ?? 0, bonus.evasion ?? 0, "回避"),
        asw: naked("asw", sum.asw ?? 0, bonus.asw ?? 0, "対潜"),
        los: naked("los", sum.los ?? 0, bonus.los ?? 0, "索敵"),
        luck: r.luck.value ?? 0,
      },
      morale: ship.morale,
      slots: equipInputs,
    };
    // 補給量は最大値で比較する (未指定だと sim-core 既定の 100 になり消費量が狂う)。
    if (m?.api_fuel_max) out.fuelMax = m.api_fuel_max;
    if (m?.api_bull_max) out.ammoMax = m.api_bull_max;
    if (m?.api_ctype) out.shipClass = m.api_ctype;
    if (Object.keys(bonus).length > 0) out.equipBonus = bonus;
    if (exInput) out.exSlot = exInput;
    const range = r.range.value;
    if (range !== null && range > 0) out.range = range;
    const speed = r.speed.value;
    if (speed !== null) out.speed = speed;
    return out;
  });

  return { input, warnings, fitSkipped };
};

// ---- enemy ----

export type EstimateMap = Partial<Record<HiddenStat, { value: number; confidence: string; source: string }>>;

const CONFIDENCE_RANK: Record<Confidence, number> = { observed: 0, datamined: 1, db_estimate: 2, placeholder: 3, unknown: 4 };

/**
 * 艦の隠しステータスの最良値。API の `best` をそのまま使うが、`useServerEstimates` が false なら
 * サーバの推定 (estimator:server) を無視し、その項目は残りの出典から確度順 (同じなら新しい順) で選び直す。
 */
export const bestEstimates = (detail: ShipDetail | undefined, useServerEstimates: boolean): EstimateMap => {
  const best: EstimateMap = detail?.best ?? {};
  if (useServerEstimates || !detail || !Object.values(best).some((b) => b?.source === SERVER_ESTIMATOR_SOURCE)) return best;
  const out: EstimateMap = {};
  for (const [stat, b] of Object.entries(best) as [HiddenStat, NonNullable<EstimateMap[HiddenStat]>][]) {
    if (b.source !== SERVER_ESTIMATOR_SOURCE) {
      out[stat] = b;
      continue;
    }
    const next = detail.estimates
      .filter((e) => e.stat === stat && e.source !== SERVER_ESTIMATOR_SOURCE)
      .sort((x, y) => CONFIDENCE_RANK[x.confidence] - CONFIDENCE_RANK[y.confidence] || y.updatedAt.localeCompare(x.updatedAt))[0];
    if (next) out[stat] = { value: next.value, confidence: next.confidence, source: next.source };
  }
  return out;
};

/** `best` を ShipInput に入れる。best に無い隠しステータスは 0 (sim-core の既定)。 */
export const applyBest = (ship: ShipInput, best: EstimateMap): ShipInput => ({
  ...ship,
  stats: {
    ...ship.stats,
    evasion: best.ev?.value ?? 0,
    asw: best.asw?.value ?? 0,
    los: best.los?.value ?? 0,
    luck: best.luck?.value ?? 0,
  },
  // tacc (kcsim TACC, 雷撃のみ) → torpedoAccuracy; acc (推定器の汎用隠し命中) → hiddenAccuracy。
  // TACC を hiddenAccuracy に入れると砲撃・夜戦の命中が +50〜85 され、被害が過大になる。
  ...(best.tacc ? { torpedoAccuracy: best.tacc.value } : {}),
  ...(best.acc ? { hiddenAccuracy: best.acc.value } : {}),
});

export interface EnemyLookup {
  ship: (id: number) => ApiShip | undefined;
  equip: (id: number) => ApiEquipment | undefined;
  detail: (id: number) => ShipDetail | undefined;
}

export interface EnemyBuild {
  input: ShipInput[];
  warnings: string[];
  /** 隠しステータスごとの出典の確度 (信頼性パネル用)。n は estimator:server のときの観測数 */
  reliability: { shipId: number; name: string; stat: HiddenStat; confidence: string; value: number | null; source: string | null; n: number | null }[];
}

const apiEquipToInput = (e: ApiEquipment, planes: number): EquipmentInput => {
  const stats: EquipmentStats = {};
  if (e.fp) stats.firepower = e.fp;
  if (e.tp) stats.torpedo = e.tp;
  if (e.aa) stats.antiAir = e.aa;
  if (e.ar) stats.armor = e.ar;
  if (e.ev) stats.evasion = e.ev;
  if (e.asw) stats.asw = e.asw;
  if (e.los) stats.los = e.los;
  if (e.acc) stats.accuracy = e.acc;
  if (e.bomb) stats.bombing = e.bomb;
  if (e.luck) stats.luck = e.luck;
  if (e.range) stats.range = e.range;
  const input: EquipmentInput = { id: e.id, types: e.type, stats };
  if (AIRCRAFT_TYPES.has(e.type[2] ?? 0)) input.planes = planes;
  return input;
};
const AIRCRAFT_TYPES = new Set([6, 7, 8, 9, 10, 11, 25, 26, 41, 45, 47, 48, 49, 56, 57, 58, 59]);

export interface BuildEnemyOptions {
  /** サーバの推定値 (estimator:server の best) を使う。既定 true */
  useServerEstimates?: boolean;
  /** 隠しステータスを入れない (推定器が自前で決めるとき。stats は API の可視値だけ)。reliability は空。 */
  skipHiddenStats?: boolean;
}

export const buildEnemyShips = (ships: CompShip[], lookup: EnemyLookup, opts: BuildEnemyOptions = {}): EnemyBuild => {
  const warnings: string[] = [];
  const reliability: EnemyBuild["reliability"] = [];

  const input = ships.map((cs): ShipInput => {
    const info = lookup.ship(cs.shipId);
    const name = info?.name ?? `#${cs.shipId}`;
    if (!info) warnings.push(`${name}: 艦マスターが見つかりません (艦種 0 として扱います)`);

    // 搭載数は master の slots (api_maxeq)。装備スロットと同じ並び
    const equips = cs.equips.map((id, i): EquipmentInput | null => {
      if (id <= 0) return null;
      const e = lookup.equip(id);
      if (!e) {
        warnings.push(`${name}: 装備#${id} が不明`);
        return null;
      }
      return apiEquipToInput(e, info?.slots?.[i] ?? 0);
    });

    const base: ShipInput = {
      id: cs.shipId,
      name,
      shipType: info?.stype ?? 0,
      level: cs.level,
      maxHp: cs.hp || info?.hp || 1,
      stats: { firepower: cs.fp, torpedo: cs.tp, antiAir: cs.aa, armor: cs.ar },
      slots: equips.slice(0, 5),
    };
    if (info?.range) base.range = info.range;
    if (info?.speed != null) base.speed = info.speed;

    const detail = lookup.detail(cs.shipId);
    if (opts.skipHiddenStats) return base;
    const best = bestEstimates(detail, opts.useServerEstimates ?? true);
    for (const stat of ["ev", "asw", "los", "luck", "acc", "tacc"] as HiddenStat[]) {
      const b = best[stat];
      const n = b?.source === SERVER_ESTIMATOR_SOURCE ? (detail?.estimates.find((e) => e.stat === stat && e.source === b.source)?.n ?? null) : null;
      reliability.push({ shipId: cs.shipId, name, stat, confidence: b?.confidence ?? "unknown", value: b?.value ?? null, source: b?.source ?? null, n });
    }
    if (!detail) warnings.push(`${name}: 隠しステータスの推定値を取得できませんでした (0 扱い)`);
    return applyBest(base, best);
  });

  return { input, warnings, reliability };
};

// ---- battle ----

export interface BuildBattleOptions {
  kind: BattleKind;
  friendFormation: Formation;
  enemyFormation: Formation;
}

export const buildBattleInput = (friend: ShipInput[], enemy: ShipInput[], o: BuildBattleOptions): BattleInput => ({
  friend: { ships: friend, formation: o.friendFormation },
  enemy: { ships: enemy, formation: o.enemyFormation },
  options: { kind: o.kind },
});

export const enemyFormationOf = (comp: Pick<EnemyComp, "formation">): Formation =>
  ENEMY_FORMATION_BY_ID[comp.formation ?? 1] ?? "lineAhead";

export const friendFormationOf = (preset: Pick<Preset, "formation">): Formation =>
  FORMATION_MAP[preset.formation] ?? "lineAhead";

export type { PresetShip };
