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
        <>
          {!offline && <>{error.message}<br /></>}
          {offline && (
            <>
              <code className="text-ink-200">{apiBase}</code> が起動しているか確認してください
              (<code className="text-ink-200">cd data-worker && bun run dev</code>)。設定タブで API ベース URL を変更できます。
            </>
          )}
        </>
      }
      action={onRetry && <Button onClick={onRetry}>再試行</Button>}
    />
  );
};

export const StaleBadge = () => <Badge tone="warn" title="サーバに接続できず、保存済みのキャッシュを表示しています">オフライン (キャッシュ)</Badge>;

/** 静的バンドル (オフライン代替) のデータを表示中であることの注意書き。 */
export const BundleBanner = ({ generatedAt }: { generatedAt?: string }) => (
  <div className="rounded-md border border-warn-600/50 bg-warn-600/10 px-3 py-2 text-xs text-warn-400">
    <b>オフライン:</b> データサーバに接続できないため、同梱の静的マップデータを表示しています
    {generatedAt ? ` (生成: ${generatedAt.slice(0, 10)})` : ""}。最新ではない可能性があります。設定タブで API の URL を確認してください。
  </div>
);
