import React, { useState } from "react";
import { FORMATION_NAME } from "../../data/routing";
import type { CompSelection, CompShip, EnemyComp, EnemyCompSet } from "@shared/data/types";
import { compSourceLabel } from "../../sim/sortieAdapter";
import { Badge, ProgressBar, Select, cx } from "../../ui";

interface Names {
  shipName: (id: number) => string;
  equipName: (id: number) => string;
}

const DIFF_LABEL: Record<number, string> = { 0: "通常", 1: "丁", 2: "丙", 3: "乙", 4: "甲" };

const STAT_COLS = ["HP", "火", "雷", "空", "装"];
const COL = "w-10 shrink-0 text-right";

const ShipRow = ({ s, names }: { s: CompShip; names: Names }) => {
  const equips = s.equips.filter((e) => e > 0).map(names.equipName);
  return (
    <li className="flex items-center gap-x-3 px-1 py-0.5" title={equips.join(" / ")}>
      <span className="min-w-0 flex-1 truncate text-sm text-ink-100">
        {names.shipName(s.shipId)} <span className="text-xs text-ink-400">Lv{s.level}</span>
      </span>
      {[s.hp, s.fp, s.tp, s.aa, s.ar].map((v, i) => (
        <span key={i} className={cx(COL, "text-sm tabular-nums", v === 0 ? "text-ink-500" : "text-ink-100")}>
          {v}
        </span>
      ))}
    </li>
  );
};

const Comp = ({ comp, names }: { comp: EnemyComp; names: Names }) => (
  <article className="rounded-md bg-ink-900/50 px-2.5 py-2">
    <div className="mb-1 flex items-center gap-3">
      <span className="w-16 shrink-0 text-xl font-semibold text-ink-50 tabular-nums" title={`${comp.count.toLocaleString()} 回`}>
        {(comp.weight * 100).toFixed(1)}%
      </span>
      <div className="flex-1">
        <ProgressBar value={comp.weight} max={1} tone="accent" className="h-1.5" />
      </div>
      {comp.formation !== null && <Badge tone="neutral">{FORMATION_NAME[comp.formation] ?? `陣形${comp.formation}`}</Badge>}
    </div>
    <ul className="flex flex-col">
      {comp.main.map((s, i) => (
        <ShipRow key={i} s={s} names={names} />
      ))}
    </ul>
    {comp.escort.length > 0 && (
      <>
        <div className="mt-1.5 px-1 text-xs text-ink-400">護衛艦隊</div>
        <ul className="flex flex-col">
          {comp.escort.map((s, i) => (
            <ShipRow key={i} s={s} names={names} />
          ))}
        </ul>
      </>
    )}
  </article>
);

/** 「観測 (n=…)」/「KCNav」。KCNav のときは観測が閾値に届かなかった件数も添える。 */
const CompSourceBadge = ({ set, selection }: { set: EnemyCompSet; selection?: CompSelection }) => {
  const observed = set.source === "poi-observed";
  const title = observed
    ? `自分たちの観測 (poi) の集計。${set.periodStart?.slice(0, 10) ?? "?"} 以降`
    : selection && selection.observedCount > 0
      ? `観測 n=${selection.observedCount} が閾値 ${selection.minObserved} 未満のため KCNav を使用`
      : "KCNav (TsunDB) の集計";
  return (
    <Badge tone={observed ? "ok" : "neutral"} className="ml-1.5" title={title}>
      {compSourceLabel(set)}
    </Badge>
  );
};

export const CompsPanel = ({ sets, names, selection }: { sets: EnemyCompSet[]; names: Names; selection?: CompSelection[] }) => {
  const [difficulty, setDifficulty] = useState<number | null>(null);
  if (sets.length === 0) return <p className="text-sm text-ink-400">編成なし</p>;

  const diffs = [...new Set(sets.map((s) => s.difficulty))].sort();
  const diff = difficulty !== null && diffs.includes(difficulty) ? difficulty : diffs[diffs.length - 1];
  // 同じ難易度は最新の取得を使う (API.md)
  const set = sets.filter((s) => s.difficulty === diff).sort((a, b) => b.retrievedAt.localeCompare(a.retrievedAt))[0];
  const comps = [...set.comps].sort((a, b) => b.weight - a.weight);

  return (
    <div className="flex flex-col gap-2">
      {/* 列見出しは一覧の先頭に1回だけ。右端は Comp の px-2.5 + ShipRow の px-1 に揃える */}
      <div className="flex items-center gap-x-3 pr-3.5 text-xs text-ink-400">
        {diffs.length > 1 && (
          <Select className="w-24" value={diff} onChange={(e) => setDifficulty(Number(e.target.value))} aria-label="難易度">
            {diffs.map((d) => (
              <option key={d} value={d}>
                {DIFF_LABEL[d] ?? d}
              </option>
            ))}
          </Select>
        )}
        <span className="min-w-0 flex-1" title={`期間 ${set.periodStart?.slice(0, 10) ?? "?"} 〜 ${set.periodEnd?.slice(0, 10) ?? "現在"}`}>
          {set.totalCount.toLocaleString()} 回
          <CompSourceBadge set={set} selection={selection?.find((s) => s.difficulty === set.difficulty)} />
        </span>
        {STAT_COLS.map((h) => (
          <span key={h} className={COL}>
            {h}
          </span>
        ))}
      </div>
      {comps.map((c) => (
        <Comp key={c.id} comp={c} names={names} />
      ))}
    </div>
  );
};
