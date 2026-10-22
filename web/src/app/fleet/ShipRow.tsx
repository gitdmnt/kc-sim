import React from "react";
import { Ellipsis, X } from "lucide-react";
import type { PresetShip } from "../../fleet";
import { Button, Combobox, Field, NumberInput, Popover, ProgressBar, S, cx } from "../../ui";
import { useApp } from "../context";
import { EquipSlot } from "./EquipSlot";
import { defaultSlotSize, newShipFor } from "./presets";
import { StatsGrid } from "./StatsGrid";

/** 艦種 (api_stype) の略号 */
const STYPE_ABBR: Record<number, string> = {
  1: "DE", 2: "DD", 3: "CL", 4: "CLT", 5: "CA", 6: "CAV", 7: "CVL", 8: "FBB", 9: "BB", 10: "BBV", 11: "CV",
  12: "BB", 13: "SS", 14: "SSV", 15: "AP", 16: "AV", 17: "LHA", 18: "CVB", 19: "AR", 20: "AS", 21: "CT", 22: "AO",
};

/** 見出し行の列: 番号・艦種・艦名・Lv・HP・操作。装備行 (SLOT_COLS) と左端・右端を揃える。 */
export const HEAD_COLS = "grid grid-cols-[1rem_minmax(0,1fr)_2.5rem_3.5rem] items-center gap-x-1";

interface Props {
  index: number;
  ship: PresetShip;
  onChange: (next: PresetShip) => void;
  onRemove: () => void;
}

/** 1 隻: 見出し行 (番号・艦種・艦名・Lv、実測 HP があれば棒) の下に装備を上から 1 列。改修・士気・ステータスは ⋯ に畳む。 */
export const ShipRow = ({ index, ship, onChange, onRemove }: Props) => {
  const { catalog } = useApp();
  const patch = (p: Partial<PresetShip>) => onChange({ ...ship, ...p });
  const known = !!catalog.master.ships[ship.masterId];
  const obs = ship.observed;
  const mods = ship.luckMod + ship.hpMod + ship.aswMod;
  const stype = catalog.master.ships[ship.masterId]?.api_stype;

  return (
    <div className="group/ship flex min-w-0 flex-col gap-1 tall:gap-2">
      <div className={HEAD_COLS}>
        <span className="text-xs text-ink-500 tabular-nums" title={catalog.shipTypeName(ship.masterId)}>
          {index + 1}
        </span>
        <Combobox
          variant="ghost"
          buttonClassName="h-6! tall:h-7! px-1 font-medium"
          prefix={
            <span className="w-7 shrink-0 text-xs font-normal text-ink-400" title={catalog.shipTypeName(ship.masterId)}>
              {stype !== undefined ? (STYPE_ABBR[stype] ?? "") : ""}
            </span>
          }
          options={catalog.shipOptions}
          value={ship.masterId}
          fallbackLabel={known ? undefined : `艦#${ship.masterId}`}
          onChange={(id) => id !== null && onChange(newShipFor(id, catalog, ship))}
          aria-label={`${index + 1}番艦`}
        />
        <div className="flex flex-col">
          <NumberInput variant="ghost" className="h-5! w-full px-1!" min={1} max={185} value={ship.level} onChange={(v) => patch({ level: v })} title="Lv" aria-label="Lv" />
          {obs?.maxHp !== undefined && obs.nowHp !== undefined && (
            <div className="px-1" title={`HP ${obs.nowHp}/${obs.maxHp}`}>
              <ProgressBar value={obs.nowHp} max={obs.maxHp} className="h-0.5" />
            </div>
          )}
        </div>
        <div className="flex items-center justify-end">
          <Popover
            size="sm"
            variant="ghost"
            icon
            className={cx(!(mods > 0 || obs) && "opacity-0 group-hover/ship:opacity-100 focus-within:opacity-100")}
            buttonClassName={cx("h-6! w-6!", (mods > 0 || obs) && "text-accent-400!")}
            label={<Ellipsis size={14} aria-hidden />}
            title="改修・コンディション・ステータス"
            aria-label={`${index + 1}番艦の詳細`}
            panelClassName="flex w-[25rem] flex-col gap-4"
          >
            <div className="grid grid-cols-4 gap-3">
              <Field label={S.fleet.luckMod}>
                <NumberInput min={0} max={99} value={ship.luckMod} onChange={(v) => patch({ luckMod: v })} />
              </Field>
              <Field label={S.fleet.hpMod}>
                <NumberInput min={0} max={99} value={ship.hpMod} onChange={(v) => patch({ hpMod: v })} />
              </Field>
              <Field label={S.fleet.aswMod}>
                <NumberInput min={0} max={99} value={ship.aswMod} onChange={(v) => patch({ aswMod: v })} />
              </Field>
              <Field label={S.fleet.morale}>
                <NumberInput min={0} max={100} value={ship.morale} onChange={(v) => patch({ morale: v })} />
              </Field>
            </div>
            <StatsGrid ship={ship} />
            {obs && (
              <div className="flex items-center gap-2 text-xs text-ink-400">
                <span>{S.source.observed}</span>
                <span className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => patch({ observed: undefined })}>
                  {S.fleet.discardObserved}
                </Button>
              </div>
            )}
          </Popover>
          <Button
            variant="ghost"
            size="sm"
            icon
            className="h-6! w-6! opacity-0 group-hover/ship:opacity-100 focus-visible:opacity-100"
            onClick={onRemove}
            title={S.common.remove}
            aria-label={`${index + 1}番艦を${S.common.remove}`}
          >
            <X size={14} aria-hidden />
          </Button>
        </div>
      </div>
      <div className="flex min-w-0 flex-col">
        {ship.equips.map((e, i) => (
          <EquipSlot
            key={i}
            label={`#${i + 1}`}
            equip={e}
            shipMasterId={ship.masterId}
            defaultSlotSize={defaultSlotSize(catalog, ship.masterId, i)}
            onChange={(next) => patch({ equips: ship.equips.map((x, j) => (j === i ? next : x)) })}
          />
        ))}
        <EquipSlot label="EX" noSlotSize equip={ship.exSlot ?? null} onChange={(next) => patch({ exSlot: next })} />
      </div>
    </div>
  );
};
