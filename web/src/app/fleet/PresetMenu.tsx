import React, { useState } from "react";
import { ArrowLeftRight, Copy, Download, Ellipsis, FilePlus, Trash } from "lucide-react";
import { airBasesFromPoi, importCombinedFromPoi, importFromPoi, isCombinedFleetType } from "../../fleet";
import type { Preset } from "../../fleet";
import { Button, ConfirmDialog, Field, NumberInput, Popover, Select, TextInput, S, useToast } from "../../ui";
import { useApp } from "../context";
import { IoModal } from "./IoModal";
import { blankPreset, getPresetStore } from "./presets";
import type { PresetsApi } from "./presets";

interface Props {
  store: PresetsApi;
  preset: Preset | null;
  select: (id: string | null) => void;
}

/** poi の第 1〜4 艦隊 (state.info.fleets)。プラグインから開いていない・未ログインなら空 */
export const usePoiFleets = (): unknown[] => {
  const { state } = useApp();
  return Array.isArray(state?.info?.fleets) ? state.info.fleets : [];
};

let lastFleet = 0;

const isCombined = (p: Preset) => isCombinedFleetType(p.fleetType);

/**
 * poi の艦隊の取り込み。importPoi(i) は第 i+1 艦隊を新しいプリセットとして保存して選ぶ。importCombined は第1 + 第2 艦隊を
 * 連合艦隊 (種別は poi の連合艦隊フラグ、組んでいなければ機動部隊) として、importEscort は第 i+1 艦隊を開いているプリセットの随伴に。
 * reimport は開いているプリセットの艦を poi の今の編成で置き換える (名前・陣形・メモ・基地航空隊は保つ): 連合艦隊なら第1 + 第2、
 * そうでなければ最後に取り込んだ艦隊 (まだなら第 1)。importAirBases は基地航空隊を置き換える (目標マスは保つ)。
 */
export const useImportPoi = (store: PresetsApi, select: (id: string | null) => void) => {
  const { state } = useApp();
  const toast = useToast();
  const load = (i: number) => {
    const p = importFromPoi(state, i);
    if (p) lastFleet = i;
    else toast.push(`第${i + 1}艦隊を取り込めませんでした`, "danger");
    return p;
  };
  const loadCombined = (into?: Preset) => {
    const p = importCombinedFromPoi(state, into && isCombined(into) ? (into.fleetType as Parameters<typeof importCombinedFromPoi>[1]) : undefined);
    if (!p) toast.push("第1・第2艦隊を連合艦隊として取り込めませんでした", "danger");
    return p;
  };
  return {
    importPoi: (i: number) => {
      const p = load(i);
      if (p) select(store.save(p).id);
    },
    importCombined: () => {
      const p = loadCombined();
      if (p) select(store.save(p).id);
    },
    importEscort: (into: Preset, i: number) => {
      const p = load(i);
      if (p) store.save({ ...into, escort: p.ships });
    },
    importAirBases: (into: Preset, areaId: number | undefined) => {
      const bases = airBasesFromPoi(state, areaId);
      if (bases.length === 0) return toast.push("poi に基地航空隊がありません", "danger");
      // 目標マスは海域ごとに選ぶもので poi には無い。今の選択を隊の順に残す
      store.save({ ...into, lbas: bases.map((b, i) => ({ ...b, targets: into.lbas?.[i]?.targets ?? b.targets })) });
    },
    reimport: (into: Preset | null) => {
      if (into && isCombined(into)) {
        const p = loadCombined(into);
        if (p) store.save({ ...into, ships: p.ships, escort: p.escort, hqLevel: p.hqLevel ?? into.hqLevel, source: "poi" });
        return;
      }
      const p = load(lastFleet);
      if (!p) return;
      // 7 隻の艦隊を取り込んだら遊撃部隊にする
      if (into) store.save({ ...into, ships: p.ships, fleetType: p.fleetType === "striking_force" ? p.fleetType : into.fleetType, hqLevel: p.hqLevel ?? into.hqLevel, source: "poi" });
      else select(store.save(p).id);
    },
    /** reimport のツールチップ */
    reimportTitle: (into: Preset | null) => (into && isCombined(into) ? S.fleet.reimportCombinedTitle : S.fleet.reimportTitle(lastFleet + 1)),
  };
};

