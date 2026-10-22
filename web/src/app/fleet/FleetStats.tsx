import React, { useMemo } from "react";
import type { Preset } from "../../fleet";
import { summarizePreset } from "@shared/fleet/calc";
import { S } from "../../ui";
import { useApp } from "../context";

const V = ({ children }: { children: React.ReactNode }) => <span className="font-medium tabular-nums text-ink-50">{children}</span>;

/** 艦隊の制空・速力・索敵 (33式)・ドラム缶・電探を 1 行で。 */
export const FleetStats = ({ preset }: { preset: Preset }) => {
  const { catalog } = useApp();
  const sum = useMemo(() => summarizePreset(preset, catalog.master), [preset, catalog]);
  if (preset.ships.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-x-3 overflow-hidden text-xs whitespace-nowrap text-ink-400">
      <span title="熟練度込み">
        {S.fleet.fighterPower} <V>{sum.fighterPower}</V>
      </span>
      <span title={sum.speed !== null && sum.speedIsBase ? "装備補正除く" : undefined}>
        <V>{sum.speed === null ? "—" : (S.speeds[sum.speed] ?? sum.speed)}</V>
      </span>
      {sum.los && (
        <span title={`${S.fleet.los} 司令部Lv${preset.hqLevel ?? 120}`}>
          {(["cn1", "cn2", "cn3", "cn4"] as const).map((k, i) => (
            <span key={k} className="mr-1.5">
              Cn{i + 1} <V>{sum.los![k].toFixed(1)}</V>
            </span>
          ))}
        </span>
      )}
      {sum.drums.total > 0 && (
        <span>
          {S.fleet.drums} <V>{sum.drums.total}</V>
          <span className="text-ink-500">/{sum.drums.ships}隻</span>
        </span>
      )}
      {sum.radars > 0 && (
        <span>
          {S.fleet.radars} <V>{sum.radars}</V>
        </span>
      )}
    </div>
  );
};
