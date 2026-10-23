import React, { useMemo } from "react";
import type { MapEdge, MapNode, NodeType } from "@shared/data/types";

export const NODE_COLOR: Record<string, string> = {
  start: "var(--color-accent-600)",
  battle: "var(--color-danger-600)",
  boss: "var(--color-danger-500)",
  night_battle: "#8a62bf",
  night_to_day: "#6d5fb8",
  air_battle: "var(--color-warn-600)",
  air_raid: "#a8641c",
  empty: "#5c6d86",
  select: "var(--color-ink-400)",
  resource: "var(--color-ok-600)",
  maelstrom: "#2a8f9e",
  landing: "#b8892a",
  escort_success: "#b8892a",
  air_recon: "#6f9fd6",
  anchorage_repair: "#5fae88",
  unknown: "var(--color-ink-500)",
};

export const NODE_TYPE_LABEL: Record<string, string> = {
  start: "出撃地点", battle: "通常戦闘", boss: "ボス", night_battle: "夜戦", night_to_day: "夜昼戦", air_battle: "航空戦",
  air_raid: "空襲", empty: "気のせい/空", select: "分岐選択", resource: "資源", maelstrom: "渦潮",
  landing: "揚陸", escort_success: "護衛成功", air_recon: "航空偵察", anchorage_repair: "泊地修理", unknown: "不明",
};

export const typeKey = (t: NodeType): string => t ?? "unknown";

interface Props {
  nodes: MapNode[];
  edges: MapEdge[];
  selected: string | null;
  onSelect: (letter: string) => void;
  /** 選択ノードのルールで行き先になりうるノード */
  targets: Set<string>;
  /** 敵編成データを持つノード */
  withComps: Set<string>;
  /** 出撃シミュレーション結果: 辺の通過率 (key = "from>to") とノードの到達率ラベル */
  edgeRates?: Map<string, number>;
  nodeBadges?: Map<string, string>;
  /** 親の高さいっぱいに描く (縦横比は保って中央寄せ)。凡例は点だけにして図の隅に重ねる */
  fill?: boolean;
}

const R = 15;

