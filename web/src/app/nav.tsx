import { createContext, useContext } from "react";

export type TabId = "sortie" | "map" | "enemy" | "settings";

/** タブ間の遷移指示。遷移先のタブが読む (seq は同じ指示の再送を区別する)。 */
export interface NavIntent {
  tab: TabId;
  seq: number;
  /** sortie タブ: 出撃 / 単一マス戦闘 */
  mode?: "sortie" | "battle";
  map?: string;
  node?: string;
  /** enemy タブ: 開く区画 (敵艦の一覧 / サーバの推定値) と、推定値で選ぶ深海棲艦 */
  view?: "ships" | "estimates";
  shipId?: number;
}

interface NavApi {
  intent: NavIntent | null;
  go: (intent: Omit<NavIntent, "seq">) => void;
}

const Ctx = createContext<NavApi>({ intent: null, go: () => {} });
export const NavProvider = Ctx.Provider;
export const useNav = () => useContext(Ctx);

/** 指示が自分宛てならそれを返す。 */
export const useIntentFor = (tab: TabId): NavIntent | null => {
  const { intent } = useNav();
  return intent?.tab === tab ? intent : null;
};
