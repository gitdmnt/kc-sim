/**
 * 敵艦 1 隻分のグリッド事後分布。
 *
 * θ = (ev, acc, luck) の事前分布は独立と置く。被弾側の観測は (ev, luck)、攻撃側の観測は (acc, luck)
 * にだけ依存するので、対数尤度を 2 つの 2 次元グリッドに貯め、周辺化は log-sum-exp で厳密に行う:
 *   p(luck) ∝ π(luck)·E(luck)·A(luck),  E(l) = Σ_ev π(ev)·L_ev(ev,l),  A(l) = Σ_acc π(acc)·L_acc(acc,l)
 *   p(ev)   ∝ π(ev)·Σ_l π(l)·A(l)·L_ev(ev,l)
 *   p(acc)  ∝ π(acc)·Σ_l π(l)·E(l)·L_acc(acc,l)
 */
import type { Confidence } from "../data/types";
import type { EstimatedStat } from "./types";

export interface Axis {
  min: number;
  max: number;
  step: number;
}

export type GridSpec = Record<EstimatedStat, Axis>;

export const DEFAULT_GRID: GridSpec = {
  ev: { min: 0, max: 200, step: 1 },
  acc: { min: 0, max: 200, step: 1 },
  luck: { min: 0, max: 100, step: 1 },
};

export const axisValues = (a: Axis): number[] => {
  const n = Math.floor((a.max - a.min) / a.step + 1e-9) + 1;
  return Array.from({ length: n }, (_, i) => a.min + i * a.step);
};

/** 確度ごとの事前分布の標準偏差。placeholder / unknown / 推定値なしは平坦。 */
export type PriorSdTable = Record<"observed" | "datamined" | "db_estimate", Record<EstimatedStat, number>>;

export const DEFAULT_PRIOR_SD: PriorSdTable = {
  // observed は API の sd があればそちらを使う
  observed: { ev: 5, acc: 8, luck: 5 },
  datamined: { ev: 3, acc: 5, luck: 3 },
  db_estimate: { ev: 10, acc: 15, luck: 10 },
};

export interface PriorSpec {
  value: number | null;
  confidence: Confidence | "none";
  /** API の sd (observed のとき優先) */
  sd?: number | null;
}

/** 事前分布の sd。null は平坦。 */
export const priorSd = (stat: EstimatedStat, p: PriorSpec, table: PriorSdTable = DEFAULT_PRIOR_SD): number | null => {
  if (p.value === null) return null;
  switch (p.confidence) {
    case "observed":
      return p.sd != null && p.sd > 0 ? p.sd : table.observed[stat];
    case "datamined":
    case "db_estimate":
      return table[p.confidence][stat];
    default:
      return null;
  }
};

/** 事前分布の中心がグリッド外なら上端を広げる (下端は固定)。 */
export const axisForPrior = (axis: Axis, p: PriorSpec, sd: number | null): Axis => {
  if (p.value === null || sd === null) return axis;
  const need = p.value + 3 * sd;
  if (need <= axis.max) return axis;
  return { ...axis, max: axis.min + Math.ceil((need - axis.min) / axis.step) * axis.step };
};

/** 正規化済み対数事前重み (離散化した正規分布、または一様)。 */
export const logPrior = (values: number[], p: PriorSpec, sd: number | null): Float64Array => {
  const out = new Float64Array(values.length);
  if (p.value !== null && sd !== null) {
    for (let i = 0; i < values.length; i++) out[i] = -((values[i] - p.value) ** 2) / (2 * sd * sd);
  }
  const z = logSumExp(out);
  for (let i = 0; i < out.length; i++) out[i] -= z;
  return out;
};

export const logSumExp = (v: ArrayLike<number>): number => {
  let m = -Infinity;
  for (let i = 0; i < v.length; i++) if (v[i] > m) m = v[i];
  if (m === -Infinity) return -Infinity;
  let s = 0;
  for (let i = 0; i < v.length; i++) s += Math.exp(v[i] - m);
  return m + Math.log(s);
};

export interface OutcomeCounts {
  miss: number;
  hit: number;
  crit: number;
}

export interface Marginal {
  values: number[];
  /** 確率 (和 1) */
  p: Float64Array;
}

export interface Summary {
  mean: number;
  sd: number;
  ci90: [number, number];
}

export const summarize = (m: Marginal): Summary => {
  let mean = 0;
  for (let i = 0; i < m.values.length; i++) mean += m.p[i] * m.values[i];
  let v = 0;
  for (let i = 0; i < m.values.length; i++) v += m.p[i] * (m.values[i] - mean) ** 2;
  const quantile = (q: number) => {
    let c = 0;
    for (let i = 0; i < m.values.length; i++) {
      c += m.p[i];
      if (c >= q - 1e-12) return m.values[i];
    }
    return m.values[m.values.length - 1];
  };
  return { mean, sd: Math.sqrt(v), ci90: [quantile(0.05), quantile(0.95)] };
};

