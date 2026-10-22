import React, { useMemo } from "react";
import type { Preset } from "../../fleet";
import { summarizePreset } from "../../fleet/calc";
import { Button, Card, Stat, S, cx } from "../../ui";
import { useNav } from "../nav";
import { useApp } from "../context";

export const FleetSummary = ({ preset }: { preset: Preset }) => {
  const { catalog } = useApp();
  const nav = useNav();
  const sum = useMemo(() => summarizePreset(preset, catalog.master), [preset, catalog]);
  const empty = preset.ships.length === 0;

  return (
    <Card
      title={S.fleet.summary}
      actions={
        <>
          <Button variant="primary" disabled={empty} onClick={() => nav.go({ tab: "sim", mode: "sortie", presetId: preset.id })}>
            {S.fleet.toSortieSim}
          </Button>
          <Button disabled={empty} onClick={() => nav.go({ tab: "sim", mode: "battle", presetId: preset.id })}>
            {S.fleet.toBattleSim}
          </Button>
        </>
      }
      bodyClassName="flex flex-col gap-3"
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[8rem_8rem_minmax(0,1fr)]">
        <Stat size="lg" label={S.fleet.fighterPower} value={sum.fighterPower} title="熟練度込み" />
        <Stat
          size="lg"
          label={S.fleet.speed}
          value={sum.speed === null ? "—" : (S.speeds[sum.speed] ?? sum.speed)}
          sub={sum.speed !== null && sum.speedIsBase ? "装備補正除く" : undefined}
        />
        <Stat
          size="lg"
          className="col-span-2 sm:col-span-1"
          label={S.fleet.los}
          title={sum.los ? `司令部Lv${preset.hqLevel ?? 120} で計算` : "索敵値が不明"}
          value={
            sum.los ? (
              <div className="grid grid-cols-4 gap-2">
                {(["cn1", "cn2", "cn3", "cn4"] as const).map((k, i) => (
                  <div key={k} className="min-w-0">
                    <div className="text-xs font-normal text-ink-400">Cn{i + 1}</div>
                    <div className="text-xl">{(Math.round(sum.los![k] * 100) / 100).toFixed(2)}</div>
                  </div>
                ))}
              </div>
            ) : (
              "—"
            )
          }
        />
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-300">
        <span className={cx(sum.drums.total === 0 && "text-ink-400")}>
          {S.fleet.drums} <span className="tabular-nums">{sum.drums.total}</span> 個 ({sum.drums.ships} 隻)
        </span>
        <span className={cx(sum.radars === 0 && "text-ink-400")}>
          {S.fleet.radars} <span className="tabular-nums">{sum.radars}</span>
        </span>
      </div>
    </Card>
  );
};
