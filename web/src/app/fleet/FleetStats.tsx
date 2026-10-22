import React, { useMemo } from "react";
import { Cylinder, Eye, Gauge, Plane, Radar } from "lucide-react";
import type { Preset } from "../../fleet";
import { summarizePreset } from "@shared/fleet/calc";
import { S } from "../../ui";
import { useApp } from "../context";

const Item = ({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) => (
  <span className="flex items-center gap-1" title={title}>
    <span className="text-ink-500">{icon}</span>
    <span className="font-medium tabular-nums text-ink-100">{children}</span>
  </span>
);

/** 艦隊の制空・速力・索敵 (33式 Cn1〜4)・ドラム缶・電探を 1 行で。見出しはアイコンとツールチップ。 */
export const FleetStats = ({ preset }: { preset: Preset }) => {
  const { catalog } = useApp();
  const sum = useMemo(() => summarizePreset(preset, catalog.master), [preset, catalog]);
  if (preset.ships.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-4 overflow-hidden text-sm whitespace-nowrap">
      <Item icon={<Plane size={14} aria-hidden />} title={`${S.fleet.fighterPower} (熟練度込み)`}>
        {sum.fighterPower}
      </Item>
      <Item icon={<Gauge size={14} aria-hidden />} title={sum.speed !== null && sum.speedIsBase ? "速力 (装備補正除く)" : "速力"}>
        {sum.speed === null ? "—" : (S.speeds[sum.speed] ?? sum.speed)}
      </Item>
      {sum.los && (
        <Item icon={<Eye size={14} aria-hidden />} title={`${S.fleet.los} Cn1 / Cn2 / Cn3 / Cn4 (司令部Lv${preset.hqLevel ?? 120})`}>
          <span className="flex gap-2">
            {(["cn1", "cn2", "cn3", "cn4"] as const).map((k, i) => (
              <span key={k}>
                <span className="mr-0.5 text-xs font-normal text-ink-500">{i + 1}</span>
                {sum.los![k].toFixed(1)}
              </span>
            ))}
          </span>
        </Item>
      )}
      {sum.drums.total > 0 && (
        <Item icon={<Cylinder size={14} aria-hidden />} title={`${S.fleet.drums} (個数 / 搭載艦数)`}>
          {sum.drums.total}
          <span className="font-normal text-ink-500">/{sum.drums.ships}</span>
        </Item>
      )}
      {sum.radars > 0 && (
        <Item icon={<Radar size={14} aria-hidden />} title={`${S.fleet.radars}の数`}>
          {sum.radars}
        </Item>
      )}
    </div>
  );
};
