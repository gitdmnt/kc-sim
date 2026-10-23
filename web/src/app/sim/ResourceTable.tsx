import React from "react";
import type { Dist, ResourcesSummary, SortieSummary } from "@sim-core";
import { DTable, DTr, Num, Td, Th } from "./bars";

/** 秒 → 「9時間28分」「28分」「0分」(30 秒未満の正の値は「1分未満」) */
export const fmtDuration = (sec: number): string => {
  if (sec > 0 && sec < 30) return "1分未満";
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}時間${m % 60}分` : `${m}分`;
};

const KEYS: [keyof ResourcesSummary, string][] = [
  ["fuel", "燃料"],
  ["ammo", "弾薬"],
  ["steel", "鋼材"],
  ["bauxite", "ボーキ"],
  ["buckets", "高速修復材"],
  ["timeSec", "入渠時間"],
];

const fmt = (k: keyof ResourcesSummary, v: number, mean = false) => (k === "timeSec" ? fmtDuration(v) : v.toFixed(k === "buckets" && mean ? 2 : 0));

/**
 * 結果の要約の「入渠」: 1 出撃で最も遅い 1 隻の入渠時間 (高速修復材を使った艦は 0)。ツールチップに中央値・90% 点、
 * 高速修復材なしの値、1 ドックでの合計、入渠の燃料・鋼材。
 */
export const dockingFact = (s: Pick<SortieSummary, "repair" | "resourcesPerSortie">): { label: string; value: string; title: string } => {
  const t = s.resourcesPerSortie.timeSec;
  const buckets = s.resourcesPerSortie.buckets.mean;
  const stats = (d: Dist) => `平均 ${fmtDuration(d.mean)} · 中央値 ${fmtDuration(d.p50)} · 90% 点 ${fmtDuration(d.p90)}`;
  return {
    label: "入渠",
    value: buckets > 0.005 ? `${fmtDuration(t.mean)} · 修復材 ${buckets.toFixed(1)}` : fmtDuration(t.mean),
    title: [
      `1 出撃で最も遅い 1 隻の入渠時間 (ドック並列${buckets > 0 ? "、高速修復材を使った艦は 0" : ""})`,
      stats(t),
      ...(buckets > 0 ? [`高速修復材 ${buckets.toFixed(2)} 個/出撃`, `高速修復材なし: ${stats(s.repair.timeSec)}`] : []),
      `1 ドックで全艦を直す合計: 平均 ${fmtDuration(s.repair.timeSecTotal.mean)}`,
      `入渠の燃料 ${s.repair.fuel.mean.toFixed(0)} · 鋼材 ${s.repair.steel.mean.toFixed(0)}`,
    ].join("\n"),
  };
};

/** 内訳の行 (1 出撃あたりの平均) */
const Line = ({ label, value, title }: { label: string; value: string; title?: string }) => (
  <DTr>
    <Td className="text-ink-200" title={title}>
      {label}
    </Td>
    <Td className="text-right whitespace-nowrap tabular-nums text-ink-100">{value}</Td>
  </DTr>
);

const four = (r: { fuel: number; ammo: number; steel: number; bauxite: number }) => [r.fuel, r.ammo, r.steel, r.bauxite].map((v) => v.toFixed(1)).join(" / ");

/** 資源タブ: 1 出撃・1 ゲージ破壊あたりの純コスト、入渠、基地航空隊・洋上補給・糧食、マスの効果 */
export const ResourceTable = ({ s }: { s: SortieSummary }) => {
  const g = s.gauge?.resources;
  const e = s.effects;
  const used = s.underwayUsedMean > 0.0005 || s.rationsUsedMean > 0.0005;
  return (
    <div className="flex flex-col gap-3">
      <DTable
        head={
          <>
            <Th className="text-left">資源</Th>
            <Th title="1 出撃あたりの平均">平均</Th>
            <Th>中央値</Th>
            <Th>90%</Th>
            {g && (
              <>
                <Th title="1 ゲージ破壊あたり (破壊できた試行の平均)">ゲージ平均</Th>
                <Th>ゲージ90%</Th>
              </>
            )}
          </>
        }
      >
        {KEYS.map(([k, label]) => (
          <DTr key={k}>
            <Td className="text-ink-200">{label}</Td>
            <Num>{fmt(k, s.resourcesPerSortie[k].mean, true)}</Num>
            <Num>{fmt(k, s.resourcesPerSortie[k].p50)}</Num>
            <Num>{fmt(k, s.resourcesPerSortie[k].p90)}</Num>
            {g && (
              <>
                <Num>{fmt(k, g[k].mean, true)}</Num>
                <Num>{fmt(k, g[k].p90)}</Num>
              </>
            )}
          </DTr>
        ))}
      </DTable>

      <DTable
        head={
          <>
            <Th className="text-left">内訳 (1 出撃あたりの平均)</Th>
            <Th />
          </>
        }
      >
        <Line
          label="入渠 (燃料 / 鋼材)"
          value={`${s.repair.fuel.mean.toFixed(1)} / ${s.repair.steel.mean.toFixed(1)}`}
          title="帰投時の損傷を直す燃料・鋼材 (上の表に含む)"
        />
        <Line
          label="入渠時間 (最も遅い艦 / 1 ドック合計)"
          value={`${fmtDuration(s.repair.timeSec.mean)} / ${fmtDuration(s.repair.timeSecTotal.mean)}`}
          title="高速修復材を使う前の時間"
        />
        {s.lbasCostMean && <Line label="基地航空隊 (燃料 / 弾薬 / 鋼材 / ボーキ)" value={four(s.lbasCostMean)} title="出撃した基地の費用と、失った機体の補充 (上の表に含む)" />}
        {s.supportCostMean && <Line label="支援艦隊 (燃料 / 弾薬 / 鋼材 / ボーキ)" value={four(s.supportCostMean)} title="道中・決戦支援の遠征の消費と、失った機体の補充 (上の表に含む)" />}
        {used && <Line label="洋上補給 / 戦闘糧食 (個)" value={`${s.underwayUsedMean.toFixed(2)} / ${s.rationsUsedMean.toFixed(2)}`} />}
        {e && (
          <>
            <Line label="資源マスの獲得 (燃料 / 弾薬 / 鋼材 / ボーキ)" value={four(e.gainedMean)} title="上の表から差し引いている" />
            <Line label="渦潮の損失 (燃料 / 弾薬)" value={`${e.maelstromFuelMean.toFixed(1)} / ${e.maelstromAmmoMean.toFixed(1)}`} />
            <Line
              label="泊地修理 (回復HP / 修理資材 / 鋼材)"
              value={`${e.anchorageHpMean.toFixed(1)} / ${e.anchorageMaterialsMean.toFixed(2)} / ${e.anchorageSteelMean.toFixed(1)}`}
            />
          </>
        )}
      </DTable>

      <ul className="list-inside list-disc text-xs text-ink-400">
        <li>純コスト: 補給 (Lv100 以上は ×0.85)・入渠の燃料と鋼材・艦載機の補充・基地航空隊・1 出撃ごとに足す費用から、資源マスの獲得を引いた値</li>
        <li>入渠時間: 1 出撃では最も遅い 1 隻 (ドック並列、高速修復材を使った艦は 0)、ゲージでは出撃ごとの合計</li>
        {s.gauge?.kind === "kill" && g && !s.gauge.phases && <li>撃破ゲージは 1 出撃の平均 × 出撃数の近似</li>}
        {s.gauge && !g && <li>ゲージを破壊できた試行が無いので、1 ゲージあたりは出せない</li>}
      </ul>
    </div>
  );
};
