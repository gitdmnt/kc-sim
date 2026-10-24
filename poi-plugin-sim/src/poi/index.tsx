/**
 * poi プラグインとしてのエントリ (vite build の lib エントリ。poi が `views/index.js` として読む)。
 * redux の購読と CSS の注入だけをここに置き、ビューは PluginPanel に任せる。
 */
import React from "react";
import { connect } from "react-redux";
import type { PoiState } from "@shared/embed/protocol";
import styles from "../../assets/styles.css?inline";
import { PluginPanel } from "../panel/PluginPanel";
import { questListOf } from "../quests/reducer";
import { countedGoals, getQuestProgressDb, onQuestProgress } from "../quests";
import type { QuestCounts } from "../quests";
import { resourcesFromPoi } from "../resources";

/** この提督の任務の進捗カウンタ (メインウィンドウの startCapture が数えて保存する)。保存の通知で読み直す */
const useQuestCounts = (admiral: string | null): QuestCounts => {
  const [counts, setCounts] = React.useState<QuestCounts>({});
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => onQuestProgress((a) => a === admiral && setVersion((v) => v + 1)), [admiral]);
  React.useEffect(() => {
    if (!admiral) return;
    let alive = true;
    getQuestProgressDb().load(admiral).then(
      (c) => alive && setCounts(c),
      (e) => console.error("[kcsim] failed to load quest progress", e),
    );
    return () => {
      alive = false;
    };
  }, [admiral, version]);
  return counts;
};

const PoiApp = ({ info, const: master, combinedFlag, questList }: PoiState) => {
  const counts = useQuestCounts(resourcesFromPoi({ info }).admiral);
  const infoQuests = (info as { quests?: unknown } | undefined)?.quests;
  // 日付が変わったときの「本日中」の数え直しは、次に state か進捗が変わったときに反映される
  const questCounts = React.useMemo(() => countedGoals(infoQuests, counts, Date.now()), [infoQuests, counts]);
  const poiState = React.useMemo(
    () => ({ info, const: master, combinedFlag, questList, questCounts }),
    [info, master, combinedFlag, questList, questCounts],
  );
  return (
    // <style> はこのコンポーネントがマウントされている間だけ存在する (アンマウントで poi 本体に残らない)
    <>
      <style>{styles}</style>
      <PluginPanel poiState={poiState} />
    </>
  );
};

// poi の state 全体ではなく info / const と連合艦隊のフラグ、このプラグインの任務一覧だけ購読して再描画を減らす
// (mapState の戻り値は浅く比較されるので、スライスを props にする)
const Connected = connect((state: (Partial<PoiState> & { sortie?: { combinedFlag?: unknown } }) | undefined): PoiState => ({
  info: state?.info,
  const: state?.const,
  combinedFlag: state?.sortie?.combinedFlag,
  questList: questListOf(state),
}))(PoiApp);

// poi はこのコンポーネントをプラグインパネルに描画する
export class reactClass extends React.Component {
  render() {
    return <Connected />;
  }
}

export { startCapture, stopCapture, getCaptureDb } from "../capture";
// poi が state.ext[パッケージ名]._ に置く (任務タブ用の任務一覧)
export { reducer } from "../quests/reducer";
