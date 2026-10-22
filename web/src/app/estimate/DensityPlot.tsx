import React from "react";
import type { EstimateDensity as Density } from "@shared/data/types";

const W = 360;
const H = 96;
const PAD = { l: 8, r: 8, t: 8, b: 4 };

/** 表示範囲: 事後分布の 0.1%–99.9% と事前分布の中心 (+ 正規なら 5%–95%) を含む範囲。 */
const viewRange = (d: Density, priorValue: number | null): [number, number] => {
  const x = (i: number) => d.min + i * d.step;
  const quantile = (p: number[], q: number) => {
    let c = 0;
    for (let i = 0; i < p.length; i++) if ((c += p[i]) >= q) return x(i);
    return x(p.length - 1);
  };
  let lo = quantile(d.posterior, 0.001);
  let hi = quantile(d.posterior, 0.999);
  const flat = Math.max(...d.prior) - Math.min(...d.prior) < 1e-9;
  if (!flat) {
    lo = Math.min(lo, quantile(d.prior, 0.05));
    hi = Math.max(hi, quantile(d.prior, 0.95));
  }
  if (priorValue !== null) {
    lo = Math.min(lo, priorValue);
    hi = Math.max(hi, priorValue);
  }
  const pad = Math.max(3, (hi - lo) * 0.1);
  return [Math.max(d.min, Math.floor(lo - pad)), Math.min(x(d.posterior.length - 1), Math.ceil(hi + pad))];
};

const ticks = (lo: number, hi: number): number[] => {
  const span = hi - lo;
  const step = [1, 2, 5, 10, 20, 25, 50].find((s) => span / s <= 6) ?? 100;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
};

/** 事前分布 (破線) と事後分布 (塗り) の確率、90% 信用区間 (帯)、事後平均と事前の中心 (縦線)。 */
export const DensityPlot = ({
  density,
  ci90,
  mean,
  priorValue,
  label,
}: {
  density: Density;
  ci90: [number, number];
  mean: number;
  priorValue: number | null;
  label: string;
}) => {
  const [lo, hi] = viewRange(density, priorValue);
  const i0 = Math.round((lo - density.min) / density.step);
  const i1 = Math.round((hi - density.min) / density.step);
  const ymax = Math.max(1e-12, ...density.posterior.slice(i0, i1 + 1), ...density.prior.slice(i0, i1 + 1));
  const sx = (v: number) => PAD.l + ((v - lo) / Math.max(1e-9, hi - lo)) * (W - PAD.l - PAD.r);
  const sy = (p: number) => H - PAD.b - (p / ymax) * (H - PAD.t - PAD.b);
  const line = (p: number[]) =>
    p
      .slice(i0, i1 + 1)
      .map((v, k) => `${k === 0 ? "M" : "L"}${sx(density.min + (i0 + k) * density.step).toFixed(1)},${sy(v).toFixed(1)}`)
      .join("");
  const post = line(density.posterior);
  const base = H - PAD.b;
  const tickValues = ticks(lo, hi);

  // 軸ラベルは viewBox の拡大に引きずられないよう SVG の外 (HTML) に置き、実寸 12px で描く。
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`${label} の事前・事後分布`}>
        <rect x={sx(ci90[0])} y={PAD.t} width={Math.max(1, sx(ci90[1]) - sx(ci90[0]))} height={base - PAD.t} className="fill-accent-500/10" />
        <line x1={PAD.l} x2={W - PAD.r} y1={base} y2={base} className="stroke-ink-500" strokeWidth={1} />
        {tickValues.map((t) => (
          <line key={t} x1={sx(t)} x2={sx(t)} y1={base} y2={base + 3} className="stroke-ink-500" />
        ))}
        <path d={`${post}L${sx(hi).toFixed(1)},${base}L${sx(lo).toFixed(1)},${base}Z`} className="fill-accent-500/25" />
        <path d={post} className="fill-none stroke-accent-400" strokeWidth={1.5} />
        <path d={line(density.prior)} className="fill-none stroke-ink-400" strokeWidth={1.2} strokeDasharray="4 3" />
        {priorValue !== null && (
          <line x1={sx(priorValue)} x2={sx(priorValue)} y1={PAD.t} y2={base} className="stroke-ink-400" strokeDasharray="2 2" />
        )}
        <line x1={sx(mean)} x2={sx(mean)} y1={PAD.t} y2={base} className="stroke-ink-50" strokeWidth={1.5} />
      </svg>
      <div className="relative h-4 text-xs leading-4 text-ink-300 tabular-nums" aria-hidden>
        {tickValues.map((t) => (
          <span key={t} className="absolute -translate-x-1/2" style={{ left: `${(sx(t) / W) * 100}%` }}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
};
