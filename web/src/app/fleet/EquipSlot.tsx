import React, { useEffect, useMemo, useRef } from "react";
import type { PresetEquip } from "../../fleet";
import { buildEquipPicker, selectedEquipKey, PROFICIENCY_GLYPH } from "../../fleet/owned";
import { isAircraft } from "@shared/fleet/calc";
import { Combobox, NumberInput, S, cx } from "../../ui";
import { useApp } from "../context";

interface Props {
  equip: PresetEquip | null;
  label: string;
  defaultSlotSize?: number;
  /** 補強増設は搭載数を持たない */
  noSlotSize?: boolean;
  /** 装備できる種別に絞るための艦のマスターID。省略時は全装備 */
  shipMasterId?: number;
  onChange: (next: PresetEquip | null) => void;
}

interface ChipProps {
  value: number;
  max: number;
  text: string;
  title: string;
  onChange: (v: number) => void;
}

/** クリックで +1 (最大の次は 0)、右クリックで -1、ホイール/↑↓/数字キーでも変えられる小さな値ボタン。 */
const Chip = ({ value, max, text, title, onChange }: ChipProps) => {
  const ref = useRef<HTMLButtonElement>(null);
  const step = (d: number) => onChange(Math.min(max, Math.max(0, value + d)));

  // React の onWheel は passive なので preventDefault できない。ネイティブで張る。
  const latest = useRef(step);
  latest.current = step;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      latest.current(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      title={title}
      aria-label={title}
      onClick={() => onChange(value >= max ? 0 : value + 1)}
      onContextMenu={(e) => {
        e.preventDefault();
        step(-1);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowRight" || e.key === "+") step(1);
        else if (e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "-") step(-1);
        else if (/^[0-9]$/.test(e.key) && Number(e.key) <= max) onChange(Number(e.key));
        else return;
        e.preventDefault();
      }}
      className={cx(
        "h-7 w-9 shrink-0 cursor-pointer rounded-md border border-ink-600 bg-ink-900 text-xs tabular-nums transition-colors",
        "hover:border-ink-500 focus-visible:outline-2 focus-visible:outline-accent-400",
        value === 0 ? "text-ink-400" : "text-amber-300"
      )}
    >
      {text}
    </button>
  );
};

export const EquipSlot = ({ equip, label, defaultSlotSize, noSlotSize, shipMasterId, onChange }: Props) => {
  const { catalog, state } = useApp();
  const master = equip ? catalog.master.equips[equip.masterId] : undefined;
  const aircraft = isAircraft(master);

  // 補強増設は装備種別の規則が別なので絞り込まない
  const picker = useMemo(
    () => buildEquipPicker(catalog, state, noSlotSize ? undefined : shipMasterId),
    [catalog, state, noSlotSize, shipMasterId]
  );

  const pick = (id: number | null, option?: { key?: string }) => {
    if (id === null) return onChange(null);
    const choice = (option?.key && picker.choices.get(option.key)) || { masterId: id, improvement: 0, proficiency: 0 };
    const next: PresetEquip = {
      masterId: id,
      improvement: choice.improvement,
      proficiency: isAircraft(catalog.master.equips[id]) ? choice.proficiency : 0,
    };
    if (isAircraft(catalog.master.equips[id]) && !noSlotSize && defaultSlotSize !== undefined) next.slotSize = defaultSlotSize;
    onChange(next);
  };
  const patch = (p: Partial<PresetEquip>) => equip && onChange({ ...equip, ...p });
  const slotSize = equip?.slotSize ?? defaultSlotSize ?? 0;

  return (
    <div className="flex items-center gap-1.5">
      <span className="w-7 shrink-0 text-xs tabular-nums text-ink-400">{label}</span>
      <Combobox
        className="flex-1"
        menuClassName="min-w-80"
        buttonClassName="h-7! px-2 text-sm"
        options={picker.options}
        value={equip?.masterId ?? null}
        selectedKey={selectedEquipKey(picker, equip)}
        fallbackLabel={equip ? catalog.equipName(equip.masterId) : undefined}
        onChange={pick}
        placeholder={S.fleet.equipPlaceholder}
        maxItems={200}
        typeToSearch
        clearable
        aria-label={`${label} 装備`}
      />
      {equip && (
        <Chip
          value={equip.improvement}
          max={10}
          text={`★${equip.improvement}`}
          title="改修値 ★"
          onChange={(v) => patch({ improvement: v })}
        />
      )}
      {equip && aircraft && (
        <Chip
          value={equip.proficiency}
          max={7}
          text={PROFICIENCY_GLYPH[equip.proficiency] || "熟"}
          title="熟練度"
          onChange={(v) => patch({ proficiency: v })}
        />
      )}
      {equip && aircraft && !noSlotSize && (
        <NumberInput
          className={cx("h-7! w-10 px-1!", slotSize === 0 && "text-ink-400!")}
          min={0}
          max={99}
          value={slotSize}
          title="搭載数"
          aria-label="搭載数"
          onChange={(v) => patch({ slotSize: v })}
        />
      )}
    </div>
  );
};
