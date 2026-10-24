import React, { useState } from "react";
import { niceTicks, timeTicks } from "../../resources/view";

export interface ChartSeries {
  key: string;
  color: string;
  /** 点列 [t, 値] の組 (値の無い区間で分かれる) */
  lines: [number, number][][];
}

/** SVG の座標系 (viewBox)。preserveAspectRatio="none" で枠いっぱいに伸ばし、線は non-scaling-stroke で太さを保つ */
const W = 1000;
const H = 1000;

const pct = (n: number) => `${n * 100}%`;

/**
 * 時系列の折れ線 (階段状の点列をそのまま結ぶ)。大きさは親の flex に従い、目盛りの文字は HTML で重ねる
 * (SVG を伸ばしても文字が歪まない。大きさを測らないので ResizeObserver も要らない)。
 * tooltip はポインタの時刻を受けて中身を返す。
 */
export const LineChart = ({
  series,
  from,
  to,
  tooltip,
  ariaLabel,
}: {
  series: ChartSeries[];
  from: number;
  to: number;
  tooltip: (t: number) => React.ReactNode;
  ariaLabel: string;
}) => {
  const [hover, setHover] = useState<number | null>(null);
  const values = series.flatMap((s) => s.lines.flat().map(([, v]) => v));
  const y = values.length ? niceTicks(Math.min(...values), Math.max(...values)) : null;
  const xs = timeTicks(from, to);
  const span = Math.max(1, to - from);
  const fx = (t: number) => ((t - from) / span) * W;
  const fy = (v: number) => (y ? H - ((v - y.lo) / Math.max(1, y.hi - y.lo)) * H : H / 2);

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
    setHover(from + f * span);
  };

  return (
    // 余白: 左は縦の目盛り、下は時刻の目盛り
    <div className="relative min-h-0 flex-1 text-xs text-ink-400 tabular-nums" role="img" aria-label={ariaLabel}>
      <div className="absolute top-2 right-3 bottom-6 left-16" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
          {y?.ticks.map((v) => (
            <line key={v} x1={0} x2={W} y1={fy(v)} y2={fy(v)} stroke="var(--color-ink-800)" vectorEffect="non-scaling-stroke" />
          ))}
          {xs.map(({ t }) => (
            <line key={t} x1={fx(t)} x2={fx(t)} y1={0} y2={H} stroke="var(--color-ink-800)" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
          ))}
          {series.map((s) =>
            s.lines.map((line, i) => (
              <path
                key={`${s.key}-${i}`}
                d={line.map(([t, v], j) => `${j ? "L" : "M"}${fx(t).toFixed(1)} ${fy(v).toFixed(1)}`).join("")}
                fill="none"
                stroke={s.color}
                strokeWidth={1.5}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))
          )}
          {hover !== null && (
            <line x1={fx(hover)} x2={fx(hover)} y1={0} y2={H} stroke="var(--color-ink-500)" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {y?.ticks.map((v) => (
          <span key={v} className="absolute right-full mr-2 -translate-y-1/2 whitespace-nowrap" style={{ top: pct(fy(v) / H) }}>
            {v.toLocaleString("ja-JP")}
          </span>
        ))}
        {xs.map(({ t, label }) => (
          <span key={t} className="absolute top-full mt-1 -translate-x-1/2 whitespace-nowrap" style={{ left: pct(fx(t) / W) }}>
            {label}
          </span>
        ))}
        {hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-md border border-ink-700 bg-ink-800 px-2 py-1 text-ink-100 shadow-lg"
            // 右半分では線の左に出す
            style={hover - from > span / 2 ? { right: pct(1 - fx(hover) / W), marginRight: 8 } : { left: pct(fx(hover) / W), marginLeft: 8 }}
          >
            {tooltip(hover)}
          </div>
        )}
      </div>
    </div>
  );
};
