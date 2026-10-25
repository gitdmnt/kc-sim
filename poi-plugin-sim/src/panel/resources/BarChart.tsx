import React, { useState } from "react";
import { niceTicks, timeTicks } from "../../resources/view";

export interface Bar {
  /** 区切りの始まりと次の区切りの始まり */
  t0: number;
  t1: number;
  /** series と同じ並びの増減 (値の無い資源は null) */
  d: (number | null)[];
}

/** SVG の座標系 (viewBox)。LineChart と同じく枠いっぱいに伸ばし、文字は HTML で重ねる */
const W = 1000;
const H = 1000;
/** 区切りの幅のうち棒が占める割合 */
const FILL = 0.8;

const pct = (n: number) => `${n * 100}%`;

/**
 * 時間の区切りごとの増減の棒。資源を符号ごとに積む (増えた分は 0 の線の上、減った分は下)。
 * 大きさは親の flex に従う。tooltip はポインタの下の棒の番号を受けて中身を返す。
 */
export const BarChart = ({
  colors,
  bars,
  from,
  to,
  tooltip,
  ariaLabel,
}: {
  /** 資源ごとの色 (積む順) */
  colors: string[];
  bars: Bar[];
  from: number;
  to: number;
  tooltip: (i: number) => React.ReactNode;
  ariaLabel: string;
}) => {
  const [hover, setHover] = useState<number | null>(null);
  const sums = (sign: 1 | -1) => bars.map((b) => b.d.reduce<number>((a, n) => (n !== null && n * sign > 0 ? a + n : a), 0));
  const y = niceTicks(Math.min(0, ...sums(-1)), Math.max(0, ...sums(1)));
  const xs = timeTicks(from, to);
  const span = Math.max(1, to - from);
  const fx = (t: number) => ((t - from) / span) * W;
  const fy = (v: number) => H - ((v - y.lo) / Math.max(1, y.hi - y.lo)) * H;

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = from + ((e.clientX - r.left) / Math.max(1, r.width)) * span;
    const i = bars.findIndex((b) => b.t0 <= t && t < b.t1);
    setHover(i === -1 ? null : i);
  };

  const hovered = hover === null ? null : bars[hover];
  const mid = hovered ? (hovered.t0 + hovered.t1) / 2 : 0;

  return (
    // 余白: 左は縦の目盛り、下は時刻の目盛り
    <div className="relative min-h-0 flex-1 text-xs text-ink-400 tabular-nums" role="img" aria-label={ariaLabel}>
      <div className="absolute top-2 right-3 bottom-6 left-16" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
          {xs.map(({ t }) => (
            <line key={t} x1={fx(t)} x2={fx(t)} y1={0} y2={H} stroke="var(--color-ink-800)" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
          ))}
          {y.ticks.map((v) => (
            <line
              key={v}
              x1={0}
              x2={W}
              y1={fy(v)}
              y2={fy(v)}
              stroke={v === 0 ? "var(--color-ink-500)" : "var(--color-ink-800)"}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {hovered && <rect x={fx(hovered.t0)} width={fx(hovered.t1) - fx(hovered.t0)} y={0} height={H} fill="var(--color-ink-800)" opacity={0.6} />}
          {bars.map((b) => {
            const x = fx(b.t0) + ((fx(b.t1) - fx(b.t0)) * (1 - FILL)) / 2;
            const w = (fx(b.t1) - fx(b.t0)) * FILL;
            let up = 0;
            let down = 0;
            return b.d.map((n, k) => {
              if (!n) return null;
              const lo = n > 0 ? up : down + n;
              if (n > 0) up += n;
              else down += n;
              return <rect key={`${b.t0}-${k}`} x={x} width={w} y={fy(lo + Math.abs(n))} height={fy(lo) - fy(lo + Math.abs(n))} fill={colors[k]} />;
            });
          })}
        </svg>
        {y.ticks.map((v) => (
          <span key={v} className="absolute right-full mr-2 -translate-y-1/2 whitespace-nowrap" style={{ top: pct(fy(v) / H) }}>
            {v.toLocaleString("ja-JP", { signDisplay: "exceptZero" })}
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
            // 右半分では棒の左に出す
            style={mid - from > span / 2 ? { right: pct(1 - fx(hovered!.t0) / W), marginRight: 8 } : { left: pct(fx(hovered!.t1) / W), marginLeft: 8 }}
          >
            {tooltip(hover)}
          </div>
        )}
      </div>
    </div>
  );
};