/** ツールバーの「編成」: プリセットの切り替えと管理 (⋯: 名前・司令部Lv・メモ、poi から取り込み、新規・複製・入出力・削除)。 */
export const PresetMenu = ({ store, preset, select }: Props) => {
  const { presets, save, remove, refresh } = store;
  const [io, setIo] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const poiFleets = usePoiFleets();
  const { importPoi, importCombined } = useImportPoi(store, select);
  const patch = (p: Partial<Preset>) => preset && save({ ...preset, ...p });

  const duplicate = () => {
    if (!preset) return;
    const { id: _id, ...rest } = preset;
    const now = Date.now();
    select(save({ ...rest, name: `${preset.name} のコピー`, createdAt: now, updatedAt: now }).id);
  };

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Select className="h-7! w-40 min-w-24 shrink" value={preset?.id ?? ""} onChange={(e) => select(e.target.value)} aria-label={S.fleet.presets}>
        {!preset && <option value="">{blankPreset().name}</option>}
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name || S.fleet.untitled}
          </option>
        ))}
      </Select>
      <Popover
        size="sm"
        variant="ghost"
        icon
        label={<Ellipsis size={16} aria-hidden />}
        title="プリセットの管理"
        aria-label="プリセットの管理"
        panelClassName="flex w-[22rem] flex-col gap-4"
      >
        {(close) => (
          <>
            {preset && (
              <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-3">
                <Field label={S.fleet.name}>
                  <TextInput value={preset.name} onChange={(e) => patch({ name: e.target.value })} />
                </Field>
                <Field label={S.fleet.hq}>
                  <NumberInput min={1} max={185} value={preset.hqLevel ?? 120} onChange={(v) => patch({ hqLevel: v })} />
                </Field>
                <Field label={S.fleet.note} className="col-span-2">
                  <TextInput value={preset.note ?? ""} onChange={(e) => patch({ note: e.target.value })} />
                </Field>
              </div>
            )}
            <div className="flex items-center gap-1">
              <span className="flex flex-1 items-center gap-2 text-sm text-ink-300">
                <Download size={14} aria-hidden />
                {S.fleet.importPoi}
              </span>
              {[0, 1, 2, 3].map((i) => (
                <Button
                  key={i}
                  size="sm"
                  icon
                  disabled={!poiFleets[i]}
                  title={`第${i + 1}艦隊`}
                  onClick={() => {
                    importPoi(i);
                    close();
                  }}
                >
                  {i + 1}
                </Button>
              ))}
              <Button
                size="sm"
                disabled={!poiFleets[0] || !poiFleets[1]}
                title={S.fleet.importCombinedTitle}
                onClick={() => {
                  importCombined();
                  close();
                }}
              >
                {S.fleet.importCombined}
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-1">
              <Button size="sm" onClick={() => (select(save(blankPreset()).id), close())}>
                <FilePlus size={14} aria-hidden />
                {S.fleet.newPreset}
              </Button>
              <Button size="sm" disabled={!preset} onClick={() => (duplicate(), close())}>
                <Copy size={14} aria-hidden />
                {S.fleet.saveAs}
              </Button>
              <Button size="sm" onClick={() => (setIo(true), close())}>
                <ArrowLeftRight size={14} aria-hidden />
                {S.fleet.importExport}
              </Button>
              <Button size="sm" variant="danger" disabled={!preset} onClick={() => (setConfirming(true), close())}>
                <Trash size={14} aria-hidden />
                {S.common.delete}
              </Button>
            </div>
            {!getPresetStore().persistent && <p className="text-xs text-danger-400">{S.fleet.notPersistent}</p>}
          </>
        )}
      </Popover>

      {io && (
        <IoModal
          current={preset}
          onClose={() => setIo(false)}
          onImported={(imported) => {
            // IoModal 内で store に保存済み。一覧だけ再読込する
            refresh();
            if (imported[0]) select(imported[0].id);
          }}
        />
      )}
      {confirming && preset && (
        <ConfirmDialog
          danger
          title={`「${preset.name}」を削除`}
          confirmLabel={S.common.delete}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            remove(preset.id);
            select(null);
          }}
        />
      )}
    </div>
  );
};
