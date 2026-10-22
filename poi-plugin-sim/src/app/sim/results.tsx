import React from "react";
import type { ShipSummary, SimulationSummary } from "@sim-core";
import { Badge, Card, ProgressBar, Stat, Table, Td, Th, Thead, Tr, cx } from "../../ui";
import { RANKS, RANK_COLOR, STATE_PARTS, StackedBar, pct } from "./bars";

export interface FleetLine {
  name: string;
  isFlag?: boolean;
}

export const RankCard = ({ summary }: { summary: SimulationSummary }) => {
  const r = summary.rankRates;
  return (
    <Card title={`勝敗判定 (${summary.count.toLocaleString()} 戦)`} bodyClassName="flex flex-col gap-3">
      <StackedBar parts={RANKS.map((k) => ({ label: k, value: r[k], color: RANK_COLOR[k] }))} height="h-9" />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {RANKS.map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: RANK_COLOR[k] }} />
            {k} <span className="tabular-nums text-ink-100">{pct(r[k], 2)}</span>
          </span>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="S勝利以上" value={pct(r.SS + r.S)} />
        <Stat label="A勝利以上" value={pct(r.SS + r.S + r.A)} />
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
              <span className="mr-1.5 text-[11px] text-ink-400">{i + 1}</span>
              {lines[i]?.name ?? `#${i + 1}`}
              {i === 0 && <Badge tone="neutral" className="ml-1.5">旗艦</Badge>}
            </Td>
            <Td>
              <div className="flex items-center gap-2">
                <ProgressBar value={s.hpMean} max={s.maxHp} className="flex-1" />
                <span className="w-16 text-right text-xs tabular-nums text-ink-200">
                  {s.hpMean.toFixed(1)}/{s.maxHp}
                </span>
              </div>
            </Td>
            <Td>
              <StackedBar parts={STATE_PARTS(s)} height="h-3.5" />
            </Td>
            <Td className={cx("text-right tabular-nums", s.sunkRate > 0.005 && "text-danger-400")}>{pct(s.sunkRate)}</Td>
            <Td className="text-right tabular-nums text-ink-200">{s.damageDealtMean.toFixed(1)}</Td>
            {showMvp && <Td className="text-right tabular-nums">{pct(s.mvpRate)}</Td>}
          </Tr>
        ))}
      </tbody>
    </Table>
    <div className="flex flex-wrap gap-3 border-t border-ink-600 px-4 py-2 text-[11px] text-ink-300">
      {STATE_PARTS({ healthyRate: 1, lightRate: 1, moderateRate: 1, heavyRate: 1, sunkRate: 1 }).map((p) => (
        <span key={p.label} className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: p.color }} />
          {p.label}
        </span>
      ))}
    </div>
  </Card>
);
