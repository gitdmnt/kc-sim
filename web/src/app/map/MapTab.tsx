import React, { useEffect, useMemo, useRef, useState } from "react";
import { STORAGE_PREFIX } from "../../fleet";
import { getDataApi } from "../../data/api";
import { useMapNames } from "../../data/names";
import { useMapData, useMapList } from "../../data/useMapData";
import type { MapSummary } from "@shared/data/types";
import { RefreshCw, Route, Swords } from "lucide-react";
import { Button, Card, Select, S } from "../../ui";
import { useApp } from "../context";
import { useNav } from "../nav";
import { DataError, StaleBadge } from "../DataState";
import { CompsPanel } from "./CompsPanel";
import { MapGraph, NODE_COLOR, NODE_TYPE_LABEL, typeKey } from "./MapGraph";
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
  const names = useMapNames(detail.data);
  const md = detail.data;
  const d = md?.detail;

  const compNodes = useMemo(() => new Set(d?.enemyCompNodes ?? []), [d]);
  const views = useMemo(() => (selected && d ? routingViewsFor(d.routing, selected) : null), [d, selected]);
  const targets = useMemo(() => new Set(views?.views.flatMap((v) => v.targets) ?? []), [views]);
  const node = d?.nodes.find((n) => n.letter === selected);
  // ノード未選択のまま空の欄を出さない。ボス (敵編成ありを優先) → 先頭の敵編成ノード
  useEffect(() => {
    if (selected || !d || d.map.key !== mapKey) return;
    const pick = d.nodes.find((n) => n.isBoss && compNodes.has(n.letter)) ?? d.nodes.find((n) => compNodes.has(n.letter)) ?? d.nodes.find((n) => n.isBoss) ?? d.nodes.find((n) => n.type !== "start") ?? d.nodes[0];
    if (pick) setSelected(pick.letter);
  }, [d, mapKey, selected, compNodes]);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected && window.innerWidth < 1280) panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selected]);

  if (maps.error) return <DataError error={maps.error} onRetry={() => setTick((t) => t + 1)} />;
  if (maps.loading && !maps.data) return <p className="text-sm text-ink-300">{S.common.loading}</p>;

  return (
    <div className="grid grid-cols-1 gap-4 lg:h-full lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
      <Card
        className="flex min-h-0 flex-col"
        bodyClassName="min-h-0 flex-1"
        title={
          <span className="flex flex-wrap items-center gap-2">
            <Select
              className="w-52"
              aria-label="ワールド"
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
            <Select className="w-60" aria-label="マップ" title={d?.map.opetext || undefined} value={mapKey ?? ""} onChange={(e) => pickMap(e.target.value)}>
              {list
                .filter((m) => m.world === world)
                .map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.name && m.name !== m.key ? `${m.key} ${m.name}` : m.key}
                  </option>
                ))}
            </Select>
          </span>
        }
        actions={
          <>
            {(maps.stale || detail.stale || md?.source === "bundle" || maps.data?.source === "bundle") && <StaleBadge />}
            <Button
              size="sm"
              variant="ghost"
              icon
              onClick={() => {
                getDataApi().clearCache();
                setTick((t) => t + 1);
              }}
              title="再読み込み"
              aria-label="再読み込み"
            >
              <RefreshCw size={14} aria-hidden />
            </Button>
          </>
        }
      >
        {detail.error ? (
          <DataError error={detail.error} onRetry={() => setTick((t) => t + 1)} />
        ) : !d ? (
          <p className="text-sm text-ink-300">{S.common.loading}</p>
        ) : (
          <MapGraph nodes={d.nodes} edges={d.edges} selected={selected} onSelect={setSelected} targets={targets} withComps={compNodes} fill />
        )}
      </Card>

      {d && node && (
        <div ref={panelRef} className="min-h-0 min-w-0">
          <Card
            className="flex h-full min-h-0 flex-col"
            bodyClassName="flex min-h-0 flex-1 flex-col gap-6 overflow-auto"
            title={
              <span className="flex items-baseline gap-2">
                <span className="inline-block h-2.5 w-2.5 self-center rounded-full" style={{ background: NODE_COLOR[typeKey(node.type)] }} aria-hidden />
                {node.letter}
                <span className="text-sm font-normal text-ink-400">{NODE_TYPE_LABEL[typeKey(node.type)]}</span>
              </span>
            }
            actions={
              <>
                {compNodes.has(node.letter) && (
                  <Button size="sm" variant="primary" onClick={() => nav.go({ view: "sortie", mode: "battle", map: d.map.key, node: node.letter })}>
                    <Swords size={14} aria-hidden />
                    戦闘シミュ
                  </Button>
                )}
                {d.routing && (
                  <Button size="sm" onClick={() => nav.go({ view: "sortie", mode: "sortie", map: d.map.key })}>
                    <Route size={14} aria-hidden />
                    出撃シミュ
                  </Button>
                )}
              </>
            }
          >
            <RoutingPanel doc={d.routing} letter={node.letter} views={views} />
            {compNodes.has(node.letter) ? (
              <CompsPanel sets={md!.comps[node.letter] ?? []} selection={md!.compSelection[node.letter]} names={names} />
            ) : (
              <p className="text-sm text-ink-400">編成なし</p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
};
