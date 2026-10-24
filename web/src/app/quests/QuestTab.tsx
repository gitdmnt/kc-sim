import React, { useMemo, useState } from "react";
import type { PoiQuests } from "@shared/embed/protocol";
import {
  OwnershipIndex, aggregateNeeds, buildQuestGraph, describeRequirement, prerequisiteOutline, questStatuses, resolvePrerequisites,
  rosterFromPoi, visibleQuests,
} from "@shared/quest/tree";
import type { EquipNeedRow, ShipNeedRow } from "@shared/quest/tree";
import { FREQUENCY_LABEL, filterQuests, parseQuestFilter, questFrequency } from "@shared/quest/filter";
import type { QuestFilter } from "@shared/quest/filter";
import { questDoability } from "@shared/quest/doable";
import type { Doability } from "@shared/quest/doable";
import type { QuestEntry } from "@shared/quest/types";
import { Card, S, TextInput, cx } from "../../ui";
import { normalizeForSearch } from "../../fleet/catalog";
import { STORAGE_PREFIX } from "../../fleet";
import { getDataApi } from "../../data/api";
import { useAsync } from "../../data/useAsync";
import { useApp } from "../context";
import { DataError, StaleBadge } from "../DataState";
import { QuestFilters } from "./QuestFilters";
import { QuestRewardsView } from "./QuestRewards";
import { Dot, FINISHED, QuestRow, STATUS, progressSource, progressText, questLabel } from "./QuestRow";
import type { Player } from "./QuestRow";
import { PrerequisiteTree } from "./PrerequisiteTree";

const MAX_LIST = 400;
const SELECTED_KEY = `${STORAGE_PREFIX}quest`;
const FILTER_KEY = `${STORAGE_PREFIX}questFilter`;

/** Data sources of one quest, in display order: the override's reference page, then the upstream files that contributed. */
const questSources = (q: QuestEntry): [name: string, url: string][] => {
  const out = new Map<string, string>();
  if (q.override) {
    const url = q.override.source;
    let name = url;
    try {
      const u = new URL(url);
      name = u.hostname === "zekamashi.net" ? "ぜかましねっと"
        : u.pathname.startsWith("/kcwikizh/") ? "kcwiki-quest-data"
        : u.pathname.startsWith("/KC3Kai/") ? "KC3Kai"
        : u.hostname;
    } catch {
      // not a URL: shown as is
    }
    out.set(name, url);
  }
  const fields = q.override?.fields ?? [];
  if (q.pre.some((p) => p.src.includes("kcwiki")) || (q.requirements && !fields.includes("requirements")) || q.rewards?.src === "kcwiki") {
    if (!out.has("kcwiki-quest-data")) out.set("kcwiki-quest-data", "https://github.com/kcwikizh/kcwiki-quest-data");
  }
  // the quest list, code and text
  if (!out.has("KC3Kai")) out.set("KC3Kai", "https://github.com/KC3Kai/KC3Kai");
  if (q.rewards?.src === "kcanotify") out.set("kcanotify", "https://github.com/antest1/kcanotify-gamedata");
  return [...out];
};

const needText = (r: ShipNeedRow | EquipNeedRow) =>
  `${"names" in r ? r.names.join("/") : r.name} ${r.owned ?? 0}/${r.amount}`;

/** 実施可能でない理由のうち一覧から分からないもの: 不足の艦娘・装備、所持と照合できない条件。 */
const DoableView = ({ d }: { d: Doability }) => {
  const missing = [...d.ships, ...d.equips];
  if (missing.length === 0 && d.unchecked.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 text-xs text-ink-200" aria-label="実施可能かどうか">
      {missing.length > 0 && <p>不足: {missing.map(needText).join("、")}</p>}
      {d.unchecked.length > 0 && <p>照合できない条件: {d.unchecked.join("、")}</p>}
    </div>
  );
};

const NeedList = <R extends ShipNeedRow | EquipNeedRow>({ title, rows, render }: {
  title: string;
  rows: R[];
  render: (r: R) => React.ReactNode;
}) => (
  <div>
    <h4 className="mb-1 text-xs font-semibold text-ink-300">{title}</h4>
    {rows.length === 0 ? (
      <p className="text-xs text-ink-500">指定なし</p>
    ) : (
      <ul className="flex flex-col gap-0.5">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2 text-sm" title={r.unresolved.length ? `マスターに無い名前: ${r.unresolved.join("、")}` : undefined}>
            <span className="min-w-0 flex-1 truncate text-ink-100">{render(r)}</span>
            <span className={cx("shrink-0 text-xs tabular-nums", r.ok === false ? "text-danger-400/80" : "text-ink-400")}>
              {r.owned === null ? (r.unresolved.length ? `?/${r.amount}` : `×${r.amount}`) : `${r.owned}/${r.amount}`}
            </span>
          </li>
        ))}
      </ul>
    )}
  </div>
);

