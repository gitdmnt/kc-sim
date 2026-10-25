import React, { useEffect, useState } from "react";
import { serverOrigin } from "@shared/embed/protocol";
import { AUTO_UPLOAD_STATUS_KEY, getObservationDb, getUploadClient, readAutoUploadStatus } from "../capture";
import type { AutoUploadStatus } from "../capture";
import { Ban, Check, CircleAlert, Clock, RotateCcw, Trash2 } from "lucide-react";
import { Button, Card, Checkbox, ConfirmDialog, Field, TextInput, S, useToast } from "@web/ui";
import { DEFAULT_SERVER_URL, updatePluginSettings, usePluginSettings } from "../settings";
import { L } from "./strings";
import { useRegistration } from "./useUploadClient";

/**
 * 送信の状況を 1 行で: 停止 > 送信元の拒否 (再試行待ち) > エラー > 未送信 > 送信済みの順に一番重要な 1 つをアイコン
 * (形で区別) と短い文で出す。詳細 (エラー文・最終成功時刻・登録 ID) は title。色は付けない。
 */
const UploadStatusLine = ({ banned, rejectedUntil, error, pending, lastSuccess, clientId }: {
  banned: boolean; rejectedUntil: string | null; error: string | null; pending: number; lastSuccess: string | null; clientId: string | null;
}) => {
  const [icon, text, title] = banned
    ? [<Ban key="i" size={14} aria-hidden />, L.log.uploadBanned, null]
    : rejectedUntil
      ? [<Clock key="i" size={14} aria-hidden />, `${L.log.uploadRejected(rejectedUntil)}${pending ? ` · 未送信 ${pending}` : ""}`, lastSuccess && `最終成功: ${lastSuccess}`]
      : error
        ? [<CircleAlert key="i" size={14} aria-hidden />, pending ? `送信エラー · 未送信 ${pending}` : "送信エラー", error]
        : pending
          ? [<Clock key="i" size={14} aria-hidden />, `未送信 ${pending}`, lastSuccess && `最終成功: ${lastSuccess}`]
          : lastSuccess
            ? [<Check key="i" size={14} aria-hidden />, "送信済み", `最終成功: ${lastSuccess}`]
            : [null, null, null];
  if (!text) return null;
  return (
    <span className="flex items-center gap-1 text-sm text-ink-300" title={[title, clientId && `登録 ID: ${clientId}`].filter(Boolean).join("\n") || undefined}>
      <span className="text-ink-400">{icon}</span>
      {text}
    </span>
  );
};

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

/** 自動送信がオンの間、送る内容と送り先を出す (閉じるまで)。内容は capture/db.ts の uploadPending が送るもの。 */
const UploadNotice = ({ origin }: { origin: string }) => {
  const N = L.upload.notice;
  return (
    <Card title={N.title} bodyClassName="flex flex-col gap-2 text-sm text-ink-200">
      <p>{N.where(origin)}</p>
      <ul className="list-disc pl-5">
        {N.sent.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <p>{N.notSent}</p>
      <div className="flex gap-2 pt-1">
        <Button size="sm" variant="secondary" onClick={() => updatePluginSettings({ autoUpload: false, uploadNoticeClosed: true })}>
          {N.disable}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => updatePluginSettings({ uploadNoticeClosed: true })}>
          {N.close}
        </Button>
      </div>
    </Card>
  );
};

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
  const draftValid = serverOrigin(draft) !== null;

  // 別のウィンドウで変わったら入力欄も追従する
  useEffect(() => setDraft(settings.serverUrl), [settings.serverUrl]);

  const register = async () => {
    setRegistering(true);
    try {
      const r = await getUploadClient().register(apiBase);
      toast.push(r.status === "registered" ? "登録しました" : `登録は ${Math.max(1, Math.ceil((r.until - Date.now()) / 1000))} 秒後に可能`, "info");
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

  // 有効な URL だけ、Enter / フォーカスが外れたときに保存する
  const commit = () => {
    if (draftValid && draft.trim() !== settings.serverUrl) updatePluginSettings({ serverUrl: draft.trim() });
  };
  const regKind = registration.state.kind;

  return (
    <div className="flex flex-col gap-4">
      {settings.autoUpload && !settings.uploadNoticeClosed && <UploadNotice origin={apiBase} />}
      <Card bodyClassName="flex flex-col gap-6">
        <Field label={L.upload.serverUrl} hint={draftValid ? undefined : L.upload.serverUrlInvalid}>
          <div className="flex gap-2">
            <TextInput
              className="flex-1"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === "Enter" && commit()}
              spellCheck={false}
              placeholder={DEFAULT_SERVER_URL}
              aria-invalid={!draftValid}
            />
            {settings.serverUrl !== DEFAULT_SERVER_URL && (
              <Button size="sm" variant="ghost" onClick={() => updatePluginSettings({ serverUrl: DEFAULT_SERVER_URL })}>
                <RotateCcw size={14} aria-hidden />
                {L.upload.reset}
              </Button>
            )}
          </div>
        </Field>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Checkbox
            label={L.upload.autoUpload}
            checked={settings.autoUpload}
            onChange={(e) => updatePluginSettings({ autoUpload: e.target.checked })}
          />
          <UploadStatusLine
            banned={regKind === "banned"}
            rejectedUntil={upload.status.rejectedUntil === null ? null : formatTime(upload.status.rejectedUntil)}
            error={upload.status.lastError ? `${upload.status.lastError} (${formatTime(upload.status.lastErrorAt)})` : null}
            pending={upload.pending ?? 0}
            lastSuccess={upload.status.lastSuccessAt === null ? null : formatTime(upload.status.lastSuccessAt)}
            clientId={regKind === "registered" ? registration.state.clientId : null}
          />
          {(regKind === "banned" || upload.status.lastError) && (
            <Button size="sm" variant="secondary" onClick={() => void register()} disabled={registering || apiBase === ""}>
              再登録
            </Button>
          )}
        </div>

        <div className="flex items-center gap-4">
          <span className="text-sm text-ink-100">
            {L.upload.observations}
            <span className="ml-2 text-ink-400 tabular-nums">{upload.battles === null ? "—" : S.common.count(upload.battles)}</span>
          </span>
          <Button size="sm" variant="danger" onClick={() => setConfirmClear(true)}>
            <Trash2 size={14} aria-hidden />
            {S.settings.deleteAll}
          </Button>
        </div>
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
