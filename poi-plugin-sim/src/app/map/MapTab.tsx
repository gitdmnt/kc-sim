import React, { useEffect, useMemo, useRef, useState } from "react";
import { STORAGE_PREFIX } from "../../fleet";
import { getDataApi } from "../../data/api";
import { useAbyssalData } from "../../data/names";
import { useMapData, useMapList } from "../../data/useMapData";
import { countUncertain } from "../../data/routing";
import type { MapSummary } from "../../data/types";
import { Badge, Button, Card, EmptyState, Field, Select, S } from "../../ui";
import { useApp } from "../context";
import { useNav } from "../nav";
import { BundleBanner, DataError, StaleBadge } from "../DataState";
import { CompsPanel } from "./CompsPanel";
import { MapGraph, NODE_TYPE_LABEL, typeKey } from "./MapGraph";
import { RoutingPanel, routingViewsFor } from "./RoutingPanel";

const KEY = `${STORAGE_PREFIX}map`;

export const MapTab = () => {
  const { state } = useApp();
  const nav = useNav();
  const [tick, setTick] = useState(0);
  const maps = useMapList(tick);
  const [world, setWorld] = useState<number | null>(null);
  const [mapKey, setMapKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const list: MapSummary[] = maps.data?.maps ?? [];
  const worlds = useMemo(() => [...new Set(list.map((m) => m.world))].sort((a, b) => a - b), [list]);
  const worldName = (w: number) => {
    const n = state?.const?.$mapareas?.[w]?.api_name;
    return `${w}${n ? ` ${n}` : ""}${list.find((m) => m.world === w)?.isEvent ? " (イベント)" : ""}`;
  };

  // 初期選択 (前回の選択を復元、なければ 1-5 → 先頭)
  useEffect(() => {
    if (list.length === 0 || mapKey) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      // ignore
    }
    const m = list.find((x) => x.key === saved) ?? list.find((x) => x.key === "1-5") ?? list[0];
    setWorld(m.world);
    setMapKey(m.key);
  }, [list, mapKey]);

  const pickMap = (key: string) => {
    setMapKey(key);
    setSelected(null);
    try {
      localStorage.setItem(KEY, key);
    } catch {
      // ignore
    }
  };

  const detail = useMapData(mapKey, tick);
  const names = useAbyssalData(detail.data);
  const summary = list.find((m) => m.key === mapKey);
  const md = detail.data;
  const d = md?.detail;

  const compNodes = useMemo(() => new Set(d?.enemyCompNodes ?? []), [d]);
  const views = useMemo(() => (selected && d ? routingViewsFor(d.routing, selected) : null), [d, selected]);
  const targets = useMemo(() => new Set(views?.views.flatMap((v) => v.targets) ?? []), [views]);
  const node = d?.nodes.find((n) => n.letter === selected);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected && window.innerWidth < 1280) panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selected]);

  if (maps.error) return <DataError error={maps.error} onRetry={() => setTick((t) => t + 1)} />;
  if (maps.loading && !maps.data) return <p className="text-sm text-ink-300">{S.common.loading}</p>;

  return (
    <div className="flex flex-col gap-4">
      <Card
        bodyClassName="flex flex-wrap items-end gap-3"
        actions={
          <>
            {(maps.stale || detail.stale) && <StaleBadge />}
            <Button size="sm" onClick={() => { getDataApi().clearCache(); setTick((t) => t + 1); }} title="再読み込み">
              ↻
            </Button>
          </>
        }
        title="海域選択"
      >
        <Field label="ワールド" className="w-64">
          <Select
            value={world ?? ""}
            onChange={(e) => {
              const w = Number(e.target.value);
              setWorld(w);
              const first = list.find((m) => m.world === w);
              if (first) pickMap(first.key);
            }}
          >
            {worlds.map((w) => (
              <option key={w} value={w}>
                {worldName(w)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="マップ" className="w-72">
          <Select value={mapKey ?? ""} onChange={(e) => pickMap(e.target.value)}>
            {list
              .filter((m) => m.world === world)
              .map((m) => (
                <option key={m.key} value={m.key}>
                  {m.key} {m.name}
                </option>
              ))}
          </Select>
        </Field>
        {summary && (
          <div className="flex flex-wrap items-center gap-1.5 pb-1">
            <Badge tone="neutral">ノード {summary.approx && d ? d.nodes.length : summary.nodeCount}</Badge>
            <Badge tone="neutral">経路 {summary.approx && d ? d.edges.length : summary.edgeCount}</Badge>
            <Badge tone={summary.compSetCount > 0 ? "ok" : "neutral"}>敵編成セット {summary.compSetCount}</Badge>
            {summary.approx ? null : summary.routing ? (
              <>
                <Badge tone="accent">ルール {summary.routing.ruleCount}</Badge>
                <Badge tone={summary.routing.uncertainCount > 0 ? "warn" : "ok"}>不確実 {summary.routing.uncertainCount}</Badge>
              </>
            ) : (
              <Badge tone="danger">ルーティング未登録</Badge>
            )}
          </div>
        )}
      </Card>

      {(md?.source === "bundle" || maps.data?.source === "bundle") && <BundleBanner generatedAt={md?.generatedAt} />}
      {detail.error ? (
        <DataError error={detail.error} onRetry={() => setTick((t) => t + 1)} />
      ) : !d ? (
        <p className="text-sm text-ink-300">{S.common.loading}</p>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <Card title={`${d.map.key} ${d.map.name}`} bodyClassName="flex flex-col gap-3">
            {d.map.opetext && <p className="text-xs text-ink-300">{d.map.opetext}</p>}
            <MapGraph nodes={d.nodes} edges={d.edges} selected={selected} onSelect={setSelected} targets={targets} withComps={compNodes} />
          </Card>

          <div ref={panelRef} className="scroll-mt-4 min-w-0">
          {node ? (
            <Card
              title={
                <span className="flex items-center gap-2">
                  ノード {node.letter}
                  <Badge tone={node.isBoss ? "danger" : "neutral"}>{NODE_TYPE_LABEL[typeKey(node.type)]}</Badge>
                </span>
              }
              actions={
                <>
                  {compNodes.has(node.letter) && (
                    <Button size="sm" variant="primary" onClick={() => nav.go({ tab: "sim", mode: "battle", map: d.map.key, node: node.letter })}>
                      このノードでシミュレーション
                    </Button>
                  )}
                  {d.routing && (
                    <Button size="sm" onClick={() => nav.go({ tab: "sim", mode: "sortie", map: d.map.key })}>
                      この海域を出撃シミュ
                    </Button>
                  )}
                </>
              }
              bodyClassName="flex flex-col gap-4"
            >
              <section>
                <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold text-ink-300">
                  ルーティング
                  {views && countUncertain(views.views) > 0 && <Badge tone="warn">不確実 {countUncertain(views.views)}</Badge>}
                </h4>
                <RoutingPanel doc={d.routing} letter={node.letter} views={views} />
              </section>
              <section>
                <h4 className="mb-2 text-xs font-semibold text-ink-300">敵編成</h4>
                {compNodes.has(node.letter) ? (
                  <CompsPanel sets={md!.comps[node.letter] ?? []} selection={md!.compSelection[node.letter]} names={names} />
                ) : (
                  <p className="text-xs text-ink-400">このノードの敵編成データはありません。</p>
                )}
              </section>
            </Card>
          ) : (
            <EmptyState title="ノードを選択" description="マップ上のノードをクリックすると、ルーティングルールと敵編成を表示します。" className="py-16" />
          )}
          </div>
        </div>
      )}
    </div>
  );
};
