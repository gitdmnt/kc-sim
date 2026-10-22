import React, { useEffect, useState } from "react";
import { STORAGE_PREFIX } from "../fleet";
import { AUTO_UPLOAD_STATUS_KEY, getObservationDb, readAutoUploadStatus } from "../capture";
import type { AutoUploadStatus } from "../capture";
import { getDataApi } from "../data/api";
import { Button, Card, Checkbox, ConfirmDialog, Field, TextInput, S, useToast } from "../ui";
import { getPresetStore } from "./fleet/presets";
import { useApp } from "./context";
import { resetSettings, updateSettings, useSettings } from "./settings";
import { NumberInput } from "../ui/NumberInput";

/** 自動送信の状況。送信はメインウィンドウで動くので、状態は localStorage (storage イベント) と共有の IndexedDB から読む。 */
const useAutoUploadStatus = (): { status: AutoUploadStatus; pending: number | null } => {
  const [status, setStatus] = useState(readAutoUploadStatus);
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      setStatus(readAutoUploadStatus());
      getObservationDb()
        .countPending()
        .then((n) => alive && setPending(n))
        .catch(() => alive && setPending(null));
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === AUTO_UPLOAD_STATUS_KEY) refresh();
    };
    refresh();
    const timer = setInterval(refresh, 5_000);
    window.addEventListener("storage", onStorage);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return { status, pending };
};

const formatTime = (t: number | null) => (t === null ? "—" : new Date(t).toLocaleString());

type Action = "presets" | "observations" | "settings" | "cache";

export const SettingsTab = () => {
  const settings = useSettings();
  const toast = useToast();
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [counts, setCounts] = useState<{ presets: number; battles: number | null }>({ presets: 0, battles: null });
  const [tick, setTick] = useState(0);
  const { state, catalog } = useApp();
  const [seeding, setSeeding] = useState(false);
  const upload = useAutoUploadStatus();

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
  // 消すと戻せないもの (プリセット・観測ログ) だけ danger。行の主役は項目名と件数で、ボタンは小さく右に寄せる。
  const DATA_ROWS: { action: Action; label: string; count?: number | null; button: string; danger: boolean }[] = [
    { action: "presets", label: S.settings.presets, count: counts.presets, button: S.settings.deleteAll, danger: true },
    { action: "observations", label: S.settings.observations, count: counts.battles, button: S.settings.deleteAll, danger: true },
    { action: "cache", label: S.settings.cache, button: S.settings.clear, danger: false },
    { action: "settings", label: S.settings.settings, button: S.settings.reset, danger: false },
  ];

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
        <Field label="オフライン用マップデータ URL" className="mt-3">
          <TextInput
            value={settings.bundleBase}
            onChange={(e) => updateSettings({ bundleBase: e.target.value })}
            spellCheck={false}
            placeholder="空欄 = 同梱データ"
          />
        </Field>
        <div className="mt-3 flex flex-col gap-2">
          <Checkbox
            label="観測ログを自動送信"
            hint="戦闘後・帰投時に送信し、失敗したら再試行します"
            checked={settings.autoUpload}
            onChange={(e) => updateSettings({ autoUpload: e.target.checked })}
          />
          <div className="text-sm text-ink-300">
            最終成功: {formatTime(upload.status.lastSuccessAt)} / 未送信 {upload.pending ?? "—"} 件
            {upload.status.lastError && (
              <span className="text-danger-400">
                {" "}
                / 直近のエラー: {upload.status.lastError} ({formatTime(upload.status.lastErrorAt)})
              </span>
            )}
          </div>
        </div>
      </Card>

      <Card title="推定値" bodyClassName="flex flex-col gap-3">
        <Checkbox
          label="シミュレーションで推定値を使う"
          hint="パラメータ推定の値 (観測 30 回以上) を API の値より優先します"
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
        {seed && (
          <div className="flex items-center gap-3">
            <Button onClick={() => void seed()} disabled={seeding} title="第1艦隊と実在の深海棲艦で 500 戦を sim-core で回し、観測ログに追加します (送信対象外)">
              {seeding ? "投入中…" : "合成データ投入"}
            </Button>
            <span className="text-xs text-ink-400">開発用 · 送信対象外</span>
          </div>
        )}
      </Card>

      <Card title={S.settings.data} bodyClassName="flex flex-col divide-y divide-ink-700">
        {DATA_ROWS.map((r) => (
          <div key={r.action} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
            <span className="text-sm text-ink-100">
              {r.label}
              {r.count !== undefined && <span className="ml-2 text-ink-400 tabular-nums">{r.count === null ? "—" : S.log.count(r.count)}</span>}
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
          onConfirm={() => void run(confirm)}
        />
      )}
    </div>
  );
};
