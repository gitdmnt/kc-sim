import { createContext, useContext } from "react";

export type TabId = "fleet" | "map" | "enemy" | "sim" | "estimate" | "log" | "settings";

/** タブ間の遷移指示。遷移先のタブが初期状態として読む (seq は同じ指示の再送を区別する)。 */
export interface NavIntent {
  tab: TabId;
  seq: number;
  /** sim タブ: 戦闘 / 出撃 */
  mode?: "battle" | "sortie";
  presetId?: string;
  map?: string;
  node?: string;
  /** estimate タブ: 表示する深海棲艦 */
  shipId?: number;
}

interface NavApi {
  intent: NavIntent | null;
  go: (intent: Omit<NavIntent, "seq">) => void;
}

const Ctx = createContext<NavApi>({ intent: null, go: () => {} });
export const NavProvider = Ctx.Provider;
export const useNav = () => useContext(Ctx);

/** 指示が自分宛てならそれを返す (マウント時の初期値用)。 */
export const useIntentFor = (tab: TabId): NavIntent | null => {
  const { intent } = useNav();
  return intent?.tab === tab ? intent : null;
};
