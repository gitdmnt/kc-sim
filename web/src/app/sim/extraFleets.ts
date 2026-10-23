/** 条件 (支援艦隊・友軍艦隊・基地空襲) → 出撃 / 単一戦闘の計算の入力と、結果の基地空襲の説明。 */
import type { AirState, BaseRaidSummary } from "@sim-core";
import type { SortieSettings } from "../../sim/sortieAdapter";
import { S } from "../../ui";
import { pct } from "./bars";
import type { BattleExtras } from "./requests";
import type { WorkspacePrefs } from "./prefs";
import type { SortieMapPrefs } from "./sortieConfig";

type ExtraPrefs = Pick<WorkspacePrefs, "support" | "friend" | "battleRaid">;

/** 出す枠だけ。種別 auto は省く (エンジンが編成から決める) */
const supportOf = (p: ExtraPrefs): SortieSettings["support"] => {
  const [node, boss] = [p.support.node, p.support.boss].map((s) => (s.enabled ? (s.type === "auto" ? {} : { type: s.type }) : undefined));
  return node || boss ? { ...(node && { node }), ...(boss && { boss }) } : undefined;
};

const AIR_LABEL: Record<AirState, string> = { none: "航空戦なし", supremacy: "確保", superiority: "優勢", parity: "均衡", denial: "劣勢", incapability: "喪失" };

/** 基地空襲の結果の説明 (制空の割合と、基地ごとの HP 減少の平均)。`bases` は hpLostMean の各基地の番号 */
export const raidTitle = (r: BaseRaidSummary, bases: number[]): string =>
  [
    `${S.extraFleets.raidAir}: ${(Object.keys(AIR_LABEL) as AirState[])
      .filter((k) => r.airStateRates[k] >= 0.0005)
      .map((k) => `${AIR_LABEL[k]} ${pct(r.airStateRates[k])}`)
      .join(" · ")}`,
    ...r.hpLostMean.map((hp, i) => `${S.extraFleets.raidHp(bases[i] ?? i + 1)} ${hp.toFixed(1)}`),
  ].join("\n");

/** 出撃: 支援 (道中 / 決戦)、友軍 (海域ごとのマス、空は目標マス)、基地空襲 (海域ごと) */
export const sortieExtrasOf = (p: ExtraPrefs, m: SortieMapPrefs): Pick<SortieSettings, "support" | "friendFleet" | "baseRaid"> => {
  const support = supportOf(p);
  return {
    ...(support && { support }),
    ...(p.friend.enabled && { friendFleet: { chance: p.friend.chancePct / 100, nodes: m.friendNode ? [m.friendNode] : [] } }),
    ...(m.baseRaid?.node && m.baseRaid.compNode && { baseRaid: { node: m.baseRaid.node, chance: m.baseRaid.chancePct / 100, compNode: m.baseRaid.compNode } }),
  };
};

/** 単一戦闘: 選んだマスがボスなら決戦支援、ほかは道中支援 */
export const battleExtrasOf = (p: ExtraPrefs, boss: boolean): BattleExtras => {
  const support = supportOf(p);
  return {
    boss,
    ...(support && { support }),
    ...(p.friend.enabled && { friendChance: p.friend.chancePct / 100 }),
    ...(p.battleRaid && { baseRaid: true }),
  };
};
