/**
 * 推定の入口 (メインスレッド側): 保存済みの観測と data API から推定を走らせ、結果を送信し、
 * シミュレーション入力へ反映する。wasm を使う計算 (infer.ts) は `compute` に委ねる
 * (poi では sim/client.ts の estimateInWorker、テストや開発では computeInProcess)。
 */
import type { ShipInput } from "@sim-core";
import type { AttackEvent, CapturedBattle } from "../capture/types";
import type { ApiEquipment, ApiShip, Confidence, HiddenStat, ShipDetail, ShipEstimate } from "../data/types";
import type { MasterData } from "../fleet/types";
import type { ApplyEstimates, EnemyLookup } from "../sim/adapter";
import type { FitEntry } from "../sim/fit";
import { estimateFromObservations } from "./infer";
import type { InferOptions, PriorInput, PriorTable } from "./infer";
import { buildObservations } from "./observe";
import type { ObserveResult } from "./observe";
import { ESTIMATED_STATS } from "./types";
import type { BattleRecord, EstimatedStat, EstimateResult, Observation } from "./types";

/** 観測と事前分布から推定値を求める非同期の計算 (Worker 越しでもよい)。 */
export type EstimateCompute = (
  observations: Observation[],
  priors: PriorTable,
  options: InferOptions,
  onProgress?: (done: number, total: number) => void
) => Promise<EstimateResult[]>;

/** 同じスレッドで計算する。sim-core の init 済みであること (poi のウィンドウでは使えない)。 */
export const computeInProcess: EstimateCompute = async (observations, priors, options, onProgress) =>
  estimateFromObservations(observations, priors, { ...options, onProgress });

// ---- 事前分布 (API) ----

const CONFIDENCE_RANK: Record<Confidence, number> = { observed: 0, datamined: 1, db_estimate: 2, placeholder: 3, unknown: 4 };
const HIDDEN_STATS: HiddenStat[] = ["ev", "asw", "los", "luck", "acc", "tacc"];

/**
 * API の推定値から事前分布を選ぶ: 確度 (observed > datamined > db_estimate > placeholder > unknown)、
 * 同じ確度なら新しいもの。`estimator:` で始まる出典は除く (自分の過去の結果を事前分布にすると同じ
 * データを二重に数えるため)。estimates が無ければ `best` を同じ条件で使う。
 * `acc` (汎用の隠し命中) は推定器だけが出す量なので、自分の結果を除くと事前分布は無い (平坦)。
 * 雷撃の基礎命中 `tacc` (kcsim TACC) は別の量で、`acc` の事前分布には使わない。
 */
export const choosePrior = (detail: ShipDetail | undefined, stat: EstimatedStat): PriorInput | undefined => {
  if (!detail || stat === "acc") return undefined;
  const own = (source: string) => source.startsWith("estimator");
  const rows = detail.estimates
    .filter((e) => e.stat === stat && !own(e.source))
    .sort((a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] || b.updatedAt.localeCompare(a.updatedAt));
  const e = rows[0];
  if (e) return { value: e.value, confidence: e.confidence, sd: e.sd, source: e.source };
  const best = detail.best[stat];
  if (best && !own(best.source)) return { value: best.value, confidence: best.confidence, source: best.source };
  return undefined;
};

// ---- estimateAll ----

/** ObservationDb の必要部分。 */
export interface EstimatorDb {
  listBattles(): Promise<CapturedBattle[]>;
  listEvents(battleId: string): Promise<AttackEvent[]>;
}

/** DataApi の必要部分。 */
export interface EstimatorApi {
  abyssalShips(): Promise<{ data: ApiShip[] }>;
  abyssalEquipments(): Promise<{ data: ApiEquipment[] }>;
  ship(id: number): Promise<{ data: ShipDetail }>;
  fitBonuses?(): Promise<{ data: FitEntry[] }>;
}

