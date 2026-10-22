import React from "react";
import type { ShipSummary, SimulationSummary } from "@sim-core";
import { Badge, Card, ProgressBar, Stat, Table, Td, Th, Thead, Tr } from "../../ui";
import { NumTd, RANKS, RANK_COLOR, RankLegend, STATE_PARTS, StackedBar, pct } from "./bars";

export interface FleetLine {
  name: string;
  isFlag?: boolean;
}

/** 勝敗判定: 結論 (S/A 勝利以上) を大きく、内訳と補助指標をその下に。`meta` は見出し右の実行情報。 */
export const RankCard = ({ summary, meta }: { summary: SimulationSummary; meta?: React.ReactNode }) => {
  const r = summary.rankRates;
  return (
    <Card title="勝敗判定" actions={meta} bodyClassName="flex flex-col gap-3">
      <div className="grid items-center gap-3 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="grid grid-cols-2 gap-2">
          <Stat size="lg" label="S勝利以上" value={pct(r.SS + r.S)} />
          <Stat size="lg" label="A勝利以上" value={pct(r.SS + r.S + r.A)} />
        </div>
        <div className="flex flex-col gap-2">
          <StackedBar parts={RANKS.map((k) => ({ label: k, value: r[k], color: RANK_COLOR[k] }))} height="h-6" />
          <RankLegend rates={r} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="B勝利以上" value={pct(r.SS + r.S + r.A + r.B)} />
        <Stat label="敵旗艦撃沈" value={pct(summary.enemyFlagshipSunkRate)} />
        <Stat label="味方に大破あり" value={pct(summary.friendHeavyAnyRate)} />
        <Stat label="味方に撃沈あり" value={pct(summary.friendSunkAnyRate)} />
      </div>
    </Card>
  );
};

export const ShipTable = ({
  title,
  lines,
  ships,
  showMvp,
}: {
  title: string;
  lines: FleetLine[];
  ships: ShipSummary[];
  showMvp?: boolean;
}) => (
  <Card title={title} bodyClassName="p-0">
    <Table className="rounded-none border-0">
      <Thead>
        <tr>
          <Th>艦</Th>
          <Th className="w-44">平均 残HP</Th>
          <Th className="w-56">終了時の状態</Th>
          <Th className="text-right">撃沈率</Th>
          <Th className="text-right">平均与ダメ</Th>
          {showMvp && <Th className="text-right">MVP率</Th>}
        </tr>
      </Thead>
      <tbody>
        {ships.map((s, i) => (
          <Tr key={i}>
            <Td>
              <span className="mr-1.5 text-xs text-ink-400">{i + 1}</span>
              {lines[i]?.name ?? `#${i + 1}`}
              {i === 0 && <Badge tone="neutral" className="ml-1.5">旗艦</Badge>}
            </Td>
            <Td>
              <div className="flex items-center gap-2">
                <ProgressBar value={s.hpMean} max={s.maxHp} className="flex-1" />
                <span className="w-20 text-right tabular-nums text-ink-200">
                  {s.hpMean.toFixed(1)}/{s.maxHp}
                </span>
              </div>
            </Td>
            <Td>
              <StackedBar parts={STATE_PARTS(s)} height="h-3.5" />
            </Td>
            <NumTd main alert={s.sunkRate > 0.005}>{pct(s.sunkRate)}</NumTd>
            <NumTd>{s.damageDealtMean.toFixed(1)}</NumTd>
            {showMvp && <NumTd>{pct(s.mvpRate)}</NumTd>}
          </Tr>
        ))}
      </tbody>
    </Table>
    <div className="flex flex-wrap gap-3 border-t border-ink-600 px-4 py-2 text-xs text-ink-300">
      {STATE_PARTS({ healthyRate: 1, lightRate: 1, moderateRate: 1, heavyRate: 1, sunkRate: 1 }).map((p) => (
        <span key={p.label} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} />
          {p.label}
        </span>
      ))}
    </div>
  </Card>
);
