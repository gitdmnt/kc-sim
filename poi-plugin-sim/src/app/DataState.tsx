import React from "react";
import { Badge, Button, EmptyState } from "../ui";
import { useSettings } from "./settings";

/** 取得エラー時の表示 (オフライン・HTTP エラー)。 */
export const DataError = ({ error, onRetry }: { error: Error; onRetry?: () => void }) => {
  const { apiBase } = useSettings();
  const offline = (error as any).kind === "offline";
  return (
    <EmptyState
      className="py-12"
      title={offline ? "データサーバに接続できません" : "データを取得できませんでした"}
      description={
        offline ? (
          <>
            接続先 <code className="text-ink-200" title="ローカル: cd server && bun run dev">{apiBase}</code> を確認してください (設定タブで変更可)。
          </>
        ) : (
          error.message
        )
      }
      action={onRetry && <Button onClick={onRetry}>再試行</Button>}
    />
  );
};

export const StaleBadge = () => <Badge tone="warn" title="サーバに接続できず、保存済みのキャッシュを表示しています">オフライン</Badge>;

/** 静的バンドル (オフライン代替) のデータを表示中であることの注意書き。 */
export const BundleBanner = ({ generatedAt }: { generatedAt?: string }) => (
  <div
    className="rounded-md border border-warn-600/50 bg-warn-600/10 px-3 py-2 text-sm text-warn-400"
    title="データサーバに接続できないため同梱データを表示しています。最新ではない可能性があります。"
  >
    <b>オフライン</b> — 同梱のマップデータを表示中{generatedAt ? ` (${generatedAt.slice(0, 10)} 時点)` : ""}
  </div>
);
