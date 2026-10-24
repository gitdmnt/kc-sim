/**
 * 任務の進捗カウンタの共有部分: 保存先と「進捗が変わった」通知。数えるのは startCapture (capture/plugin.ts)、
 * 表示用に読むのはプラグインの画面 (poi/index.tsx → 埋め込みの Web UI)。
 */
import { PROGRESS_CHANNEL, QuestProgressDb } from "./store";

export { QuestCounter, bundledQuestGoals, countedGoals } from "./counter";
export { QuestProgressDb } from "./store";
export type { QuestCounts, QuestProgressStore } from "./store";

// プラグインの再読み込みでモジュールが作り直されても、動き続けている記録と UI が同じものを使うよう globalThis に置く
const shared = globalThis as typeof globalThis & {
  __kcsimQuestListeners?: Set<(admiral: string) => void>;
  __kcsimQuestDb?: QuestProgressDb;
  __kcsimQuestChannel?: BroadcastChannel | null;
};
const listeners = (shared.__kcsimQuestListeners ??= new Set());

/** 進捗の保存先 (数える側と表示する側で共有する接続) */
export const getQuestProgressDb = (): QuestProgressDb => (shared.__kcsimQuestDb ??= new QuestProgressDb());

const channel = (): BroadcastChannel | null => {
  if (shared.__kcsimQuestChannel === undefined) {
    shared.__kcsimQuestChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel(PROGRESS_CHANNEL) : null;
    if (shared.__kcsimQuestChannel) {
      shared.__kcsimQuestChannel.onmessage = (e: MessageEvent) => {
        if (typeof e.data === "string") for (const fn of listeners) fn(e.data);
      };
    }
  }
  return shared.__kcsimQuestChannel;
};

/** 進捗が変わったとき (このウィンドウでも別ウィンドウでも) に呼ばれる。戻り値で解除。 */
export const onQuestProgress = (fn: (admiral: string) => void): (() => void) => {
  channel();
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** 保存したあとに呼ぶ: このウィンドウの購読者と、BroadcastChannel で別ウィンドウへ */
export const notifyQuestProgress = (admiral: string) => {
  for (const fn of listeners) fn(admiral);
  channel()?.postMessage(admiral);
};
