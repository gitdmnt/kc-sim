import React, { useMemo, useState } from "react";
import type { NodeSummary, SortieSummary } from "@sim-core";
import { geometricSorties } from "../../sim/runner";
import { compSourceLabel } from "../../sim/sortieAdapter";
import { Badge, Tabs } from "../../ui";
import { MapGraph } from "../map/MapGraph";
import { Assumptions } from "./Assumptions";
import { DTable, DTr, Kpi, Mini, Num, RankLegend, StackedBar, Td, Th, pct, rankBar } from "./bars";
import type { SortieOutcome } from "./requests";

const num = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "—" : v.toFixed(d));

/** 上位経路から辺ごとの通過率を集計する (上位に入らなかった経路の分だけ過小評価)。 */
export const edgeRatesFromPaths = (paths: { path: string[]; rate: number }[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const p of paths) {
    for (let i = 0; i + 1 < p.path.length; i++) {
      const k = `${p.path[i]}>${p.path[i + 1]}`;
      m.set(k, (m.get(k) ?? 0) + p.rate);
    }
  }
  return m;
};

/** 出撃あたりの主要率。大破撤退はノードごとの大破撤退率の和 (1 出撃で撤退は 1 回)。 */
const sortieRates = (s: SortieSummary) => {
  const nodes = Object.values(s.nodes);
  return {
    clear: s.boss.killRate,
    reach: s.boss.reachRate,
    sWin: s.boss.reachRate * (s.boss.rankRates.SS + s.boss.rankRates.S),
    heavy: nodes.reduce((t, n) => t + n.retreatHeavyRate, 0),
    moderate: nodes.reduce((t, n) => t + n.retreatModerateRate, 0),
  };
};

const NO_VISIT: NodeSummary = {
  reachRate: 0,
  battleRate: 0,
  rankRates: { SS: 0, S: 0, A: 0, B: 0, C: 0, D: 0, E: 0 },
  retreatRate: 0,
  retreatHeavyRate: 0,
  retreatModerateRate: 0,
  nightRate: 0,
};

/** ノード表の行: 出撃地点 (Start*) を先頭に、以降は到達率の高い順。到達 0% はボスだけ残す。 */
export const orderNodeRows = (nodes: Record<string, NodeSummary>, bosses: string[]): [string, NodeSummary][] => {
  const rows = new Map(Object.entries(nodes).filter(([, n]) => n.reachRate > 0));
  for (const b of bosses) if (!rows.has(b)) rows.set(b, nodes[b] ?? NO_VISIT);
  const start = (l: string) => (l.startsWith("Start") ? 0 : 1);
  return [...rows].sort((a, b) => start(a[0]) - start(b[0]) || b[1].reachRate - a[1].reachRate);
};

/** 結果がまだ無いときの主要指標の枠 */
export const SortieKpis = ({ s }: { s?: SortieSummary }) => {
  const r = s && sortieRates(s);
  const v = (x: number | undefined) => (x === undefined ? "—" : pct(x));
  return (
    <div className="grid grid-cols-2 gap-1.5">
      <Kpi label="突破" value={v(r?.clear)} title="ボスで A 勝利以上 (出撃あたり)" />
      <Kpi label="ボス到達" value={v(r?.reach)} />
      <Kpi label="S勝利" value={v(r?.sWin)} title="ボスで S 勝利以上 (出撃あたり)" />
      <Kpi label="大破撤退" value={v(r?.heavy)} sub={r && r.moderate > 0.0005 ? `中破 ${pct(r.moderate)}` : undefined} />
    </div>
  );
};

type Detail = "nodes" | "graph" | "ships" | "notes";