export interface EstimateAllOptions extends InferOptions {
  /** 味方艦・装備のマスター (poi の state.const。UI では useApp().catalog.master) */
  master: MasterData;
  /** wasm を使う計算。poi では estimateInWorker (sim/client.ts) */
  compute: EstimateCompute;
  /** 既定 true */
  includeCutins?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface EstimateAllResult {
  results: EstimateResult[];
  observe: Omit<ObserveResult, "observations"> & { observations: number };
  /** 事前分布を取得できなかった艦 (平坦な事前分布で推定) */
  priorErrors: number[];
}

/**
 * 保存済みの全戦闘から推定する。敵艦マスター・装備・装備ボーナス・事前分布 (choosePrior) は api から
 * 取る。装備ボーナスが取れなければ差し引かない。観測の組み立ては同じスレッド、グリッド計算は compute。
 */
export const estimateAll = async (db: EstimatorDb, api: EstimatorApi, opts: EstimateAllOptions): Promise<EstimateAllResult> => {
  const battles = await db.listBattles();
  const records: BattleRecord[] = await Promise.all(battles.map(async (battle) => ({ battle, events: await db.listEvents(battle.id) })));
  const [ships, equips, fit] = await Promise.all([
    api.abyssalShips(),
    api.abyssalEquipments(),
    api.fitBonuses?.().then((r) => r.data).catch(() => undefined),
  ]);
  const shipById = new Map(ships.data.map((s) => [s.id, s]));
  const equipById = new Map(equips.data.map((e) => [e.id, e]));
  const lookup: EnemyLookup = { ship: (id) => shipById.get(id), equip: (id) => equipById.get(id), detail: () => undefined };
  const observed = buildObservations(records, { master: opts.master, lookup, fitBonuses: fit, includeCutins: opts.includeCutins });

  const priors: PriorTable = {};
  const priorErrors: number[] = [];
  await Promise.all(
    [...new Set(observed.observations.map((o) => o.shipId))].map((id) =>
      api.ship(id).then(
        (r) => {
          const p: PriorTable[number] = {};
          for (const stat of ESTIMATED_STATS) {
            const c = choosePrior(r.data, stat);
            if (c) p[stat] = c;
          }
          priors[id] = p;
        },
        () => void priorErrors.push(id)
      )
    )
  );
  const { grid, priorSd, epsilon } = opts;
  const results = await opts.compute(observed.observations, priors, { grid, priorSd, epsilon }, opts.onProgress);
  return {
    results,
    observe: { skipped: observed.skipped, battles: observed.battles, observations: observed.observations.length },
    priorErrors: priorErrors.sort((a, b) => a - b),
  };
};

// ---- アップロード ----

export const ESTIMATOR_SOURCE = { key: "estimator:poi", name: "kc-sim Bayesian grid estimator (poi plugin)" } as const;

export interface UploadEstimatesOptions {
  fetch?: typeof fetch;
  /** n がこれ未満の推定値は送らない。既定 30 */
  minN?: number;
  source?: { key: string; name: string };
}

/**
 * `${apiBase}/api/v1/estimates` に送る (docs/API.md §3)。値は事後平均、sd は事後 sd。
 * 1 リクエスト 5000 行まで。戻り値は保存された行数。失敗時は例外。
 */
export const uploadEstimates = async (apiBase: string, results: EstimateResult[], opts: UploadEstimatesOptions = {}): Promise<number> => {
  const source = opts.source ?? ESTIMATOR_SOURCE;
  const rows = results
    .filter((r) => r.shipId > 1500 && r.n >= (opts.minN ?? 30) && Number.isFinite(r.mean))
    .map((r) => ({
      shipId: r.shipId,
      stat: r.stat,
      value: Math.round(r.mean * 100) / 100,
      sd: Math.round(r.sd * 100) / 100,
      n: r.n,
      note: `posterior mean; ci90 [${r.ci90[0]}, ${r.ci90[1]}]; prior ${r.prior.source} (${r.prior.confidence})`,
    }));
  const url = `${apiBase.replace(/\/+$/, "")}/api/v1/estimates`;
  let stored = 0;
  for (let i = 0; i < rows.length; i += 5000) {
    const res = await (opts.fetch ?? globalThis.fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, estimates: rows.slice(i, i + 5000) }),
    });
    if (!res.ok) throw new Error(`POST /api/v1/estimates: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    const body: unknown = await res.json();
    const n = body !== null && typeof body === "object" && "stored" in body ? body.stored : undefined;
    stored += typeof n === "number" ? n : 0;
  }
  return stored;
};

// ---- シミュレーション入力への反映 ----

/** 適用候補の推定値 (API の estimates 1 行、またはローカルの推定結果)。 */
export interface EstimateCandidate {
  stat: HiddenStat;
  value: number;
  confidence: Confidence;
  source: string;
  /** observed の候補はこれが minN 以上のときだけ使う。null は不明 (API の best など) で、使う。 */
  n?: number | null;
}

export interface ApplyOptions {
  /** ローカル推定・API の observed を使う最小観測数。既定 30 */
  minN?: number;
}

export const candidatesFromResults = (results: EstimateResult[], shipId: number): EstimateCandidate[] =>
  results
    .filter((r) => r.shipId === shipId)
    .map((r) => ({ stat: r.stat, value: r.mean, confidence: "observed", source: "estimator:local", n: r.n }));

export const candidatesFromApi = (rows: ShipEstimate[]): EstimateCandidate[] =>
  rows.map((e) => ({ stat: e.stat, value: e.value, confidence: e.confidence, source: e.source, n: e.n }));

/**
 * 隠しステータスごとに 1 つ選ぶ: observed (推定器, n ≥ minN) > datamined > db_estimate > placeholder > unknown。
 * 同じ確度なら n の大きいもの、同じなら先に並んだもの。
 */
export const pickEstimates = (
  candidates: EstimateCandidate[], opts: ApplyOptions = {}
): Partial<Record<HiddenStat, EstimateCandidate>> => {
  const minN = opts.minN ?? 30;
  const out: Partial<Record<HiddenStat, EstimateCandidate>> = {};
  for (const c of candidates) {
    if (!Number.isFinite(c.value)) continue;
    if (c.confidence === "observed" && c.n != null && c.n < minN) continue;
    const cur = out[c.stat];
    const better =
      !cur ||
      CONFIDENCE_RANK[c.confidence] < CONFIDENCE_RANK[cur.confidence] ||
      (CONFIDENCE_RANK[c.confidence] === CONFIDENCE_RANK[cur.confidence] && (c.n ?? 0) > (cur.n ?? 0));
    if (better) out[c.stat] = c;
  }
  return out;
};

/**
 * 敵艦の ShipInput に推定値を入れる (ev → stats.evasion, luck → stats.luck, asw, los,
 * acc → hiddenAccuracy, tacc → torpedoAccuracy)。それぞれ確度順で選ぶ。
 */
export const applyEstimates = (ship: ShipInput, candidates: EstimateCandidate[], opts: ApplyOptions = {}): ShipInput => {
  const pick = pickEstimates(candidates, opts);
  const stats = { ...ship.stats };
  if (pick.ev) stats.evasion = pick.ev.value;
  if (pick.luck) stats.luck = pick.luck.value;
  if (pick.asw) stats.asw = pick.asw.value;
  if (pick.los) stats.los = pick.los.value;
  return {
    ...ship,
    stats,
    ...(pick.tacc ? { torpedoAccuracy: pick.tacc.value } : {}),
    ...(pick.acc ? { hiddenAccuracy: pick.acc.value } : {}),
  };
};

/**
 * sim/adapter の buildEnemyShips に渡すフック: ローカル推定 (n ≥ minN) を API の best より優先する。
 * best に無い隠しステータスは 0 (sim-core の既定) のまま。
 */
export const makeApplyEstimates = (results: EstimateResult[], opts: ApplyOptions = {}): ApplyEstimates => (ship, { shipId, best }) => {
  const fromBest = HIDDEN_STATS.flatMap((stat): EstimateCandidate[] => {
    const b = best[stat];
    return b && b.confidence in CONFIDENCE_RANK
      ? [{ stat, value: b.value, confidence: b.confidence as Confidence, source: b.source }]
      : [];
  });
  return applyEstimates(ship, [...candidatesFromResults(results, shipId), ...fromBest], opts);
};
