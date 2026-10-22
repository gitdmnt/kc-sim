import React, { useEffect, useState } from "react";
import { STORAGE_PREFIX } from "../fleet";
import { getDataApi } from "../data/api";
import { Card, Checkbox, ConfirmDialog, Field, Button, S, useToast } from "../ui";
import { getPresetStore } from "./fleet/presets";
import { resetSettings, updateSettings, useSettings } from "./settings";
import { NumberInput } from "../ui/NumberInput";

type Action = "presets" | "settings" | "cache";

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
  // 消すと戻せないもの (プリセット) だけ danger。行の主役は項目名と件数で、ボタンは小さく右に寄せる。
  const DATA_ROWS: { action: Action; label: string; count?: number; button: string; danger: boolean }[] = [
    { action: "presets", label: S.settings.presets, count: presetCount, button: S.settings.deleteAll, danger: true },
    { action: "cache", label: S.settings.cache, button: S.settings.clear, danger: false },
    { action: "settings", label: S.settings.settings, button: S.settings.reset, danger: false },
  ];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Card title="推定値" bodyClassName="flex flex-col gap-3">
        <Checkbox
          label="シミュレーションで推定値を使う"
          hint="サーバが観測から求めた推定値 (観測 30 回以上) を使います。オフのときは使いません"
          checked={settings.useEstimates}
          onChange={(e) => updateSettings({ useEstimates: e.target.checked })}
        />
      </Card>

      <Card title="敵編成の出典" bodyClassName="flex flex-col gap-3">
        <Field label="観測を優先する遭遇数" hint="このノード・難易度の自分たちの観測 (poi) がこの数以上なら観測の集計、未満なら KCNav を使います">
          <NumberInput className="w-28" value={settings.minObserved} min={1} max={100000} onChange={(minObserved) => updateSettings({ minObserved })} />
        </Field>
      </Card>

      <Card title={S.settings.debug} bodyClassName="flex flex-col gap-3">
        <Checkbox
          label={S.settings.useSample}
          hint={S.settings.useSampleHint}
          checked={settings.useSampleState}
          onChange={(e) => updateSettings({ useSampleState: e.target.checked })}
        />
      </Card>

      <Card title={S.settings.data} bodyClassName="flex flex-col divide-y divide-ink-700">
        {DATA_ROWS.map((r) => (
          <div key={r.action} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
            <span className="text-sm text-ink-100">
              {r.label}
              {r.count !== undefined && <span className="ml-2 text-ink-400 tabular-nums">{S.common.count(r.count)}</span>}
            </span>
            <Button size="sm" variant={r.danger ? "danger" : "secondary"} onClick={() => setConfirm(r.action)}>
              {r.button}
            </Button>
          </div>
        ))}
      </Card>

      {confirm && (
        <ConfirmDialog
          danger
          title={LABEL[confirm]}
          confirmLabel={S.common.delete}
          onCancel={() => setConfirm(null)}
          onConfirm={() => run(confirm)}
        />
      )}
    </div>
  );
};
