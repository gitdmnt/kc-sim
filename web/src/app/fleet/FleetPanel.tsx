import React from "react";
import { Plus } from "lucide-react";
import type { Preset, PresetShip } from "../../fleet";
import { Button, Combobox, S } from "../../ui";
import { useApp } from "../context";
import { FleetStats } from "./FleetStats";
import { useImportPoi, usePoiFleets } from "./PresetMenu";
import { blankPreset, newShipFor } from "./presets";
import type { PresetsApi } from "./presets";
import { HEAD_COLS, ShipRow } from "./ShipRow";

const MAX_SHIPS = 6;

interface Props {
  store: PresetsApi;
  preset: Preset | null;
  select: (id: string | null) => void;
}

/** 艦隊の編集: 上に艦隊の諸元、下に 1 隻 1 行。プリセットの切り替え・管理はツールバー (PresetMenu)。プリセットが無ければ最初の艦の追加で作る。 */
export const FleetPanel = ({ store, preset, select }: Props) => {
  const { catalog } = useApp();
  const poiFleets = usePoiFleets();
  const importPoi = useImportPoi(store, select);
  const ships = preset?.ships ?? [];
  const setShips = (next: PresetShip[]) => (preset ? store.save({ ...preset, ships: next }) : select(store.save({ ...blankPreset(), ships: next }).id));

  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-md border border-ink-800 bg-ink-900 px-4 py-3 lg:min-h-0">
      {preset && ships.length > 0 && <FleetStats preset={preset} />}

      {/* 6 隻とも装備枠が多い艦隊で画面に収まらないときだけ、この枠の中でスクロールする */}
      {/* ゲームの編成画面と同じ 2 列 × 3 行 (1 2 / 3 4 / 5 6)。どの艦も同じ列構成なので装備の列が縦に揃う */}
      <div className="-mx-4 grid grid-cols-1 content-start gap-x-6 gap-y-4 px-4 sm:grid-cols-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
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
          <div className="flex min-w-0 flex-col gap-2">
            <div className={HEAD_COLS}>
              <Plus size={14} className="text-ink-500" aria-hidden />
              <Combobox
                variant="ghost"
                buttonClassName="h-6! px-1"
                options={catalog.shipOptions}
                value={null}
                onChange={(id) => id !== null && setShips([...ships, newShipFor(id, catalog)])}
                placeholder={S.fleet.addShipTo(ships.length + 1)}
                aria-label={S.fleet.addShipTo(ships.length + 1)}
                className="col-span-3"
              />
            </div>
            {ships.length === 0 && poiFleets.length > 0 && (
              <div className="flex items-center gap-1 pl-5">
                <span className="mr-2 text-sm text-ink-400">{S.fleet.importPoi}</span>
                {[0, 1, 2, 3].map((i) => (
                  <Button key={i} size="sm" icon disabled={!poiFleets[i]} title={`第${i + 1}艦隊`} onClick={() => importPoi(i)}>
                    {i + 1}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
