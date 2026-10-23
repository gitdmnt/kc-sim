/**
 * 艦隊の集計用の純粋関数 (33式索敵 / 制空値 / 速力 / ドラム缶・電探)。
 *
 * 係数は wiki・計算機の通説値で、ゲーム内検証までは行っていない:
 * - 33式: 装備係数 艦攻0.8 艦爆1.0 艦偵1.0 水偵1.2 水爆1.1 電探0.6 その他0.6、
 *   改修補正 小型電探1.25√★ 大型電探1.4√★ 水偵1.2√★ 水爆1.15√★。
 *   Cn = Σ(係数 × (装備索敵 + 改修補正)) × cn + Σ√(各艦の装備なし索敵) − ceil(0.4×司令部Lv) + 2×(6−艦数)
 * - 制空値: Σ floor((対空 + 改修補正) × √搭載数 + √(内部熟練/10) + 機種別ボーナス)。
 *   改修補正は 艦戦/水戦/局戦 0.2★・艦爆 0.25★ (対空値を持つもののみ)。
 */
import type { EquipMaster, MasterData, Preset, PresetEquip, PresetShip } from "./types";
import { shipBoostedSpeed } from "./speed";
import { resolveShipStats, sumEquipStats } from "./stats";

// api_type[2] (装備カテゴリ)
export const EQUIP_TYPE = {
  FIGHTER: 6,
  DIVE_BOMBER: 7,
  TORPEDO_BOMBER: 8,
  CARRIER_RECON: 9,
  SEAPLANE_RECON: 10,
  SEAPLANE_BOMBER: 11,
  SMALL_RADAR: 12,
  LARGE_RADAR: 13,
  FLYING_BOAT: 41,
  SEAPLANE_FIGHTER: 45,
  LAND_ATTACKER: 47,
  LAND_FIGHTER: 48,
  LAND_RECON: 49,
  JET_FIGHTER: 56,
  JET_BOMBER: 57,
  JET_ATTACKER: 58,
  JET_RECON: 59,
} as const;

/** 搭載数と熟練度を持つ航空機カテゴリ。 */
const AIRCRAFT = new Set<number>([
  6, 7, 8, 9, 10, 11, 41, 45, 47, 48, 49, 56, 57, 58, 59,
]);
const FIGHTER_LIKE = new Set<number>([6, 45, 48, 56]);

export const equipType2 = (m: EquipMaster | undefined): number => m?.api_type?.[2] ?? 0;
export const isAircraft = (m: EquipMaster | undefined): boolean => AIRCRAFT.has(equipType2(m));

/** 熟練度 0-7 (>> 表示) に対応する内部熟練度の代表値。 */
export const INTERNAL_PROFICIENCY = [0, 10, 25, 40, 55, 70, 85, 100];

const FIGHTER_BONUS = [0, 0, 2, 5, 9, 14, 14, 22];
const SEAPLANE_BOMBER_BONUS = [0, 0, 1, 1, 1, 3, 3, 6];

const clampProf = (p: number) => Math.min(7, Math.max(0, Math.trunc(p)));

/** 1 スロットの制空値。航空機でなければ 0。 */
export const slotFighterPower = (
  m: EquipMaster | undefined,
  equip: Pick<PresetEquip, "improvement" | "proficiency">,
  slotSize: number
): number => {
  if (!m || !isAircraft(m) || slotSize <= 0) return 0;
  const t = equipType2(m);
  const aa = m.api_tyku ?? 0;
  const star = equip.improvement;
  const starBonus = FIGHTER_LIKE.has(t) ? 0.2 * star : t === 7 && aa > 0 ? 0.25 * star : 0;
  const prof = clampProf(equip.proficiency);
  const typeBonus = (FIGHTER_LIKE.has(t)
    ? FIGHTER_BONUS[prof]
    : t === 11
      ? SEAPLANE_BOMBER_BONUS[prof]
      : 0) ?? 0;
  const base = (aa + starBonus) * Math.sqrt(slotSize);
  // 対空 0 の機体 (偵察機など) は熟練度ボーナスも付かない
  if (aa <= 0) return 0;
  return Math.floor(base + Math.sqrt((INTERNAL_PROFICIENCY[prof] ?? 0) / 10) + typeBonus);
};

