import React from "react";
import type { PresetShip } from "../../fleet";
import { Button, Combobox, Field, NumberInput, Popover, ProgressBar, S, cx } from "../../ui";
import { useApp } from "../context";
import { EquipSlot } from "./EquipSlot";
import { defaultSlotSize, newShipFor } from "./presets";
import { StatsGrid } from "./StatsGrid";

interface Props {
  index: number;
  ship: PresetShip;
  onChange: (next: PresetShip) => void;
  onRemove: () => void;
}

/** 1 隻 = 1 行。左に艦名・Lv、右に装備 (2 列)。改修・士気・ステータスは ⋯ に畳む。 */
export const ShipRow = ({ index, ship, onChange, onRemove }: Props) => {
  const { catalog } = useApp();
  const patch = (p: Partial<PresetShip>) => onChange({ ...ship, ...p });
  const known = !!catalog.master.ships[ship.masterId];
  const obs = ship.observed;
  const mods = ship.luckMod + ship.hpMod + ship.aswMod;

  return (
    <div className="grid grid-cols-[9.5rem_minmax(0,1fr)] gap-x-2 rounded-md border border-ink-600 bg-ink-800/90 px-2 py-1.5">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-1">
          <span className="w-3.5 shrink-0 text-center text-xs font-semibold tabular-nums text-ink-400" title={catalog.shipTypeName(ship.masterId)}>
            {index + 1}
          </span>
          <Combobox
            className="flex-1"
            options={catalog.shipOptions}
            value={ship.masterId}
            fallbackLabel={known ? undefined : `艦#${ship.masterId}`}
            onChange={(id) => id !== null && onChange(newShipFor(id, catalog, ship))}
            aria-label={`${index + 1}番艦`}
          />
        </div>
        <div className="flex items-center gap-1 pl-[1.125rem]">
          <span className="text-[11px] text-ink-400">Lv</span>
          <NumberInput className="h-7! w-11 px-1!" min={1} max={185} value={ship.level} onChange={(v) => patch({ level: v })} aria-label="Lv" />
          <span className="flex-1" />
          <Popover
            size="sm"
            variant="ghost"
            buttonClassName={cx("h-6! w-6 px-0!", (mods > 0 || obs) && "text-accent-400!")}
            label="⋯"
            title="改修・コンディション・ステータス"
            aria-label={`${index + 1}番艦の詳細`}
            panelClassName="flex w-[25rem] flex-col gap-2.5"
          >
            <div className="grid grid-cols-4 gap-2">
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
                {obs.maxHp !== undefined && obs.nowHp !== undefined && (
                  <div className="w-16" title={`HP ${obs.nowHp}/${obs.maxHp}`}>
                    <ProgressBar value={obs.nowHp} max={obs.maxHp} />
                  </div>
                )}
                <span className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => patch({ observed: undefined })}>
                  {S.fleet.discardObserved}
                </Button>
              </div>
            )}
          </Popover>
          <Button variant="ghost" size="sm" className="h-6! w-6 px-0!" onClick={onRemove} title={S.common.remove} aria-label={`${index + 1}番艦を${S.common.remove}`}>
            ✕
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-1 content-start gap-x-2 gap-y-0.5 sm:grid-cols-2">
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
