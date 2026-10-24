import React from "react";
import { Plus, RefreshCw } from "lucide-react";
import { maxShipsOf } from "../../fleet";
import type { Preset, PresetShip } from "../../fleet";
import { Button, S } from "../../ui";
import { FleetStats } from "./FleetStats";
import { useImportPoi, usePoiFleets } from "./PresetMenu";
import { blankPreset } from "./presets";
import type { PresetsApi } from "./presets";
import { HEAD_COLS, ShipRow } from "./ShipRow";
import { ShipPicker } from "./ShipPicker";

interface Props {
  store: PresetsApi;
  preset: Preset | null;
  select: (id: string | null) => void;
  /** 選んだ海域の分岐が使う索敵の係数 (33式の Cn) */
  losCns: number[];
  /** 編集する艦隊: 主力 (ships)、連合艦隊の随伴 (escort)、支援艦隊 (supportNode / supportBoss)、友軍艦隊 (friendFleet)。既定は主力 */
  fleet?: "main" | "escort" | "supportNode" | "supportBoss" | "friendFleet";
  /** 艦の一覧の上に置く要素 (支援艦隊の道中 / 決戦の切り替えなど) */
  header?: React.ReactNode;
}

/**
 * 艦隊の編集: 上に艦隊の諸元、下に 1 隻 1 行。プリセットの切り替え・管理はツールバー (PresetMenu)。プリセットが無ければ最初の艦の追加で作る。
 * 連合艦隊の随伴・支援艦隊・友軍艦隊も `fleet` で同じ部品を使う (poi の取り込みは主力と随伴だけ)。
 */
export const FleetPanel = ({ store, preset, select, losCns, fleet = "main", header }: Props) => {
  const poiFleets = usePoiFleets();
  const { importPoi, importEscort, reimport, reimportTitle } = useImportPoi(store, select);
  const escort = fleet === "escort";
  const key = fleet === "main" ? "ships" : fleet;
  const ships = preset?.[key] ?? [];
  const setShips = (next: PresetShip[]) => (preset ? store.save({ ...preset, [key]: next }) : select(store.save({ ...blankPreset(), [key]: next }).id));
  // 遊撃部隊の主力と友軍艦隊は 7 隻、ほかは 6 隻
  const max = fleet === "main" ? (preset ? maxShipsOf(preset.fleetType) : 6) : fleet === "friendFleet" ? 7 : 6;

  return (
    <section className="@container flex min-w-0 flex-col gap-2 rounded-md border border-ink-800 bg-ink-900 px-4 py-3 lg:min-h-0">
      {header}
      {preset && ships.length > 0 && (
        <div className="flex min-w-0 items-start justify-between gap-2">
          <FleetStats preset={fleet === "main" ? preset : escort ? { ...preset, ships } : { ...preset, fleetType: "single", ships }} cns={losCns} />
          {poiFleets.length > 0 && (fleet === "main" || escort) && (
            <Button size="sm" className="-my-0.5" title={reimportTitle(preset)} onClick={() => reimport(preset)}>
              <RefreshCw size={14} aria-hidden />
              {S.fleet.reimportPoi}
            </Button>
          )}
        </div>
      )}

      {/* 6 隻とも装備枠が多い艦隊で画面に収まらないときだけ、この枠の中でスクロールする */}
      {/* ゲームの編成画面と同じ 2 列 × 3 行 (1 2 / 3 4 / 5 6)。どの艦も同じ列構成なので装備の列が縦に揃う。
          2 列は艦の欄が艦名・装備名を読める幅 (約 17rem) になる枠の幅 36rem から。狭い枠 (1024px の窓など) では 1 列にする */}
      <div className="-mx-4 grid grid-cols-1 content-start gap-x-6 gap-y-4 px-4 tall:gap-y-6 @min-[36rem]:grid-cols-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {ships.map((ship, i) => (
          <ShipRow
            key={i}
            index={i}
            ship={ship}
            onChange={(next) => setShips(ships.map((s, j) => (j === i ? next : s)))}
            onRemove={() => setShips(ships.filter((_, j) => j !== i))}
          />
        ))}
        {ships.length < max && (
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
            {ships.length === 0 && poiFleets.length > 0 && (fleet === "main" || escort) && (
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