const slotSizeOf = (ship: PresetShip, idx: number, shipMasterMaxeq?: number[]) =>
  ship.equips[idx]?.slotSize ?? shipMasterMaxeq?.[idx] ?? 0;

export const shipFighterPower = (ship: PresetShip, master: MasterData): number => {
  const maxeq = master.ships[ship.masterId]?.api_maxeq;
  return ship.equips.reduce((sum, e, i) => {
    if (!e) return sum;
    return sum + slotFighterPower(master.equips[e.masterId], e, slotSizeOf(ship, i, maxeq));
  }, 0);
};

export const fleetFighterPower = (ships: PresetShip[], master: MasterData): number =>
  ships.reduce((sum, s) => sum + shipFighterPower(s, master), 0);

// ---- 33式索敵 ----
// 係数は sim-core routing::los33 / kcsim と同じ。共通テストベクタ: sim-core/tests/fixtures/los33-vectors.json

const CARRIER_RECON_2 = 94;
const LARGE_RADAR_2 = 93;
/** 装備種別ごとの係数 (艦爆を含むその他は 0.6)。 */
const LOS_COEFFICIENT: Record<number, number> = {
  [EQUIP_TYPE.TORPEDO_BOMBER]: 0.8,
  [EQUIP_TYPE.CARRIER_RECON]: 1.0,
  [CARRIER_RECON_2]: 1.0,
  [EQUIP_TYPE.SEAPLANE_RECON]: 1.2,
  [EQUIP_TYPE.SEAPLANE_BOMBER]: 1.1,
};
/** 改修ボーナス係数 (× √★)。 */
const LOS_STAR: Record<number, number> = {
  [EQUIP_TYPE.CARRIER_RECON]: 1.2,
  [CARRIER_RECON_2]: 1.2,
  [EQUIP_TYPE.SMALL_RADAR]: 1.25,
  [EQUIP_TYPE.LARGE_RADAR]: 1.4,
  [LARGE_RADAR_2]: 1.4,
  [EQUIP_TYPE.SEAPLANE_RECON]: 1.2,
  [EQUIP_TYPE.SEAPLANE_BOMBER]: 1.15,
  [EQUIP_TYPE.FLYING_BOAT]: 1.2,
};

export interface LosEquip {
  type2: number;
  los: number;
  improvement: number;
}
export interface LosShip {
  /** 装備を除いた艦娘自身の索敵値 */
  bareLos: number;
  equips: LosEquip[];
}

export const losEquipScore = (e: LosEquip): number => {
  const coef = LOS_COEFFICIENT[e.type2] ?? 0.6;
  const starBonus = (LOS_STAR[e.type2] ?? 0) * Math.sqrt(Math.max(0, e.improvement));
  return coef * (e.los + starBonus);
};

/**
 * 判定式(33) (docs/ROUTING_DSL.md §5)。`cn` は分岐点係数 (1-4)。連合艦隊は両艦隊の艦を渡し、
 * 末尾の項の定数 (`fullSize`) を 12 にする。小数第 2 位で切り捨てる (sim-core routing::los33 と同じ)。
 */
export const mapLos33 = (ships: LosShip[], hqLevel: number, cn = 1, fullSize = 6): number => {
  const equipTerm = ships.reduce(
    (sum, s) => sum + s.equips.reduce((a, e) => a + losEquipScore(e), 0),
    0
  );
  const shipTerm = ships.reduce((sum, s) => sum + Math.sqrt(Math.max(0, s.bareLos)), 0);
  const v = equipTerm * cn + shipTerm - Math.ceil(0.4 * hqLevel) + 2 * (fullSize - ships.length);
  // 加算順の浮動小数点誤差を epsilon で吸収する (routing.rs と同じ)
  return Math.floor(v * 100 + 1e-7) / 100;
};

