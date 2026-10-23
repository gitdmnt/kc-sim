import React from "react";
import type { SortieShipSummary } from "@sim-core";
import { StackedBar } from "../../ui";
import { DTable, DTr, Num, Td, Th, pct } from "./bars";
import { fmtDuration } from "./ResourceTable";

/** 損耗タブ: 艦ごとの帰投時の状態、入渠時間、ボーキ、ダメコン、退避。どの艦でも 0 の列は出さない */
export const ShipLossTable = ({ ships, names }: { ships: SortieShipSummary[]; names: string[] }) => {
  const bauxite = ships.some((s) => s.bauxiteMean >= 0.05);
  const damecon = ships.some((s) => s.damecon.usedRate >= 0.0005);
  const evacuated = ships.some((s) => s.evacuatedRate >= 0.0005);
  return (
    <DTable
      head={
        <>
          <Th className="text-left">艦</Th>
          <Th className="w-24 text-left" title="帰投時の状態 (撃沈・大破・中破)">
            損傷
          </Th>
          <Th className="w-14">大破</Th>
          <Th className="w-14">撃沈</Th>
          <Th className="w-20" title="その艦の入渠時間の平均 (高速修復材を使う前)。ツールチップに帰投時に減っている HP">
            入渠
          </Th>
          {bauxite && (
            <Th className="w-14" title="艦載機の補充のボーキの平均 (1 出撃あたり)">
              ボーキ
            </Th>
          )}
          {damecon && <Th className="w-16">ダメコン</Th>}
          {evacuated && (
            <Th className="w-14" title="護衛退避で艦隊を離れた出撃の割合 (退避した艦と、連合艦隊で付き添った駆逐艦)">
              退避
            </Th>
          )}
        </>
      }
    >
      {ships.map((s, i) => (
        <DTr key={i}>
          <Td className="max-w-28 truncate text-ink-200" title={names[i]}>
            {names[i]}
          </Td>
          <Td>
            <StackedBar
              parts={[
                { label: "撃沈", value: s.sunkRate, color: "var(--color-hp-sunk)" },
                { label: "大破", value: s.heavyRate, color: "var(--color-hp-heavy)" },
                { label: "中破", value: s.moderateRate, color: "var(--color-hp-moderate)" },
              ]}
            />
          </Td>
          <Num>{pct(s.heavyRate)}</Num>
          <Num alert={s.sunkRate > 0.005}>{pct(s.sunkRate)}</Num>
          <Td
            className="text-right whitespace-nowrap tabular-nums text-ink-100"
            title={`修理 HP ${s.hpMissingMean.toFixed(1)} · 燃料 ${s.repair.fuel.mean.toFixed(1)} · 鋼材 ${s.repair.steel.mean.toFixed(1)} · 90% 点 ${fmtDuration(s.repair.timeSec.p90)}`}
          >
            {fmtDuration(s.repair.timeSec.mean)}
          </Td>
          {bauxite && <Num>{s.bauxiteMean.toFixed(1)}</Num>}
          {damecon && <Num>{pct(s.damecon.usedRate)}</Num>}
          {evacuated && <Num>{pct(s.evacuatedRate)}</Num>}
        </DTr>
      ))}
    </DTable>
  );
};
