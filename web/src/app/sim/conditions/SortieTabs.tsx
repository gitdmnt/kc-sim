import React, { useState } from "react";
import type { EnemyCompSet, MapNode } from "@shared/data/types";
import { Tabs } from "../../../ui";
import { GaugeSettings } from "./GaugeSettings";
import { NodeChoices } from "./NodeChoices";
import type { SortieOptionProps } from "./parts";
import { ResourceSettings } from "./ResourceSettings";

type Section = "basic" | "nodes" | "gauge" | "resources";

/** 出撃の条件を基本・マス・ゲージ・資源に分ける。`basic` は夜戦・撤退・分岐・陣形・計算の欄 */
export const SortieTabs = ({ basic, nodes, bossSets, ...props }: SortieOptionProps & { basic: React.ReactNode; nodes: MapNode[]; bossSets: EnemyCompSet[] }) => {
  const [section, setSection] = useState<Section>("basic");
  const { prefs, mapPrefs } = props;
  const nodeCount = Object.keys(mapPrefs.advance).length + Object.keys(mapPrefs.effects).length;
  const g = mapPrefs.gauge;
  const resCount = Number(prefs.bucketAboveMin !== null) + Number(Object.values(prefs.extraPerSortie).some(Boolean));
  return (
    <div className="flex flex-col gap-3">
      <Tabs<Section>
        variant="pill"
        size="sm"
        value={section}
        onChange={setSection}
        tabs={[
          { id: "basic", label: "基本" },
          { id: "nodes", label: "マス", hint: nodeCount ? String(nodeCount) : undefined },
          { id: "gauge", label: "ゲージ", hint: g.kind === "none" ? (prefs.consecutive.enabled ? "連続" : undefined) : String(1 + g.extra.length) },
          { id: "resources", label: "資源", hint: resCount ? String(resCount) : undefined },
        ]}
      />
      {section === "basic" && basic}
      {section === "nodes" && <NodeChoices {...props} nodes={nodes} />}
      {section === "gauge" && <GaugeSettings {...props} bossSets={bossSets} />}
      {section === "resources" && <ResourceSettings {...props} />}
    </div>
  );
};
