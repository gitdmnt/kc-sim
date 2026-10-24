import React, { useEffect, useState } from "react";
import { Tabs } from "../../ui";
import type { TabItem } from "../../ui";
import { EstimateTab } from "../estimate/EstimateTab";
import { useIntentFor } from "../nav";
import type { NavIntent } from "../nav";
import { EnemyTab } from "./EnemyTab";

type View = NonNullable<NavIntent["view"]>;

const VIEWS: TabItem<View>[] = [
  { id: "ships", label: "敵艦", title: "深海棲艦の一覧とステータス" },
  { id: "estimates", label: "推定", title: "サーバが観測から推定した隠しステータス" },
];

/** 敵艦・推定タブ: 敵艦の一覧と、サーバの推定値を上の切り替えで行き来する。敵艦の「推定詳細」はその艦を選んだ推定へ飛ぶ。 */
export const EnemyHub = () => {
  const intent = useIntentFor("enemy");
  const [view, setView] = useState<View>(intent?.view ?? "ships");
  // 推定で最初に選ぶ艦。切り替えで開いたときは選ばない
  const [shipId, setShipId] = useState(intent?.shipId);

  useEffect(() => {
    if (!intent?.view) return;
    setView(intent.view);
    setShipId(intent.shipId);
  }, [intent?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-2 lg:h-full">
      <Tabs
        tabs={VIEWS}
        value={view}
        onChange={(id) => {
          setView(id);
          setShipId(undefined);
        }}
        variant="pill"
        size="sm"
      />
      <div className="lg:min-h-0 lg:flex-1">{view === "ships" ? <EnemyTab /> : <EstimateTab initialShipId={shipId} />}</div>
    </div>
  );
};