const initialSelected = (): number | null => {
  try {
    const v = Number(localStorage.getItem(SELECTED_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};

const initialFilter = (): QuestFilter => {
  try {
    return parseQuestFilter(JSON.parse(localStorage.getItem(FILTER_KEY) ?? "null"));
  } catch {
    return parseQuestFilter(null);
  }
};

/**
 * 任務タブ: 任務を選ぶと、前提任務のツリー、未達成の前提で要る艦娘・装備 (所持/必要数)、後続任務を出す。
 * 達成状況・進捗は poi (プラグイン経由) の任務一覧と poi の進捗カウンタから。
 */
export const QuestTab = () => {
  const { state, poi } = useApp();
  const res = useAsync(() => getDataApi().quests(), []);
  const [query, setQuery] = useState("");
  const [filter, setFilterState] = useState<QuestFilter>(initialFilter);
  const setFilter = (f: QuestFilter) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(f));
    } catch {
      // ignore
    }
  };
  const [selected, setSelectedState] = useState<number | null>(initialSelected);
  const select = (id: number) => {
    setSelectedState(id);
    try {
      localStorage.setItem(SELECTED_KEY, String(id));
    } catch {
      // ignore
    }
  };
  const quests = res.data?.quests;
  const graph = useMemo(() => buildQuestGraph(quests ?? []), [quests]);
  const poiQuests: PoiQuests | undefined = state?.quests;
  const owned = useMemo(() => {
    const roster = rosterFromPoi(state);
    return roster ? new OwnershipIndex(roster) : null;
  }, [state]);
  const player: Player = useMemo(() => {
    const statuses = questStatuses(graph, poiQuests);
    const listSeen = !!poiQuests?.list;
    const doability =
      poiQuests && owned ? new Map([...graph.byId.keys()].map((id) => [id, questDoability(graph, id, statuses, listSeen, owned)])) : null;
    return { statuses, visible: visibleQuests(poiQuests), records: poiQuests?.records ?? {}, doability };
  }, [graph, poiQuests, owned]);

  const { list: filtered, counts } = useMemo(() => {
    const needle = normalizeForSearch(query);
    const { statuses, doability } = player;
    return filterQuests(quests ?? [], filter, {
      statusOf: poiQuests ? (id) => statuses.get(id) ?? "unknown" : undefined,
      doableOf: doability ? (id) => doability.get(id)! : undefined,
      match: needle ? (q) => normalizeForSearch(`${q.code ?? ""}${q.name ?? ""}${q.id}`).includes(needle) : undefined,
    });
  }, [quests, query, filter, player, poiQuests]);
  // 既定: 遂行中の任務、無ければ最初の任務
  const fallback = [...player.visible.values()].find((e) => e.state === 2)?.id ?? quests?.[0]?.id ?? null;
  const current = selected !== null && graph.byId.has(selected) ? selected : fallback;

  const tree = useMemo(() => (current === null ? null : resolvePrerequisites(graph, current)), [graph, current]);
  const outline = useMemo(() => (current === null ? [] : prerequisiteOutline(graph, current)), [graph, current]);
  const needs = useMemo(() => {
    if (!tree) return null;
    const open = tree.order.filter((id) => !FINISHED.includes(player.statuses.get(id) ?? "unknown"));
    return aggregateNeeds(graph, open, owned);
  }, [graph, tree, player, owned]);

  if (res.error && !quests) return <DataError error={res.error} />;
  if (!quests) return <p className="text-sm text-ink-300">{S.common.loading}</p>;

  const q = current === null ? undefined : graph.byId.get(current);
  // 報酬は構造化して出すので、メモの「[獲]」以降は省く
  const memo = q?.memo && q.rewards ? q.memo.split("[獲]")[0]!.trim() : q?.memo;
  const status = current === null ? "unknown" : (player.statuses.get(current) ?? "unknown");
  const goals = current === null ? undefined : player.records[current];
  const progress = current === null ? null : progressText(player.visible.get(current), goals);
  const unlocks = current === null ? [] : (graph.unlocks.get(current) ?? []);
  const pending = tree ? tree.order.filter((id) => id !== current && !FINISHED.includes(player.statuses.get(id) ?? "unknown")).length : 0;
  const doability = q && player.doability?.get(q.id);

  return (
    <div className="grid grid-cols-1 gap-2 lg:h-full lg:grid-cols-[17rem_minmax(0,1fr)_19rem] lg:grid-rows-[minmax(0,1fr)]">
      <Card
        title={
          <span className="tabular-nums">
            {S.common.count(filtered.length)}
            {filtered.length < quests.length && <span className="ml-1 text-xs font-normal text-ink-400">/ {quests.length}</span>}
          </span>
        }
        actions={res.stale ? <StaleBadge /> : undefined}
        className="flex min-h-0 flex-col"
        bodyClassName="flex min-h-0 flex-1 flex-col gap-2"
      >
        <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="コード・名前で検索" aria-label="任務を検索" />
        <QuestFilters
          filter={filter}
          counts={counts}
          showStatus={!!poiQuests}
          doableOff={!poiQuests ? "poi 接続時のみ" : !owned ? "所持艦のデータ待ち" : null}
          onChange={setFilter}
        />
        {!poiQuests && poi.status === "connected" && <p className="text-xs text-ink-400">プラグインが古く任務の状態が届きません</p>}
        <ul className="-mx-2 flex min-h-0 flex-1 flex-col overflow-auto px-2" aria-label="任務の一覧">
          {filtered.slice(0, MAX_LIST).map((x) => (
            <QuestRow key={x.id} id={x.id} graph={graph} player={player} current={x.id === current} onSelect={select} />
          ))}
          {filtered.length > MAX_LIST && <li className="py-1 text-center text-xs text-ink-400">他 {filtered.length - MAX_LIST} 件</li>}
        </ul>
      </Card>

      <Card
        title={
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-sm tabular-nums text-ink-400">{q?.code}</span>
            <span className="truncate">{q?.name ?? "任務を選択"}</span>
          </span>
        }
        actions={
          q && (
            <span className="flex items-center gap-2 text-xs text-ink-300">
              <span className="text-ink-400">{FREQUENCY_LABEL[questFrequency(q.code)]}</span>
              {status !== "unknown" && (
                <span className="flex items-center gap-1">
                  <Dot status={status} />
                  {STATUS[status].label}
                </span>
              )}
            </span>
          )
        }
        className="flex min-h-0 flex-col"
        bodyClassName="flex min-h-0 flex-1 flex-col gap-3 overflow-auto"
      >
        {q && tree && (
          <>
            <div className="flex flex-col gap-1 text-sm">
              {q.detail && <p className="whitespace-pre-line text-ink-200">{q.detail}</p>}
              {memo && <p className="text-xs text-ink-400">{memo}</p>}
              {q.requirements && (
                <pre className="font-sans text-xs whitespace-pre-wrap text-ink-300">{describeRequirement(q.requirements).join("\n")}</pre>
              )}
              {q.override?.note && <p className="text-xs text-ink-400">{q.override.note}</p>}
              {doability && <DoableView d={doability} />}
              <QuestRewardsView rewards={q.rewards} />
              {progress && (
                <div className="text-xs text-accent-400" title={progressSource(goals)}>
                  {goals && goals.length > 1 && player.visible.get(current!)?.state !== 3 ? (
                    <>
                      <p>進捗{goals[0]?.source === "kcsim" ? " (kc-sim)" : ""}:</p>
                      <ul className="pl-3 tabular-nums">
                        {goals.map((g) => (
                          <li key={g.key} className={g.count >= g.required ? "text-ok-400" : undefined}>
                            {g.description ?? g.key} {g.count}/{g.required}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p>進捗{goals?.[0]?.source === "kcsim" ? " (kc-sim)" : ""}: {progress}</p>
                  )}
                </div>
              )}
            </div>
            <PrerequisiteTree
              key={q.id}
              rows={outline}
              graph={graph}
              player={player}
              onSelect={select}
              title={`前提任務 ${tree.order.length - 1} 件${tree.order.length > 1 && poiQuests ? ` (未達成・不明 ${pending} 件)` : ""}`}
            />
            {(tree.cycleEdges.length > 0 || tree.missing.length > 0) && (
              <p className="-mt-2 text-xs text-warn-400">
                {tree.cycleEdges.length > 0 && `循環する前提 ${tree.cycleEdges.map(([a, b]) => `${questLabel(graph.byId.get(a), a)} → ${questLabel(graph.byId.get(b), b)}`).join("、")} を除外`}
                {tree.missing.length > 0 && ` データに無い任務: ${tree.missing.map((m) => `#${m}`).join(", ")}`}
              </p>
            )}
            <p className="mt-auto text-[11px] text-ink-500">
              出典:{" "}
              {questSources(q).map(([name, url], i) => (
                <React.Fragment key={name}>
                  {i > 0 && " / "}
                  <a href={url} target="_blank" rel="noreferrer" className="hover:text-ink-300 hover:underline">{name}</a>
                </React.Fragment>
              ))}
            </p>
          </>
        )}
      </Card>

      <Card title="必要なもの" className="flex min-h-0 flex-col" bodyClassName="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
        {needs && (
          <>
            <p className="text-xs text-ink-400">未達成の前提任務を含む</p>
            <NeedList title="艦娘" rows={needs.ships} render={(r) => `${r.names.join(" / ")}${r.consumed ? " (改修素材)" : ""}`} />
            <NeedList title="装備" rows={needs.equips} render={(r) => r.name} />
          </>
        )}
        <div>
          <h4 className="mb-1 text-xs font-semibold text-ink-300">後続任務</h4>
          {unlocks.length === 0 ? (
            <p className="text-xs text-ink-500">なし</p>
          ) : (
            <ul className="-mx-2 flex flex-col px-2" aria-label="後続任務">
              {unlocks.map((id) => (
                <QuestRow key={id} id={id} graph={graph} player={player} onSelect={select} />
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
};
