import React, { useMemo } from "react";
import type { MapEdge, MapNode, NodeType } from "../../data/types";

export const NODE_COLOR: Record<string, string> = {
  start: "#4c90f0",
  battle: "#cd4246",
  boss: "#e76a6e",
  night_battle: "#9d6ad8",
  air_battle: "#ec9a3c",
  air_raid: "#c87619",
  empty: "#738091",
  select: "#8f99a8",
  resource: "#32a467",
  maelstrom: "#2bb5c8",
  landing: "#d1980b",
  escort_success: "#d1980b",
  air_recon: "#8abbff",
  anchorage_repair: "#72ca9b",
  unknown: "#5f6b7c",
};

export const NODE_TYPE_LABEL: Record<string, string> = {
  start: "出撃地点", battle: "通常戦闘", boss: "ボス", night_battle: "夜戦", air_battle: "航空戦",
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
}

const R = 15;

export const MapGraph = ({ nodes, edges, selected, onSelect, targets, withComps, edgeRates, nodeBadges }: Props) => {
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
    <div className="flex flex-col gap-2">
      <svg
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        className="w-full rounded-md bg-ink-900"
        style={{ maxHeight: "34rem", aspectRatio: `${box.w} / ${box.h}` }}
        role="img"
        aria-label="海域マップ"
      >
        <defs>
          <marker id="kc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="#5f6b7c" />
          </marker>
          <marker id="kc-arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="#4c90f0" />
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
          const width = edgeRates ? (rate ? 1.8 + rate * 9 : 1) : hl ? 3 : 1.8;
          const color = edgeRates ? (rate ? "#4c90f0" : "#2f343c") : hl ? "#4c90f0" : "#404854";
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
            {rate !== undefined && rate >= 0.005 && (
              <text
                x={(a.x! + b.x!) / 2}
                y={(a.y! + b.y!) / 2 - 5}
                textAnchor="middle"
                fontSize={11}
                fontWeight={600}
                fill="#d3d8de"
                stroke="#111418"
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
              {n.isBoss && <circle r={R + 7} fill="none" stroke="#fa999c" strokeWidth={2} strokeDasharray="3 3" />}
              {isSel && <circle r={R + 4} fill="none" stroke="#fff" strokeWidth={2.5} />}
              {targets.has(n.letter) && !isSel && <circle r={R + 4} fill="none" stroke="#4c90f0" strokeWidth={2} />}
              <circle r={R} fill={color} stroke="#1c2127" strokeWidth={2} />
              <text textAnchor="middle" dominantBaseline="central" fontSize={n.letter.length > 2 ? 10 : 13} fontWeight={700} fill="#fff" style={{ pointerEvents: "none" }}>
                {n.letter === "Start" ? "S" : n.letter}
              </text>
              {nodeBadges?.has(n.letter) && (
                <g transform={`translate(0 ${R + 11})`} style={{ pointerEvents: "none" }}>
                  <rect x={-19} y={-8} width={38} height={15} rx={7} fill="#111418" stroke="#404854" />
                  <text textAnchor="middle" dominantBaseline="central" fontSize={10} fontWeight={600} fill="#8abbff">
                    {nodeBadges.get(n.letter)}
                  </text>
                </g>
              )}
              {withComps.has(n.letter) && !edgeRates && <circle cx={R - 2} cy={-R + 2} r={4.5} fill="#f6f7f9" stroke="#1c2127" strokeWidth={1.2} />}
            </g>
          );
        })}
      </svg>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-300">
        {[...new Set(nodes.map((n) => typeKey(n.type)))].map((t) => (
          <span key={t} className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: NODE_COLOR[t] }} />
            {NODE_TYPE_LABEL[t]}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full border border-ink-900 bg-ink-50" />
          敵編成データあり
        </span>
        {unplaced > 0 && <span className="text-warn-400">座標なし {unplaced} ノード (非表示)</span>}
      </div>
    </div>
  );
};
