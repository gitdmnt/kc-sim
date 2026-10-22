import React, { useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { NodeSummary, SortieSummary } from "@sim-core";
import { geometricSorties } from "../../sim/runner";
import { compSourceLabel } from "../../sim/sortieAdapter";
import { StackedBar, Tabs } from "../../ui";
import { MapGraph, NODE_COLOR, NODE_TYPE_LABEL, typeKey } from "../map/MapGraph";
import { Assumptions } from "./Assumptions";
import { DTable, DTr, Fact, Num, RateList, RateRow, Td, Th, pct, rankBar } from "./bars";
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

/**
 * 出撃あたりの主要率 (ボス到達 → 突破 → S 勝利、大破撤退) を同じ尺度の棒で上から並べる。
 * ボス到達の棒はボス戦の勝敗で塗り分け、突破・S 勝利はその一部分。大破撤退はノードごとの和 (1 出撃で撤退は 1 回)。
 */
export const SortieRates = ({ s }: { s?: SortieSummary }) => {
  const v = (x: number | undefined) => (x === undefined ? "—" : pct(x));
  const reach = s?.boss.reachRate ?? 0;
  const ranks = s ? rankBar(s.boss.rankRates, reach) : [];
  const heavy = s ? Object.values(s.nodes).reduce((t, n) => t + n.retreatHeavyRate, 0) : undefined;
  const moderate = s ? Object.values(s.nodes).reduce((t, n) => t + n.retreatModerateRate, 0) : 0;
  const sWin = ranks.slice(0, 2);
  return (
    <RateList>
      <RateRow label="ボス到達" parts={ranks} value={v(s?.boss.reachRate)} />
      <RateRow label="突破" title="ボスで A 勝利以上 (出撃あたり)" parts={ranks.slice(0, 3)} value={v(s?.boss.killRate)} />
      <RateRow label="S勝利" title="ボスで S 勝利以上 (出撃あたり)" parts={sWin} value={v(s && sWin.reduce((t, p) => t + p.value, 0))} />
      <RateRow
        label="大破撤退"
        title={moderate > 0.0005 ? `中破撤退 ${pct(moderate)}` : undefined}
        parts={[
          { label: "大破撤退", value: heavy ?? 0, color: "var(--color-hp-heavy)" },
          { label: "中破撤退", value: moderate, color: "var(--color-hp-moderate)" },
        ]}
        value={v(heavy)}
        tone={heavy !== undefined && heavy >= 0.1 ? "danger" : undefined}
      />
    </RateList>
  );
};

type Detail = "nodes" | "graph" | "ships" | "notes";

export const SortieResults = ({ out, meta }: { out: SortieOutcome; meta: React.ReactNode }) => {
  const { summary: s, data } = out;
  const [detail, setDetail] = useState<Detail>("nodes");
  const nodeInfo = useMemo(() => new Map(data.detail.nodes.map((n) => [n.letter, n])), [data]);
  const bossLetters = data.detail.nodes.filter((n) => n.isBoss).map((n) => n.letter);
  const edgeRates = useMemo(() => edgeRatesFromPaths(s.paths), [s]);
  const badges = useMemo(() => {
    const m = new Map<string, string>();
    for (const [l, n] of Object.entries(s.nodes)) if (n.reachRate > 0.0005) m.set(l, pct(n.reachRate, n.reachRate < 0.1 ? 1 : 0));
    return m;
  }, [s]);

  const clear = s.gauge ?? null;
  const sorties = clear ? { mean: clear.expectedSorties, p50: clear.p50Sorties, p90: clear.p90Sorties } : geometricSorties(s.boss.killRate);

  // 経路が不確実なルールを持つノードを通る割合 (そのルールが実際に発火したかまでは分からない)
  const uncertain = useMemo(() => {
    const through = new Map<string, number>();
    for (const p of s.paths) for (const l of new Set(p.path.slice(0, -1))) if (out.uncertain.has(l)) through.set(l, (through.get(l) ?? 0) + p.rate);
    return [...through.entries()].sort((a, b) => b[1] - a[1]);
  }, [s, out.uncertain]);

  const nodeRows = orderNodeRows(s.nodes, bossLetters);
  const anyNight = nodeRows.some(([, n]) => n.nightRate >= 0.0005);
  const maxRetreat = Math.max(0.0001, ...nodeRows.map(([, n]) => n.retreatHeavyRate));
  const anyDamecon = s.friend.some((f) => f.damecon.usedRate >= 0.0005);
  const notes = out.assumptions.warnings.length;

  return (
    <>
      <SortieRates s={s} />

      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <Fact
          label={clear ? `周回 (${clear.kind === "hp" ? "HP" : "撃破"}ゲージ)` : "周回"}
          value={num(sorties?.mean, 1)}
          sub={sorties ? `中央 ${sorties.p50} · 90% ${sorties.p90}` : undefined}
          title={clear ? `${clear.runs} 回試行` : "1 / 突破率 (幾何分布)"}
        />
        <Fact label="ボス旗艦撃沈" value={pct(s.boss.flagshipSunkRate)} title={`平均旗艦ダメージ ${num(s.boss.flagshipDamageMean)}`} />
        <Fact label="戦闘" value={num(s.battlesMean, 2)} title={`平均 ${num(s.nodesMean, 2)} マス`} />
        <Fact label="燃料 / 弾薬" value={`${num(s.fuelUsedMean, 0)} / ${num(s.ammoUsedMean, 0)}`} title="艦隊合計の平均 (出撃あたり)" />
        {s.sunkRate >= 0.0005 && <Fact label="味方撃沈" value={pct(s.sunkRate)} tone="danger" />}
        {uncertain.length > 0 && (
          <Fact
            icon={<TriangleAlert size={12} className="text-warn-400" aria-hidden />}
            label="不確実な分岐を通過"
            value={pct(uncertain[0][1])}
            title={uncertain.map(([l, r]) => `${l} ${pct(r)}`).join(", ")}
            tone="warn"
          />
        )}
        {clear && clear.cappedRate > 0 && <Fact label="上限到達" value={pct(clear.cappedRate)} tone="danger" />}
      </div>

      <div className="flex items-center justify-between gap-2">
        <Tabs
          variant="pill"
          size="sm"
          value={detail}
          onChange={setDetail}
          tabs={[
            { id: "nodes", label: "マス" },
            { id: "graph", label: "経路" },
            { id: "ships", label: "損耗" },
            { id: "notes", label: "前提", hint: notes ? String(notes) : undefined },
          ]}
        />
        {meta}
      </div>

      <div className="-mx-2 min-h-0 flex-1 overflow-auto px-2">
        {detail === "nodes" && (
          <DTable
            head={
              <>
                <Th className="w-12 text-left">マス</Th>
                <Th className="text-left" title="棒の長さ = 到達率、色 = そのマスでの勝敗">
                  到達・勝敗
                </Th>
                <Th className="w-16">到達</Th>
                {anyNight && <Th className="w-14">夜戦</Th>}
                <Th className="w-28" title="そのマスで大破撤退する割合 (出撃あたり)">
                  大破撤退
                </Th>
              </>
            }
          >
            {nodeRows.map(([l, n]) => {
              const info = nodeInfo.get(l);
              const type = info ? typeKey(info.type) : "unknown";
              return (
                <DTr key={l}>
                  <Td className="whitespace-nowrap" title={[NODE_TYPE_LABEL[type], out.compSets[l] && `敵編成: ${compSourceLabel(out.compSets[l])}`].filter(Boolean).join(" · ")}>
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: NODE_COLOR[type] }} aria-hidden />
                      <span className={info?.isBoss ? "font-semibold text-ink-50" : "text-ink-200"}>{l === "Start" ? "S" : l}</span>
                      {out.uncertain.has(l) && <TriangleAlert size={12} className="text-warn-400" aria-label="不確実な分岐" />}
                    </span>
                  </Td>
                  <Td>
                    <StackedBar
                      parts={n.battleRate > 0 ? rankBar(n.rankRates, n.reachRate * n.battleRate) : [{ label: "到達", value: n.reachRate, color: "var(--color-ink-600)" }]}
                    />
                  </Td>
                  <Num>{pct(n.reachRate)}</Num>
                  {anyNight && <Num>{n.battleRate > 0 ? pct(n.nightRate) : "—"}</Num>}
                  <Td>
                    <span className="flex items-center gap-2">
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full">
                        <span className="block h-full rounded-full bg-hp-heavy" style={{ width: `${(n.retreatHeavyRate / maxRetreat) * 100}%` }} />
                      </span>
                      <span className={n.retreatHeavyRate >= 0.0005 ? "w-12 text-right tabular-nums text-ink-100" : "w-12 text-right tabular-nums text-ink-500"}>{pct(n.retreatHeavyRate)}</span>
                    </span>
                  </Td>
                </DTr>
              );
            })}
          </DTable>
        )}

        {detail === "graph" && (
          <div className="flex flex-col gap-3">
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
                  <Th className="w-28" />
                  <Th className="w-16">割合</Th>
                </>
              }
            >
              {s.paths.slice(0, 20).map((p, i) => (
                <DTr key={i}>
                  <Td className="font-mono text-xs text-ink-200">{p.path.join(" ")}</Td>
                  <Td>
                    <StackedBar parts={[{ label: "割合", value: p.rate, color: "var(--color-ink-400)" }]} className="h-1.5" />
                  </Td>
                  <Num>{pct(p.rate, 1)}</Num>
                </DTr>
              ))}
              {s.otherPathsRate > 0.0005 && (
                <DTr>
                  <Td className="text-ink-400">その他</Td>
                  <Td />
                  <Num>{pct(s.otherPathsRate, 1)}</Num>
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
                <Th className="w-32 text-left" title="帰投時の状態 (撃沈・大破・中破)">
                  損傷
                </Th>
                <Th className="w-14">大破</Th>
                <Th className="w-14">撃沈</Th>
                <Th className="w-16" title="帰投時に減っている HP の平均">
                  修理HP
                </Th>
                {anyDamecon && <Th className="w-16">ダメコン</Th>}
              </>
            }
          >
            {s.friend.map((f, i) => (
              <DTr key={i}>
                <Td className="max-w-28 truncate text-ink-200" title={out.friendNames[i]}>
                  {out.friendNames[i]}
                </Td>
                <Td>
                  <StackedBar
                    parts={[
                      { label: "撃沈", value: f.sunkRate, color: "var(--color-hp-sunk)" },
                      { label: "大破", value: f.heavyRate, color: "var(--color-hp-heavy)" },
                      { label: "中破", value: f.moderateRate, color: "var(--color-hp-moderate)" },
                    ]}
                  />
                </Td>
                <Num>{pct(f.heavyRate)}</Num>
                <Num alert={f.sunkRate > 0.005}>{pct(f.sunkRate)}</Num>
                <Num>{f.hpMissingMean.toFixed(1)}</Num>
                {anyDamecon && <Num>{pct(f.damecon.usedRate)}</Num>}
              </DTr>
            ))}
          </DTable>
        )}

        {detail === "notes" && <Assumptions data={out.assumptions} />}
      </div>
    </>
  );
};

