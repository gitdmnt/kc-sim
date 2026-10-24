/**
 * 資源の推移: poi の state から値を読む部分と、UI との共有 (保存先・記録の通知)。
 * 記録は startCapture (capture/plugin.ts) が game.response ごとに `recordFromPoi` で行う。
 */
import { normalizeValues } from "./history";
import type { RecordInput, ResourceRecorder, ResourceSnapshot } from "./history";
import { ResourceDb } from "./store";

export * from "./history";
export { ResourceDb } from "./store";

const at = (v: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), v);

/** poi の state (未検証の JSON) から提督 ID と資源を読む。 */
export const resourcesFromPoi = (state: unknown): Pick<RecordInput, "admiral" | "values"> => {
  const id = at(state, "info", "basic", "api_member_id");
  return {
    admiral: (typeof id === "number" || typeof id === "string") && String(id) !== "" ? String(id) : null,
    values: normalizeValues(at(state, "info", "resources")),
  };
};

/** game.response 1 件分 (detail) を記録する。 */
export const recordFromPoi = (recorder: ResourceRecorder, state: unknown, detail: { path: string; body?: unknown; time?: unknown }) =>
  recorder.observe({
    ...resourcesFromPoi(state),
    path: detail.path,
    body: detail.body,
    time: typeof detail.time === "number" ? detail.time : undefined,
  });

// プラグインの再読み込みでモジュールが作り直されても、動き続けている記録と UI が同じものを使うよう globalThis に置く
const shared = globalThis as typeof globalThis & {
  __kcsimResourceListeners?: Set<(s: ResourceSnapshot) => void>;
  __kcsimResourceDb?: ResourceDb;
};
const listeners = (shared.__kcsimResourceListeners ??= new Set());

/** 記録の保存先 (UI と記録で共有する接続) */
export const getResourceDb = (): ResourceDb => (shared.__kcsimResourceDb ??= new ResourceDb());

/** 新しい記録を受け取る。戻り値で解除。 */
export const onResourceRecorded = (fn: (s: ResourceSnapshot) => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const notifyResourceRecorded = (s: ResourceSnapshot) => {
  for (const fn of listeners) fn(s);
};
