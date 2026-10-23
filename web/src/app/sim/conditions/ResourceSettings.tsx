import React from "react";
import type { ResourceAmounts } from "@sim-core";
import { Checkbox, Field, NumberInput } from "../../../ui";
import { Group, Inline } from "./parts";
import type { SortieOptionProps } from "./parts";

const RES: [keyof ResourceAmounts, string][] = [
  ["fuel", "燃料"],
  ["ammo", "弾薬"],
  ["steel", "鋼材"],
  ["bauxite", "ボーキ"],
];

/** 資源: 高速修復材を使う入渠時間 (時間と分で入力し、分で保存) と、支援艦隊などの 1 出撃あたりの費用 */
export const ResourceSettings = ({ prefs, setPrefs }: Pick<SortieOptionProps, "prefs" | "setPrefs">) => {
  const min = prefs.bucketAboveMin;
  const h = Math.floor((min ?? 0) / 60);
  const m = (min ?? 0) % 60;
  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="col-span-3">
        <Checkbox
          label="入渠時間が長い艦に高速修復材を使う"
          hint="その艦の入渠時間が 0 になり、高速修復材が 1 増える (燃料・鋼材は変わらない)"
          checked={min !== null}
          onChange={(e) => setPrefs({ bucketAboveMin: e.target.checked ? 60 : null })}
        />
      </div>
      {min !== null && (
        <>
          <Field label="これを超えたら (時間)">
            <NumberInput min={0} max={99} value={h} onChange={(v) => setPrefs({ bucketAboveMin: v * 60 + m })} />
          </Field>
          <Field label="(分)">
            <NumberInput min={0} max={59} value={m} onChange={(v) => setPrefs({ bucketAboveMin: h * 60 + v })} />
          </Field>
          <span />
        </>
      )}
      <Group title="1 出撃ごとに足す費用 (支援艦隊など、計算に無いもの)" className="col-span-3">
        <div className="grid grid-cols-4 gap-2">
          {RES.map(([k, label]) => (
            <Inline key={k} label={label}>
              <NumberInput
                className="h-7! w-full"
                aria-label={`1 出撃ごとの${label}`}
                min={0}
                max={9999}
                value={prefs.extraPerSortie[k] ?? 0}
                onChange={(v) => setPrefs({ extraPerSortie: { ...prefs.extraPerSortie, [k]: v || undefined } })}
              />
            </Inline>
          ))}
        </div>
      </Group>
    </div>
  );
};
