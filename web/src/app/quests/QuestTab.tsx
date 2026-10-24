import React, { useMemo, useState } from "react";
import type { PoiQuestGoal, PoiQuestEntry, PoiQuests } from "@shared/embed/protocol";
import {
  OwnershipIndex, aggregateNeeds, buildQuestGraph, descendants, describeRequirement, questStatuses, resolvePrerequisites,
  rosterFromPoi, visibleQuests,
} from "@shared/quest/tree";
import type { EquipNeedRow, QuestGraph, QuestStatus, ShipNeedRow } from "@shared/quest/tree";
import { CATEGORY_LABEL, FREQUENCY_LABEL, filterQuests, parseQuestFilter, questCategory, questFrequency } from "@shared/quest/filter";
import type { QuestFilter } from "@shared/quest/filter";
import { rewardSummary, sumRewards } from "@shared/quest/rewards";
import type { QuestEntry } from "@shared/quest/types";
import { Badge, Card, S, TextInput, cx } from "../../ui";
import type { BadgeTone } from "../../ui";
import { normalizeForSearch } from "../../fleet/catalog";
import { STORAGE_PREFIX } from "../../fleet";
import { getDataApi } from "../../data/api";
import { useAsync } from "../../data/useAsync";
import { useApp } from "../context";
import { DataError, StaleBadge } from "../DataState";
import { QuestFilters } from "./QuestFilters";
import { QuestRewardsView, RewardTotalLine } from "./QuestRewards";

const STATUS: Record<QuestStatus, { label: string; tone: BadgeTone; dot: string; title: string }> = {
  done: { label: "達成", tone: "ok", dot: "bg-ok-400", title: "条件達成 (報酬未受取)" },
  active: { label: "遂行中", tone: "accent", dot: "bg-accent-400", title: "遂行中" },
  available: { label: "受注可", tone: "neutral", dot: "bg-ink-200", title: "開放済み・未受注" },
  cleared: { label: "達成済", tone: "ok", dot: "bg-ok-600", title: "達成済み (一覧にある任務の前提なので)" },
  locked: { label: "未開放", tone: "warn", dot: "bg-warn-400", title: "未開放 (一覧にある単発任務の後続なので)" },
  unknown: { label: "不明", tone: "neutral", dot: "bg-ink-700", title: "poi のデータからは分からない" },
};
/** 前提の必要数から外す任務 (もう条件を満たした) */
const FINISHED: QuestStatus[] = ["cleared", "done"];
const MAX_LIST = 400;
const SELECTED_KEY = `${STORAGE_PREFIX}quest`;
const FILTER_KEY = `${STORAGE_PREFIX}questFilter`;

const Dot = ({ status }: { status: QuestStatus }) => (
  <span role="img" aria-label={STATUS[status].label} title={STATUS[status].title} className={cx("size-2 shrink-0 rounded-full", STATUS[status].dot)} />
);

/** 進捗: 追跡カウンタ (poi の records、無ければ kc-sim プラグインのカウンタ) があればその数、無ければゲームの 50% / 80% 表示。 */
const progressText = (entry: PoiQuestEntry | undefined, goals: PoiQuestGoal[] | undefined): string | null => {
  if (entry?.state === 3) return "達成";
  if (goals?.length) return goals.map((g) => `${goals.length > 1 && g.description ? `${g.description} ` : ""}${g.count}/${g.required}`).join(" · ");
  if (entry?.progress === 1) return "50%以上";
  if (entry?.progress === 2) return "80%以上";
  return null;
};

const progressSource = (goals: PoiQuestGoal[] | undefined) =>
  goals?.some((g) => g.source === "kcsim") ? "kc-sim プラグインが数えた進捗 (手入力の達成条件から)" : "poi の任務トラッカー / ゲームの進捗表示";


const sourceHost = (url: string) => {
  try {
    const host = new URL(url).hostname;
    return host === "zekamashi.net" ? "ぜかましねっと" : host;
  } catch {
    return url;
  }
};

