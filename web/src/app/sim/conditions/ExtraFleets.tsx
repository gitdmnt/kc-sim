import React from "react";
import type { SupportType } from "@sim-core";
import type { Preset } from "@shared/fleet/types";
import { Checkbox, NumberInput, Select, S } from "../../../ui";
import type { SimMode, SupportPref, WorkspacePrefs } from "../prefs";
import type { SortieMapPrefs } from "../sortieConfig";
import { Group, Inline } from "./parts";

const TYPES: (SupportType | "auto")[] = ["auto", "air", "shelling", "torpedo", "asw"];

interface Props {
  mode: SimMode;
  prefs: WorkspacePrefs;
  setPrefs: (p: Partial<WorkspacePrefs>) => void;
  /** 出撃のみ: 海域ごとの条件 (基地空襲・友軍のマス) */
  mapPrefs?: SortieMapPrefs;
  setMapPrefs?: (p: Partial<SortieMapPrefs>) => void;
  /** 出撃のみ: 戦闘マスと、敵編成のあるマス */
  nodes?: string[];
  compNodes?: string[];
  preset: Preset | null;
}

/** 支援艦隊・友軍艦隊・基地空襲の条件。艦は左の「支援」「友軍」タブで編成する */
export const ExtraFleets = ({ mode, prefs, setPrefs, mapPrefs, setMapPrefs, nodes = [], compNodes = [], preset }: Props) => {
  const T = S.extraFleets;
  const count = (k: "supportNode" | "supportBoss" | "friendFleet") => preset?.[k]?.length ?? 0;
  const raid = mapPrefs?.baseRaid;
  const setRaid = (p: Partial<NonNullable<SortieMapPrefs["baseRaid"]>>) =>
    setMapPrefs?.({ baseRaid: { node: raid?.node ?? "", chancePct: raid?.chancePct ?? 100, compNode: raid?.compNode ?? compNodes[0] ?? "", ...p } });

  return (
    <div className="flex flex-col gap-3">
      <Group title={T.supportTitle}>
        {(["node", "boss"] as const).map((k) => (
          <div key={k} className="flex items-center gap-3">
            <Checkbox
              className="w-40"
              label={T.support(k, count(k === "node" ? "supportNode" : "supportBoss"))}
              checked={prefs.support[k].enabled}
              onChange={(e) => setPrefs({ support: { ...prefs.support, [k]: { ...prefs.support[k], enabled: e.target.checked } } })}
            />
            <Inline label={T.type}>
              <Select
                className="h-6! w-24"
                value={prefs.support[k].type}
                disabled={!prefs.support[k].enabled}
                onChange={(e) => setPrefs({ support: { ...prefs.support, [k]: { ...prefs.support[k], type: e.target.value as SupportPref["type"] } } })}
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {T.types[t]}
                  </option>
                ))}
              </Select>
            </Inline>
          </div>
        ))}
        <p className="text-xs text-ink-500">{T.supportHint}</p>
        {mode === "battle" && <p className="text-xs text-ink-500">{T.battleSupportHint}</p>}
      </Group>

      <Group title={T.friendTitle}>
        <div className="flex items-center gap-3">
          <Checkbox className="w-40" label={T.friend(count("friendFleet"))} checked={prefs.friend.enabled} onChange={(e) => setPrefs({ friend: { ...prefs.friend, enabled: e.target.checked } })} />
          <Inline label={T.chance}>
            <NumberInput className="w-16" min={0} max={100} value={prefs.friend.chancePct} disabled={!prefs.friend.enabled} onChange={(chancePct) => setPrefs({ friend: { ...prefs.friend, chancePct } })} />
          </Inline>
          {mode === "sortie" && (
            <Inline label={T.node}>
              <Select className="h-6! w-24" value={mapPrefs?.friendNode ?? ""} disabled={!prefs.friend.enabled} onChange={(e) => setMapPrefs?.({ friendNode: e.target.value })}>
                <option value="">{T.targetNode}</option>
                {nodes.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Inline>
          )}
        </div>
      </Group>

      <Group title={T.raidTitle}>
        {mode === "battle" ? (
          <Checkbox label={T.battleRaid} checked={prefs.battleRaid} onChange={(e) => setPrefs({ battleRaid: e.target.checked })} />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Inline label={T.raidNode}>
              <Select className="h-6! w-20" value={raid?.node ?? ""} onChange={(e) => setRaid({ node: e.target.value })}>
                <option value="">{T.noRaid}</option>
                {nodes.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Inline>
            <Inline label={T.chance}>
              <NumberInput className="w-16" min={0} max={100} value={raid?.chancePct ?? 100} disabled={!raid?.node} onChange={(chancePct) => setRaid({ chancePct })} />
            </Inline>
            <Inline label={T.raider}>
              <Select className="h-6! w-20" value={raid?.compNode ?? ""} disabled={!raid?.node} onChange={(e) => setRaid({ compNode: e.target.value })}>
                {compNodes.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Inline>
          </div>
        )}
        <p className="text-xs text-ink-500">{T.raidHint}</p>
      </Group>
    </div>
  );
};
