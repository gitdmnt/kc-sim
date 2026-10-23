/**
 * プリセット / 敵編成 → sim-core の BattleInput への変換 (純粋関数)。
 * 規約は docs/SIM_INTERFACE.md "Conventions" に従う: 艦の stats は「装備なし・装備ボーナスなし」。
 */
import type {
  BaseRaidInput,
  BattleInput,
  BattleKind,
  CombinedType,
  EquipmentInput,
  EquipmentStats,
  FleetInput,
  Formation,
  FriendFleetInput,
  LandBaseWave,
  RaidBase,
  ShipInput,
  SupportInput,
} from "../../sim-core/pkg/sim_core";
import { SERVER_ESTIMATOR_SOURCE } from "../data/types";
import type { ApiEquipment, ApiShip, CompShip, Confidence, EnemyComp, HiddenStat, ShipDetail } from "../data/types";
import { isAircraft } from "../fleet/calc";
import { resolveShipStats } from "../fleet/stats";
import type { EquipMaster, MasterData, Preset, PresetAirBase, PresetEquip, PresetFleetType, PresetFormation, PresetShip } from "../fleet/types";
import { abyssalTraits, HIDDEN_FALLBACK_SOURCE, hiddenFallback } from "./abyssal";
import { computeFitBonus, fitEquipOf, fitShipOf, fitToEquipmentStats } from "./fit";
import type { FitEntry } from "./fit";

export const FORMATION_MAP: Record<PresetFormation, Formation> = {
  line_ahead: "lineAhead",
  double_line: "doubleLine",
  diamond: "diamond",
  echelon: "echelon",
  line_abreast: "lineAbreast",
  vanguard: "vanguard",
  combined_anti_sub: "combinedAntiSub",
  combined_forward: "combinedForward",
  combined_diamond: "combinedDiamond",
  combined_battle: "combinedBattle",
};

/** 連合艦隊の種別 (通常艦隊・遊撃部隊は undefined) */
export const COMBINED_TYPE: Record<PresetFleetType, CombinedType | undefined> = {
  single: undefined,
  carrier_task_force: "carrier",
  surface_task_force: "surface",
  transport_escort: "transport",
  striking_force: undefined,
};

/** 連合艦隊用の陣形 (sim-core の名前) */
export const isCombinedFormation = (f: Formation): boolean => f.startsWith("combined");

/** 通常艦隊の formation id (API 1-6) → sim-core。連合艦隊 (11-14) は COMBINED_FORMATION_BY_ID (随伴のある敵編成だけ)。 */
export const ENEMY_FORMATION_BY_ID: Record<number, Formation> = {
  1: "lineAhead", 2: "doubleLine", 3: "diamond", 4: "echelon", 5: "lineAbreast", 6: "vanguard",
};
/** 連合艦隊の formation id (第一〜第四警戒航行序列) → sim-core */
export const COMBINED_FORMATION_BY_ID: Record<number, Formation> = {
  11: "combinedAntiSub", 12: "combinedForward", 13: "combinedDiamond", 14: "combinedBattle",
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
  /** 警告の艦の頭に付ける艦隊名 (支援艦隊・友軍艦隊)。既定は無し */
  prefix?: string;
}

