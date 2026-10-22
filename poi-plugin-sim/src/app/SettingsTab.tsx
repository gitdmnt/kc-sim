import React, { useEffect, useState } from "react";
import { STORAGE_PREFIX } from "../fleet";
import { getObservationDb } from "../capture";
import { getDataApi } from "../data/api";
import { Button, Card, Checkbox, ConfirmDialog, Field, TextInput, S, useToast } from "../ui";
import { getPresetStore } from "./fleet/presets";
import { useApp } from "./context";
import { resetSettings, updateSettings, useSettings } from "./settings";

type Action = "presets" | "observations" | "settings" | "cache";

export const SettingsTab = () => {
  const settings = useSettings();
  const toast = useToast();
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [counts, setCounts] = useState<{ presets: number; battles: number | null }>({ presets: 0, battles: null });
  const [tick, setTick] = useState(0);
  const { state, catalog } = useApp();
  const [seeding, setSeeding] = useState(false);

  // 開発用: runBattle のログから合成の観測を作る。vite dev のみ (本番ビルドでは三項演算ごと消える)。
  // 静的 import するとメインスレッド用の wasm 初期化が本番バンドルに入るので、動的 import にしている。
  const seed = import.meta.env.DEV
    ? async () => {
        setSeeding(true);
        try {
          const { seedSyntheticObservations, TRUE_SHIFT } = await import("../estimate/devSeed");
          const r = await seedSyntheticObservations(state, catalog.master, getObservationDb(), getDataApi(), { seed: Date.now() % 100_000 });
          toast.push(`合成の戦闘 ${r.battles} 件を投入しました (真値 = API の値 + 回避 ${TRUE_SHIFT.ev} / 命中 ${TRUE_SHIFT.acc})`, "ok");
          setTick((t) => t + 1);
        } catch (e) {
          toast.push((e as Error).message, "danger");
        } finally {
          setSeeding(false);
        }
      }
    : undefined;

  useEffect(() => {
    let alive = true;
    const presets = getPresetStore().list().length;
    getObservationDb()
      .countBattles()
      .then((battles) => alive && setCounts({ presets, battles }))
      .catch(() => alive && setCounts({ presets, battles: null }));
    return () => {
      alive = false;
    };
  }, [tick]);

  const run = async (action: Action) => {
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
      } else if (action === "observations") {
        await getObservationDb().clear();
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
    observations: S.settings.clearObservations,
    settings: S.settings.resetSettings,
    cache: S.settings.clearCache,
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Card title={S.settings.api}>
        <Field label={S.settings.apiBase} hint={S.settings.apiBaseHint}>
          <TextInput
            value={settings.apiBase}
            onChange={(e) => updateSettings({ apiBase: e.target.value })}
            spellCheck={false}
            placeholder="http://127.0.0.1:8787"
          />
        </Field>
        <Field label="静的マップバンドルの場所 (URL)" hint="API に接続できないときの代替データ。空ならプラグイン同梱の maps/ を使います。" className="mt-3">
          <TextInput
            value={settings.bundleBase}
            onChange={(e) => updateSettings({ bundleBase: e.target.value })}
            spellCheck={false}
            placeholder="(空 = 同梱)"
          />
        </Field>
      </Card>

      <Card title="推定値" bodyClassName="flex flex-col gap-3">
        <Checkbox
          label="シミュレーションで推定値を使う"
          hint="パラメータ推定タブの推定値 (観測 30 回以上) を、敵の回避・命中・運として API の値より優先して使います (戦闘・出撃の両方)。"
          checked={settings.useEstimates}
          onChange={(e) => updateSettings({ useEstimates: e.target.checked })}
        />
      </Card>

      <Card title={S.settings.debug} bodyClassName="flex flex-col gap-3">
        <Checkbox
          label={S.settings.useSample}
          hint={S.settings.useSampleHint}
          checked={settings.useSampleState}
          onChange={(e) => updateSettings({ useSampleState: e.target.checked })}
        />
        {seed && (
          <div className="flex items-center gap-3">
            <Button onClick={() => void seed()} disabled={seeding}>
              {seeding ? "投入中…" : "合成データ投入"}
            </Button>
            <span className="text-xs text-ink-400">
              開発用: 第1艦隊と実在の深海棲艦で 500 戦を sim-core で回し、観測ログに追加します (送信対象外)。
            </span>
          </div>
        )}
      </Card>

      <Card title={S.settings.data} bodyClassName="flex flex-col gap-3">
        <div className="text-xs text-ink-300">
          プリセット {counts.presets} 件 / 観測ログ {counts.battles ?? "—"} 件
        </div>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(LABEL) as Action[]).map((a) => (
            <Button key={a} variant="danger" onClick={() => setConfirm(a)}>
              {LABEL[a]}
            </Button>
          ))}
        </div>
      </Card>

      {confirm && (
        <ConfirmDialog
          danger
          title={LABEL[confirm]}
          confirmLabel={S.common.delete}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void run(confirm)}
        />
      )}
    </div>
  );
};
