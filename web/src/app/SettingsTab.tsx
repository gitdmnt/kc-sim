import React, { useEffect, useState } from "react";
import { STORAGE_PREFIX } from "../fleet";
import { getDataApi } from "../data/api";
import { Card, ConfirmDialog, Button, NumberInput, S, useToast } from "../ui";
import { getPresetStore } from "./fleet/presets";
import { resetSettings, updateSettings, useSettings } from "./settings";

type Action = "presets" | "settings" | "cache";

const Row = ({ label, title, children }: { label: React.ReactNode; title?: string; children: React.ReactNode }) => (
  <div className="flex min-h-11 items-center justify-between gap-3 py-1.5" title={title}>
    <span className="text-sm text-ink-100">{label}</span>
    {children}
  </div>
);

const Toggle = ({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) => (
  <input type="checkbox" aria-label={label} className="h-4 w-4 cursor-pointer accent-accent-500" checked={checked} onChange={(e) => onChange(e.target.checked)} />
);

export const SettingsTab = () => {
  const settings = useSettings();
  const toast = useToast();
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [presetCount, setPresetCount] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setPresetCount(getPresetStore().list().length);
  }, [tick]);

  const run = (action: Action) => {
    setConfirm(null);
    try {
      if (action === "presets") {
        const store = getPresetStore();
        store.list().forEach((p) => store.remove(p.id));
        try {
          localStorage.removeItem(`${STORAGE_PREFIX}selectedPreset`);
        } catch {
          // ignore
        }
      } else if (action === "cache") {
        getDataApi().clearCache();
      } else {
        resetSettings();
      }
      toast.push(S.settings.done, "ok");
      setTick((t) => t + 1);
    } catch (e) {
      toast.push((e as Error).message, "danger");
    }
  };

  const LABEL: Record<Action, string> = {
    presets: S.settings.clearPresets,
    settings: S.settings.resetSettings,
    cache: S.settings.clearCache,
  };
  // 消すと戻せないもの (プリセット) だけ danger
  const DATA_ROWS: { action: Action; label: string; count?: number; button: string; danger: boolean }[] = [
    { action: "presets", label: S.settings.presets, count: presetCount, button: S.settings.deleteAll, danger: true },
    { action: "cache", label: S.settings.cache, button: S.settings.clear, danger: false },
    { action: "settings", label: S.settings.settings, button: S.settings.reset, danger: false },
  ];

  return (
    <Card className="mx-auto max-w-2xl" bodyClassName="flex flex-col divide-y divide-ink-700 py-1">
      <Row label="サーバの推定値を使う" title="観測 30 回以上の推定値">
        <Toggle label="サーバの推定値を使う" checked={settings.useEstimates} onChange={(useEstimates) => updateSettings({ useEstimates })} />
      </Row>
      <Row label="観測を優先する遭遇数" title="これ以上の観測があるノードは KCNav ではなく観測の敵編成を使う">
        <NumberInput className="w-24" value={settings.minObserved} min={1} max={100000} onChange={(minObserved) => updateSettings({ minObserved })} />
      </Row>
      {/* 普段は出撃タブの空状態から入る。オンのときは戻せるよう常に出す */}
      {(import.meta.env.DEV || settings.useSampleState) && (
        <Row label={S.settings.useSample}>
          <Toggle label={S.settings.useSample} checked={settings.useSampleState} onChange={(useSampleState) => updateSettings({ useSampleState })} />
        </Row>
      )}
      {DATA_ROWS.map((r) => (
        <Row
          key={r.action}
          label={
            <>
              {r.label}
              {r.count !== undefined && <span className="ml-2 text-ink-400 tabular-nums">{S.common.count(r.count)}</span>}
            </>
          }
        >
          <Button size="sm" variant={r.danger ? "danger" : "secondary"} onClick={() => setConfirm(r.action)}>
            {r.button}
          </Button>
        </Row>
      ))}

      {confirm && (
        <ConfirmDialog
          danger
          title={LABEL[confirm]}
          confirmLabel={DATA_ROWS.find((r) => r.action === confirm)?.button}
          onCancel={() => setConfirm(null)}
          onConfirm={() => run(confirm)}
        />
      )}
    </Card>
  );
};
