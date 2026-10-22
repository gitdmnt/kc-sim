/** simulateBattle を分割実行して結果を合成する (Worker と単体テストの両方から使う)。 */
import type {
  BattleInput, Dist, NodeSummary, PathRate, Rank, ShipSummary, SimulationSummary, SortieInput, SortieShipSummary, SortieSummary,
} from "@sim-core";

export type Engine = (input: BattleInput, count: number, seed: number) => SimulationSummary;

export interface Job {
  key: string;
  input: BattleInput;
  count: number;
  /** [0, 2^53)。チャンクごとに +index する */
  seed: number;
}

const MAX_SEED = 2 ** 53;

const weighted = <K extends string>(parts: { n: number; rec: Record<K, number> }[]): Record<K, number> => {
  const total = parts.reduce((s, p) => s + p.n, 0);
  const out = {} as Record<K, number>;
  for (const k of Object.keys(parts[0].rec) as K[]) {
    out[k] = total === 0 ? 0 : parts.reduce((s, p) => s + p.rec[k] * p.n, 0) / total;
  }
  return out;
};

const mergeShip = (list: { n: number; s: ShipSummary }[]): ShipSummary => {
  const total = list.reduce((a, p) => a + p.n, 0);
  const w = (f: (s: ShipSummary) => number) => (total === 0 ? 0 : list.reduce((a, p) => a + f(p.s) * p.n, 0) / total);
  const hist = new Array(list[0].s.hpHistogram.length).fill(0);
  for (const { s } of list) s.hpHistogram.forEach((c, i) => (hist[i] += c));
  return {
    maxHp: list[0].s.maxHp,
    hpMean: w((s) => s.hpMean),
    hpHistogram: hist,
    sunkRate: w((s) => s.sunkRate),
    heavyRate: w((s) => s.heavyRate),
    moderateRate: w((s) => s.moderateRate),
    lightRate: w((s) => s.lightRate),
    healthyRate: w((s) => s.healthyRate),
    damageDealtMean: w((s) => s.damageDealtMean),
    mvpRate: w((s) => s.mvpRate),
  };
};

/** 同じ入力から得た (または味方が同じ) サマリを件数で重み付けして合成する。艦数が違うとエラー。 */
export const mergeSummaries = (list: SimulationSummary[], opts: { skipEnemy?: boolean } = {}): SimulationSummary => {
  const parts = list.filter((s) => s.count > 0);
  if (parts.length === 0) return list[0];
  if (parts.length === 1) return opts.skipEnemy ? { ...parts[0], enemy: [] } : parts[0];
  const first = parts[0];
  const ships = (side: "friend" | "enemy") => {
    if (side === "enemy" && opts.skipEnemy) return [];
    return first[side].map((_, i) => {
      if (parts.some((p) => p[side].length !== first[side].length)) throw new Error(`mergeSummaries: ${side} fleet size mismatch`);
      return mergeShip(parts.map((p) => ({ n: p.count, s: p[side][i] })));
    });
  };
  const nPart = (f: (s: SimulationSummary) => number) => parts.map((p) => ({ n: p.count, rec: { v: f(p) } }));
  return {
    count: parts.reduce((s, p) => s + p.count, 0),
    rankRates: weighted(parts.map((p) => ({ n: p.count, rec: p.rankRates as Record<Rank, number> }))),
    airStateRates: weighted(parts.map((p) => ({ n: p.count, rec: p.airStateRates }))),
    nightBattleRate: weighted(nPart((p) => p.nightBattleRate)).v,
    enemyFlagshipSunkRate: weighted(nPart((p) => p.enemyFlagshipSunkRate)).v,
    friendHeavyAnyRate: weighted(nPart((p) => p.friendHeavyAnyRate)).v,
    friendSunkAnyRate: weighted(nPart((p) => p.friendSunkAnyRate)).v,
    friend: ships("friend"),
    enemy: ships("enemy"),
  };
};

export interface JobResult {
  key: string;
  summary: SimulationSummary;
}

/** 全ジョブをチャンク単位で実行する。同期処理で、チャンクごとに onProgress を呼ぶ。 */
export const runJobs = (
  engine: Engine,
  jobs: Job[],
  opts: { chunk?: number; onProgress?: (done: number, total: number) => void } = {}
): JobResult[] => {
  const chunk = Math.max(1, opts.chunk ?? 10_000);
  const total = jobs.reduce((s, j) => s + j.count, 0);
  let done = 0;
  return jobs.map((job) => {
    const parts: SimulationSummary[] = [];
    let remaining = job.count;
    for (let c = 0; remaining > 0; c++) {
      const n = Math.min(chunk, remaining);
      parts.push(engine(job.input, n, (job.seed + c) % MAX_SEED));
      remaining -= n;
      done += n;
      opts.onProgress?.(done, total);
    }
    if (parts.length === 0) parts.push(engine(job.input, 0, job.seed % MAX_SEED));
    return { key: job.key, summary: mergeSummaries(parts) };
  });
};

