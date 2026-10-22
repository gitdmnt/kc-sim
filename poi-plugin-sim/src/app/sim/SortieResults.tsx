import React, { useMemo } from "react";
import type { SortieSummary } from "@sim-core";
import { geometricSorties } from "../../sim/runner";
import { compSourceLabel } from "../../sim/sortieAdapter";
import { Badge, Card, ProgressBar, Stat, Table, Td, Th, Thead, Tr, cx } from "../../ui";
import { MapGraph } from "../map/MapGraph";
import type { MapData } from "../../data/mapData";
import type { EnemyCompSet } from "../../data/types";
import { RANKS, RANK_COLOR, StackedBar, pct } from "./bars";

export interface SortieRunMeta {
  data: MapData;
  summary: SortieSummary;
  friendNames: string[];
  warnings: string[];
  uncertain: Set<string>;
  /** ノード → 使った編成セット (出典バッジ用) */
  compSets: Record<string, EnemyCompSet>;
  ms: number;
  seed: number;
}

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

export const SortieResults = ({ run }: { run: SortieRunMeta }) => {
  const { summary: s, data } = run;
  const bossNode = data.detail.nodes.find((n) => n.isBoss)?.letter;
  const edgeRates = useMemo(() => edgeRatesFromPaths(s.paths), [s]);
  const badges = useMemo(() => {
    const m = new Map<string, string>();
    for (const [l, n] of Object.entries(s.nodes)) if (n.reachRate > 0.0005) m.set(l, pct(n.reachRate, n.reachRate < 0.1 ? 1 : 0));
    return m;
  }, [s]);

  const clear = s.gauge ?? null;
  const geo = geometricSorties(s.boss.killRate);
  const sorties = clear ? { mean: clear.expectedSorties, p50: clear.p50Sorties, p90: clear.p90Sorties } : geo ? { mean: geo.mean, p50: geo.p50, p90: geo.p90 } : null;

  // 経路が不確実なルールを持つノードを通る割合 (そのルールが実際に発火したかまでは分からない)
  const uncertainShare = useMemo(() => {
    const through = new Map<string, number>();
    for (const p of s.paths) for (const l of new Set(p.path.slice(0, -1))) if (run.uncertain.has(l)) through.set(l, (through.get(l) ?? 0) + p.rate);
    return [...through.entries()].sort((a, b) => b[1] - a[1]);
  }, [s, run.uncertain]);

  const nodeRows = Object.entries(s.nodes)
    .filter(([, n]) => n.reachRate > 0)
    .sort((a, b) => b[1].reachRate - a[1].reachRate);

  return (
    <div className="flex flex-col gap-4">
      <div className="text-xs text-ink-300">
        {s.count.toLocaleString()} 出撃 / seed {run.seed} / {(run.ms / 1000).toFixed(2)} 秒 / データ: {data.source === "api" ? "API" : "静的バンドル"}
        {data.stale && " (キャッシュ)"}
      </div>

      {uncertainShare.length > 0 && (
        <div className="rounded-md border border-warn-600/50 bg-warn-600/10 px-3 py-2 text-xs text-warn-400">
          <b>ルーティングの不確実性:</b> 不確実と注記されたルールを持つノードを通る出撃があります —{" "}
          {uncertainShare.map(([l, r]) => `${l} (${pct(r)})`).join(", ")}。到達率・経路はこの仮定に依存します。
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        <Stat label="ボス到達率" value={pct(s.boss.reachRate)} sub={bossNode ? `ノード ${bossNode}` : undefined} />
        <Stat label="ボスA勝利以上 (出撃あたり)" value={pct(s.boss.killRate)} sub="撃破の目安" />
        <Stat label="ボス旗艦撃沈 (出撃あたり)" value={pct(s.boss.flagshipSunkRate)} sub="別集計" />
        <Stat label="出撃あたりの撤退" value={pct(s.retreatRate)} />
        <Stat label="味方に撃沈あり" value={pct(s.sunkRate)} />
        <Stat label="平均戦闘数" value={num(s.battlesMean, 2)} sub={`平均 ${num(s.nodesMean, 2)} ノード`} />
        <Stat label="燃料/出撃" value={num(s.fuelUsedMean, 1)} sub="艦隊合計の平均" />
        <Stat label="弾薬/出撃" value={num(s.ammoUsedMean, 1)} sub="艦隊合計の平均" />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Card title="経路と到達率" bodyClassName="flex flex-col gap-2">
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
          <p className="text-[11px] text-ink-400">辺の太さ・％ = 通過率 (上位 {s.paths.length} 経路から集計{s.otherPathsRate > 0.0005 ? `、その他 ${pct(s.otherPathsRate)}` : ""})。ノード下のラベル = 到達率。</p>
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="ボス戦の勝敗判定" bodyClassName="flex flex-col gap-2">
            <StackedBar parts={RANKS.map((k) => ({ label: k, value: s.boss.rankRates[k], color: RANK_COLOR[k] }))} height="h-8" />
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
              {RANKS.map((k) => (
                <span key={k} className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: RANK_COLOR[k] }} />
                  {k} <span className="tabular-nums">{pct(s.boss.rankRates[k], 2)}</span>
                </span>
              ))}
            </div>
            <p className="text-[11px] text-ink-400">ボス戦が発生した出撃に限った分布。平均ボス旗艦ダメージ {num(s.boss.flagshipDamageMean, 1)}。</p>
          </Card>

          <Card
            title="クリアまでの出撃回数"
            actions={<Badge tone={clear ? "accent" : "neutral"}>{clear ? `${clear.kind === "hp" ? "HP" : "撃破数"}ゲージ (${clear.runs} 回)` : "簡易 (幾何分布)"}</Badge>}
            bodyClassName="grid grid-cols-3 gap-2"
          >
            <Stat label="平均" value={num(sorties?.mean, 1)} />
            <Stat label="中央値" value={sorties?.p50 ?? "—"} />
            <Stat label="90%点" value={sorties?.p90 ?? "—"} />
            {clear && clear.cappedRate > 0 && <div className="col-span-3 text-[11px] text-warn-400">上限回数に達した試行 {pct(clear.cappedRate)}</div>}
            {!clear && <div className="col-span-3 text-[11px] text-ink-400">ゲージ未指定のため、ボスA勝利以上の確率 p から 1/p などで見積もった目安です。</div>}
          </Card>
        </div>
      </div>

      <Card title="ノード別 (到達・撤退)" bodyClassName="p-0">
        <Table className="rounded-none border-0">
          <Thead>
            <tr>
              <Th>ノード</Th>
              <Th className="text-right">到達率</Th>
              <Th className="text-right">戦闘率</Th>
              <Th className="w-56">勝敗 (戦闘した場合)</Th>
              <Th className="text-right">夜戦率</Th>
              <Th className="text-right">大破撤退</Th>
              <Th className="text-right">中破撤退</Th>
              <Th className="text-right">撤退計</Th>
            </tr>
          </Thead>
          <tbody>
            {nodeRows.map(([l, n]) => (
              <Tr key={l}>
                <Td className="font-medium">
                  {l}
                  {l === bossNode && <Badge tone="danger" className="ml-1.5">ボス</Badge>}
                  {run.uncertain.has(l) && <Badge tone="warn" className="ml-1.5" title="不確実なルーティングルールあり">不確実</Badge>}
                  {run.compSets[l] && (
                    <Badge tone={run.compSets[l].source === "poi-observed" ? "ok" : "neutral"} className="ml-1.5" title="敵編成データの出典">
                      {compSourceLabel(run.compSets[l])}
                    </Badge>
                  )}
                </Td>
                <Td className="text-right tabular-nums">{pct(n.reachRate)}</Td>
                <Td className="text-right tabular-nums">{pct(n.battleRate)}</Td>
                <Td>{n.battleRate > 0 ? <StackedBar parts={RANKS.map((k) => ({ label: k, value: n.rankRates[k], color: RANK_COLOR[k] }))} height="h-3.5" /> : <span className="text-ink-400">—</span>}</Td>
                <Td className="text-right tabular-nums">{n.battleRate > 0 ? pct(n.nightRate) : "—"}</Td>
                <Td className={cx("text-right tabular-nums", n.retreatHeavyRate > 0.01 && "text-danger-400")}>{pct(n.retreatHeavyRate)}</Td>
                <Td className="text-right tabular-nums">{pct(n.retreatModerateRate)}</Td>
                <Td className="text-right tabular-nums">{pct(n.retreatRate)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-2">
        <Card title="主な経路" bodyClassName="p-0">
          <Table className="max-h-96 rounded-none border-0">
            <Thead>
              <tr>
                <Th>経路</Th>
                <Th className="w-40 text-right">割合</Th>
              </tr>
            </Thead>
            <tbody>
              {s.paths.slice(0, 20).map((p, i) => (
                <Tr key={i}>
                  <Td className="font-mono text-xs">{p.path.join(" → ")}</Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <ProgressBar value={p.rate} max={1} tone="accent" className="flex-1" />
                      <span className="w-14 text-right text-xs tabular-nums">{pct(p.rate, 2)}</span>
                    </div>
                  </Td>
                </Tr>
              ))}
              {s.otherPathsRate > 0.0005 && (
                <Tr>
                  <Td className="text-xs text-ink-400">その他</Td>
                  <Td className="text-right text-xs tabular-nums text-ink-300">{pct(s.otherPathsRate, 2)}</Td>
                </Tr>
              )}
            </tbody>
          </Table>
        </Card>

        <Card title="艦ごとの損耗 (1 出撃あたり)" bodyClassName="p-0">
          <Table className="rounded-none border-0">
            <Thead>
              <tr>
                <Th>艦</Th>
                <Th className="text-right">大破</Th>
                <Th className="text-right">中破</Th>
                <Th className="text-right">撃沈</Th>
                <Th className="text-right">受ダメ</Th>
                <Th className="text-right">要修理HP</Th>
                <Th className="text-right">燃料</Th>
                <Th className="text-right">弾薬</Th>
                <Th className="text-right">ダメコン</Th>
              </tr>
            </Thead>
            <tbody>
              {s.friend.map((f, i) => (
                <Tr key={i}>
                  <Td>
                    <span className="mr-1.5 text-[11px] text-ink-400">{i + 1}</span>
                    {run.friendNames[i]}
                  </Td>
                  <Td className="text-right tabular-nums">{pct(f.heavyRate)}</Td>
                  <Td className="text-right tabular-nums">{pct(f.moderateRate)}</Td>
                  <Td className={cx("text-right tabular-nums", f.sunkRate > 0.005 && "text-danger-400")}>{pct(f.sunkRate)}</Td>
                  <Td className="text-right tabular-nums">{f.damageTakenMean.toFixed(1)}</Td>
                  <Td className="text-right tabular-nums">{f.hpMissingMean.toFixed(1)}</Td>
                  <Td className="text-right tabular-nums">{f.fuelUsedMean.toFixed(1)}</Td>
                  <Td className="text-right tabular-nums">{f.ammoUsedMean.toFixed(1)}</Td>
                  <Td className="text-right tabular-nums">{pct(f.damecon.usedRate)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      <Card title={`警告・前提 (${run.warnings.length + s.warnings.length})`} bodyClassName="text-xs text-ink-200">
        <ul className="list-inside list-disc">
          {[...new Set([...s.warnings, ...run.warnings])].map((w, i) => (
            <li key={i}>{w}</li>
          ))}
          <li>通常艦隊のみ。連合艦隊・基地航空隊・支援・資源/渦潮などのノード効果は未対応 (SIM_INTERFACE.md)。</li>
          <li>敵の隠しステータスは推定値を使用 (戦闘シミュレーションタブの信頼性パネル参照)。</li>
        </ul>
      </Card>
    </div>
  );
};
