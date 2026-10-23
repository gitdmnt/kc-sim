import React from "react";
import { isCombinedFleetType } from "@shared/fleet/types";
import type { Preset } from "@shared/fleet/types";
import { Checkbox } from "../../../ui";
import { FCF_EQUIPS, flagshipFcf } from "../sortieConfig";
import type { SortieOptionProps } from "./parts";
import { Group } from "./parts";

/** 旗艦の司令部施設と、それが使える艦隊かどうかの説明 */
const fcfHint = (preset: Preset | null): string => {
  const id = flagshipFcf(preset?.ships[0]);
  if (id === undefined) return "旗艦に司令部施設なし";
  const usable = id === 107 ? isCombinedFleetType(preset!.fleetType) : id === 272 ? preset!.fleetType === "striking_force" : true;
  return `旗艦: ${FCF_EQUIPS[id].name}${usable ? "" : ` (${FCF_EQUIPS[id].fleet}のみ有効)`}`;
};

/** 撤退 (大破・ダメコン・中破・護衛退避) と、ボス前の洋上補給・戦闘糧食 */
export const RetreatSettings = ({ prefs, setPrefs, preset }: Pick<SortieOptionProps, "prefs" | "setPrefs"> & { preset: Preset | null }) => (
  <>
    <Group title="撤退" className="col-span-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Checkbox label="大破撤退" title="旗艦大破は常に撤退" checked={prefs.onHeavy} onChange={(e) => setPrefs({ onHeavy: e.target.checked })} />
        <Checkbox label="ダメコン所持艦は進撃" checked={prefs.allowDamecon} disabled={!prefs.onHeavy} onChange={(e) => setPrefs({ allowDamecon: e.target.checked })} />
        <Checkbox label="中破撤退" checked={prefs.onModerate} onChange={(e) => setPrefs({ onModerate: e.target.checked })} />
        <Checkbox
          label="護衛退避"
          title="旗艦の艦隊司令部施設 (連合艦隊)・遊撃部隊 艦隊司令部 (遊撃部隊)・精鋭水雷戦隊 司令部で、撤退の原因の 1 隻を退避させて進撃する"
          hint={fcfHint(preset)}
          checked={prefs.useFcf}
          onChange={(e) => setPrefs({ useFcf: e.target.checked })}
        />
      </div>
    </Group>
    <Group title="ボス前の消費">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Checkbox label="洋上補給" title="洋上補給を積んでいれば、ボス (目標マス) の前に燃料・弾薬を補給する" checked={prefs.underway} onChange={(e) => setPrefs({ underway: e.target.checked })} />
        <Checkbox label="戦闘糧食" title="戦闘糧食を積んでいれば、ボス (目標マス) の前に食べて士気を上げる" checked={prefs.rations} onChange={(e) => setPrefs({ rations: e.target.checked })} />
      </div>
    </Group>
  </>
);