/** 判定式(33) の末尾の項の定数: 通常艦隊 6、連合艦隊 12。 */
export const losFullSize = (combined: boolean): number => (combined ? 12 : 6);

// ---- 艦隊サマリ ----

const DRUM_CANISTER_ID = 75;

export interface FleetSummary {
  /** 艦隊速力 (最も遅い艦)。不明な艦しか無ければ null */
  speed: number | null;
  /** 装備による速力補正 (缶・タービン) を含まない値か。補正を計算できなかった艦 (master 無し) があるとき true */
  speedIsBase: boolean;
  /** 補正の計算に、一覧に無い艦の既定の速力グループを使った艦があるか */
  speedGuessed: boolean;
  los: { cn1: number; cn2: number; cn3: number; cn4: number } | null;
  fighterPower: number;
  drums: { total: number; ships: number };
  radars: number;
}

/**
 * 装備を除いた索敵値。表示値 (実測・計算とも装備の索敵を含む) から装備の素の索敵を引く。
 * 装備ボーナス (固有・改修) は差し引けないため、実測値では僅かに過小評価になりうる。
 */
const bareLosOf = (ship: PresetShip, master: MasterData): number | null => {
  const { value } = resolveShipStats(ship, master).los;
  return value === null ? null : value - sumEquipStats(ship, master).los;
};

/** `ships` は連合艦隊なら両艦隊を連結したもの。`combined` で判定式(33) の定数が 12 になる。 */
export const summarizeFleet = (
  ships: PresetShip[],
  master: MasterData,
  hqLevel = 120,
  combined = false
): FleetSummary => {
  const speeds = ships
    .map((s) => resolveShipStats(s, master).speed.value)
    .filter((v): v is number => v !== null);
  const unobserved = ships.filter((s) => !s.observed || s.observed.speed === undefined);

  const fullSize = losFullSize(combined);
  let los: FleetSummary["los"] = null;
  const bare = ships.map((s) => bareLosOf(s, master));
  if (ships.length > 0 && bare.every((v) => v !== null)) {
    const losShips: LosShip[] = ships.map((s, i) => ({
      bareLos: bare[i] as number,
      equips: [...s.equips, s.exSlot].flatMap((e) => {
        const m = e ? master.equips[e.masterId] : undefined;
        return e && m
          ? [{ type2: equipType2(m), los: m.api_saku ?? 0, improvement: e.improvement }]
          : [];
      }),
    }));
    los = {
      cn1: mapLos33(losShips, hqLevel, 1, fullSize),
      cn2: mapLos33(losShips, hqLevel, 2, fullSize),
      cn3: mapLos33(losShips, hqLevel, 3, fullSize),
      cn4: mapLos33(losShips, hqLevel, 4, fullSize),
    };
  }

  let drumTotal = 0;
  let drumShips = 0;
  let radars = 0;
  for (const ship of ships) {
    let drums = 0;
    for (const e of [...ship.equips, ship.exSlot]) {
      if (!e) continue;
      if (e.masterId === DRUM_CANISTER_ID) drums++;
      const t = equipType2(master.equips[e.masterId]);
      if (t === EQUIP_TYPE.SMALL_RADAR || t === EQUIP_TYPE.LARGE_RADAR) radars++;
    }
    drumTotal += drums;
    if (drums > 0) drumShips++;
  }

  return {
    speed: speeds.length > 0 ? Math.min(...speeds) : null,
    speedIsBase: unobserved.some((s) => !master.ships[s.masterId]),
    speedGuessed: unobserved.some((s) => {
      const m = master.ships[s.masterId];
      return !!m && shipBoostedSpeed(m, [...s.equips, s.exSlot].filter((e) => !!e)).guessed;
    }),
    los,
    fighterPower: fleetFighterPower(ships, master),
    drums: { total: drumTotal, ships: drumShips },
    radars,
  };
};

export const summarizePreset = (p: Preset, master: MasterData) =>
  summarizeFleet(p.ships, master, p.hqLevel ?? 120);
