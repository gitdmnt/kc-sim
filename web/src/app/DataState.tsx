import React from "react";
import { Badge, Button, EmptyState } from "../ui";
import { DataApiError } from "../data/api";

/** 取得エラー時の表示 (オフライン・HTTP エラー)。 */
export const DataError = ({ error, onRetry }: { error: Error; onRetry?: () => void }) => {
  const offline = error instanceof DataApiError && error.kind === "offline";
  return (
    <EmptyState
      className="py-12"
      title={offline ? "データサーバに接続できません" : "データを取得できませんでした"}
      description={offline ? undefined : error.message}
      action={onRetry && <Button onClick={onRetry}>再試行</Button>}
    />
  );
};

export const StaleBadge = () => <Badge tone="warn" title="保存済みのキャッシュを表示中">オフライン</Badge>;
