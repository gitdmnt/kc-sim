import React, { useEffect, useState } from "react";
import { serverOrigin } from "@shared/embed/protocol";
import { AUTO_UPLOAD_STATUS_KEY, getObservationDb, getUploadClient, readAutoUploadStatus } from "../capture";
import type { AutoUploadStatus } from "../capture";
import { Button, Card, Checkbox, ConfirmDialog, Field, TextInput, S, useToast } from "@web/ui";
import { DEFAULT_SERVER_URL, updatePluginSettings, usePluginSettings } from "../settings";
import { L } from "./strings";
import { useRegistration, useUploadWaitSeconds } from "./useUploadClient";

/** 自動送信の状況。送信はメインウィンドウで動くので、状態は localStorage (storage イベント) と共有の IndexedDB から読む。 */
const useAutoUploadStatus = (tick: number): { status: AutoUploadStatus; pending: number | null; battles: number | null } => {
  const [status, setStatus] = useState(readAutoUploadStatus);
  const [counts, setCounts] = useState<{ pending: number | null; battles: number | null }>({ pending: null, battles: null });
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      setStatus(readAutoUploadStatus());
      const db = getObservationDb();
      Promise.all([db.countPending(), db.countBattles()])
        .then(([pending, battles]) => alive && setCounts({ pending, battles }))
        .catch(() => alive && setCounts({ pending: null, battles: null }));
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
  }, [tick]);
  return { status, ...counts };
};

const formatTime = (t: number | null) => (t === null ? "—" : new Date(t).toLocaleString());

/** プラグインの設定: サーバ URL (Web UI と送信先)、自動送信、登録、観測ログの削除。 */
export const UploadSettings = () => {
  const settings = usePluginSettings();
  const toast = useToast();
  const [draft, setDraft] = useState(settings.serverUrl);
  const [tick, setTick] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [registering, setRegistering] = useState(false);
  const upload = useAutoUploadStatus(tick);
  const apiBase = serverOrigin(settings.serverUrl) ?? "";
  const registration = useRegistration(apiBase);
  const wait = useUploadWaitSeconds();
  const draftValid = serverOrigin(draft) !== null;

  // 別のウィンドウで変わったら入力欄も追従する
  useEffect(() => setDraft(settings.serverUrl), [settings.serverUrl]);

  const register = async () => {
    setRegistering(true);
    try {
      const r = await getUploadClient().register(apiBase);
      toast.push(r.status === "registered" ? "登録しました" : `登録が制限されています。${Math.max(1, Math.ceil((r.until - Date.now()) / 1000))} 秒後にやり直してください`, "info");
    } catch (e) {
      toast.push((e as Error).message, "danger");
    } finally {
      registration.refresh();
      setRegistering(false);
    }
  };

  const clearObservations = async () => {
    setConfirmClear(false);
    try {
      await getObservationDb().clear();
      toast.push(S.settings.done, "ok");
      setTick((t) => t + 1);
    } catch (e) {
      toast.push((e as Error).message, "danger");
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Card title={L.upload.server}>
        <Field label={L.upload.serverUrl} hint={draftValid ? L.upload.serverUrlHint : L.upload.serverUrlInvalid}>
          <div className="flex gap-2">
            <TextInput
              className="flex-1"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              placeholder={DEFAULT_SERVER_URL}
              aria-invalid={!draftValid}
            />
            <Button size="sm" disabled={!draftValid || draft.trim() === settings.serverUrl} onClick={() => updatePluginSettings({ serverUrl: draft.trim() })}>
              {S.common.save}
            </Button>
            <Button size="sm" variant="ghost" disabled={settings.serverUrl === DEFAULT_SERVER_URL} onClick={() => updatePluginSettings({ serverUrl: DEFAULT_SERVER_URL })}>
              {L.upload.reset}
            </Button>
          </div>
        </Field>
        <div className="mt-3 flex flex-col gap-2">
          <Checkbox
            label="観測ログを自動送信"
            hint="戦闘後・帰投時に送信し、失敗したら再試行します"
            checked={settings.autoUpload}
            onChange={(e) => updatePluginSettings({ autoUpload: e.target.checked })}
          />
          <div className="text-sm text-ink-300">
            最終成功: {formatTime(upload.status.lastSuccessAt)} / 未送信 {upload.pending ?? "—"} 件
            {wait > 0 && <span> / 次の送信まで {wait} 秒</span>}
            {upload.status.lastError && (
              <span className="text-danger-400">
                {" "}
                / 直近のエラー: {upload.status.lastError} ({formatTime(upload.status.lastErrorAt)})
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink-300">
            <span>
              登録:{" "}
              {registration.state.kind === "none" && "未登録 (最初の送信時にサーバへ登録します)"}
              {registration.state.kind === "registered" && (
                <>
                  登録済み <span className="text-ink-400">({registration.state.clientId})</span>
                </>
              )}
              {registration.state.kind === "banned" && <span className="text-danger-400">サーバに拒否されました (403)。送信を停止しています</span>}
            </span>
            <Button size="sm" variant="secondary" onClick={() => void register()} disabled={registering || apiBase === ""}>
              {registration.state.kind === "none" ? "登録" : "再登録"}
            </Button>
          </div>
        </div>
      </Card>

      <Card title={S.settings.data} bodyClassName="flex items-center justify-between gap-3">
        <span className="text-sm text-ink-100">
          {L.upload.observations}
          <span className="ml-2 text-ink-400 tabular-nums">{upload.battles === null ? "—" : S.common.count(upload.battles)}</span>
        </span>
        <Button size="sm" variant="danger" onClick={() => setConfirmClear(true)}>
          {S.settings.deleteAll}
        </Button>
      </Card>

      {confirmClear && (
        <ConfirmDialog
          danger
          title={L.upload.clearObservations}
          confirmLabel={S.common.delete}
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => void clearObservations()}
        />
      )}
    </div>
  );
};
