import React, { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { STORAGE_PREFIX } from "../fleet";
import { getDataApi } from "../data/api";
import { Card, Checkbox, ConfirmDialog, Button, Field, NumberInput, S, cx, useToast } from "../ui";
import { getPresetStore } from "./fleet/presets";
import { resetSettings, updateSettings, useSettings } from "./settings";

type Action = "presets" | "settings" | "cache";

/** シミュレーション → 計算設定: 計算に使う敵のデータ (隠しステータスの推定値、敵編成の出典) */
export const SimSettingsTab = () => {
  const settings = useSettings();
  return (
    <Card className="max-w-xl" bodyClassName="flex flex-col gap-3">
      <h4 className="text-xs text-ink-400">{S.settings.enemyData}</h4>
      <div title="観測 30 回以上の推定値">
        <Checkbox
          label="サーバの推定値を使う"
          checked={settings.useEstimates}
          onChange={(e) => updateSettings({ useEstimates: e.target.checked })}
        />
      </div>
      <Field label="観測を優先する遭遇数" className="w-fit">
        <NumberInput title="これ以上の観測があるノードは KCNav ではなく観測の敵編成を使う" className="w-24" value={settings.minObserved} min={1} max={100000} onChange={(minObserved) => updateSettings({ minObserved })} />
      </Field>
    </Card>
  );
};

/** 全体の設定 (左のバーの下端): poi のデータの代わり、保存したデータの消去と設定の初期化 */
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
    <Card className="max-w-xl" bodyClassName="flex flex-col gap-6">
      {/* 普段は出撃タブの空状態から入る。オンのときは戻せるよう常に出す */}
      {(import.meta.env.DEV || settings.useSampleState) && (
        <section className="flex flex-col gap-3">
          <h4 className="text-xs text-ink-400">{S.settings.poiData}</h4>
          <Checkbox label={S.settings.useSample} checked={settings.useSampleState} onChange={(e) => updateSettings({ useSampleState: e.target.checked })} />
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h4 className="text-xs text-ink-400">{S.settings.data}</h4>
        <ul className="grid grid-cols-[12rem_auto] items-center gap-x-4 gap-y-2">
          {DATA_ROWS.map((r) => (
            <li key={r.action} className="contents">
              <span className="text-sm text-ink-100">
                {r.label}
                {r.count !== undefined && <span className="ml-2 text-ink-400 tabular-nums">{S.common.count(r.count)}</span>}
              </span>
              <Button size="sm" className={cx("w-24", r.danger && "text-danger-400!")} onClick={() => setConfirm(r.action)}>
                {r.danger && <Trash2 size={14} aria-hidden />}
                {r.button}
              </Button>
            </li>
          ))}
        </ul>
      </section>

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
