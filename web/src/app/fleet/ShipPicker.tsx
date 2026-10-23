import React, { useMemo, useState } from "react";
import { shipFromPoi } from "../../fleet";
import type { PresetShip } from "../../fleet";
import { ownedShips } from "../../fleet/owned";
import { Button, Combobox, cx } from "../../ui";
import { useApp } from "../context";
import { PickerModal, PickerTrigger } from "./PickerModal";
import type { PickItem } from "./PickerModal";
import { newShipFor } from "./presets";

interface Props {
  /** 入れ替える艦 (追加なら undefined)。マスター一覧から選んだときの Lv・装備の引き継ぎ元 */
  current?: PresetShip;
  onPick: (next: PresetShip) => void;
  /** トリガーの先頭に置く要素 */
  prefix?: React.ReactNode;
  placeholder?: string;
  className?: string;
  buttonClassName?: string;
  "aria-label": string;
}

/**
 * 艦の選択。poi の所持艦があれば所持艦 (Lv の高い順、艦種で絞り込み) から選び、その艦の Lv・装備・実測値ごと取り込む。
 * poi に繋がっていなければ (または「全艦から選ぶ」で) マスターの艦を検索して選ぶ。
 */
export const ShipPicker = ({ current, onPick, prefix, placeholder, className, buttonClassName, "aria-label": ariaLabel }: Props) => {
  const { catalog, state } = useApp();
  const owned = useMemo(() => ownedShips(state, catalog), [state, catalog]);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<"owned" | "master">("owned");

  const label = current ? (catalog.master.ships[current.masterId] ? catalog.shipName(current.masterId) : `艦#${current.masterId}`) : undefined;

  const view = useMemo(() => {
    if (!open) return null;
    const searchOf = new Map(catalog.shipOptions.map((o) => [o.value, o.search]));
    const items: PickItem[] =
      source === "owned"
        ? owned.map((s) => ({
            value: s.instanceId,
            key: `s:${s.instanceId}`,
            label: catalog.shipName(s.masterId),
            sub: `Lv${s.level}`,
            search: searchOf.get(s.masterId) ?? "",
            category: s.stype,
          }))
        : catalog.shipOptions.map((o) => ({ ...o, category: catalog.master.ships[o.value]?.api_stype ?? 0 }));
    const types = [...new Set(items.map((i) => i.category))].sort((a, b) => a - b);
    return { items, categories: types.map((id) => ({ id, label: catalog.shipTypes[id] ?? "その他" })) };
  }, [open, source, owned, catalog]);

  // poi に繋がっていない (所持艦が分からない) ときは従来のマスター検索
  if (owned.length === 0) {
    return (
      <Combobox
        variant="ghost"
        buttonClassName={buttonClassName}
        prefix={prefix}
        options={catalog.shipOptions}
        value={current?.masterId ?? null}
        fallbackLabel={current ? `艦#${current.masterId}` : undefined}
        onChange={(id) => id !== null && onPick(newShipFor(id, catalog, current))}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={className}
      />
    );
  }

  const pick = (item: PickItem) => {
    onPick(source === "owned" ? (shipFromPoi(item.value, state) ?? newShipFor(owned.find((s) => s.instanceId === item.value)!.masterId, catalog, current)) : newShipFor(item.value, catalog, current));
    setOpen(false);
    setSource("owned");
  };

  return (
    <div className={cx("min-w-0", className)}>
      <PickerTrigger className={buttonClassName} prefix={prefix} label={label} placeholder={placeholder} aria-label={ariaLabel} onClick={() => setOpen(true)} />
      {view && (
        <PickerModal
          key={source}
          title={ariaLabel}
          items={view.items}
          categories={view.categories}
          categoryLabel="艦種"
          onPick={pick}
          onClose={() => (setOpen(false), setSource("owned"))}
          footer={
            <Button variant="ghost" onClick={() => setSource(source === "owned" ? "master" : "owned")}>
              {source === "owned" ? "全艦から選ぶ" : "所持艦から選ぶ"}
            </Button>
          }
        />
      )}
    </div>
  );
};
