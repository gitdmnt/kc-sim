/**
 * 推定の計算本体: 観測 → 敵艦ごとのグリッド事後分布 → EstimateResult。
 * wasm (hitProbabilityGrid) を呼ぶので、poi では sim.worker (file:// Worker) の中で動かす
 * (プラグインウィンドウの CSP がページ内の WebAssembly コンパイルを禁止しているため)。
 * 入出力はすべて構造化複製できる値。
 */
import { gridFor, signature, wasmGrid } from "./forward";
import type { GridFn } from "./forward";
import {
  axisForPrior, axisValues, DEFAULT_GRID, DEFAULT_PRIOR_SD, logPrior, priorSd, ShipPosterior, summarize,
} from "./posterior";
import type { GridSpec, OutcomeCounts, PriorSdTable, PriorSpec } from "./posterior";
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

interface Group {
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

/** 観測から敵艦ごとの推定値を求める (同期)。観測のある艦だけを、艦 id 順に ev / acc / luck で返す。 */
export const estimateFromObservations = (
  observations: Observation[],
  priors: PriorTable,
  opts: EstimateOptions = {}
): EstimateResult[] => {
  const grid: GridSpec = { ...DEFAULT_GRID, ...opts.grid };
  const sdTable = opts.priorSd ?? DEFAULT_PRIOR_SD;
  const gridFn = opts.gridFn ?? wasmGrid;
  const groups = groupObservations(observations);
  const total = [...groups.values()].reduce((s, g) => s + g.size, 0);
  let done = 0;
  const results: EstimateResult[] = [];

  for (const [shipId, ship] of [...groups].sort((x, y) => x[0] - y[0])) {
    const prior = {} as Record<EstimatedStat, PriorInput>;
    const sd = {} as Record<EstimatedStat, number | null>;
    const values = {} as Record<EstimatedStat, number[]>;
    for (const stat of ESTIMATED_STATS) {
      prior[stat] = priors[shipId]?.[stat] ?? FLAT;
      sd[stat] = priorSd(stat, prior[stat], sdTable);
      values[stat] = axisValues(axisForPrior(grid[stat], prior[stat], sd[stat]));
    }
    const post = new ShipPosterior(values.ev, values.acc, values.luck, opts.epsilon);
    for (const g of ship.values()) {
      const p = gridFor(gridFn, g.obs.query, g.obs.role, values);
      if (g.obs.role === "evasion") post.addEvasion(p, g.counts);
      else post.addAccuracy(p, g.counts);
      opts.onProgress?.(++done, total);
    }
    const logw = {} as Record<EstimatedStat, Float64Array>;
    for (const stat of ESTIMATED_STATS) logw[stat] = logPrior(values[stat], prior[stat], sd[stat]);
    const marginals = post.marginals(logw);
    const n: Record<EstimatedStat, number> = { ev: post.nEvasion, acc: post.nAccuracy, luck: post.nEvasion + post.nAccuracy };
    for (const stat of ESTIMATED_STATS) {
      const s = summarize(marginals[stat]);
      const priorP = logw[stat].map(Math.exp);
      const priorSummary = summarize({ values: values[stat], p: priorP });
      const info: PriorInfo = { source: prior[stat].source, confidence: prior[stat].confidence, value: prior[stat].value, sd: priorSummary.sd };
      const density = { min: values[stat][0], step: grid[stat].step, posterior: Array.from(marginals[stat].p), prior: Array.from(priorP) };
      results.push({ shipId, stat, mean: s.mean, sd: s.sd, ci90: s.ci90, n: n[stat], priorSource: info.source, prior: info, density });
    }
  }
  return results;
};
