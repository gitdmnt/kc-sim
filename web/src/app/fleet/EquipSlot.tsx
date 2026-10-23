import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { PresetEquip } from "../../fleet";
import { buildEquipPicker, equipCategory, selectedEquipKey, EQUIP_CATEGORIES, PROFICIENCY_GLYPH } from "../../fleet/owned";
import type { EquipPicker } from "../../fleet/owned";
import { isAircraft } from "@shared/fleet/calc";
import { Button, EquipIcon, NumberInput, cx } from "../../ui";
import { PickerModal, PickerTrigger } from "./PickerModal";
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
  /** 選択肢をさらに絞る条件 (基地航空隊の中隊は航空機だけ) */
  only?: (equipMasterId: number) => boolean;
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

interface PickerModalProps {
  picker: EquipPicker;
  selectedKey?: string;
  initialQuery: string;
  title: string;
  onPick: (item: { value: number; key?: string }) => void;
  /** 装備を外す。空き枠のときは undefined */
  onClear?: () => void;
  onClose: () => void;
}

/** 装備の選択ダイアログ。所持装備 (★・熟練・個数つき) を先に、未所持のマスター装備を薄く後ろに。装備種別のカテゴリで絞り込める。 */
const EquipPickerModal = ({ picker, selectedKey, initialQuery, title, onPick, onClear, onClose }: PickerModalProps) => {
  const { catalog } = useApp();
  const { items, categories } = useMemo(() => {
    const items = picker.options.map((o) => ({ ...o, category: equipCategory(catalog.master.equips[o.value]?.api_type?.[2]) }));
    const present = new Set(items.map((i) => i.category));
    return { items, categories: EQUIP_CATEGORIES.flatMap((c, id) => (present.has(id) ? [{ id, label: c.label }] : [])) };
  }, [picker, catalog]);
  return (
    <PickerModal
      title={title}
      items={items}
      categories={categories}
      categoryLabel="装備種別"
      selectedKey={selectedKey}
      initialQuery={initialQuery}
      prefix={(o) => {
        const id = catalog.master.equips[o.value]?.api_type?.[3];
        return id === undefined ? <span className="w-4 shrink-0" /> : <EquipIcon iconId={id} />;
      }}
      footer={onClear && <Button variant="danger" onClick={onClear}>装備を外す</Button>}
      onPick={onPick}
      onClose={onClose}
    />
  );
};

export const EquipSlot = ({ equip, label, defaultSlotSize, noSlotSize, shipMasterId, only, onChange }: Props) => {
  const { catalog, state } = useApp();
  const master = equip ? catalog.master.equips[equip.masterId] : undefined;
  const aircraft = isAircraft(master);

  // 補強増設は装備種別の規則が別なので絞り込まない
  const picker = useMemo(
    () => buildEquipPicker(catalog, state, noSlotSize ? undefined : shipMasterId, only),
    [catalog, state, noSlotSize, shipMasterId, only]
  );

  /** 選択ダイアログを開いているとき、検索欄の初期入力 (文字キーで開いたときはその文字) */
  const [picking, setPicking] = useState<string | null>(null);

  const pick = (id: number, option?: { key?: string }) => {
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
      <PickerTrigger
        className="h-6! tall:h-7! px-1"
        label={equip ? catalog.equipName(equip.masterId) : undefined}
        onClick={() => setPicking("")}
        onType={setPicking}
        aria-label={`${label} 装備`}
      />
      {picking !== null && (
        <EquipPickerModal
          picker={picker}
          selectedKey={selectedEquipKey(picker, equip)}
          initialQuery={picking}
          title={`${label} 装備を選択`}
          onPick={(item) => (pick(item.value, item), setPicking(null))}
          onClear={equip ? () => (onChange(null), setPicking(null)) : undefined}
          onClose={() => setPicking(null)}
        />
      )}
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
