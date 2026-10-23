import React from "react";
import { Plus, RefreshCw } from "lucide-react";
import type { Preset, PresetShip } from "../../fleet";
import { Button, S } from "../../ui";
import { FleetStats } from "./FleetStats";
import { useImportPoi, usePoiFleets } from "./PresetMenu";
import { blankPreset } from "./presets";
import type { PresetsApi } from "./presets";
import { HEAD_COLS, ShipRow } from "./ShipRow";
import { ShipPicker } from "./ShipPicker";

const MAX_SHIPS = 6;

interface Props {
  store: PresetsApi;
  preset: Preset | null;
  select: (id: string | null) => void;
  /** 選んだ海域の分岐が使う索敵の係数 (33式の Cn) */
  losCns: number[];
  /** 連合艦隊の主力 (ships) と随伴 (escort) のどちらを編集するか。既定は主力 */
  fleet?: "main" | "escort";
}

/**
 * 艦隊の編集: 上に艦隊の諸元、下に 1 隻 1 行。プリセットの切り替え・管理はツールバー (PresetMenu)。プリセットが無ければ最初の艦の追加で作る。
 * 連合艦隊の随伴は `fleet="escort"` で同じ部品を使う。
 */
export const FleetPanel = ({ store, preset, select, losCns, fleet = "main" }: Props) => {
  const poiFleets = usePoiFleets();
  const { importPoi, importEscort, reimport, reimportTitle } = useImportPoi(store, select);
  const escort = fleet === "escort";
  const ships = (escort ? preset?.escort : preset?.ships) ?? [];
  const setShips = (next: PresetShip[]) =>
    preset ? store.save(escort ? { ...preset, escort: next } : { ...preset, ships: next }) : select(store.save({ ...blankPreset(), ships: next }).id);

  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-md border border-ink-800 bg-ink-900 px-4 py-3 lg:min-h-0">
      {preset && ships.length > 0 && (
        <div className="flex min-w-0 items-start justify-between gap-2">
          <FleetStats preset={escort ? { ...preset, ships } : preset} cns={losCns} />
          {poiFleets.length > 0 && (
            <Button size="sm" className="-my-0.5" title={reimportTitle(preset)} onClick={() => reimport(preset)}>
              <RefreshCw size={14} aria-hidden />
              {S.fleet.reimportPoi}
            </Button>
          )}
        </div>
      )}

      {/* 6 隻とも装備枠が多い艦隊で画面に収まらないときだけ、この枠の中でスクロールする */}
      {/* ゲームの編成画面と同じ 2 列 × 3 行 (1 2 / 3 4 / 5 6)。どの艦も同じ列構成なので装備の列が縦に揃う */}
      <div className="-mx-4 grid grid-cols-1 content-start gap-x-6 gap-y-4 px-4 tall:gap-y-6 sm:grid-cols-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
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
              <ShipPicker
                buttonClassName="h-6! px-1"
                onPick={(ship) => setShips([...ships, ship])}
                placeholder={S.fleet.addShipTo(ships.length + 1)}
                aria-label={S.fleet.addShipTo(ships.length + 1)}
                className="col-span-3"
              />
            </div>
            {ships.length === 0 && poiFleets.length > 0 && (
              <div className="flex items-center gap-1 pl-5">
                <span className="mr-2 text-sm text-ink-400">{S.fleet.importPoi}</span>
                {[0, 1, 2, 3].map((i) => (
                  <Button key={i} size="sm" icon disabled={!poiFleets[i]} title={`第${i + 1}艦隊`} onClick={() => (escort && preset ? importEscort(preset, i) : importPoi(i))}>
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
