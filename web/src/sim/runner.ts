/** simulateBattle を分割実行して結果を合成する (Worker と単体テストの両方から使う)。 */
import type {
  AirState, BaseRaidSummary, BattleInput, Dist, NodeSummary, PathRate, Rank, ShipSummary, SimulationSummary, SortieInput, SortieShipSummary, SortieSummary,
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
    ...optional("supportRate", optRate(parts.map((p) => ({ n: p.count, v: p.supportRate })))),
    ...optional("friendFleetRate", optRate(parts.map((p) => ({ n: p.count, v: p.friendFleetRate })))),
    ...optional("baseRaid", mergeBaseRaid(parts.map((p) => ({ n: p.count, s: p.baseRaid })))),
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
const AIR_KEYS: AirState[] = ["none", "supremacy", "superiority", "parity", "denial", "incapability"];

/** 省略できる欄: 値が無ければ欄ごと省く (sim-core と同じく、入力に無い機能の欄は出さない) */
const optional = <K extends string, V>(key: K, v: V | undefined): Partial<Record<K, V>> => (v === undefined ? {} : ({ [key]: v } as Record<K, V>));

/** 支援・友軍の率: 値のある部分だけで重み付け平均。どの部分にも無ければ undefined */
const optRate = (parts: { n: number; v: number | undefined }[]): number | undefined => {
  const have = parts.filter((p): p is { n: number; v: number } => p.v !== undefined);
  return have.length === 0 ? undefined : wavg(have);
};

/** 基地空襲: 起きた割合 (rate) は件数で、空襲の結果 (制空・被害) は空襲の回数 (件数 × rate) で重み付け */
const mergeBaseRaid = (parts: { n: number; s?: BaseRaidSummary }[]): BaseRaidSummary | undefined => {
  const raids = parts.flatMap((p) => (p.s ? [{ n: p.n * (p.s.rate ?? 1), s: p.s }] : []));
  if (raids.length === 0) return undefined;
  const bases = Math.max(...raids.map((r) => r.s.hpLostMean.length));
  return {
    ...(raids[0].s.rate !== undefined ? { rate: wavg(parts.map((p) => ({ n: p.n, v: p.s?.rate ?? 0 }))) } : {}),
    airStateRates: wrec(raids.map((r) => ({ n: r.n, rec: r.s.airStateRates })), AIR_KEYS),
    hpLostMean: Array.from({ length: bases }, (_, i) => wavg(raids.map((r) => ({ n: r.n, v: r.s.hpLostMean[i] ?? 0 })))),
  };
};

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
    // 出撃あたりの率: その節点を持たない塊は 0 として全出撃で平均する
    const perSortie = (f: (n: NodeSummary) => number) => ns.reduce((s, x) => s + f(x.s) * x.count, 0) / total;
    nodes[l] = {
      reachRate: perSortie((n) => n.reachRate),
      battleRate: perSortie((n) => n.battleRate),
      rankRates: wrec(battles, RANK_KEYS),
      retreatRate: perSortie((n) => n.retreatRate),
      retreatHeavyRate: perSortie((n) => n.retreatHeavyRate),
      retreatModerateRate: perSortie((n) => n.retreatModerateRate),
      nightRate: wavg(ns.map((x) => ({ n: x.count * x.s.battleRate, v: x.s.nightRate }))),
      fcfRate: perSortie((n) => n.fcfRate),
      ...optional("supportRate", optRate(ns.map((x) => ({ n: x.count * x.s.battleRate, v: x.s.supportRate })))),
      ...optional("friendFleetRate", optRate(ns.map((x) => ({ n: x.count * x.s.battleRate, v: x.s.friendFleetRate })))),
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
    evacuatedRate: wavg(by((s) => s.friend[i].evacuatedRate)),
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
    fcfRate: wavg(by((s) => s.fcfRate)),
    underwayUsedMean: wavg(by((s) => s.underwayUsedMean)),
    rationsUsedMean: wavg(by((s) => s.rationsUsedMean)),
    ...(parts[0].lbasCostMean && {
      lbasCostMean: {
        fuel: wavg(by((s) => s.lbasCostMean?.fuel ?? 0)),
        ammo: wavg(by((s) => s.lbasCostMean?.ammo ?? 0)),
        steel: wavg(by((s) => s.lbasCostMean?.steel ?? 0)),
        bauxite: wavg(by((s) => s.lbasCostMean?.bauxite ?? 0)),
      },
    }),
    ...(parts[0].supportCostMean && {
      supportCostMean: {
        fuel: wavg(by((s) => s.supportCostMean?.fuel ?? 0)),
        ammo: wavg(by((s) => s.supportCostMean?.ammo ?? 0)),
        steel: wavg(by((s) => s.supportCostMean?.steel ?? 0)),
        bauxite: wavg(by((s) => s.supportCostMean?.bauxite ?? 0)),
      },
    }),
    ...(parts[0].waitMinutesMean !== undefined && { waitMinutesMean: wavg(by((s) => s.waitMinutesMean ?? 0)) }),
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
    resourcesPerSortie: {
      fuel: mergeDist(by((s) => s.resourcesPerSortie.fuel)),
      ammo: mergeDist(by((s) => s.resourcesPerSortie.ammo)),
      steel: mergeDist(by((s) => s.resourcesPerSortie.steel)),
      bauxite: mergeDist(by((s) => s.resourcesPerSortie.bauxite)),
      buckets: mergeDist(by((s) => s.resourcesPerSortie.buckets)),
      timeSec: mergeDist(by((s) => s.resourcesPerSortie.timeSec)),
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
      anchorageSteelMean: wavg(by((s) => s.effects!.anchorageSteelMean)),
    },
    friend,
    gauge: parts.find((p) => p.gauge)?.gauge,
    ...optional("baseRaid", mergeBaseRaid(parts.map((p) => ({ n: p.count, s: p.baseRaid })))),
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
