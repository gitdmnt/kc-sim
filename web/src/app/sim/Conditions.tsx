import React from "react";
import { Dices } from "lucide-react";
import type { Formation, NightPolicy } from "@sim-core";
import type { EnemyCompSet, MapNode, RoutingDoc } from "@shared/data/types";
import type { PresetFormation } from "@shared/fleet/types";
import { FORMATION_NAME } from "../../data/routing";
import { flagNames, hasStartRules, selectNodes, startNodes } from "../../sim/sortieAdapter";
import { Button, Checkbox, Field, NumberInput, Select, S } from "../../ui";
import type { OfferedKind, SimMode, WorkspacePrefs } from "./prefs";

const NIGHT_LABEL: Record<NightPolicy, string> = {
  never: "夜戦しない",
  bossOnly: "ボスのみ夜戦",
  always: "全戦闘で夜戦",
  ifNotSRank: "S勝利でなければ夜戦",
  ifNotARank: "A勝利でなければ夜戦",
};
const KIND_LABEL: Record<OfferedKind, string> = { day: "昼戦のみ", dayNight: "昼戦 → 夜戦", nightOnly: "夜戦マス" };
const FORMATIONS: Formation[] = ["lineAhead", "doubleLine", "diamond", "echelon", "lineAbreast", "vanguard"];
const COUNTS = [10_000, 50_000, 100_000, 500_000];
export const DIFF = ["通常", "丁", "丙", "乙", "甲"];
/** 通常艦隊の陣形 (連合艦隊は未対応) */
const PRESET_FORMATIONS = Object.keys(S.formations) as (keyof typeof S.formations)[];

/** 海域ごとの出撃条件 (保存しない)。 */
export interface MapConfig {
  /** 出撃地点。"" は規則 (start.rules) で自動 */
  start: string;
  selects: Record<string, string>;
  flags: Record<string, boolean>;
  /** ノード → 陣形。無いノードは自動 */
  formations: Record<string, Formation>;
  phase?: number;
  gaugeNo?: number;
  gaugeKind: "none" | "kill" | "hp";
  remaining: number;
  /** HP ゲージ最終形態の編成セット (`難易度:取得日時`)。"" はボスマスと同じ */
  finalSetKey: string;
  /** 単一マス戦闘の敵編成 ("all" は出現率で重み付け)。compNode と違うノードでは "all" */
  compId: string;
  compNode: string;
}

export const defaultMapConfig = (routing: RoutingDoc | null): MapConfig => ({
  start: hasStartRules(routing) ? "" : startNodes(routing)[0],
  selects: {},
  flags: {},
  formations: {},
  phase: (routing?.defaults as { phase?: number } | undefined)?.phase,
  gaugeKind: "none",
  remaining: 4,
  finalSetKey: "",
  compId: "all",
  compNode: "",
});

export const fmtCount = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1000 ? `${n / 1000}k` : String(n));

const Group = ({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) => (
  <div className={className}>
    <div className="mb-1 text-xs text-ink-400">{title}</div>
    <div className="flex flex-col gap-1">{children}</div>
  </div>
);

interface Props {
  mode: SimMode;
  prefs: WorkspacePrefs;
  setPrefs: (p: Partial<WorkspacePrefs>) => void;
  routing: RoutingDoc | null;
  cfg: MapConfig;
  setCfg: (p: Partial<MapConfig>) => void;
  /** 敵編成のある戦闘ノード (ノード別陣形用) */
  battleNodes: MapNode[];
  bossSets: EnemyCompSet[];
  formation: PresetFormation | null;
  setFormation: (f: PresetFormation) => void;
}

/** 条件パネル (ツールバーの「条件」)。 */
export const Conditions = ({ mode, prefs, setPrefs, routing, cfg, setCfg, battleNodes, bossSets, formation, setFormation }: Props) => {
  const starts = startNodes(routing);
  const selNodes = selectNodes(routing);
  const flags = flagNames(routing);

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
          <Select value={formation ?? "line_ahead"} disabled={!formation} onChange={(e) => setFormation(e.target.value as PresetFormation)}>
            {PRESET_FORMATIONS.map((f) => (
              <option key={f} value={f}>
                {S.formations[f]}
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

  return (
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
      <Group title="撤退" className="col-span-2">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <Checkbox label="大破撤退" title="旗艦大破は常に撤退" checked={prefs.onHeavy} onChange={(e) => setPrefs({ onHeavy: e.target.checked })} />
          <Checkbox label="ダメコン持ちは継続" checked={prefs.allowDamecon} disabled={!prefs.onHeavy} onChange={(e) => setPrefs({ allowDamecon: e.target.checked })} />
          <Checkbox label="中破撤退" checked={prefs.onModerate} onChange={(e) => setPrefs({ onModerate: e.target.checked })} />
        </div>
      </Group>

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
            value={cfg.selects[node] ?? routing?.defaults?.select?.[node] ?? options[0]}
            onChange={(e) => setCfg({ selects: { ...cfg.selects, [node]: e.target.value } })}
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

      <Field label="ゲージ">
        <Select value={cfg.gaugeKind} onChange={(e) => setCfg({ gaugeKind: e.target.value as MapConfig["gaugeKind"] })}>
          <option value="none">指定なし</option>
          <option value="kill">撃破数ゲージ</option>
          <option value="hp">HPゲージ</option>
        </Select>
      </Field>
      {cfg.gaugeKind !== "none" && (
        <Field label={cfg.gaugeKind === "kill" ? "残り撃破数" : "残りHP"}>
          <NumberInput min={1} max={99999} value={cfg.remaining} onChange={(remaining) => setCfg({ remaining })} />
        </Field>
      )}
      {cfg.gaugeKind === "hp" && bossSets.length > 1 && (
        <Field label="最終形態の編成">
          <Select value={cfg.finalSetKey} onChange={(e) => setCfg({ finalSetKey: e.target.value })}>
            <option value="">ボスマスと同じ</option>
            {bossSets.map((s) => (
              <option key={`${s.difficulty}:${s.retrievedAt}`} value={`${s.difficulty}:${s.retrievedAt}`}>
                {DIFF[s.difficulty]} / {s.periodStart ?? "?"}〜 ({s.totalCount.toLocaleString()}回)
              </option>
            ))}
          </Select>
        </Field>
      )}

      {battleNodes.length > 0 && (
        <>
          <div className="col-span-3 h-px bg-ink-800" />
          {battleNodes.map((n) => (
            <Field key={n.letter} label={`陣形 ${n.letter}`}>
              <Select
                value={cfg.formations[n.letter] ?? ""}
                onChange={(e) => {
                  const { [n.letter]: _drop, ...rest } = cfg.formations;
                  setCfg({ formations: e.target.value ? { ...rest, [n.letter]: e.target.value as Formation } : rest });
                }}
              >
                <option value="">自動</option>
                {FORMATIONS.map((f, i) => (
                  <option key={f} value={f}>
                    {FORMATION_NAME[i + 1]}
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
  );
};