export interface FriendBuild {
  /** 通常艦隊の艦、連合艦隊なら主力 */
  input: ShipInput[];
  /** 連合艦隊の随伴 (通常艦隊は undefined) */
  escort?: ShipInput[];
  combined?: CombinedType;
  warnings: string[];
  /** 未知のキーや master に無い艦情報 (初期艦・国籍) のため評価できなかった装備ボーナス定義の数 (全艦合計) */
  fitUnresolved: number;
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

/** プリセットの艦隊 (連合艦隊なら主力と随伴) を sim-core の艦にする。随伴の警告は「随伴n番艦」。 */
export const buildFriendShips = (preset: Preset, master: MasterData, opts: FriendOptions = {}): FriendBuild => {
  const warnings: string[] = [];
  let fitUnresolved = 0;
  const apply = opts.applyFit !== false && !!opts.fitBonuses;

  const toInput = (prefix: string) => (ship: PresetShip, idx: number): ShipInput => {
    const m = master.ships[ship.masterId];
    const label = `${prefix}${idx + 1}番艦 (${m?.api_name ?? `#${ship.masterId}`})`;
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
    let rangeBonus = 0;
    if (apply) {
      const fit = computeFitBonus(fitShipOf(ship.masterId, master), all.map((e) => fitEquipOf(e, master)), opts.fitBonuses!);
      bonus = fitToEquipmentStats(fit.bonus);
      rangeBonus = fit.bonus.leng ?? 0;
      fitUnresolved += fit.unresolved;
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
    // 観測した射程は装備ボーナス込み。計算値 (max(艦, 装備)) には射程ボーナスを足す。
    const range = r.range.value === null ? null : r.range.value + (r.range.source === "observed" ? 0 : rangeBonus);
    if (range !== null && range > 0) out.range = range;
    const speed = r.speed.value;
    if (speed !== null) out.speed = speed;
    return out;
  };

  const combined = COMBINED_TYPE[preset.fleetType];
  const input = preset.ships.map(toInput(opts.prefix ?? ""));
  if (!combined) return { input, warnings, fitUnresolved };
  return { input, escort: (preset.escort ?? []).map(toInput("随伴")), combined, warnings, fitUnresolved };
};

/** 偵察機 (艦偵・水偵・大艇・陸偵・艦偵II) の api_type[2] */
const RECON_TYPES = new Set([9, 10, 41, 49, 94]);
/** 大型陸上機 (重爆) の api_type[2] */
const LARGE_LAND_BOMBER = 53;

/** 基地の中隊の満載の機数: 偵察機は 4、大型陸上機は 9、他は 18 (sim-core の既定と同じ) */
export const squadronSize = (m: EquipMaster | undefined): number => {
  const t = m?.api_type?.[2] ?? 0;
  return RECON_TYPES.has(t) ? 4 : t === LARGE_LAND_BOMBER ? 9 : 18;
};

/** 出撃の基地航空隊の中隊 (空きは除く)。機数は slotSize、無ければ満載。半径はマスターの api_distance */
export const buildSquadrons = (base: PresetAirBase, master: MasterData): EquipmentInput[] =>
  base.squadrons.flatMap((e) => {
    const m = e && master.equips[e.masterId];
    if (!e || !m) return [];
    return [
      equipFromMaster(m, {
        improvement: e.improvement,
        proficiency: e.proficiency,
        planes: e.slotSize ?? squadronSize(m),
        ...(m.api_distance ? { radius: m.api_distance } : {}),
      }),
    ];
  });

/**
 * 基地の行動半径: 中隊の最小半径 + 偵察機による延長 min(3, round(√(偵察機の最大半径 − 最小半径)))。
 * zh.kcwiki「基地航空队」航程数据 (日 wiki より、運営 twitter 764086515177631744)。半径の分かる中隊が無ければ null
 */
export const baseRadius = (squadrons: EquipmentInput[]): number | null => {
  const known = squadrons.filter((s) => s.radius !== undefined);
  if (known.length === 0) return null;
  const min = Math.min(...known.map((s) => s.radius!));
  const recon = Math.max(min, ...known.filter((s) => RECON_TYPES.has(s.types[2] ?? 0)).map((s) => s.radius!));
  return min + Math.min(3, Math.round(Math.sqrt(recon - min)));
};

/** 単一マス戦闘の基地航空隊の波: 出撃の隊のうち目標が `node` の波 (隊の順、1 波目 → 2 波目) */
export const landBaseWaves = (bases: PresetAirBase[] | undefined, node: string, master: MasterData): LandBaseWave[] =>
  (bases ?? []).flatMap((b) => {
    if (b.mode !== "sortie") return [];
    const squadrons = buildSquadrons(b, master);
    return squadrons.length === 0 ? [] : b.targets.filter((t) => t === node).map(() => ({ squadrons }));
  });

/** 基地空襲を受ける基地: 中隊のある隊すべて (迎撃するのは防空の隊だけ)。`numbers` は各基地の番号 (第n基地) */
export const raidBases = (bases: PresetAirBase[] | undefined, master: MasterData): { bases: RaidBase[]; numbers: number[] } => {
  const out: { bases: RaidBase[]; numbers: number[] } = { bases: [], numbers: [] };
  (bases ?? []).forEach((b, i) => {
    const squadrons = buildSquadrons(b, master);
    if (squadrons.length === 0) return;
    out.bases.push({ squadrons, ...(b.mode === "defense" ? { defense: true } : {}) });
    out.numbers.push(i + 1);
  });
  return out;
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

/**
 * `best` を ShipInput に入れる。best に無い回避・対潜・索敵・運は `fallback` (艦種別の代替値)、
 * それも無ければ 0。
 */
export const applyBest = (ship: ShipInput, best: EstimateMap, fallback?: readonly [number, number, number, number] | null): ShipInput => ({
  ...ship,
  stats: {
    ...ship.stats,
    evasion: best.ev?.value ?? fallback?.[0] ?? 0,
    asw: best.asw?.value ?? fallback?.[1] ?? 0,
    los: best.los?.value ?? fallback?.[2] ?? 0,
    luck: best.luck?.value ?? fallback?.[3] ?? 0,
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
    // 陸上型・PT・集積地・特効対象・夜戦攻撃・先制対潜 (ships.flags = kcSHIPDATA)
    Object.assign(base, abyssalTraits(info?.flags));

    const detail = lookup.detail(cs.shipId);
    if (opts.skipHiddenStats) return base;
    const best = bestEstimates(detail, opts.useServerEstimates ?? true);
    const fallback = hiddenFallback(base.shipType, base.maxHp);
    const FALLBACK_INDEX: Partial<Record<HiddenStat, 0 | 1 | 2 | 3>> = { ev: 0, asw: 1, los: 2, luck: 3 };
    const missing: HiddenStat[] = [];
    for (const stat of ["ev", "asw", "los", "luck", "acc", "tacc"] as HiddenStat[]) {
      const b = best[stat];
      const n = b?.source === SERVER_ESTIMATOR_SOURCE ? (detail?.estimates.find((e) => e.stat === stat && e.source === b.source)?.n ?? null) : null;
      const fi = FALLBACK_INDEX[stat];
      if (!b && fi !== undefined && fallback) {
        missing.push(stat);
        reliability.push({ shipId: cs.shipId, name, stat, confidence: "placeholder", value: fallback[fi]!, source: HIDDEN_FALLBACK_SOURCE, n: null });
        continue;
      }
      reliability.push({ shipId: cs.shipId, name, stat, confidence: b?.confidence ?? "unknown", value: b?.value ?? null, source: b?.source ?? null, n });
    }
    if (missing.length > 0) warnings.push(`${name}: 隠しステータス (${missing.join(", ")}) の推定値が無いため艦種別の代替値を使います`);
    else if (!detail) warnings.push(`${name}: 隠しステータスの推定値を取得できませんでした (0 扱い)`);
    return applyBest(base, best, fallback);
  });

  return { input, warnings, reliability };
};

/** 敵編成 → sim-core の敵艦隊 (随伴があれば敵連合艦隊)。build.input は結果と同じ並び (主力の後に随伴) */
export const buildEnemyFleet = (
  comp: Pick<EnemyComp, "formation" | "main" | "escort">,
  lookup: EnemyLookup,
  opts: BuildEnemyOptions = {}
): { fleet: FleetInput; build: EnemyBuild } => {
  const main = buildEnemyShips(comp.main, lookup, opts);
  if (comp.escort.length === 0) return { fleet: { ships: main.input, formation: enemyFormationOf(comp) }, build: main };
  const escort = buildEnemyShips(comp.escort, lookup, opts);
  return {
    fleet: { ships: main.input, escort: escort.input, formation: enemyFormationOf(comp) },
    build: { input: [...main.input, ...escort.input], warnings: [...main.warnings, ...escort.warnings], reliability: [...main.reliability, ...escort.reliability] },
  };
};

// ---- battle ----

export interface BuildBattleOptions {
  kind: BattleKind;
  lbas?: LandBaseWave[];
  /** 煙幕を展開する (出撃中 1 回) */
  smoke?: boolean;
  /** 阻塞気球マス (`isBalloonNode`) */
  balloons?: boolean;
  support?: SupportInput;
  friendFleet?: FriendFleetInput;
  baseRaid?: BaseRaidInput;
}

/** 味方の FleetInput (連合艦隊なら随伴と種別つき) */
export const friendFleet = (build: Pick<FriendBuild, "input" | "escort" | "combined">, formation?: Formation): FleetInput => ({
  ships: build.input,
  ...(formation ? { formation } : {}),
  ...(build.combined ? { escort: build.escort ?? [], combined: build.combined } : {}),
});

export const buildBattleInput = (friend: FleetInput, enemy: FleetInput, o: BuildBattleOptions): BattleInput => ({
  friend,
  enemy,
  options: { kind: o.kind, ...(o.smoke ? { smoke: true } : {}), ...(o.balloons ? { balloons: true } : {}) },
  ...(o.lbas?.length ? { lbas: o.lbas } : {}),
  ...(o.support ? { support: o.support } : {}),
  ...(o.friendFleet ? { friendFleet: o.friendFleet } : {}),
  ...(o.baseRaid ? { baseRaid: o.baseRaid } : {}),
});

/** 敵の陣形。随伴のある編成 (敵連合艦隊) は警戒航行序列 (不明・通常の陣形なら第四)、ほかは通常の陣形 (不明なら単縦陣) */
export const enemyFormationOf = (comp: Pick<EnemyComp, "formation" | "escort">): Formation =>
  comp.escort.length > 0
    ? (COMBINED_FORMATION_BY_ID[comp.formation ?? 14] ?? "combinedBattle")
    : (ENEMY_FORMATION_BY_ID[comp.formation ?? 1] ?? "lineAhead");

/** プリセットの陣形。艦隊の種類 (通常 / 連合) に合わない陣形なら、その種類の既定 (単縦陣 / 第四警戒航行序列) */
export const friendFormationOf = (preset: Pick<Preset, "formation" | "fleetType">): Formation => {
  const f = FORMATION_MAP[preset.formation] ?? "lineAhead";
  const combined = COMBINED_TYPE[preset.fleetType] !== undefined;
  return isCombinedFormation(f) === combined ? f : combined ? "combinedBattle" : "lineAhead";
};

export type { PresetShip };
