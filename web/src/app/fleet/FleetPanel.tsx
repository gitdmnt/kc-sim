import React, { useState } from "react";
import { importFromPoi } from "../../fleet";
import type { Preset, PresetShip } from "../../fleet";
import { Button, Combobox, ConfirmDialog, Field, NumberInput, Popover, Select, TextInput, S, useToast } from "../../ui";
import { useApp } from "../context";
import { FleetStats } from "./FleetStats";
import { IoModal } from "./IoModal";
import { blankPreset, newShipFor } from "./presets";
import type { PresetsApi } from "./presets";
import { ShipRow } from "./ShipRow";

const MAX_SHIPS = 6;

interface Props {
  store: PresetsApi;
  preset: Preset | null;
  select: (id: string | null) => void;
}

/** プリセットの切り替え・管理 (⋯) と艦の編集。プリセットが無ければ最初の艦の追加で作る。 */
export const FleetPanel = ({ store, preset, select }: Props) => {
  const { catalog, state } = useApp();
  const toast = useToast();
  const { presets, save, remove, refresh } = store;
  const [io, setIo] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ships = preset?.ships ?? [];
  // poi プラグインから開いていない (または未ログイン) ときは艦隊が無い
  const poiFleets: unknown[] = Array.isArray(state?.info?.fleets) ? state.info.fleets : [];

  const patch = (p: Partial<Preset>) => (preset ? save({ ...preset, ...p }) : select(save({ ...blankPreset(), ...p }).id));
  const setShips = (next: PresetShip[]) => patch({ ships: next });

  const create = () => select(save(blankPreset()).id);
  const duplicate = () => {
    if (!preset) return;
    const { id: _id, ...rest } = preset;
    const now = Date.now();
    select(save({ ...rest, name: `${preset.name} のコピー`, createdAt: now, updatedAt: now }).id);
  };
  const importPoi = (i: number) => {
    const p = importFromPoi(state, i);
    if (!p) return toast.push(`第${i + 1}艦隊を取り込めませんでした`, "danger");
    select(save(p).id);
  };

  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <div className="flex h-7 items-center gap-1.5">
        <Select className="h-7! w-48 shrink-0 text-[13px]" value={preset?.id ?? ""} onChange={(e) => select(e.target.value)} aria-label={S.fleet.presets}>
          {!preset && <option value="">{blankPreset().name}</option>}
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Popover
          size="sm"
          variant="ghost"
          label="⋯"
          buttonClassName="w-7 px-0!"
          title="プリセットの管理"
          aria-label="プリセットの管理"
          panelClassName="flex w-[23rem] flex-col gap-3"
        >
          {(close) => (
            <>
              {preset && (
                <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-2">
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
              <div className="flex items-center gap-1.5">
                <span className="w-24 shrink-0 text-[13px] text-ink-200">{S.fleet.importPoi}</span>
                {[0, 1, 2, 3].map((i) => (
                  <Button
                    key={i}
                    size="sm"
                    className="flex-1"
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
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" className="flex-1" onClick={() => (create(), close())}>
                  ＋ {S.fleet.newPreset}
                </Button>
                <Button size="sm" className="flex-1" disabled={!preset} onClick={() => (duplicate(), close())}>
                  {S.common.duplicate}
                </Button>
                <Button size="sm" className="flex-1" onClick={() => (setIo(true), close())}>
                  {S.fleet.importExport}
                </Button>
                <Button size="sm" variant="danger" disabled={!preset} onClick={() => (setConfirming(true), close())}>
                  {S.common.delete}
                </Button>
              </div>
            </>
          )}
        </Popover>
        {preset && <FleetStats preset={preset} />}
      </div>

      <div className="flex flex-col gap-1">
        {ships.map((ship, i) => (
          <ShipRow
            key={i}
            index={i}
            ship={ship}
            onChange={(next) => setShips(ships.map((s, j) => (j === i ? next : s)))}
            onRemove={() => setShips(ships.filter((_, j) => j !== i))}
          />
        ))}
        {ships.length < MAX_SHIPS && (
          <div className="flex items-center gap-1 rounded-md border border-dashed border-ink-500 bg-ink-800/50 px-2 py-1.5">
            <span className="w-3.5 shrink-0 text-center text-xs font-semibold tabular-nums text-ink-500">{ships.length + 1}</span>
            <Combobox
              className="w-[calc(9.5rem-1.125rem)]"
              options={catalog.shipOptions}
              value={null}
              onChange={(id) => id !== null && setShips([...ships, newShipFor(id, catalog)])}
              placeholder={S.fleet.addShipTo(ships.length + 1)}
              aria-label={S.fleet.addShipTo(ships.length + 1)}
            />
            {ships.length === 0 && poiFleets.length > 0 && (
              <div className="ml-4 flex items-center gap-1">
                <span className="mr-1 text-xs text-ink-400">{S.fleet.importPoi}</span>
                {[0, 1, 2, 3].map((i) => (
                  <Button key={i} size="sm" className="w-8 px-0!" disabled={!poiFleets[i]} title={`第${i + 1}艦隊`} onClick={() => importPoi(i)}>
                    {i + 1}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

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
    </section>
  );
};