export const SortieResults = ({ out, meta }: { out: SortieOutcome; meta: React.ReactNode }) => {
  const { summary: s, data } = out;
  const [detail, setDetail] = useState<Detail>("nodes");
  const bossLetters = data.detail.nodes.filter((n) => n.isBoss).map((n) => n.letter);
  const edgeRates = useMemo(() => edgeRatesFromPaths(s.paths), [s]);
  const badges = useMemo(() => {
    const m = new Map<string, string>();
    for (const [l, n] of Object.entries(s.nodes)) if (n.reachRate > 0.0005) m.set(l, pct(n.reachRate, n.reachRate < 0.1 ? 1 : 0));
    return m;
  }, [s]);

  const clear = s.gauge ?? null;
  const geo = geometricSorties(s.boss.killRate);
  const sorties = clear ? { mean: clear.expectedSorties, p50: clear.p50Sorties, p90: clear.p90Sorties } : geo;

  // 経路が不確実なルールを持つノードを通る割合 (そのルールが実際に発火したかまでは分からない)
  const uncertain = useMemo(() => {
    const through = new Map<string, number>();
    for (const p of s.paths) for (const l of new Set(p.path.slice(0, -1))) if (out.uncertain.has(l)) through.set(l, (through.get(l) ?? 0) + p.rate);
    return [...through.entries()].sort((a, b) => b[1] - a[1]);
  }, [s, out.uncertain]);

  const nodeRows = orderNodeRows(s.nodes, bossLetters);
  const notes = out.assumptions.warnings.length;

  return (
    <>
      <SortieKpis s={s} />
      <div className="flex flex-col gap-1">
        <StackedBar parts={rankBar(s.boss.rankRates)} height="h-3" />
        <RankLegend rates={s.boss.rankRates} />
      </div>
      <div className="grid grid-cols-4 gap-x-2 gap-y-1">
        <Mini label="ボス旗艦撃沈" value={pct(s.boss.flagshipSunkRate)} title={`平均旗艦ダメージ ${num(s.boss.flagshipDamageMean)}`} />
        <Mini label="味方撃沈" value={pct(s.sunkRate)} alert={s.sunkRate > 0.005} />
        <Mini label="戦闘数" value={num(s.battlesMean, 2)} title={`平均 ${num(s.nodesMean, 2)} ノード`} />
        <Mini label="燃料/弾薬" value={`${num(s.fuelUsedMean, 0)}/${num(s.ammoUsedMean, 0)}`} title="艦隊合計の平均 (出撃あたり)" />
        <Mini
          label={clear ? `周回 (${clear.kind === "hp" ? "HP" : "撃破"}ゲージ)` : "周回 (目安)"}
          value={num(sorties?.mean, 1)}
          title={clear ? `${clear.runs} 回試行` : "1 / 突破率"}
        />
        <Mini label="中央値" value={sorties ? String(sorties.p50) : "—"} />
        <Mini label="90%点" value={sorties ? String(sorties.p90) : "—"} />
        {uncertain.length > 0 ? (
          <Mini
            label="不確実ルート"
            value={pct(uncertain.reduce((t, [, r]) => Math.max(t, r), 0))}
            title={uncertain.map(([l, r]) => `${l} ${pct(r)}`).join(", ")}
          />
        ) : clear && clear.cappedRate > 0 ? (
          <Mini label="上限到達" value={pct(clear.cappedRate)} alert />
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2">
        <Tabs
          variant="pill"
          size="sm"
          value={detail}
          onChange={setDetail}
          tabs={[
            { id: "nodes", label: "ノード" },
            { id: "graph", label: "経路" },
            { id: "ships", label: "損耗" },
            { id: "notes", label: notes ? `前提 ${notes}` : "前提" },
          ]}
        />
        {meta}
      </div>

      <div className="-mx-1 min-h-0 flex-1 overflow-auto px-1">
        {detail === "nodes" && (
          <DTable
            head={
              <>
                <Th className="text-left">ノード</Th>
                <Th>到達</Th>
                <Th className="w-[38%] text-left">勝敗</Th>
                <Th>夜戦</Th>
                <Th>大破撤退</Th>
              </>
            }
          >
            {nodeRows.map(([l, n]) => (
              <DTr key={l}>
                <Td
                  className="font-medium whitespace-nowrap"
                  title={out.compSets[l] ? `敵編成: ${compSourceLabel(out.compSets[l])}` : undefined}
                >
                  {l}
                  {bossLetters.includes(l) && <Badge tone="danger" className="ml-1">ボス</Badge>}
                  {out.uncertain.has(l) && <Badge tone="warn" className="ml-1" title="不確実なルーティングルール">?</Badge>}
                </Td>
                <Num main>{pct(n.reachRate)}</Num>
                <Td>{n.battleRate > 0 ? <StackedBar parts={rankBar(n.rankRates)} height="h-2.5" /> : <span className="text-ink-500">—</span>}</Td>
                <Num>{n.battleRate > 0 ? pct(n.nightRate) : "—"}</Num>
                <Num alert={n.retreatHeavyRate > 0.01}>{pct(n.retreatHeavyRate)}</Num>
              </DTr>
            ))}
          </DTable>
        )}

        {detail === "graph" && (
          <div className="flex flex-col gap-2">
            <MapGraph
              nodes={data.detail.nodes}
              edges={data.detail.edges}
              selected={null}
              onSelect={() => {}}
              targets={new Set()}
              withComps={new Set()}
              edgeRates={edgeRates}
              nodeBadges={badges}
            />
            <DTable
              head={
                <>
                  <Th className="text-left">経路</Th>
                  <Th>割合</Th>
                </>
              }
            >
              {s.paths.slice(0, 20).map((p, i) => (
                <DTr key={i}>
                  <Td className="font-mono">{p.path.join("→")}</Td>
                  <Num main>{pct(p.rate, 2)}</Num>
                </DTr>
              ))}
              {s.otherPathsRate > 0.0005 && (
                <DTr>
                  <Td className="text-ink-400">その他</Td>
                  <Num>{pct(s.otherPathsRate, 2)}</Num>
                </DTr>
              )}
            </DTable>
          </div>
        )}

        {detail === "ships" && (
          <DTable
            head={
              <>
                <Th className="text-left">艦</Th>
                <Th>大破</Th>
                <Th>中破</Th>
                <Th>撃沈</Th>
                <Th>受ダメ</Th>
                <Th>修理HP</Th>
                <Th>燃料</Th>
                <Th>弾薬</Th>
                <Th>ダメコン</Th>
              </>
            }
          >
            {s.friend.map((f, i) => (
              <DTr key={i}>
                <Td className="max-w-24 truncate" title={out.friendNames[i]}>
                  {out.friendNames[i]}
                </Td>
                <Num main>{pct(f.heavyRate)}</Num>
                <Num>{pct(f.moderateRate)}</Num>
                <Num alert={f.sunkRate > 0.005}>{pct(f.sunkRate)}</Num>
                <Num>{f.damageTakenMean.toFixed(1)}</Num>
                <Num>{f.hpMissingMean.toFixed(1)}</Num>
                <Num>{f.fuelUsedMean.toFixed(1)}</Num>
                <Num>{f.ammoUsedMean.toFixed(1)}</Num>
                <Num>{pct(f.damecon.usedRate)}</Num>
              </DTr>
            ))}
          </DTable>
        )}

        {detail === "notes" && <Assumptions data={out.assumptions} />}
      </div>
    </>
  );
};
