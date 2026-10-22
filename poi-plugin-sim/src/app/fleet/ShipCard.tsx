import React from "react";
import type { PresetShip } from "../../fleet";
import { Badge, Button, Combobox, Field, NumberInput, ProgressBar, S } from "../../ui";
import { useApp } from "../context";
import { EquipSlot } from "./EquipSlot";
import { newShipFor, defaultSlotSize } from "./presets";
import { StatsGrid } from "./StatsGrid";

interface Props {
  index: number;
  ship: PresetShip;
  onChange: (next: PresetShip) => void;
  onRemove: () => void;
}

export const ShipCard = ({ index, ship, onChange, onRemove }: Props) => {
  const { catalog } = useApp();
  const patch = (p: Partial<PresetShip>) => onChange({ ...ship, ...p });
  const stypeName = catalog.shipTypeName(ship.masterId);
  const known = !!catalog.master.ships[ship.masterId];
  const obs = ship.observed;

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-ink-600 bg-ink-800 p-3.5 shadow-sm shadow-black/20">
      <header className="flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-ink-700 text-xs font-semibold text-ink-200">
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
        {stypeName && <Badge tone="neutral">{stypeName}</Badge>}
        <Button variant="ghost" size="sm" onClick={onRemove} title={S.common.remove} aria-label={S.common.remove}>
          ✕
        </Button>
      </header>

      <div className="grid grid-cols-5 gap-2">
        <Field label={S.fleet.level}>
          <NumberInput min={1} max={185} value={ship.level} onChange={(v) => patch({ level: v })} />
        </Field>
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

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 pl-[2.625rem] pr-px text-[10px] text-ink-400">
          <span className="flex-1" />
          <span className="w-14 text-center">★</span>
          <span className="w-14 text-center">&gt;&gt;</span>
          <span className="w-14 text-center">{S.fleet.slotSize}</span>
        </div>
        {ship.equips.map((e, i) => (
          <EquipSlot
            key={i}
            label={`#${i + 1}`}
            equip={e}
            defaultSlotSize={defaultSlotSize(catalog, ship.masterId, i)}
            onChange={(next) => patch({ equips: ship.equips.map((x, j) => (j === i ? next : x)) })}
          />
        ))}
        <EquipSlot
          label="EX"
          noSlotSize
          equip={ship.exSlot ?? null}
          onChange={(next) => patch({ exSlot: next })}
        />
      </div>

      {obs && (
        <div className="flex items-center gap-2 rounded-md border border-ok-600/30 bg-ok-600/10 px-2.5 py-1.5 text-[11px] text-ok-400">
          <span className="flex-1">{S.fleet.observedNote}</span>
          {obs.maxHp !== undefined && obs.nowHp !== undefined && (
            <div className="w-20 shrink-0">
              <ProgressBar value={obs.nowHp} max={obs.maxHp} />
            </div>
          )}
          <Button size="sm" variant="ghost" onClick={() => patch({ observed: undefined })}>
            {S.fleet.discardObserved}
          </Button>
        </div>
      )}

      <StatsGrid ship={ship} />
    </article>
  );
};
