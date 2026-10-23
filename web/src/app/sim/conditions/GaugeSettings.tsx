import React from "react";
import { Plus, X } from "lucide-react";
import type { TankType } from "@sim-core";
import type { EnemyCompSet } from "@shared/data/types";
import type { GaugeKind } from "../../../sim/sortieOptions";
import { Button, Checkbox, Field, NumberInput, Select } from "../../../ui";
import { addGauge, setKeyOf } from "../sortieConfig";
import type { GaugeConfig, PhaseConfig } from "../sortieConfig";
import { DIFF, Group, Inline } from "./parts";
import type { SortieOptionProps } from "./parts";

export const GAUGE_KIND_LABEL: Record<GaugeKind, string> = { kill: "撃破 (ボス旗艦撃沈)", hp: "HP", tp: "輸送 (TP)" };
const REMAINING_LABEL: Record<GaugeKind, string> = { kill: "残り撃破数", hp: "残りHP", tp: "残りTP" };
const TANK_LABEL: Record<TankType, string> = { type1: "戦車隊 1 型", type2: "戦車隊 2 型", typeUnk: "戦車隊 (種別不明)" };
const KINDS = Object.keys(GAUGE_KIND_LABEL) as GaugeKind[];

/** 士気の持ち越し: 有効にすると、最低の待ち時間と、全艦がこの士気になるまで待つ */
const MoraleFields = ({ label, hint, value, onChange }: { label: string; hint: string; value: GaugeConfig["morale"]; onChange: (v: GaugeConfig["morale"]) => void }) => (
  <>
    <div className="col-span-3">
      <Checkbox label={label} hint={hint} checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
    </div>
    {value.enabled && (
      <>
        <Field label="最低の待ち時間 (分)">
          <NumberInput min={0} max={1440} value={value.waitMinutes} onChange={(waitMinutes) => onChange({ ...value, waitMinutes })} />
        </Field>
        <Field label="この士気まで待つ" hint="49 まで自然回復">
          <NumberInput min={0} max={49} value={value.untilMorale} onChange={(untilMorale) => onChange({ ...value, untilMorale })} />
        </Field>
        <span />
      </>
    )}
  </>
);

/** ゲージ: 種別・残り・HP の最終形態・輸送の戦車隊と TP、追加のゲージ、士気の持ち越し (ゲージ・連続出撃) */
export const GaugeSettings = ({ prefs, setPrefs, mapPrefs, setMapPrefs, bossSets }: SortieOptionProps & { bossSets: EnemyCompSet[] }) => {
  const g = mapPrefs.gauge;
  const set = (p: Partial<GaugeConfig>) => setMapPrefs({ gauge: { ...g, ...p } });
  const setExtra = (i: number, p: Partial<PhaseConfig>) => set({ extra: g.extra.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  return (
    <div className="grid grid-cols-3 gap-3">
      <Field label="ゲージ">
        <Select aria-label="ゲージの種別" value={g.kind} onChange={(e) => set({ kind: e.target.value as GaugeConfig["kind"], ...(e.target.value === "none" ? { extra: [] } : {}) })}>
          <option value="none">指定なし</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {GAUGE_KIND_LABEL[k]}
            </option>
          ))}
        </Select>
      </Field>
      {g.kind !== "none" && (
        <Field label={REMAINING_LABEL[g.kind]}>
          <NumberInput min={1} max={99999} value={g.remaining} onChange={(remaining) => set({ remaining })} />
        </Field>
      )}
      {g.kind === "hp" && (
        <Field label="最終形態の残りHP" hint="0 = 旗艦の最大HP">
          <NumberInput min={0} max={99999} value={g.finalThreshold ?? 0} onChange={(v) => set({ finalThreshold: v || undefined })} />
        </Field>
      )}
      {g.kind === "hp" && bossSets.length > 1 && (
        <Field label="最終形態の編成" className="col-span-2">
          <Select value={g.finalSetKey} onChange={(e) => set({ finalSetKey: e.target.value })}>
            <option value="">ボスマスと同じ</option>
            {bossSets.map((s) => (
              <option key={setKeyOf(s)} value={setKeyOf(s)}>
                {DIFF[s.difficulty]} / {s.periodStart ?? "?"}〜 ({s.totalCount.toLocaleString()}回)
              </option>
            ))}
          </Select>
        </Field>
      )}
      {g.kind === "tp" && (
        <>
          <Field label="戦車隊">
            <Select value={g.tank ?? ""} onChange={(e) => set({ tank: (e.target.value || undefined) as TankType | undefined })}>
              <option value="">なし</option>
              {(Object.keys(TANK_LABEL) as TankType[]).map((t) => (
                <option key={t} value={t}>
                  {TANK_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="S勝利の TP" hint="0 = 編成から計算 (A勝利は ×0.7)">
            <NumberInput min={0} max={999} value={g.tpPerSortie ?? 0} onChange={(v) => set({ tpPerSortie: v || undefined })} />
          </Field>
          <span />
        </>
      )}

      {g.extra.length > 0 && (
        <Group title="追加のゲージ (1 本目を削ったあと順に削る。phase 0 = 自動)" className="col-span-3">
          {g.extra.map((p, i) => (
            <div key={i} className="grid grid-cols-[2.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_1.75rem] items-center gap-2">
              <span className="text-xs text-ink-400 tabular-nums">{i + 2} 本目</span>
              <Select className="h-7!" aria-label={`${i + 2} 本目の種別`} value={p.kind} onChange={(e) => setExtra(i, { kind: e.target.value as GaugeKind })}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {GAUGE_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
              <Inline label="残り">
                <NumberInput className="h-7! w-full" aria-label={`${i + 2} 本目の残り`} min={1} max={99999} value={p.remaining} onChange={(remaining) => setExtra(i, { remaining })} />
              </Inline>
              <Inline label="phase" title="この本の間の分岐の phase (0 = 1 本目の phase + 本数)">
                <NumberInput className="h-7! w-full" aria-label={`${i + 2} 本目の phase`} min={0} max={20} value={p.phase ?? 0} onChange={(v) => setExtra(i, { phase: v || undefined })} />
              </Inline>
              <Button size="sm" variant="ghost" icon onClick={() => set({ extra: g.extra.filter((_, j) => j !== i) })} title="このゲージを外す" aria-label={`${i + 2} 本目を外す`}>
                <X size={14} aria-hidden />
              </Button>
            </div>
          ))}
        </Group>
      )}
      <div className="col-span-3">
        <Button size="sm" variant="ghost" onClick={() => set(addGauge(g))} title="複数ゲージの海域: 1 本目のあとに削るゲージを足す">
          <Plus size={14} aria-hidden />
          ゲージを追加
        </Button>
      </div>

      <div className="col-span-3 h-px bg-ink-800" />
      <MoraleFields
        label="ゲージ破壊まで士気を持ち越す"
        hint="ゲージの試行で出撃ごとに士気の回復を待ち、待ち時間を出す (計算は遅くなる)"
        value={g.morale}
        onChange={(morale) => set({ morale })}
      />
      <MoraleFields
        label="連続出撃 (士気を持ち越す)"
        hint="実行の回数ぶん続けて出撃し、出撃の間は回復を待つ (計算の塊ごとに入力の士気から始める)"
        value={prefs.consecutive}
        onChange={(consecutive) => setPrefs({ consecutive })}
      />
    </div>
  );
};
