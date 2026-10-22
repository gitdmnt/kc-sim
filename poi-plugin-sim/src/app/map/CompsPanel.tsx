import React, { useState } from "react";
import { FORMATION_NAME } from "../../data/routing";
import type { CompShip, EnemyComp, EnemyCompSet } from "../../data/types";
import { Badge, ProgressBar, Select } from "../../ui";

interface Names {
  shipName: (id: number) => string;
  equipName: (id: number) => string;
}

const DIFF_LABEL: Record<number, string> = { 0: "通常", 1: "丁", 2: "丙", 3: "乙", 4: "甲" };

const ShipRow = ({ s, names }: { s: CompShip; names: Names }) => {
  const equips = s.equips.filter((e) => e > 0).map(names.equipName);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded bg-ink-900/50 px-2 py-1" title={equips.join(" / ")}>
      <span className="truncate text-sm">
        {names.shipName(s.shipId)} <span className="text-[11px] text-ink-400">Lv{s.level}</span>
      </span>
      <span className="flex gap-2 text-[11px] text-ink-300 tabular-nums">
        <span>HP {s.hp}</span>
        <span>火 {s.fp}</span>
        <span>雷 {s.tp}</span>
        <span>空 {s.aa}</span>
        <span>装 {s.ar}</span>
      </span>
    </li>
  );
};

const Comp = ({ comp, names }: { comp: EnemyComp; names: Names }) => (
  <article className="rounded-lg border border-ink-600 bg-ink-800 p-2.5">
    <div className="mb-1.5 flex items-center gap-2">
      <div className="flex-1">
        <ProgressBar value={comp.weight} max={1} tone="accent" className="h-2" />
      </div>
      <span className="w-14 text-right text-sm font-semibold tabular-nums">{(comp.weight * 100).toFixed(1)}%</span>
      <span className="w-16 text-right text-[11px] text-ink-400 tabular-nums">{comp.count.toLocaleString()}回</span>
      {comp.formation !== null && <Badge tone="neutral">{FORMATION_NAME[comp.formation] ?? `陣形${comp.formation}`}</Badge>}
    </div>
    <ul className="flex flex-col gap-1">
      {comp.main.map((s, i) => (
        <ShipRow key={i} s={s} names={names} />
      ))}
    </ul>
    {comp.escort.length > 0 && (
      <>
        <div className="mt-1.5 mb-1 text-[10px] text-ink-400">護衛艦隊</div>
        <ul className="flex flex-col gap-1">
          {comp.escort.map((s, i) => (
            <ShipRow key={i} s={s} names={names} />
          ))}
        </ul>
      </>
    )}
  </article>
);

export const CompsPanel = ({ sets, names }: { sets: EnemyCompSet[]; names: Names }) => {
  const [difficulty, setDifficulty] = useState<number | null>(null);
  if (sets.length === 0) return <p className="text-xs text-ink-400">敵編成データがありません。</p>;

  const diffs = [...new Set(sets.map((s) => s.difficulty))].sort();
  const diff = difficulty !== null && diffs.includes(difficulty) ? difficulty : diffs[diffs.length - 1];
  // 同じ難易度は最新の取得を使う (API.md)
  const set = sets.filter((s) => s.difficulty === diff).sort((a, b) => b.retrievedAt.localeCompare(a.retrievedAt))[0];
  const comps = [...set.comps].sort((a, b) => b.weight - a.weight);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-300">
        {diffs.length > 1 && (
          <Select className="w-24" value={diff} onChange={(e) => setDifficulty(Number(e.target.value))} aria-label="難易度">
            {diffs.map((d) => (
              <option key={d} value={d}>
                {DIFF_LABEL[d] ?? d}
              </option>
            ))}
          </Select>
        )}
        <span>
          {set.periodStart ?? "?"} 〜 {set.periodEnd ?? "現在"} / 試行 {set.totalCount.toLocaleString()} 回 / {set.source}
        </span>
      </div>
      {comps.map((c) => (
        <Comp key={c.id} comp={c} names={names} />
      ))}
    </div>
  );
};
