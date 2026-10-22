/** 事前分布の選択 (API の estimates → PriorInput)。サーバの推定ジョブとテストが使う。 */
import type { Confidence, ShipDetail } from "../data/types";
import type { PriorInput } from "./infer";
import type { EstimatedStat } from "./types";

export const CONFIDENCE_RANK: Record<Confidence, number> = { observed: 0, datamined: 1, db_estimate: 2, placeholder: 3, unknown: 4 };

/**
 * API の推定値から事前分布を選ぶ: 確度 (observed > datamined > db_estimate > placeholder > unknown)、
 * 同じ確度なら新しいもの。`estimator` で始まる出典は除く (自分の過去の結果を事前分布にすると同じ
 * データを二重に数えるため)。estimates が無ければ `best` を同じ条件で使う。
 * `acc` (汎用の隠し命中) は推定器だけが出す量なので、自分の結果を除くと事前分布は無い (平坦)。
 * 雷撃の基礎命中 `tacc` (kcsim TACC) は別の量で、`acc` の事前分布には使わない。
 */
export const choosePrior = (detail: Pick<ShipDetail, "estimates" | "best"> | undefined, stat: EstimatedStat): PriorInput | undefined => {
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