const normalize = (lp: Float64Array): Float64Array => {
  const z = logSumExp(lp);
  const p = new Float64Array(lp.length);
  for (let i = 0; i < lp.length; i++) p[i] = Math.exp(lp[i] - z);
  return p;
};

/**
 * 1 隻分の対数尤度グリッド。
 * - `llEv[ie·nLuck + il]`: 被弾側の観測 (hitProbabilityGrid の evasion × luck 順)
 * - `llAcc[il·nAcc + ia]`: 攻撃側の観測 (hitProbabilityGrid の luck × hiddenAccuracy 順)
 */
export class ShipPosterior {
  readonly llEv: Float64Array;
  readonly llAcc: Float64Array;
  nEvasion = 0;
  nAccuracy = 0;
  /** log((1−ε)·k/100 + ε/3), k = 0..100。確率は sim-core の整数 % 由来なので表引きできる。 */
  private readonly logq: Float64Array;

  constructor(
    readonly ev: number[],
    readonly acc: number[],
    readonly luck: number[],
    /** 外れ値混合率 ε: 観測確率を (1−ε)·p + ε/3 にして確率 0 の結果で事後分布が潰れないようにする */
    epsilon = 1e-3
  ) {
    this.llEv = new Float64Array(ev.length * luck.length);
    this.llAcc = new Float64Array(luck.length * acc.length);
    this.logq = new Float64Array(101);
    for (let k = 0; k <= 100; k++) this.logq[k] = Math.log((1 - epsilon) * (k / 100) + epsilon / 3);
  }

  private fold(ll: Float64Array, grid: Float64Array, c: OutcomeCounts) {
    if (grid.length !== 2 * ll.length) throw new Error(`grid size ${grid.length} != ${2 * ll.length}`);
    const q = this.logq;
    for (let k = 0; k < ll.length; k++) {
      const h = Math.round(grid[2 * k] * 100);
      const cr = Math.round(grid[2 * k + 1] * 100);
      ll[k] += c.miss * q[100 - h] + c.hit * q[h - cr] + c.crit * q[cr];
    }
  }

  /** `grid` = hitProbabilityGrid(target: defender, evasion: ev, luck: luck) */
  addEvasion(grid: Float64Array, c: OutcomeCounts) {
    this.fold(this.llEv, grid, c);
    this.nEvasion += c.miss + c.hit + c.crit;
  }

  /** `grid` = hitProbabilityGrid(target: attacker, luck: luck, hiddenAccuracy: acc) */
  addAccuracy(grid: Float64Array, c: OutcomeCounts) {
    this.fold(this.llAcc, grid, c);
    this.nAccuracy += c.miss + c.hit + c.crit;
  }

  /** 対数事前重み (logPrior) から 3 つの周辺事後分布を求める。 */
  marginals(prior: Record<EstimatedStat, Float64Array>): Record<EstimatedStat, Marginal> {
    const nE = this.ev.length;
    const nA = this.acc.length;
    const nL = this.luck.length;
    const tmp = new Float64Array(Math.max(nE, nA, nL));

    // logE[l] = logΣ_ev π(ev)·L_ev(ev,l),  logA[l] = logΣ_acc π(acc)·L_acc(acc,l)
    const logE = new Float64Array(nL);
    const logA = new Float64Array(nL);
    for (let l = 0; l < nL; l++) {
      for (let e = 0; e < nE; e++) tmp[e] = prior.ev[e] + this.llEv[e * nL + l];
      logE[l] = logSumExp(tmp.subarray(0, nE));
      for (let a = 0; a < nA; a++) tmp[a] = prior.acc[a] + this.llAcc[l * nA + a];
      logA[l] = logSumExp(tmp.subarray(0, nA));
    }

    const lpLuck = new Float64Array(nL);
    for (let l = 0; l < nL; l++) lpLuck[l] = prior.luck[l] + logE[l] + logA[l];

    const lpEv = new Float64Array(nE);
    for (let e = 0; e < nE; e++) {
      for (let l = 0; l < nL; l++) tmp[l] = prior.luck[l] + logA[l] + this.llEv[e * nL + l];
      lpEv[e] = prior.ev[e] + logSumExp(tmp.subarray(0, nL));
    }

    const lpAcc = new Float64Array(nA);
    for (let a = 0; a < nA; a++) {
      for (let l = 0; l < nL; l++) tmp[l] = prior.luck[l] + logE[l] + this.llAcc[l * nA + a];
      lpAcc[a] = prior.acc[a] + logSumExp(tmp.subarray(0, nL));
    }

    return {
      ev: { values: this.ev, p: normalize(lpEv) },
      acc: { values: this.acc, p: normalize(lpAcc) },
      luck: { values: this.luck, p: normalize(lpLuck) },
    };
  }
}
