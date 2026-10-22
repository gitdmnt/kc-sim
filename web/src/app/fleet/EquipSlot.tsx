import React, { useEffect, useMemo, useRef } from "react";
import { Plus } from "lucide-react";
import type { PresetEquip } from "../../fleet";
import { buildEquipPicker, selectedEquipKey, PROFICIENCY_GLYPH } from "../../fleet/owned";
import { isAircraft } from "@shared/fleet/calc";
import { Combobox, EquipIcon, NumberInput, cx } from "../../ui";
import { useApp } from "../context";

interface Props {
  equip: PresetEquip | null;
  /** 読み上げ・ツールチップ用の枠名 (#1…, EX) */
  label: string;
  defaultSlotSize?: number;
  /** 補強増設は搭載数を持たない */
  noSlotSize?: boolean;
  /** 装備できる種別に絞るための艦のマスターID。省略時は全装備 */
  shipMasterId?: number;
  onChange: (next: PresetEquip | null) => void;
}

/** 装備 1 枠の列: アイコン・名前・★・熟練・搭載数。全艦で同じ列幅 (SLOT_COLS) なので縦に揃う。 */
export const SLOT_COLS = "grid grid-cols-[1rem_minmax(0,1fr)_2rem_1.75rem_2rem] items-center gap-x-1";

interface ChipProps {
  value: number;
  max: number;
  text: string;
  title: string;
  className?: string;
  onChange: (v: number) => void;
}

/** クリックで +1 (最大の次は 0)、右クリックで -1、ホイール/↑↓/数字キーでも変えられる小さな値ボタン。0 の間は行のホバーでだけ見せる。 */
const Chip = ({ value, max, text, title, className, onChange }: ChipProps) => {
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
        "h-6 tall:h-7 w-full cursor-pointer rounded-md text-xs tabular-nums transition-colors hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-accent-400",
        value === 0 && "text-ink-500 opacity-0 group-hover/slot:opacity-100 focus-visible:opacity-100",
        className
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
  const iconId = master?.api_type?.[3];

  return (
    <div className={cx("group/slot h-6 tall:h-7", SLOT_COLS)}>
      {iconId !== undefined ? (
        <EquipIcon iconId={iconId} title={catalog.equipTypeName(equip!.masterId)} />
      ) : noSlotSize ? (
        <span className="text-xs leading-none text-ink-600" title="補強増設">EX</span>
      ) : (
        <Plus size={14} className="text-ink-600" aria-hidden />
      )}
      <Combobox
        variant="ghost"
        menuClassName="min-w-80"
        buttonClassName="h-6! tall:h-7! px-1"
        options={picker.options}
        optionPrefix={(o) => {
          const id = catalog.master.equips[o.value]?.api_type?.[3];
          return id === undefined ? null : <EquipIcon iconId={id} />;
        }}
        value={equip?.masterId ?? null}
        selectedKey={selectedEquipKey(picker, equip)}
        fallbackLabel={equip ? catalog.equipName(equip.masterId) : undefined}
        onChange={pick}
        placeholder=""
        maxItems={200}
        typeToSearch
        clearable
        aria-label={`${label} 装備`}
      />
      {equip ? (
        <Chip
          value={equip.improvement}
          max={10}
          text={equip.improvement ? `★${equip.improvement}` : "★"}
          title="改修値 ★"
          className={equip.improvement ? "text-brass-400" : undefined}
          onChange={(v) => patch({ improvement: v })}
        />
      ) : (
        <span />
      )}
      {equip && aircraft ? (
        <Chip
          value={equip.proficiency}
          max={7}
          text={PROFICIENCY_GLYPH[equip.proficiency] || "—"}
          title="熟練度"
          className={equip.proficiency >= 4 ? "font-semibold text-brass-400" : "text-ink-300"}
          onChange={(v) => patch({ proficiency: v })}
        />
      ) : (
        <span />
      )}
      {equip && aircraft && !noSlotSize ? (
        <NumberInput
          variant="ghost"
          className={cx("h-6! tall:h-7! w-full px-1! text-xs!", slotSize === 0 ? "text-ink-500!" : "text-ink-300!")}
          min={0}
          max={99}
          value={slotSize}
          title="搭載数"
          aria-label="搭載数"
          onChange={(v) => patch({ slotSize: v })}
        />
      ) : (
        <span />
      )}
    </div>
  );
};
