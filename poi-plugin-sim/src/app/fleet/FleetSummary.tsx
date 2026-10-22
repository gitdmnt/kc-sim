import React, { useMemo } from "react";
import type { Preset } from "../../fleet";
import { summarizePreset } from "../../fleet/calc";
import { Button, Card, Stat, S } from "../../ui";
import { useNav } from "../nav";
import { useApp } from "../context";

const fmt = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export const FleetSummary = ({ preset }: { preset: Preset }) => {
  const { catalog } = useApp();
  const nav = useNav();
  const sum = useMemo(() => summarizePreset(preset, catalog.master), [preset, catalog]);

  return (
    <Card
      title={S.fleet.summary}
      actions={
        <>
          <Button size="sm" variant="primary" disabled={preset.ships.length === 0} onClick={() => nav.go({ tab: "sim", mode: "sortie", presetId: preset.id })}>
            この艦隊で出撃シミュ
          </Button>
          <Button size="sm" disabled={preset.ships.length === 0} onClick={() => nav.go({ tab: "sim", mode: "battle", presetId: preset.id })}>
            戦闘シミュ
          </Button>
        </>
      }
      bodyClassName="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
      <Stat
        label={S.fleet.speed}
        value={sum.speed === null ? "—" : (S.speeds[sum.speed] ?? sum.speed)}
        sub={sum.speed !== null && sum.speedIsBase ? "装備補正除く" : undefined}
      />
      <Stat label={S.fleet.fighterPower} value={sum.fighterPower} sub="熟練度込み" />
      {(["cn1", "cn2", "cn3", "cn4"] as const).map((k, i) => (
        <Stat
          key={k}
          label={`${S.fleet.los} Cn${i + 1}`}
          value={sum.los ? fmt(sum.los[k]) : "—"}
          sub={sum.los ? `司令部Lv${preset.hqLevel ?? 120}` : "索敵値が不明"}
        />
      ))}
      <Stat label={S.fleet.drums} value={`${sum.drums.total} 個`} sub={`${sum.drums.ships} 隻装備`} />
      <Stat label={S.fleet.radars} value={sum.radars} />
    </Card>
  );
};
