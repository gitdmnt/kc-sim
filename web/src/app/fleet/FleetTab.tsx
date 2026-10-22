import React, { useEffect, useState } from "react";
import { STORAGE_PREFIX, importFromPoi } from "../../fleet";
import type { Preset } from "../../fleet";
import { EmptyState, S, useToast } from "../../ui";
import { useApp } from "../context";
import { IoModal } from "./IoModal";
import { PresetEditor } from "./PresetEditor";
import { PresetSidebar } from "./PresetSidebar";
import { blankPreset, usePresets } from "./presets";

const SELECTED_KEY = `${STORAGE_PREFIX}selectedPreset`;

export const FleetTab = () => {
  const { state } = useApp();
  const toast = useToast();
  const { presets, save, remove, refresh } = usePresets();
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SELECTED_KEY);
    } catch {
      return null;
    }
  });
  const [ioOpen, setIoOpen] = useState(false);

  const select = (id: string | null) => {
    setSelectedId(id);
    try {
      if (id) localStorage.setItem(SELECTED_KEY, id);
      else localStorage.removeItem(SELECTED_KEY);
    } catch {
      // ignore
    }
  };

  const selected = presets.find((p) => p.id === selectedId) ?? null;

  // 選択が無効なら先頭に寄せる
  useEffect(() => {
    if (!selected && presets.length > 0) select(presets[0].id);
  }, [selected, presets]);

  const create = () => select(save(blankPreset()).id);

  const duplicate = () => {
    if (!selected) return;
    const { id: _id, ...rest } = selected;
    const now = Date.now();
    select(save({ ...rest, name: `${selected.name} のコピー`, createdAt: now, updatedAt: now }).id);
  };

  const importPoi = (fleetIndex: number) => {
    const p = importFromPoi(state, fleetIndex);
    if (!p) {
      toast.push(`第${fleetIndex + 1}艦隊を取り込めませんでした (艦がいない、または poi の状態が未取得)`, "danger");
      return;
    }
    select(save(p).id);
    toast.push(`第${fleetIndex + 1}艦隊を取り込みました`, "ok");
  };

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
      <PresetSidebar
        presets={presets}
        selectedId={selected?.id ?? null}
        onSelect={select}
        onCreate={create}
        onDuplicate={duplicate}
        onDelete={() => {
          if (!selected) return;
          remove(selected.id);
          select(null);
        }}
        onImportPoi={importPoi}
        onOpenIo={() => setIoOpen(true)}
      />
      {selected ? (
        <PresetEditor key={selected.id} preset={selected} onChange={(next: Preset) => save(next)} />
      ) : (
        <EmptyState title={S.fleet.selectOrCreate} description={S.fleet.selectOrCreateHint} className="py-24" />
      )}
      {ioOpen && (
        <IoModal
          current={selected}
          onClose={() => setIoOpen(false)}
          onImported={(imported) => {
            // IoModal 内で store に保存済み。一覧だけ再読込する
            refresh();
            if (imported[0]) select(imported[0].id);
          }}
        />
      )}
    </div>
  );
};
