import { createContext, useCallback, useContext, useRef, useState } from "react";
import { Anchor, Fuel, ListChecks, Settings } from "lucide-react";
import type { WebView } from "@shared/embed/protocol";
import { STORAGE_PREFIX } from "../fleet/presetStore";
import { defaultStorage } from "../fleet/storage";
import type { KeyValueStorage } from "../fleet/storage";
import type { ChromeFeature, ChromeView } from "../ui/AppChrome";
import { S } from "../ui/strings";

/**
 * 画面の構成 (Web UI と poi プラグインで共通): 左のアクティビティバーの機能 (全体) と、上の行のその機能の画面
 * (ローカルタブ)。画面 id は 1 つの名前空間で、保存も埋め込みのプロトコル (WebView) もこの id を使う。
 */

/** プラグインだけの画面 (データはプラグインの IndexedDB / localStorage にあり、iframe には渡さない) */
export type PluginView = "log" | "upload" | "resources-chart" | "resources-event" | "resources-day";
export type ViewId = WebView | PluginView;
export type FeatureId = "sim" | "quests" | "resources" | "settings";
export type NavFeature<V extends ViewId = ViewId> = ChromeFeature<FeatureId, V>;

/** 全部の機能と画面 (プラグインはこれをそのまま出す) */
export const FEATURES: NavFeature[] = [
  {
    id: "sim",
    label: S.nav.sim,
    title: S.nav.simTitle,
    icon: Anchor,
    views: [
      { id: "sortie", label: S.nav.sortie },
      { id: "map", label: S.nav.map },
      { id: "enemy", label: S.nav.enemy },
      { id: "log", label: S.nav.log },
      { id: "upload", label: S.nav.upload },
      { id: "sim-settings", label: S.nav.simSettings },
    ],
  },
  { id: "quests", label: S.nav.quests, title: S.nav.quests, icon: ListChecks, views: [{ id: "quests", label: S.nav.quests }] },
  {
    id: "resources",
    label: S.nav.resources,
    title: S.nav.resources,
    icon: Fuel,
    views: [
      { id: "resources-chart", label: S.nav.resourcesChart },
      { id: "resources-event", label: S.nav.resourcesEvent },
      { id: "resources-day", label: S.nav.resourcesDay },
    ],
  },
  { id: "settings", label: S.nav.settings, title: S.nav.settings, icon: Settings, views: [{ id: "settings", label: S.nav.settings }], bottom: true },
];

/** 出せる画面だけに絞った構成 (画面が 1 つも残らない機能は消す)。Web UI 単体は Web の画面 (isWebView) だけ */
export const navFeatures = <V extends ViewId>(has: (v: ViewId) => v is V): NavFeature<V>[] =>
  FEATURES.map((f) => ({ ...f, views: f.views.filter((v): v is ChromeView<V> => has(v.id)) })).filter((f) => f.views.length > 0);

const VIEW_KEY = `${STORAGE_PREFIX}view`;
/** 以前の Web UI のタブ (縦のタブ列 出撃 / 海域 / 敵艦 / 任務 / 設定)。id は今の画面と同じで、消えたタブだけ読み替える */
const LEGACY_TAB_KEY = `${STORAGE_PREFIX}tab`;
const RENAMED_TABS: Record<string, ViewId> = { estimate: "enemy" };

const featureOf = <V extends ViewId>(features: NavFeature<V>[], v: string | null | undefined) =>
  features.find((f) => f.views.some((x) => x.id === v));

/** 保存した画面 (無ければ以前の Web UI のタブを移す)。出せない画面なら最初の画面 */
export const readStoredView = <V extends ViewId>(features: NavFeature<V>[], storage: KeyValueStorage = defaultStorage()): V => {
  try {
    const stored = storage.getItem(VIEW_KEY);
    if (featureOf(features, stored)) return stored as V;
    const legacy = storage.getItem(LEGACY_TAB_KEY);
    if (legacy !== null) {
      storage.removeItem(LEGACY_TAB_KEY);
      const id = RENAMED_TABS[legacy] ?? legacy;
      if (featureOf(features, id)) {
        storage.setItem(VIEW_KEY, id);
        return id as V;
      }
    }
  } catch {
    // 保存できなくても既定の画面で動く
  }
  return features[0].views[0].id;
};

export interface ViewNav<V extends ViewId> {
  features: NavFeature<V>[];
  view: V;
  /** 画面を開く (保存して次回もここから) */
  go: (v: V) => void;
  /** 機能を開く: その機能で最後に開いていた画面、初めてなら最初の画面 */
  goFeature: (f: FeatureId) => void;
}

/** 今の画面の状態。Web UI (Shell) とプラグイン (PluginPanel) が同じ形で持つ */
export const useViewNav = <V extends ViewId>(features: NavFeature<V>[]): ViewNav<V> => {
  const [view, setView] = useState<V>(() => readStoredView(features));
  const last = useRef<Partial<Record<FeatureId, V>>>({});
  const go = useCallback((v: V) => {
    setView(v);
    try {
      defaultStorage().setItem(VIEW_KEY, v);
    } catch {
      // ignore
    }
  }, []);
  const goFeature = useCallback(
    (id: FeatureId) => {
      const target = features.find((f) => f.id === id);
      const current = featureOf(features, view);
      if (!target || !current) return;
      last.current[current.id] = view;
      go(last.current[id] ?? target.views[0].id);
    },
    [features, view, go]
  );
  return { features, view, go, goFeature };
};

/** 画面間の遷移指示 (海域 →「戦闘シミュ」→ 出撃 など)。遷移先の画面が読む (seq は同じ指示の再送を区別する)。 */
export interface NavIntent {
  view: WebView;
  seq: number;
  /** 出撃: 出撃 / 単一マス戦闘 */
  mode?: "sortie" | "battle";
  map?: string;
  node?: string;
}

interface NavApi {
  intent: NavIntent | null;
  go: (intent: Omit<NavIntent, "seq">) => void;
}

const Ctx = createContext<NavApi>({ intent: null, go: () => {} });
export const NavProvider = Ctx.Provider;
export const useNav = () => useContext(Ctx);

/** 指示が自分宛てならそれを返す。 */
export const useIntentFor = (view: WebView): NavIntent | null => {
  const { intent } = useNav();
  return intent?.view === view ? intent : null;
};
