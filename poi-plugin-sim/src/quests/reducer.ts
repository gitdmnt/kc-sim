/**
 * 任務一覧の記録 (poi のプラグイン reducer。poi が `state.ext[パッケージ名]._` に置く)。
 * poi 本体は遂行中の任務 (info.quests.activeQuests) と進捗 (records) しか持たないので、開放済みの任務すべてを知るために
 * 「全て」タブ (api_tab_id 0) の questlist を覚える。Web UI の任務タブが、一覧にある任務の前提を「達成済み」、
 * 一覧にある単発任務の後続を「未開放」と推定する (shared/quest/tree.ts)。poi の再起動では消え、任務画面を開くと戻る。
 */
import { questEntry } from "@shared/embed/protocol";
import type { PoiQuestEntry } from "@shared/embed/protocol";
import { name as packageName } from "../../package.build.json";

/** poi がプラグインの reducer state を置くキー (package.build.json の name) */
export const PLUGIN_PACKAGE = packageName;

export interface QuestListState {
  /** 最後に見た「全て」タブの一覧。まだ見ていなければ null */
  list: PoiQuestEntry[] | null;
}

interface PoiAction {
  type: string;
  body?: unknown;
  postBody?: unknown;
}

const INIT: QuestListState = { list: null };

const field = (v: unknown, key: string): unknown =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;

export const reducer = (state: QuestListState = INIT, action: PoiAction): QuestListState => {
  switch (action.type) {
    // ログインし直し (別の提督かもしれない): 前の一覧を捨てる
    case "@@Response/kcsapi/api_get_member/require_info":
      return state.list === null ? state : INIT;
    case "@@Response/kcsapi/api_get_member/questlist": {
      const raw = field(action.body, "api_list");
      if (!Array.isArray(raw)) return state;
      // 空き枠は -1 で届くことがある
      const entries = raw.flatMap((q) => questEntry(q) ?? []);
      if (Number(field(action.postBody, "api_tab_id") ?? 0) === 0) return { list: entries };
      // 他のタブ (デイリー・遂行中など) は一部だけ: 既にある一覧の状態だけ更新する
      if (state.list === null) return state;
      const byId = new Map(entries.map((e) => [e.id, e]));
      const known = new Set(state.list.map((e) => e.id));
      return { list: [...state.list.map((e) => byId.get(e.id) ?? e), ...entries.filter((e) => !known.has(e.id))] };
    }
    // 報酬を受け取った任務は一覧から消える (続く questlist で新しく開放された任務が届く)
    case "@@Response/kcsapi/api_req_quest/clearitemget": {
      const id = Number(field(action.postBody, "api_quest_id"));
      if (state.list === null || !state.list.some((e) => e.id === id)) return state;
      return { list: state.list.filter((e) => e.id !== id) };
    }
    default:
      return state;
  }
};

/** poi の state 全体から、このプラグインの reducer state (未検証)。 */
export const questListOf = (state: unknown): unknown => field(field(field(state, "ext"), PLUGIN_PACKAGE), "_");
