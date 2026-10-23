import React from "react";
import { Dices } from "lucide-react";
import type { Formation, NightPolicy } from "@sim-core";
import type { EnemyCompSet, MapNode, RoutingDoc } from "@shared/data/types";
import type { Preset, PresetFormation } from "@shared/fleet/types";
import { FORMATION_NAME } from "../../data/routing";
import { flagNames, hasStartRules, selectNodes, startNodes } from "../../sim/sortieAdapter";
import { Button, Checkbox, Field, NumberInput, Select, S } from "../../ui";
import type { OfferedKind, SimMode, WorkspacePrefs } from "./prefs";
import { mapPrefsOf } from "./sortieConfig";
import type { SortieMapPrefs } from "./sortieConfig";
import { Group } from "./conditions/parts";
import { RetreatSettings } from "./conditions/RetreatSettings";
import { SortieTabs } from "./conditions/SortieTabs";

const NIGHT_LABEL: Record<NightPolicy, string> = {
  never: "夜戦しない",
  bossOnly: "ボスのみ夜戦",
  always: "全戦闘で夜戦",
  ifNotSRank: "S勝利でなければ夜戦",
  ifNotARank: "A勝利でなければ夜戦",
};
const KIND_LABEL: Record<OfferedKind, string> = { day: "昼戦のみ", dayNight: "昼戦 → 夜戦", nightOnly: "夜戦マス" };
const FORMATIONS: Formation[] = ["lineAhead", "doubleLine", "diamond", "echelon", "lineAbreast", "vanguard"];
/** 連合艦隊の陣形 (第一〜第四警戒航行序列 = FORMATION_NAME 11〜14) */
const COMBINED_FORMATIONS: Formation[] = ["combinedAntiSub", "combinedForward", "combinedDiamond", "combinedBattle"];
const COUNTS = [10_000, 50_000, 100_000, 500_000];
export { DIFF } from "./conditions/parts";
const PRESET_FORMATIONS: Record<PresetFormation, string> = { ...S.formations, ...S.combinedFormations };
const SINGLE_KEYS = Object.keys(S.formations) as PresetFormation[];
const COMBINED_KEYS = Object.keys(S.combinedFormations) as PresetFormation[];

/** 海域ごとの出撃条件 (保存しない。能動分岐は prefs.selects)。 */
export interface MapConfig {
  /** 出撃地点。"" は規則 (start.rules) で自動 */
  start: string;
  flags: Record<string, boolean>;
  /** ノード → 陣形。無いノードは自動 */
  formations: Record<string, Formation>;
  phase?: number;
  gaugeNo?: number;
  /** 単一マス戦闘の敵編成 ("all" は出現率で重み付け)。compNode と違うノードでは "all" */
  compId: string;
  compNode: string;
}

export const defaultMapConfig = (routing: RoutingDoc | null): MapConfig => ({
  start: hasStartRules(routing) ? "" : startNodes(routing)[0],
  flags: {},
  formations: {},
  phase: (routing?.defaults as { phase?: number } | undefined)?.phase,
  compId: "all",
  compNode: "",
});

export const fmtCount = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1000 ? `${n / 1000}k` : String(n));

interface Props {
  mode: SimMode;
  prefs: WorkspacePrefs;
  setPrefs: (p: Partial<WorkspacePrefs>) => void;
  routing: RoutingDoc | null;
  cfg: MapConfig;
  setCfg: (p: Partial<MapConfig>) => void;
  /** 能動分岐ノード → 出撃に使う行き先 (resolveSelects) */
  selects: Record<string, string>;
  /** 敵編成のある戦闘ノード (ノード別陣形用) */
  battleNodes: MapNode[];
  bossSets: EnemyCompSet[];
  formation: PresetFormation | null;
  setFormation: (f: PresetFormation) => void;
  /** 連合艦隊 (陣形の選択肢が警戒航行序列になる) */
  combined: boolean;
  /** 海域の全マス (マスごとの進撃・効果) */
  nodes: MapNode[];
  /** 護衛退避の司令部施設の表示用 */
  preset: Preset | null;
}

