import React, { useCallback } from "react";
import { Download, Plus, X } from "lucide-react";
import type { AirBaseMode, Preset, PresetAirBase, PresetEquip } from "../../fleet";
import { MAX_AIR_BASES, SQUADRONS } from "../../fleet/normalize";
import { isAircraft } from "@shared/fleet/calc";
import { squadronSize } from "@shared/sim/adapter";
import { Button, Select, Tabs, S } from "../../ui";
import { useApp } from "../context";
import { EquipSlot } from "./EquipSlot";
import { useImportPoi } from "./PresetMenu";
import type { PresetsApi } from "./presets";

const MODES: AirBaseMode[] = ["sortie", "defense", "standby"];

const emptyBase = (): PresetAirBase => ({ mode: "sortie", squadrons: Array.from({ length: SQUADRONS }, () => null), targets: ["", ""] });

interface Props {
  store: PresetsApi;
  preset: Preset;
  /** 目標に選べるマス (選んだ海域の戦闘マス) */
  nodes: string[];
  /** 選んだ海域の番号 (poi の基地航空隊の取り込み用) */
  areaId: number | undefined;
}

/**
 * 基地航空隊の編集: 最大 3 隊、各 4 中隊 (装備の選び方は艦の装備と同じ EquipSlot)。出撃の隊は 2 波の目標マスを選ぶ。
 * 目標マスはプリセットに保存し、選んだ海域に無いマスは計算で使わない。
 */
export const AirBasePanel = ({ store, preset, nodes, areaId }: Props) => {
  const { catalog, state } = useApp();
  const { importAirBases } = useImportPoi(store, () => {});
  const bases = preset.lbas ?? [];
  const setBases = (next: PresetAirBase[]) => store.save({ ...preset, lbas: next });
  const patch = (i: number, p: Partial<PresetAirBase>) => setBases(bases.map((b, j) => (j === i ? { ...b, ...p } : b)));
  // EquipSlot の選択肢 (useMemo の依存) が描画ごとに作り直されないよう、参照を保つ
  const onlyAircraft = useCallback((id: number) => isAircraft(catalog.master.equips[id]), [catalog]);
  const poiHasBases = Array.isArray(state?.info?.airbase) && state.info.airbase.length > 0;

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-md border border-ink-800 bg-ink-900 px-4 py-3 lg:min-h-0">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-ink-400">{S.airBase.hint}</p>
        {poiHasBases && (
          <Button size="sm" className="-my-0.5 shrink-0" title={S.airBase.importPoiTitle} onClick={() => importAirBases(preset, areaId)}>
            <Download size={14} aria-hidden />
            {S.airBase.importPoi}
          </Button>
        )}
      </div>
      <div className="-mx-4 grid grid-cols-1 content-start gap-x-6 gap-y-4 px-4 sm:grid-cols-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {bases.map((b, i) => {
          const label = S.airBase.title(i + 1);
          return (
            <div key={i} className="flex min-w-0 flex-col gap-1" aria-label={label}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink-100">{label}</span>
                <Tabs<AirBaseMode>
                  variant="pill"
                  size="sm"
                  value={b.mode}
                  onChange={(mode) => patch(i, { mode })}
                  tabs={MODES.map((m) => ({ id: m, label: S.airBase.modes[m] }))}
                />
                <Button size="sm" variant="ghost" icon className="ml-auto" title={S.airBase.remove} aria-label={`${label}を外す`} onClick={() => setBases(bases.filter((_, j) => j !== i))}>
                  <X size={14} aria-hidden />
                </Button>
              </div>
              {b.mode === "sortie" && (
                <div className="flex items-center gap-2 text-xs text-ink-400">
                  {S.airBase.target}
                  {[0, 1].map((w) => (
                    <Select
                      key={w}
                      className="h-6! w-20"
                      aria-label={`${label} ${S.airBase.wave(w + 1)}の目標`}
                      title={S.airBase.wave(w + 1)}
                      value={b.targets[w]}
                      onChange={(e) => patch(i, { targets: w === 0 ? [e.target.value, b.targets[1]] : [b.targets[0], e.target.value] })}
                    >
                      <option value="">{S.airBase.noTarget}</option>
                      {/* 別の海域で選んだマスも、戻ったときのために選択肢に残す */}
                      {[...new Set([...nodes, ...(b.targets[w] ? [b.targets[w]] : [])])].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </Select>
                  ))}
                </div>
              )}
              {b.squadrons.map((sq, k) => (
                <EquipSlot
                  key={k}
                  equip={sq}
                  label={`${label} ${S.airBase.squadron(k + 1)}`}
                  defaultSlotSize={18}
                  only={onlyAircraft}
                  onChange={(next: PresetEquip | null) => {
                    // 機体を変えたら機数をその種別の満載に (EquipSlot は一律 defaultSlotSize を入れる)
                    const full = next && next.masterId !== sq?.masterId ? { ...next, slotSize: squadronSize(catalog.master.equips[next.masterId]) } : next;
                    patch(i, { squadrons: b.squadrons.map((s, j) => (j === k ? full : s)) });
                  }}
                />
              ))}
            </div>
          );
        })}
        {bases.length < MAX_AIR_BASES && (
          <div>
            <Button size="sm" variant="ghost" onClick={() => setBases([...bases, emptyBase()])}>
              <Plus size={14} aria-hidden />
              {S.airBase.add}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
};
