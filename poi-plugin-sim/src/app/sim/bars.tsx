import React from "react";
import type { Rank } from "@sim-core";

export const RANKS: Rank[] = ["SS", "S", "A", "B", "C", "D", "E"];
export const RANK_COLOR: Record<Rank, string> = {
  SS: "#f7d870", S: "#e0b43a", A: "#e76a6e", B: "#ec9a3c", C: "#d1980b", D: "#32a467", E: "#4c90f0",
};

export const StackedBar = ({
  parts,
  height = "h-7",
}: {
  parts: { label: string; value: number; color: string }[];
  height?: string;
}) => (
  <div className={`flex w-full overflow-hidden rounded border border-ink-600 bg-ink-900 ${height}`}>
    {parts.map((p) =>
      p.value > 0 ? (
        <div key={p.label} style={{ width: `${p.value * 100}%`, background: p.color }} title={`${p.label}: ${(p.value * 100).toFixed(2)}%`} />
      ) : null
    )}
  </div>
);

export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;

export const STATE_PARTS = (s: { healthyRate: number; lightRate: number; moderateRate: number; heavyRate: number; sunkRate: number }) => [
  { label: "無傷", value: s.healthyRate, color: "#32a467" },
  { label: "小破", value: s.lightRate, color: "#d1980b" },
  { label: "中破", value: s.moderateRate, color: "#ec9a3c" },
  { label: "大破", value: s.heavyRate, color: "#cd4246" },
  { label: "撃沈", value: s.sunkRate, color: "#5f6b7c" },
];