/** 合計 `count` を重みで按分する (最大剰余法)。合計は必ず count に一致する。 */
export const allocateCounts = (count: number, weights: number[]): number[] => {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? count : 0));
  const exact = weights.map((w) => (w / sum) * count);
  const out = exact.map(Math.floor);
  let rest = count - out.reduce((a, b) => a + b, 0);
  exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
    .forEach(({ i }) => {
      if (rest > 0) {
        out[i]++;
        rest--;
      }
    });
  return out;
};

// ---- sortie ----


export type SortieEngine = (input: SortieInput, count: number, seed: number) => SortieSummary;

export interface SortieJob {
  input: SortieInput;
  count: number;
  seed: number;
  /** ガントレット (gauge) は件数と無関係に 1 回だけ回すため、本体と分ける */
  gaugeInput?: SortieInput;
  gaugeCount?: number;
}

const wavg = (parts: { n: number; v: number }[]) => {
  const t = parts.reduce((s, p) => s + p.n, 0);
  return t === 0 ? 0 : parts.reduce((s, p) => s + p.v * p.n, 0) / t;
};
const wrec = <K extends string>(parts: { n: number; rec: Record<K, number> }[], keys: K[]): Record<K, number> => {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = wavg(parts.map((p) => ({ n: p.n, v: p.rec[k] })));
  return out;
};
/** 平均は厳密、p50/p90 は塊ごとの値の重み付き平均 (近似)。 */
const mergeDist = (parts: { n: number; v: Dist }[]): Dist => ({
  mean: wavg(parts.map((p) => ({ n: p.n, v: p.v.mean }))),
  p50: wavg(parts.map((p) => ({ n: p.n, v: p.v.p50 }))),
  p90: wavg(parts.map((p) => ({ n: p.n, v: p.v.p90 }))),
});
const RANK_KEYS: Rank[] = ["SS", "S", "A", "B", "C", "D", "E"];

