import React, { useMemo, useRef, useState } from "react";
import { isWebView } from "@shared/embed/protocol";
import type { WebView } from "@shared/embed/protocol";
import { AppChrome, Badge, cx } from "../ui";
import { EnemyTab } from "./enemy/EnemyTab";
import { MapTab } from "./map/MapTab";
import { Workspace } from "./sim/Workspace";
import { QuestTab } from "./quests/QuestTab";
import { SettingsTab, SimSettingsTab } from "./SettingsTab";
import { NavProvider, navFeatures, useViewNav } from "./nav";
import type { NavIntent } from "./nav";
import { useApp } from "./context";
import { reportView } from "../poiBridge";
import type { PoiConnection } from "../poiBridge";

/** Web UI だけで出せる機能と画面 (観測ログ・送信設定・資源はプラグインのもの) */
const FEATURES = navFeatures(isWebView);

/** 画面いっぱいに使う画面 (中で区画ごとにスクロールする)。他の画面は内容の高さで、はみ出せば main がスクロールする */
const FULL_HEIGHT: WebView[] = ["sortie", "map", "enemy", "quests"];

/** poi との接続で対処が要る状態だけ出す */
const PoiBadge = ({ poi }: { poi: PoiConnection }) =>
  poi.status === "silent" ? (
    <Badge tone="warn" className="w-fit shrink-0">poi 応答なし</Badge>
  ) : poi.status === "unsupported" ? (
    <Badge tone="danger" className="w-fit shrink-0" title={`プラグインのプロトコル v${poi.pluginVersion}`}>プラグインを更新してください</Badge>
  ) : null;

/**
 * 画面の枠と中身。枠 (左のバーで機能、上のタブで機能の中の画面) は ui/AppChrome で、poi プラグインと同じ部品。
 * v3 以降のプラグインに埋め込まれているときは、プラグインが枠を描いて `view` で画面を選ぶので、ここは中身だけ描く。
 * ブラウザで直接開いたとき (と、枠を描かない古いプラグインの中) は自分で枠を描く。
 */
export const Shell = () => {
  const { poi } = useApp();
  const nav = useViewNav(FEATURES);
  const view = nav.view;
  // プラグインの最初のメッセージを待つ間は描かない (v3 なら枠はプラグインが描く)
  const bars = !poi.hostNav && poi.status !== "waiting";
  // 版は直接開いたときだけ (枠を描かない古いプラグインの中では、プラグインのヘッダが版を出している)
  const standalone = poi.status === "standalone";

  const [intent, setIntent] = useState<NavIntent | null>(null);
  const seq = useRef(0);
  // バー・タブ・プラグインでの切り替えは遷移指示を消す
  const open = (v: WebView) => {
    setIntent(null);
    nav.go(v);
  };

  // プラグインが選んだ画面に移る。描画中に合わせる (違う画面を一度描いて読み込みを始めないように)
  const [hostView, setHostView] = useState(poi.hostView);
  if (poi.hostView !== hostView) {
    setHostView(poi.hostView);
    if (poi.hostView && poi.hostView.view !== view) open(poi.hostView.view);
  }

  const navApi = useMemo(
    () => ({
      intent,
      go: (i: Omit<NavIntent, "seq">) => {
        setIntent({ ...i, seq: ++seq.current });
        nav.go(i.view);
        reportView(i.view);
      },
    }),
    [intent, nav.go]
  );
  const sortie = view === "sortie";
  // 出撃は初めて開いたときに作る (他の画面で起動したときに海域データを取りに行かない)
  const [sortieMounted, setSortieMounted] = useState(sortie);
  if (sortie && !sortieMounted) setSortieMounted(true);
  const pane = "lg:min-h-0 lg:flex-1";

  return (
    <NavProvider value={navApi}>
      <div className="flex h-screen flex-col">
        <AppChrome
          features={FEATURES}
          view={view}
          onView={open}
          onFeature={(f) => {
            setIntent(null);
            nav.goFeature(f);
          }}
          bars={bars}
          end={standalone && `v${__APP_VERSION__}`}
        >
          <main className="min-h-0 min-w-0 flex-1 overflow-auto">
            <div className={cx("mx-auto flex max-w-[1600px] flex-col gap-2 p-2", FULL_HEIGHT.includes(view) && "lg:h-full")}>
              <PoiBadge poi={poi} />
              {/* 出撃は一度作ったら隠すだけで外さない (結果と計算を保つ) */}
              {sortieMounted && (
                <div className={sortie ? pane : "hidden"}>
                  <Workspace />
                </div>
              )}
              {view === "map" && <div className={pane}><MapTab /></div>}
              {view === "enemy" && <div className={pane}><EnemyTab /></div>}
              {view === "quests" && <div className={pane}><QuestTab /></div>}
              {view === "sim-settings" && <SimSettingsTab />}
              {view === "settings" && <SettingsTab />}
            </div>
          </main>
        </AppChrome>
      </div>
    </NavProvider>
  );
};
