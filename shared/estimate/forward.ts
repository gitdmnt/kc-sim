/**
 * sim-core の順モデル (hitProbabilityGrid) の呼び出しと、問い合わせの正規化。
 *
 * 正規化は命中・会心の確率を変えない項目だけを落とし、同じ確率になる問い合わせを 1 つの署名に
 * まとめる (グリッド計算は署名ごとに 1 回)。根拠は sim-core の battle/calc.rs:
 * - HP は命中に効かない。例外は雷撃の攻撃側で、火力 (→ 命中の floor(火力/5)) が損傷段階
 *   (> 50% / > 25% / それ以下) で変わるので段階の代表値にする。
 * - 戦意は 50 / 30 / 20 の閾値でしか効かない (攻撃側 morale_acc, 防御側 morale_ev)。
 * - 燃料は 75% 未満のときの回避ペナルティ (75 − 燃料%) だけ。
 * - 弾薬・射程・速力・名前・id は命中に効かない。交戦形態は雷撃の火力だけ、夜戦情報は夜戦だけ。
 * - 艦隊内の位置と艦数は警戒陣のときだけ効く。
 * 合成データの一致テスト (recovery.test.ts) が、正規化後の確率がエンジンのログと一致することを確認する。
 */
import { hitProbabilityGrid } from "../../sim-core/pkg/sim_core";
import type { AttackQuery, HitGridQuery, ShipInput } from "../../sim-core/pkg/sim_core";
import type { ObservationRole } from "./types";

export type GridFn = (grid: HitGridQuery) => Float64Array;

/** wasm の hitProbabilityGrid。呼ぶ前に sim-core の init が済んでいること。 */
export const wasmGrid: GridFn = (grid) => hitProbabilityGrid(grid);

const moraleBucket = (m: number): number => (m >= 50 ? 50 : m >= 30 ? 30 : m >= 20 ? 20 : 0);

/** 雷撃の損傷段階 (sim-core torpedo_state_mod) の代表 HP。 */
const torpedoHp = (hp: number, maxHp: number): number | undefined => {
  const r = hp / maxHp;
  if (r > 0.5) return undefined;
  if (r > 0.25) return Math.floor(maxHp / 2);
  return Math.min(hp, 1);
};

const canonicalShip = (s: ShipInput, opts: { target: boolean; keepHp: boolean; friend: boolean }): ShipInput => {
  const out: ShipInput = { ...s };
  for (const k of ["name", "id", "speed", "range", "ammo", "ammoMax", "hp", "fuel", "fuelMax"] as const) delete out[k];
  if (opts.target) {
    out.stats = { ...s.stats, evasion: 0, luck: 0 };
    delete out.hiddenAccuracy;
  }
  if (opts.keepHp && s.hp !== undefined) {
    const h = torpedoHp(s.hp, s.maxHp);
    if (h !== undefined) out.hp = h;
  }
  out.morale = moraleBucket(s.morale ?? 49);
  if (opts.friend && s.fuel !== undefined) {
    const max = s.fuelMax ?? 100;
    const pct = max > 0 ? Math.floor((s.fuel * 100) / max) : 100;
    if (pct < 75) {
      out.fuel = pct;
      out.fuelMax = 100;
    }
  }
  return out;
};

/**
 * 推定対象 (敵艦) の隠しステータスを 0 にし、命中・会心に効かない項目を落とした問い合わせ。
 * evasion: 敵 = 防御側、accuracy: 敵 = 攻撃側。
 */
export const canonicalQuery = (q: AttackQuery, role: ObservationRole): AttackQuery => {
  const torpedo = q.kind === "torpedo";
  const enemyAttacks = role === "accuracy";
  const out: AttackQuery = {
    kind: q.kind,
    attacker: canonicalShip(q.attacker, { target: enemyAttacks, keepHp: torpedo, friend: !enemyAttacks }),
    defender: canonicalShip(q.defender, { target: !enemyAttacks, keepHp: false, friend: enemyAttacks }),
    attackerSide: q.attackerSide ?? "friend",
    attackerFormation: q.attackerFormation ?? "lineAhead",
    defenderFormation: q.defenderFormation ?? "lineAhead",
  };
  if (out.attackerFormation === "vanguard") {
    out.attackerIndex = q.attackerIndex ?? 0;
    out.attackerFleetSize = q.attackerFleetSize ?? 6;
  }
  if (out.defenderFormation === "vanguard") {
    out.defenderIndex = q.defenderIndex ?? 0;
    out.defenderFleetSize = q.defenderFleetSize ?? 6;
  }
  if (torpedo && q.engagement) out.engagement = q.engagement;
  if (q.special && q.special !== "normal") out.special = q.special;
  if (q.kind === "night" && q.night) out.night = q.night;
  return out;
};

/** 正規化済みの問い合わせの署名 (同じ署名 ⇒ 同じ確率)。 */
export const signature = (q: AttackQuery): string => JSON.stringify(q);

/** 1 つの署名の観測に対する、対象艦の隠しステータスのグリッド上の [pHit, pCrit] 列。 */
export const gridFor = (
  gridFn: GridFn,
  q: AttackQuery,
  role: ObservationRole,
  axes: { ev: number[]; acc: number[]; luck: number[] }
): Float64Array =>
  role === "evasion"
    ? gridFn({ query: q, target: "defender", evasion: axes.ev, luck: axes.luck })
    : gridFn({ query: q, target: "attacker", luck: axes.luck, hiddenAccuracy: axes.acc });