const label = (q: QuestEntry | undefined, id: number) => (q ? `${q.code ?? `#${id}`} ${q.name ?? ""}` : `不明な任務 #${id}`);

interface Player {
  statuses: Map<number, QuestStatus>;
  visible: Map<number, PoiQuestEntry>;
  records: PoiQuests["records"];
}

const QuestRow = ({
  id, graph, player, depth, current, onSelect,
}: { id: number; graph: QuestGraph; player: Player; depth?: number; current?: boolean; onSelect: (id: number) => void }) => {
  const q = graph.byId.get(id);
  const status = player.statuses.get(id) ?? "unknown";
  const progress = progressText(player.visible.get(id), player.records[id]);
  return (
    <li>
      <button
        type="button"
        onClick={() => q && onSelect(id)}
        title={q ? [q.detail, ...describeRequirement(q.requirements), rewardSummary(q.rewards) && `報酬: ${rewardSummary(q.rewards)}`].filter(Boolean).join("\n") : "データに無い任務"}
        style={depth ? { paddingLeft: `${0.5 + Math.min(depth, 12) * 0.75}rem` } : undefined}
        className={cx(
          "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-0.5 text-left text-sm",
          current ? "bg-accent-500/12 text-ink-50" : "text-ink-100 hover:bg-ink-800",
          !q && "cursor-default text-ink-400"
        )}
      >
        <Dot status={status} />
        <span className="w-11 shrink-0 truncate text-xs tabular-nums text-ink-400">{q?.code ?? `#${id}`}</span>
        <span className="min-w-0 flex-1 truncate">{q?.name ?? `不明な任務 #${id}`}</span>
        {progress && <span className="shrink-0 text-xs tabular-nums text-accent-400" title={progressSource(player.records[id])}>{progress}</span>}
      </button>
    </li>
  );
};

const NeedList = <R extends ShipNeedRow | EquipNeedRow>({ title, rows, render, empty }: {
  title: string;
  rows: R[];
  render: (r: R) => React.ReactNode;
  empty: string;
}) => (
  <div>
    <h4 className="mb-1 text-xs font-semibold text-ink-300">{title}</h4>
    {rows.length === 0 ? (
      <p className="text-xs text-ink-500">{empty}</p>
    ) : (
      <ul className="flex flex-col gap-0.5">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2 text-sm" title={r.unresolved.length ? `マスターに無い名前: ${r.unresolved.join("、")}` : undefined}>
            <span className="min-w-0 flex-1 truncate text-ink-100">{render(r)}</span>
            <span className="shrink-0 text-xs tabular-nums text-ink-400">×{r.amount}</span>
            {r.ok === null ? (
              <Badge className="shrink-0">{r.unresolved.length ? "照合不可" : "—"}</Badge>
            ) : (
              <Badge tone={r.ok ? "ok" : "danger"} className="shrink-0 tabular-nums">{r.ok ? `所持 ${r.owned}` : `不足 ${r.owned}/${r.amount}`}</Badge>
            )}
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
 * 任務タブ: 任務を選ぶと、開放に要る前提任務すべて (前提が先の順) と、経路で要る艦娘・装備 (所持/不足)、この任務で
 * 開放される任務を出す。達成状況・進捗は poi (プラグイン経由) の任務一覧と poi の進捗カウンタから。
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
  const player: Player = useMemo(
    () => ({ statuses: questStatuses(graph, poiQuests), visible: visibleQuests(poiQuests), records: poiQuests?.records ?? {} }),
    [graph, poiQuests]
  );
  const owned = useMemo(() => {
    const roster = rosterFromPoi(state);
    return roster ? new OwnershipIndex(roster) : null;
  }, [state]);

  const { list: filtered, counts } = useMemo(() => {
    const needle = normalizeForSearch(query);
    return filterQuests(
      quests ?? [],
      filter,
      (id) => player.statuses.get(id) ?? "unknown",
      needle ? (q) => normalizeForSearch(`${q.code ?? ""}${q.name ?? ""}${q.id}`).includes(needle) : undefined,
      !!poiQuests,
    );
  }, [quests, query, filter, player, poiQuests]);
  // 既定: 遂行中の任務、無ければ最初の任務
  const fallback = [...player.visible.values()].find((e) => e.state === 2)?.id ?? quests?.[0]?.id ?? null;
  const current = selected !== null && graph.byId.has(selected) ? selected : fallback;

  const tree = useMemo(() => (current === null ? null : resolvePrerequisites(graph, current)), [graph, current]);
  const needs = useMemo(() => {
    if (!tree) return null;
    const open = tree.order.filter((id) => !FINISHED.includes(player.statuses.get(id) ?? "unknown"));
    return aggregateNeeds(graph, open, owned);
  }, [graph, tree, player, owned]);
  // 前提の経路 (未達成・不明の前提とこの任務) で受け取る報酬
  const pathRewards = useMemo(() => {
    if (!tree || tree.order.length < 2) return null;
    const open = tree.order.filter((id) => id === current || !FINISHED.includes(player.statuses.get(id) ?? "unknown"));
    return open.length > 1 ? { total: sumRewards(open.map((id) => graph.byId.get(id)?.rewards)), quests: open.length } : null;
  }, [graph, tree, player, current]);

  if (res.error && !quests) return <DataError error={res.error} />;
  if (!quests) return <p className="text-sm text-ink-300">{S.common.loading}</p>;

  const q = current === null ? undefined : graph.byId.get(current);
  // 報酬は構造化して出すので、メモの「[獲]」以降は省く
  const memo = q?.memo && q.rewards ? q.memo.split("[獲]")[0]!.trim() : q?.memo;
  const status = current === null ? "unknown" : (player.statuses.get(current) ?? "unknown");
  const goals = current === null ? undefined : player.records[current];
  const progress = current === null ? null : progressText(player.visible.get(current), goals);
  const unlocks = current === null ? [] : (graph.unlocks.get(current) ?? []);
  const allAfter = current === null ? 0 : descendants(graph, current).length;
  const pending = tree ? tree.order.filter((id) => id !== current && !FINISHED.includes(player.statuses.get(id) ?? "unknown")).length : 0;

  const poiNote =
    !poiQuests
      ? poi.status === "connected"
        ? "プラグインが古く任務の状態が届きません"
        : "poi 未接続: 達成状況は表示されません"
      : poiQuests.list === null
        ? "任務画面 (全て) を開くと開放状況を推定します"
        : null;

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
        <QuestFilters filter={filter} counts={counts} showStatus={!!poiQuests} onChange={setFilter} />
        {poiNote && <p className="text-xs text-ink-400">{poiNote}</p>}
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
            <>
              <Badge title={`${FREQUENCY_LABEL[questFrequency(q.code)]}・${CATEGORY_LABEL[questCategory(q.code)]} (任務コードから)`}>{FREQUENCY_LABEL[questFrequency(q.code)]}</Badge>
              <Badge tone={STATUS[status].tone} title={STATUS[status].title}>{STATUS[status].label}</Badge>
            </>
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
              {q.requirements ? (
                <pre className="font-sans text-xs whitespace-pre-wrap text-ink-300">{describeRequirement(q.requirements).join("\n")}</pre>
              ) : (
                <p className="text-xs text-ink-500">構造化された達成条件なし (kcwiki-quest-data・手入力データに未収録)</p>
              )}
              <QuestRewardsView rewards={q.rewards} />
              {pathRewards && <RewardTotalLine total={pathRewards.total} quests={pathRewards.quests} />}
              {q.override && (
                <p className="text-xs text-ink-500">
                  {q.override.fields.filter((f) => ["requirements", "pre", "rewards"].includes(f)).map((f) => ({ requirements: "達成条件", pre: "前提", rewards: "報酬" })[f]).join("・") || "内容"}
                  は手入力{q.override.author === "llm" ? " (LLM 作成・未検証)" : ""}、参考:{" "}
                  <a href={q.override.source} target="_blank" rel="noreferrer" className="text-accent-400 underline">{sourceHost(q.override.source)}</a>
                  {q.override.note && ` — ${q.override.note}`}
                </p>
              )}
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
            <div className="flex min-h-0 flex-col">
              <h4 className="mb-1 text-xs font-semibold text-ink-300">
                前提任務 {tree.order.length - 1} 件{tree.order.length > 1 && poiQuests ? ` (未達成・不明 ${pending} 件)` : ""}
              </h4>
              {tree.order.length === 1 ? (
                <p className="text-xs text-ink-500">前提なし</p>
              ) : (
                <ul className="-mx-2 flex flex-col px-2" aria-label="前提任務">
                  {tree.order.map((id) => (
                    <QuestRow key={id} id={id} graph={graph} player={player} depth={tree.depth.get(id)} current={id === current} onSelect={select} />
                  ))}
                </ul>
              )}
              {(tree.cycleEdges.length > 0 || tree.missing.length > 0) && (
                <p className="mt-1 text-xs text-warn-400">
                  {tree.cycleEdges.length > 0 && `循環する前提 ${tree.cycleEdges.map(([a, b]) => `${label(graph.byId.get(a), a)} → ${label(graph.byId.get(b), b)}`).join("、")} を除外`}
                  {tree.missing.length > 0 && ` データに無い任務: ${tree.missing.map((m) => `#${m}`).join(", ")}`}
                </p>
              )}
            </div>
          </>
        )}
      </Card>

      <Card title="必要なもの" className="flex min-h-0 flex-col" bodyClassName="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
        {needs && (
          <>
            <p className="text-xs text-ink-400">
              前提を含む{poiQuests ? "未達成の" : ""}任務の条件から (kcwiki-quest-data・手入力データ)。{owned ? "" : "poi のデータが無いので所持は照合しません。"}
            </p>
            <NeedList
              title="艦娘"
              rows={needs.ships}
              empty="指定なし"
              render={(r) => `${r.names.join(" / ")}${r.consumed ? " (改修素材)" : ""}`}
            />
            <NeedList title="装備" rows={needs.equips} empty="指定なし" render={(r) => r.name} />
          </>
        )}
        <div>
          <h4 className="mb-1 text-xs font-semibold text-ink-300">
            この任務で開放 {unlocks.length} 件{allAfter > unlocks.length ? ` (後続すべて ${allAfter} 件)` : ""}
          </h4>
          {unlocks.length === 0 ? (
            <p className="text-xs text-ink-500">なし</p>
          ) : (
            <ul className="-mx-2 flex flex-col px-2" aria-label="開放される任務">
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