export const MapGraph = ({ nodes, edges, selected, onSelect, targets, withComps, edgeRates, nodeBadges, fill }: Props) => {
  const placed = useMemo(() => nodes.filter((n) => n.x !== null && n.y !== null), [nodes]);
  const pos = useMemo(() => new Map(placed.map((n) => [n.letter, n])), [placed]);

  const box = useMemo(() => {
    if (placed.length === 0) return { x: 0, y: 0, w: 100, h: 100 };
    const xs = placed.map((n) => n.x!);
    const ys = placed.map((n) => n.y!);
    const pad = 40;
    const x = Math.min(...xs) - pad;
    const y = Math.min(...ys) - pad;
    return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
  }, [placed]);

  const unplaced = nodes.length - placed.length;

  return (
    <div className={fill ? "relative h-full min-h-0" : "flex flex-col gap-2"}>
      <svg
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        className={fill ? "h-full w-full rounded-md bg-ink-950" : "w-full rounded-md bg-ink-950"}
        style={fill ? undefined : { maxHeight: "34rem", aspectRatio: `${box.w} / ${box.h}` }}
        role="img"
        aria-label="海域マップ"
      >
        <defs>
          <marker id="kc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="var(--color-ink-400)" />
          </marker>
          <marker id="kc-arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="var(--color-accent-500)" />
          </marker>
        </defs>
        {edges.map((e) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          const dx = b.x! - a.x!;
          const dy = b.y! - a.y!;
          const len = Math.hypot(dx, dy) || 1;
          const hl = selected === e.from && targets.has(e.to);
          const dim = selected !== null && selected === e.from && !hl;
          const rate = edgeRates?.get(`${e.from}>${e.to}`);
          const width = edgeRates ? (rate ? 1.8 + rate * 9 : 1) : hl ? 2.5 : 1.4;
          const color = edgeRates ? (rate ? "var(--color-accent-500)" : "var(--color-ink-600)") : hl ? "var(--color-accent-500)" : "var(--color-ink-500)";
          return (
            <g key={e.id}>
            <line
              x1={a.x! + (dx / len) * R}
              y1={a.y! + (dy / len) * R}
              x2={b.x! - (dx / len) * (R + 3)}
              y2={b.y! - (dy / len) * (R + 3)}
              stroke={color}
              strokeWidth={width}
              strokeOpacity={edgeRates && rate ? 0.35 + Math.min(0.65, rate) : 1}
              strokeDasharray={dim ? "4 4" : undefined}
              markerEnd={hl || (edgeRates && rate) ? "url(#kc-arrow-hl)" : "url(#kc-arrow)"}
            />
            {rate !== undefined && rate >= 0.005 && !nodeBadges && (
              <text
                x={(a.x! + b.x!) / 2}
                y={(a.y! + b.y!) / 2 - 5}
                textAnchor="middle"
                fontSize={13}
                fontWeight={600}
                fill="var(--color-ink-100)"
                stroke="var(--color-ink-950)"
                strokeWidth={3}
                paintOrder="stroke"
                style={{ pointerEvents: "none" }}
              >
                {(rate * 100).toFixed(rate < 0.1 ? 1 : 0)}%
              </text>
            )}
            </g>
          );
        })}

        {placed.map((n) => {
          const color = NODE_COLOR[typeKey(n.type)];
          const isSel = selected === n.letter;
          return (
            <g
              key={n.letter}
              transform={`translate(${n.x} ${n.y})`}
              onClick={() => onSelect(n.letter)}
              className="cursor-pointer"
              role="button"
              aria-label={`ノード ${n.letter}`}
            >
              <title>{`${NODE_TYPE_LABEL[typeKey(n.type)]}${withComps.has(n.letter) && !edgeRates ? " · 敵編成データあり" : ""}`}</title>
              {n.isBoss && <circle r={R + 7} fill="none" stroke="var(--color-danger-500)" strokeWidth={2} strokeDasharray="3 3" />}
              {isSel && <circle r={R + 4} fill="none" stroke="var(--color-accent-400)" strokeWidth={2.5} />}
              {targets.has(n.letter) && !isSel && <circle r={R + 4} fill="none" stroke="var(--color-accent-500)" strokeWidth={2} />}
              <circle r={R} fill={color} stroke="var(--color-ink-950)" strokeWidth={2} />
              <text textAnchor="middle" dominantBaseline="central" fontSize={n.letter.length > 2 ? 12 : 14} fontWeight={700} fill="var(--color-ink-50)" style={{ pointerEvents: "none" }}>
                {n.letter === "Start" ? "S" : n.letter}
              </text>
              {nodeBadges?.has(n.letter) && (
                <g transform={`translate(0 ${R + 12})`} style={{ pointerEvents: "none" }}>
                  <rect x={-22} y={-9} width={44} height={18} rx={8} fill="var(--color-ink-900)" stroke="var(--color-ink-600)" />
                  <text textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={600} fill="var(--color-accent-400)">
                    {nodeBadges.get(n.letter)}
                  </text>
                </g>
              )}
              {withComps.has(n.letter) && !edgeRates && <circle cx={R - 2} cy={-R + 2} r={4.5} fill="var(--color-ink-50)" stroke="var(--color-ink-950)" strokeWidth={1.2} />}
            </g>
          );
        })}
      </svg>

      <div className={fill ? "absolute bottom-3 left-3 flex items-center gap-2 text-xs text-ink-300" : "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-300"}>
        {[...new Set(nodes.map((n) => typeKey(n.type)))].map((t) => (
          <span key={t} className="flex items-center gap-1" title={NODE_TYPE_LABEL[t]}>
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: NODE_COLOR[t] }} />
            {!fill && NODE_TYPE_LABEL[t]}
          </span>
        ))}
        {unplaced > 0 && <span className="text-warn-400" title={`座標なし ${unplaced} ノード`}>+{unplaced}</span>}
      </div>
    </div>
  );
};
