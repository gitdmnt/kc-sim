import React from "react";
import type { PresetEquip } from "../../fleet";
import { isAircraft } from "../../fleet/calc";
import { Combobox, NumberInput, S } from "../../ui";
import { useApp } from "../context";

interface Props {
  equip: PresetEquip | null;
  label: string;
  defaultSlotSize?: number;
  /** 補強増設は搭載数を持たない */
  noSlotSize?: boolean;
  onChange: (next: PresetEquip | null) => void;
}

export const EquipSlot = ({ equip, label, defaultSlotSize, noSlotSize, onChange }: Props) => {
  const { catalog } = useApp();
  const master = equip ? catalog.master.equips[equip.masterId] : undefined;
  const aircraft = isAircraft(master);

  const pick = (id: number | null) => {
    if (id === null) return onChange(null);
    const m = catalog.master.equips[id];
    const next: PresetEquip = { masterId: id, improvement: 0, proficiency: 0 };
    if (isAircraft(m) && !noSlotSize && defaultSlotSize !== undefined) next.slotSize = defaultSlotSize;
    onChange(next);
  };
  const patch = (p: Partial<PresetEquip>) => equip && onChange({ ...equip, ...p });

  return (
    <div className="flex items-center gap-1.5">
      <span className="w-9 shrink-0 text-[10px] text-ink-400">{label}</span>
      <Combobox
        className="flex-1"
        options={catalog.equipOptions}
        value={equip?.masterId ?? null}
        fallbackLabel={equip ? catalog.equipName(equip.masterId) : undefined}
        onChange={pick}
        placeholder={S.fleet.equipPlaceholder}
        clearable
        aria-label={`${label} 装備`}
      />
      <NumberInput
        className="w-14"
        min={0}
        max={10}
        value={equip?.improvement ?? 0}
        disabled={!equip}
        title="改修値 ★"
        aria-label="改修値"
        onChange={(v) => patch({ improvement: v })}
      />
      <NumberInput
        className="w-14"
        min={0}
        max={7}
        value={equip?.proficiency ?? 0}
        disabled={!equip || !aircraft}
        title="熟練度 (>>)"
        aria-label="熟練度"
        onChange={(v) => patch({ proficiency: v })}
      />
      {!noSlotSize && (
        <NumberInput
          className="w-14"
          min={0}
          max={99}
          value={equip?.slotSize ?? defaultSlotSize ?? 0}
          disabled={!equip || !aircraft}
          title="搭載数"
          aria-label="搭載数"
          onChange={(v) => patch({ slotSize: v })}
        />
      )}
    </div>
  );
};