/** 出撃サマリを出撃数で重み付けして合成する。経路は上位リスト同士の合算 (落ちた分は other へ)。 */
export const mergeSortieSummaries = (list: SortieSummary[], topPaths = 200): SortieSummary => {
  const parts = list.filter((s) => s.count > 0);
  if (parts.length === 0) return list[0];
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((s, p) => s + p.count, 0);
  const by = <T,>(f: (s: SortieSummary) => T, n: (s: SortieSummary) => number = (s) => s.count) =>
    parts.map((p) => ({ n: n(p), v: f(p) }));

  const pathMap = new Map<string, PathRate>();
  for (const p of parts) {
    for (const r of p.paths) {
      const k = r.path.join(">");
      const e = pathMap.get(k) ?? { path: r.path, rate: 0 };
      e.rate += (r.rate * p.count) / total;
      pathMap.set(k, e);
    }
  }
  const sorted = [...pathMap.values()].sort((a, b) => b.rate - a.rate);
  const paths = sorted.slice(0, topPaths);
  const otherPathsRate = Math.max(0, 1 - paths.reduce((s, p) => s + p.rate, 0));

  const letters = [...new Set(parts.flatMap((p) => Object.keys(p.nodes)))];
  const nodes: Record<string, NodeSummary> = {};
  for (const l of letters) {
    const ns = parts.map((p) => ({ count: p.count, s: p.nodes[l] })).filter((x): x is { count: number; s: NodeSummary } => !!x.s);
    const battles = ns.map((x) => ({ n: x.count * x.s.battleRate, rec: x.s.rankRates as Record<Rank, number> }));
    nodes[l] = {
      reachRate: wavg(ns.map((x) => ({ n: x.count, v: x.s.reachRate }))) * (ns.reduce((s, x) => s + x.count, 0) / total),
      battleRate: wavg(ns.map((x) => ({ n: x.count, v: x.s.battleRate }))) * (ns.reduce((s, x) => s + x.count, 0) / total),
      rankRates: wrec(battles, RANK_KEYS),
      retreatRate: wavg(ns.map((x) => ({ n: x.count, v: x.s.retreatRate }))) * (ns.reduce((s, x) => s + x.count, 0) / total),
      retreatHeavyRate: wavg(ns.map((x) => ({ n: x.count, v: x.s.retreatHeavyRate }))) * (ns.reduce((s, x) => s + x.count, 0) / total),
      retreatModerateRate: wavg(ns.map((x) => ({ n: x.count, v: x.s.retreatModerateRate }))) * (ns.reduce((s, x) => s + x.count, 0) / total),
      nightRate: wavg(ns.map((x) => ({ n: x.count * x.s.battleRate, v: x.s.nightRate }))),
    };
  }

  const first = parts[0];
  const friend: SortieShipSummary[] = first.friend.map((_, i) => ({
    sunkRate: wavg(by((s) => s.friend[i].sunkRate)),
    heavyRate: wavg(by((s) => s.friend[i].heavyRate)),
    moderateRate: wavg(by((s) => s.friend[i].moderateRate)),
    damageTakenMean: wavg(by((s) => s.friend[i].damageTakenMean)),
    hpMissingMean: wavg(by((s) => s.friend[i].hpMissingMean)),
    fuelUsedMean: wavg(by((s) => s.friend[i].fuelUsedMean)),
    ammoUsedMean: wavg(by((s) => s.friend[i].ammoUsedMean)),
    bauxiteMean: wavg(by((s) => s.friend[i].bauxiteMean)),
    proficiencyLostMean: wavg(by((s) => s.friend[i].proficiencyLostMean)),
    repair: {
      fuel: mergeDist(by((s) => s.friend[i].repair.fuel)),
      steel: mergeDist(by((s) => s.friend[i].repair.steel)),
      timeSec: mergeDist(by((s) => s.friend[i].repair.timeSec)),
    },
    damecon: { usedRate: wavg(by((s) => s.friend[i].damecon.usedRate)) },
  }));

  return {
    count: total,
    paths,
    otherPathsRate,
    nodes,
    boss: {
      reachRate: wavg(by((s) => s.boss.reachRate)),
      rankRates: wrec(parts.map((p) => ({ n: p.count * p.boss.reachRate, rec: p.boss.rankRates as Record<Rank, number> })), RANK_KEYS),
      killRate: wavg(by((s) => s.boss.killRate)),
      flagshipSunkRate: wavg(by((s) => s.boss.flagshipSunkRate)),
      flagshipDamageMean: wavg(by((s) => s.boss.flagshipDamageMean)),
    },
    retreatRate: wavg(by((s) => s.retreatRate)),
    sunkRate: wavg(by((s) => s.sunkRate)),
    battlesMean: wavg(by((s) => s.battlesMean)),
    nodesMean: wavg(by((s) => s.nodesMean)),
    fuelUsedMean: wavg(by((s) => s.fuelUsedMean)),
    ammoUsedMean: wavg(by((s) => s.ammoUsedMean)),
    bauxiteMean: wavg(by((s) => s.bauxiteMean)),
    repair: {
      fuel: mergeDist(by((s) => s.repair.fuel)),
      steel: mergeDist(by((s) => s.repair.steel)),
      timeSec: mergeDist(by((s) => s.repair.timeSec)),
      timeSecTotal: mergeDist(by((s) => s.repair.timeSecTotal)),
    },
    effects: parts[0].effects && {
      gainedMean: {
        fuel: wavg(by((s) => s.effects!.gainedMean.fuel)),
        ammo: wavg(by((s) => s.effects!.gainedMean.ammo)),
        steel: wavg(by((s) => s.effects!.gainedMean.steel)),
        bauxite: wavg(by((s) => s.effects!.gainedMean.bauxite)),
      },
      maelstromFuelMean: wavg(by((s) => s.effects!.maelstromFuelMean)),
      maelstromAmmoMean: wavg(by((s) => s.effects!.maelstromAmmoMean)),
      anchorageHpMean: wavg(by((s) => s.effects!.anchorageHpMean)),
      anchorageMaterialsMean: wavg(by((s) => s.effects!.anchorageMaterialsMean)),
    },
    friend,
    gauge: parts.find((p) => p.gauge)?.gauge,
    warnings: [...new Set(parts.flatMap((p) => p.warnings))],
  };
};

export const runSortieJob = (
  engine: SortieEngine,
  job: SortieJob,
  opts: { chunk?: number; onProgress?: (done: number, total: number) => void } = {}
): SortieSummary => {
  const chunk = Math.max(1, opts.chunk ?? 2_000);
  const total = job.count + (job.gaugeInput ? 1 : 0);
  const parts: SortieSummary[] = [];
  let remaining = job.count;
  let done = 0;
  for (let c = 0; remaining > 0; c++) {
    const n = Math.min(chunk, remaining);
    parts.push(engine(job.input, n, (job.seed + c) % MAX_SEED));
    remaining -= n;
    done += n;
    opts.onProgress?.(done, total);
  }
  if (parts.length === 0) parts.push(engine(job.input, 0, job.seed % MAX_SEED));
  const merged = mergeSortieSummaries(parts, job.input.topPaths ?? 200);
  if (job.gaugeInput) {
    const g = engine(job.gaugeInput, job.gaugeCount ?? Math.min(job.count, 20_000), (job.seed + 7_654_321) % MAX_SEED);
    merged.gauge = g.gauge;
    opts.onProgress?.(total, total);
  }
  return merged;
};

/** 撃破確率 p (出撃あたり) からの幾何分布による出撃回数の目安 (ゲージ未指定時の簡易表示)。 */
export const geometricSorties = (p: number): { mean: number; p50: number; p90: number } | null => {
  if (!(p > 0)) return null;
  if (p >= 1) return { mean: 1, p50: 1, p90: 1 };
  const q = (x: number) => Math.max(1, Math.ceil(Math.log(1 - x) / Math.log(1 - p)));
  return { mean: 1 / p, p50: q(0.5), p90: q(0.9) };
};
