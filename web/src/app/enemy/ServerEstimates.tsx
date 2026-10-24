/** 敵艦の詳細の推定の区画: サーバが全プレイヤーの観測から推定した隠しステータスの分布 (GET /api/v1/estimates)。 */
import React from "react";
import { ESTIMATE_MIN_N } from "@shared/data/types";
import type { EstimatedStat, EstimateRow } from "@shared/data/types";
import { ArrowDown, ArrowUp, TriangleAlert } from "lucide-react";
import { S, cx } from "../../ui";
import { formatShortDateTime } from "../../ui/format";
import { CONFIDENCE as CONF } from "./confidence";
import { DensityPlot } from "./DensityPlot";

const f1 = (v: number) => v.toFixed(1);

/** 事前の中心が 90% 信用区間の外 = データが事前の値を否定している */
export const shifted = (r: EstimateRow) => r.n > 0 && r.prior.value !== null && (r.prior.value < r.ci90[0] || r.prior.value > r.ci90[1]);

/** 観測でほとんど絞れていない (観測なし、または事後 sd が事前の 80% 超) */
const weak = (r: EstimateRow) => r.n === 0 || r.sd > 0.8 * r.prior.sd;

/** 能力の行に添える推定値: 事後平均と 90% 信用区間。n < ESTIMATE_MIN_N はシミュレーションに使わないので灰色 */
export const EstimateValue = ({ r }: { r: EstimateRow }) => (
  <span
    className={cx("text-xs tabular-nums", r.n < ESTIMATE_MIN_N ? "text-ink-400" : "text-accent-400")}
    title={`サーバの推定: 平均 ${f1(r.mean)} ± ${f1(r.sd)}、90% 区間 [${r.ci90[0]}, ${r.ci90[1]}]、n=${r.n}${r.n < ESTIMATE_MIN_N ? ` (n < ${ESTIMATE_MIN_N} はシミュレーションに使わない)` : ""}`}
  >
    推定 {f1(r.mean)} <span className="text-ink-400">[{r.ci90[0]}–{r.ci90[1]}]</span>
  </span>
);

const PriorShift = ({ r }: { r: EstimateRow }) => {
  const prior = (
    <span title={`事前の値 (${CONF[r.prior.confidence].label})`}>事前 {r.prior.value ?? "—"}</span>
  );
  if (r.prior.value === null || r.n === 0) return prior;
  const d = r.mean - r.prior.value;
  const text = `${d >= 0 ? "+" : "−"}${f1(Math.abs(d))}`;
  return (
    <span className={cx("inline-flex items-center gap-1", shifted(r) && "text-warn-400")} title={shifted(r) ? "事前の値が 90% 信用区間の外" : undefined}>
      {prior}
      {shifted(r) && (d >= 0 ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)}
      {text}
    </span>
  );
};

/** 能力ごとの事前・事後分布。平均と区間は上の能力の行 (EstimateValue) に出すので、ここは観測数・事前との差・分布だけ */
export const ServerEstimates = ({
  rows,
  label,
  updatedAt,
  loading,
}: {
  rows: EstimateRow[];
  label: (stat: EstimatedStat) => string;
  updatedAt: string | null | undefined;
  loading: boolean;
}) => (
  <section className="flex max-w-3xl flex-col gap-2">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-400">
      <h4 className="font-semibold text-ink-300">推定</h4>
      <span><span className="mr-1 inline-block h-2 w-3 bg-accent-500/40" />事後</span>
      <span><span className="mr-1 inline-block w-3 border-t border-dashed border-ink-400 align-middle" />事前</span>
      <span><span className="mr-1 inline-block h-3 w-0.5 bg-ink-50 align-middle" />平均</span>
      {updatedAt && <span className="ml-auto tabular-nums" title="サーバの最終推定">{formatShortDateTime(Date.parse(updatedAt))}</span>}
    </div>
    <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-x-4 gap-y-3">
      {rows.map((r) => (
        <div key={r.stat} className="flex min-w-0 flex-col gap-1">
          <div className="flex items-baseline gap-2 text-xs tabular-nums text-ink-400">
            <span className="font-semibold text-ink-200">{label(r.stat)}</span>
            <span className={cx("ml-auto", r.n < ESTIMATE_MIN_N && "text-ink-500")} title={`推定に効いた命中判定の数。n < ${ESTIMATE_MIN_N} はシミュレーションに使わない`}>
              n={r.n.toLocaleString()}
            </span>
          </div>
          {r.density ? (
            <DensityPlot density={r.density} ci90={r.ci90} mean={r.mean} priorValue={r.prior.value} label={label(r.stat)} />
          ) : (
            <p className="py-6 text-center text-xs text-ink-400">{loading ? S.common.loading : "—"}</p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 text-xs tabular-nums text-ink-400">
            <PriorShift r={r} />
            {weak(r) && (
              <span className="inline-flex items-center gap-1 text-warn-400" title={r.n === 0 ? "観測なし" : "観測でほぼ絞れていない"}>
                <TriangleAlert size={12} aria-hidden />
                絞れていない
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  </section>
);
