/**
 * 推定の計算本体: 観測 → 敵艦ごとのグリッド事後分布 → EstimateResult。
 * wasm (hitProbabilityGrid) を呼ぶ。サーバの推定ジョブ (data-worker/src/estimator) は accumulate で
 * 観測を足し込んだグリッドを D1 に持ち越し、summarizeShip で要約する。estimateFromObservations は
 * 一括版 (検証用)。
 */
import { gridFor, signature, wasmGrid } from "./forward";
import type { GridFn } from "./forward";
import {
  axisForPrior, axisValues, DEFAULT_GRID, DEFAULT_PRIOR_SD, logPrior, priorSd, ShipPosterior, summarize,
} from "./posterior";
import type { GridSpec, OutcomeCounts, PosteriorState, PriorSdTable, PriorSpec } from "./posterior";
import { ESTIMATED_STATS } from "./types";
import type { EstimatedStat, EstimateResult, Observation, PriorInfo } from "./types";

/** 事前分布 (API の estimates 1 行に相当)。 */
export interface PriorInput extends PriorSpec {
  source: string;
}

/** 敵艦 master id → ステータスごとの事前分布。無い艦・ステータスは平坦。 */
export type PriorTable = Record<number, Partial<Record<EstimatedStat, PriorInput>>>;

/** Worker に渡せる (構造化複製できる) 推定オプション。 */
export interface InferOptions {
  /** 既定 DEFAULT_GRID (ev 0..200, acc 0..200, luck 0..100, 刻み 1)。事前分布の中心が外なら上端を広げる。 */
  grid?: Partial<GridSpec>;
  priorSd?: PriorSdTable;
  /** 外れ値混合率 (ShipPosterior)。既定 1e-3 */
  epsilon?: number;
}

export interface EstimateOptions extends InferOptions {
  /** 既定は wasm の hitProbabilityGrid (sim-core の init 済みであること) */
  gridFn?: GridFn;
  /** 署名ごとのグリッド計算の進捗 */
  onProgress?: (done: number, total: number) => void;
}

export interface Group {
  obs: Observation;
  counts: OutcomeCounts;
}

/** 敵艦ごと・署名ごとに観測を数える (同じ署名は同じ確率なのでグリッド計算は 1 回で済む)。 */
export const groupObservations = (observations: Observation[]): Map<number, Map<string, Group>> => {
  const out = new Map<number, Map<string, Group>>();
  for (const o of observations) {
    let ship = out.get(o.shipId);
    if (!ship) out.set(o.shipId, (ship = new Map()));
    const key = `${o.role}|${signature(o.query)}`;
    let g = ship.get(key);
    if (!g) ship.set(key, (g = { obs: o, counts: { miss: 0, hit: 0, crit: 0 } }));
    g.counts[o.outcome]++;
  }
  return out;
};

const FLAT: PriorInput = { value: null, confidence: "none", source: "flat" };

/** 艦 1 隻の事前分布・その sd (null は平坦)・グリッドの軸。 */
export interface ShipPrior {
  prior: Record<EstimatedStat, PriorInput>;
  sd: Record<EstimatedStat, number | null>;
  /** 事前分布の中心 + 3sd が上端を超える軸は広げてある */
  axes: GridSpec;
}

export const shipPrior = (priors: PriorTable[number] | undefined, grid: GridSpec, sdTable: PriorSdTable = DEFAULT_PRIOR_SD): ShipPrior => {
  const out = { prior: {}, sd: {}, axes: { ...grid } } as ShipPrior;
  for (const stat of ESTIMATED_STATS) {
    out.prior[stat] = priors?.[stat] ?? FLAT;
    out.sd[stat] = priorSd(stat, out.prior[stat], sdTable);
    out.axes[stat] = axisForPrior(grid[stat], out.prior[stat], out.sd[stat]);
  }
  return out;
};

/** 軸の上に空の事後分布を作る (state があれば続きから)。 */
export const newPosterior = (axes: GridSpec, epsilon?: number, state?: PosteriorState): ShipPosterior =>
  new ShipPosterior(axisValues(axes.ev), axisValues(axes.acc), axisValues(axes.luck), epsilon, state);

/** 1 隻分の署名グループを事後分布に足し込む (署名ごとに hitProbabilityGrid を 1 回)。 */
export const accumulate = (post: ShipPosterior, groups: Iterable<Group>, gridFn: GridFn, onEach?: () => void): void => {
  const values = { ev: post.ev, acc: post.acc, luck: post.luck };
  for (const g of groups) {
    const p = gridFor(gridFn, g.obs.query, g.obs.role, values);
    if (g.obs.role === "evasion") post.addEvasion(p, g.counts);
    else post.addAccuracy(p, g.counts);
    onEach?.();
  }
};

/**
 * 足し込み済みの事後分布と事前分布から ev / acc / luck の結果を作る。事前分布は事後分布の軸の上で
 * 評価する (保存済みの軸が今の事前分布の求める軸より狭ければ、その範囲で切れる)。
 */
export const summarizeShip = (shipId: number, post: ShipPosterior, sp: Pick<ShipPrior, "prior" | "sd">, steps: Record<EstimatedStat, number>): EstimateResult[] => {
  const values: Record<EstimatedStat, number[]> = { ev: post.ev, acc: post.acc, luck: post.luck };
  const logw = {} as Record<EstimatedStat, Float64Array>;
  for (const stat of ESTIMATED_STATS) logw[stat] = logPrior(values[stat], sp.prior[stat], sp.sd[stat]);
  const marginals = post.marginals(logw);
  const n: Record<EstimatedStat, number> = { ev: post.nEvasion, acc: post.nAccuracy, luck: post.nEvasion + post.nAccuracy };
  return ESTIMATED_STATS.map((stat): EstimateResult => {
    const s = summarize(marginals[stat]);
    const priorP = logw[stat].map(Math.exp);
    const priorSummary = summarize({ values: values[stat], p: priorP });
    const p = sp.prior[stat];
    const info: PriorInfo = { source: p.source, confidence: p.confidence, value: p.value, sd: priorSummary.sd };
    const density = { min: values[stat][0] ?? 0, step: steps[stat], posterior: Array.from(marginals[stat].p), prior: Array.from(priorP) };
    return { shipId, stat, mean: s.mean, sd: s.sd, ci90: s.ci90, n: n[stat], priorSource: info.source, prior: info, density };
  });
};

/** 観測から敵艦ごとの推定値を求める (同期)。観測のある艦だけを、艦 id 順に ev / acc / luck で返す。 */
export const estimateFromObservations = (
  observations: Observation[],
  priors: PriorTable,
  opts: EstimateOptions = {}
): EstimateResult[] => {
  const grid: GridSpec = { ...DEFAULT_GRID, ...opts.grid };
  const gridFn = opts.gridFn ?? wasmGrid;
  const groups = groupObservations(observations);
  const total = [...groups.values()].reduce((s, g) => s + g.size, 0);
  let done = 0;
  const results: EstimateResult[] = [];
  const steps = { ev: grid.ev.step, acc: grid.acc.step, luck: grid.luck.step };

  for (const [shipId, ship] of [...groups].sort((x, y) => x[0] - y[0])) {
    const sp = shipPrior(priors[shipId], grid, opts.priorSd);
    const post = newPosterior(sp.axes, opts.epsilon);
    accumulate(post, ship.values(), gridFn, () => opts.onProgress?.(++done, total));
    results.push(...summarizeShip(shipId, post, sp, steps));
  }
  return results;
};