/** 条件パネル (ツールバーの「条件」)。 */
export const Conditions = ({ mode, prefs, setPrefs, routing, cfg, setCfg, selects, battleNodes, bossSets, formation, setFormation, combined, nodes, preset }: Props) => {
  const starts = startNodes(routing);
  const selNodes = selectNodes(routing);
  const flags = flagNames(routing);
  const presetKeys = combined ? COMBINED_KEYS : SINGLE_KEYS;
  const nodeFormations = combined ? COMBINED_FORMATIONS : FORMATIONS;
  const nodeFormationBase = combined ? 11 : 1;

  const common = (
    <>
      <Group title="計算">
        <Checkbox label="装備ボーナスを考慮" checked={prefs.applyFit} onChange={(e) => setPrefs({ applyFit: e.target.checked })} />
      </Group>
      <Field label="実行の回数">
        <Select value={prefs.count} onChange={(e) => setPrefs({ count: Number(e.target.value) })}>
          {COUNTS.map((c) => (
            <option key={c} value={c}>
              {c.toLocaleString()}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="乱数シード">
        <div className="flex items-center gap-1">
          <NumberInput className="w-full" min={0} max={2 ** 31} value={prefs.seed} onChange={(seed) => setPrefs({ seed })} />
          <Button size="md" icon onClick={() => setPrefs({ seed: Math.floor(Math.random() * 2 ** 31) })} title="ランダムなシード" aria-label="ランダムなシード">
            <Dices size={16} aria-hidden />
          </Button>
        </div>
      </Field>
    </>
  );

  if (mode === "battle") {
    return (
      <div className="grid grid-cols-3 gap-3">
        <Field label={S.fleet.formation}>
          <Select value={formation ?? presetKeys[0]} disabled={!formation} onChange={(e) => setFormation(e.target.value as PresetFormation)}>
            {presetKeys.map((f) => (
              <option key={f} value={f}>
                {PRESET_FORMATIONS[f]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="戦闘種別">
          <Select value={prefs.battleKind} onChange={(e) => setPrefs({ battleKind: e.target.value as OfferedKind })}>
            {(Object.keys(KIND_LABEL) as OfferedKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <span />
        {common}
      </div>
    );
  }

  const mapPrefs = mapPrefsOf(prefs.sortieMaps, prefs.map);
  const setMapPrefs = (p: Partial<SortieMapPrefs>) => setPrefs({ sortieMaps: { ...prefs.sortieMaps, [prefs.map]: { ...mapPrefs, ...p } } });
  return (
    <SortieTabs prefs={prefs} setPrefs={setPrefs} mapPrefs={mapPrefs} setMapPrefs={setMapPrefs} nodes={nodes} bossSets={bossSets} basic={
    <div className="grid grid-cols-3 gap-3">
      <Field label="夜戦">
        <Select value={prefs.night} onChange={(e) => setPrefs({ night: e.target.value as NightPolicy })}>
          {(Object.keys(NIGHT_LABEL) as NightPolicy[]).map((k) => (
            <option key={k} value={k}>
              {NIGHT_LABEL[k]}
            </option>
          ))}
        </Select>
      </Field>
      <RetreatSettings prefs={prefs} setPrefs={setPrefs} preset={preset} />

      {starts.length > 1 && (
        <Field label="出撃地点">
          <Select value={cfg.start} onChange={(e) => setCfg({ start: e.target.value })}>
            {hasStartRules(routing) && <option value="">自動</option>}
            {starts.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {Object.entries(selNodes).map(([node, options]) => (
        <Field key={node} label={`能動分岐 ${node}`}>
          <Select
            value={selects[node]}
            onChange={(e) => setPrefs({ selects: { ...prefs.selects, [prefs.map]: { ...prefs.selects[prefs.map], [node]: e.target.value } } })}
          >
            {options.map((o) => (
              <option key={o} value={o}>
                → {o}
              </option>
            ))}
          </Select>
        </Field>
      ))}
      {flags.length > 0 && (
        <Group title="フラグ" className="col-span-3">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {flags.map((f) => (
              <Checkbox
                key={f.name}
                label={f.name}
                checked={cfg.flags[f.name] ?? f.default}
                onChange={(e) => setCfg({ flags: { ...cfg.flags, [f.name]: e.target.checked } })}
              />
            ))}
          </div>
        </Group>
      )}

      {battleNodes.length > 0 && (
        <>
          <div className="col-span-3 h-px bg-ink-800" />
          {battleNodes.map((n) => (
            <Field key={n.letter} label={`陣形 ${n.letter}`}>
              <Select
                value={nodeFormations.find((f) => f === cfg.formations[n.letter]) ?? ""}
                onChange={(e) => {
                  const { [n.letter]: _drop, ...rest } = cfg.formations;
                  setCfg({ formations: e.target.value ? { ...rest, [n.letter]: e.target.value as Formation } : rest });
                }}
              >
                <option value="">自動</option>
                {nodeFormations.map((f, i) => (
                  <option key={f} value={f}>
                    {FORMATION_NAME[nodeFormationBase + i]}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
          <Field label="フェーズ">
            <NumberInput min={1} max={20} value={cfg.phase ?? 1} onChange={(phase) => setCfg({ phase })} />
          </Field>
          <Field label="ゲージ番号">
            <NumberInput min={1} max={20} value={cfg.gaugeNo ?? 1} onChange={(gaugeNo) => setCfg({ gaugeNo })} />
          </Field>
        </>
      )}

      <div className="col-span-3 h-px bg-ink-800" />
      {common}
    </div>
    } />
  );
};
