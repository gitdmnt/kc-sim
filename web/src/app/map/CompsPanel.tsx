import React, { useState } from "react";
import { FORMATION_NAME } from "../../data/routing";
import type { ApiEquipment, CompSelection, CompShip, EnemyComp, EnemyCompSet } from "@shared/data/types";
import { compSourceLabel } from "../../sim/sortieAdapter";
import { EquipIcon, ProgressBar, Select, cx } from "../../ui";

interface Names {
  shipName: (id: number) => string;
  equipName: (id: number) => string;
  equipById: (id: number) => ApiEquipment | undefined;
}

const DIFF_LABEL: Record<number, string> = { 0: "通常", 1: "丁", 2: "丙", 3: "乙", 4: "甲" };

const STATS = [
  { head: "HP", get: (s: CompShip) => s.hp },
  { head: "火", get: (s: CompShip) => s.fp },
  { head: "雷", get: (s: CompShip) => s.tp },
  { head: "空", get: (s: CompShip) => s.aa },
  { head: "装", get: (s: CompShip) => s.ar },
];

type Stat = (typeof STATS)[number];

const template = (cols: number) => ({ gridTemplateColumns: `minmax(0,1fr) 6rem repeat(${cols}, 2.5rem)` });

const ShipRow = ({ s, names, stats, showLevel }: { s: CompShip; names: Names; stats: Stat[]; showLevel: boolean }) => {
  const equips = s.equips.filter((e) => e > 0);
  return (
    <li className="grid items-center gap-x-2 py-0.5" style={template(stats.length)}>
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm text-ink-100">{names.shipName(s.shipId)}</span>
        {showLevel && <span className="shrink-0 text-xs text-ink-400 tabular-nums">Lv{s.level}</span>}
      </span>
      <span className="flex gap-0.5">
        {equips.map((id, i) => {
          const e = names.equipById(id);
          return <EquipIcon key={i} iconId={e?.icon ?? e?.type?.[3] ?? 0} title={names.equipName(id)} />;
        })}
      </span>
      {stats.map((st) => {
        const v = st.get(s);
        return (
          <span key={st.head} className={cx("text-right text-sm tabular-nums", v === 0 ? "text-ink-500" : "text-ink-100")}>
            {v}
          </span>
        );
      })}
    </li>
  );
};

const Comp = ({ comp, names, stats, showLevel }: { comp: EnemyComp; names: Names; stats: Stat[]; showLevel: boolean }) => (
  <article className="flex flex-col gap-1">
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-lg font-semibold text-ink-50 tabular-nums" title={`${comp.count.toLocaleString()} 回`}>
        {(comp.weight * 100).toFixed(1)}%
      </span>
      <ProgressBar value={comp.weight} max={1} tone="accent" className="flex-1" />
      <span className="w-14 shrink-0 text-right text-xs text-ink-400">
        {comp.formation !== null ? (FORMATION_NAME[comp.formation] ?? `陣形${comp.formation}`) : ""}
      </span>
    </div>
    <ul className="flex flex-col">
      {comp.main.map((s, i) => (
        <ShipRow key={i} s={s} names={names} stats={stats} showLevel={showLevel} />
      ))}
    </ul>
    {comp.escort.length > 0 && (
      <ul className="mt-1 flex flex-col" aria-label="護衛艦隊">
        {comp.escort.map((s, i) => (
          <ShipRow key={i} s={s} names={names} stats={stats} showLevel={showLevel} />
        ))}
      </ul>
    )}
  </article>
);

/** 集計元。観測 (poi) か KCNav か。KCNav のときは観測が閾値に届かなかった件数を title に添える。 */
const sourceTitle = (set: EnemyCompSet, selection?: CompSelection) =>
  set.source === "poi-observed"
    ? `自分たちの観測 (poi) の集計。${set.periodStart?.slice(0, 10) ?? "?"} 以降`
    : selection && selection.observedCount > 0
      ? `観測 n=${selection.observedCount} が閾値 ${selection.minObserved} 未満のため KCNav を使用`
      : "KCNav (TsunDB) の集計";

export const CompsPanel = ({ sets, names, selection }: { sets: EnemyCompSet[]; names: Names; selection?: CompSelection[] }) => {
  const [difficulty, setDifficulty] = useState<number | null>(null);
  if (sets.length === 0) return <p className="text-sm text-ink-400">編成なし</p>;

  const diffs = [...new Set(sets.map((s) => s.difficulty))].sort();
  const diff = difficulty !== null && diffs.includes(difficulty) ? difficulty : diffs[diffs.length - 1];
  // 同じ難易度は最新の取得を使う (private notes API)
  const set = sets.filter((s) => s.difficulty === diff).sort((a, b) => b.retrievedAt.localeCompare(a.retrievedAt))[0];
  const comps = [...set.comps].sort((a, b) => b.weight - a.weight);

  // 全編成で 0 の列は出さない。Lv が全艦で同じなら見出しに 1 回だけ出す
  const ships = comps.flatMap((c) => [...c.main, ...c.escort]);
  const stats = STATS.filter((st) => st.head === "HP" || ships.some((s) => st.get(s) !== 0));
  const levels = new Set(ships.map((s) => s.level));
  const uniformLevel = levels.size === 1 ? [...levels][0] : null;

  return (
    <section className="flex flex-col gap-3">
      <div className="grid items-center gap-x-2 text-xs text-ink-400" style={template(stats.length)}>
        <span className="flex min-w-0 items-center gap-2" title={`期間 ${set.periodStart?.slice(0, 10) ?? "?"} 〜 ${set.periodEnd?.slice(0, 10) ?? "現在"}`}>
          {diffs.length > 1 && (
            <Select className="w-20" value={diff} onChange={(e) => setDifficulty(Number(e.target.value))} aria-label="難易度">
              {diffs.map((d) => (
                <option key={d} value={d}>
                  {DIFF_LABEL[d] ?? d}
                </option>
              ))}
            </Select>
          )}
          <span className="tabular-nums">{set.totalCount.toLocaleString()} 回</span>
          <span title={sourceTitle(set, selection?.find((s) => s.difficulty === set.difficulty))}>{compSourceLabel(set)}</span>
          {uniformLevel !== null && <span className="tabular-nums">Lv{uniformLevel}</span>}
        </span>
        <span />
        {stats.map((st) => (
          <span key={st.head} className="text-right">
            {st.head}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-4">
        {comps.map((c) => (
          <Comp key={c.id} comp={c} names={names} stats={stats} showLevel={uniformLevel === null} />
        ))}
      </div>
    </section>
  );
};
