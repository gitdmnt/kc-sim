import React from "react";
import type { GaugeSummary } from "@sim-core";
import { DTable, DTr, Fact, Num, Td, Th, pct } from "./bars";
import { fmtDuration } from "./ResourceTable";

/** ゲージの種別 (撃破ゲージはボス旗艦の撃沈で 1 減る) */
export const GAUGE_LABEL: Record<GaugeSummary["kind"], string> = { kill: "撃破 (ボス旗艦撃沈)", hp: "HP", tp: "輸送" };

const n1 = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(1));
const n0 = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(Math.round(v)));

/** ゲージタブ: 破壊までの出撃数 (平均・中央値・90% 点)、上限到達、士気の待ち時間、ゲージごとの出撃数、1 破壊あたりの資源 */
export const GaugeResult = ({ g }: { g: GaugeSummary }) => {
  const r = g.resources;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <Fact label="ゲージ" value={g.phases ? `${g.phases.length} 本` : `${GAUGE_LABEL[g.kind]} 残り ${g.remaining.toLocaleString()}`} />
        <Fact label="試行" value={`${g.runs.toLocaleString()} 回`} />
        <Fact label="破壊までの出撃 (平均)" value={n1(g.expectedSorties)} />
        <Fact label="中央値 / 90% 点" value={`${n0(g.p50Sorties)} / ${n0(g.p90Sorties)}`} />
        <Fact label="上限到達" value={pct(g.cappedRate)} tone={g.cappedRate > 0 ? "danger" : undefined} title="出撃数の上限まで破壊できなかった試行の割合" />
        {g.expectedWaitMinutes !== undefined && (
          <Fact
            label="士気の回復待ち"
            value={fmtDuration(g.expectedWaitMinutes * 60)}
            title={`破壊までの待ち時間の合計: 平均 ${fmtDuration(g.expectedWaitMinutes * 60)} · 中央値 ${fmtDuration((g.p50WaitMinutes ?? 0) * 60)} · 90% 点 ${fmtDuration((g.p90WaitMinutes ?? 0) * 60)}`}
          />
        )}
        {r && (
          <div className="col-span-2">
            <Fact
              label="1 破壊の資源"
              value={[r.fuel, r.ammo, r.steel, r.bauxite].map((d) => Math.round(d.mean).toLocaleString()).join(" / ")}
              title={`燃料 / 弾薬 / 鋼材 / ボーキの平均。高速修復材 ${r.buckets.mean.toFixed(1)} · 入渠時間の合計 ${fmtDuration(r.timeSec.mean)} (詳細は「資源」)`}
            />
          </div>
        )}
      </div>

      {g.phases && (
        <DTable
          head={
            <>
              <Th className="text-left">ゲージ</Th>
              <Th className="text-left">種別</Th>
              <Th title="そのゲージに使った出撃 (破壊できた試行の平均)">出撃 (平均)</Th>
              <Th>90%</Th>
            </>
          }
        >
          {g.phases.map((p, i) => (
            <DTr key={i}>
              <Td className="text-ink-200">{i + 1} 本目</Td>
              <Td className="text-ink-200">{GAUGE_LABEL[p.kind]}</Td>
              <Num>{n1(p.expectedSorties)}</Num>
              <Num>{n0(p.p90Sorties)}</Num>
            </DTr>
          ))}
        </DTable>
      )}
    </div>
  );
};
