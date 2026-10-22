import React, { useMemo } from "react";
import { describeRule } from "../../data/routing";
import type { RuleView } from "../../data/routing";
import type { RoutingDoc } from "@shared/data/types";
import { Info, TriangleAlert } from "lucide-react";

// 入れ子は字下げだけで表す。枠・罫・背景は付けず、不確実なルールは警告アイコンで示す
const RuleRow = ({ view }: { view: RuleView }) => (
  <li className="py-0.5">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {view.condition === null ? (
        <span className="text-ink-400">上記以外</span>
      ) : (
        <span className="text-ink-100">{view.condition}</span>
      )}
      {view.action && <span className="font-medium text-ink-50">{view.action}</span>}
      {view.uncertain && <TriangleAlert size={14} className="shrink-0 text-warn-400" aria-label="不確実" role="img"><title>条件・閾値・比率が未確認の推定ルール</title></TriangleAlert>}
      {view.note && <Info size={14} className="shrink-0 cursor-help text-ink-400" aria-label={`注記: ${view.note}`} role="img"><title>{view.note}</title></Info>}
    </div>
    {view.children.length > 0 && (
      <ol className="ml-4 mt-1 flex flex-col gap-1">
        {view.children.map((c, i) => (
          <RuleRow key={i} view={c} />
        ))}
      </ol>
    )}
  </li>
);

export const routingViewsFor = (doc: RoutingDoc | null, letter: string): { views: RuleView[]; end: boolean } | null => {
  const node = doc?.nodes[letter];
  if (!node) return null;
  return { views: (node.rules ?? []).map(describeRule), end: !!node.end };
};

export const RoutingPanel = ({
  doc,
  letter,
  views,
}: {
  doc: RoutingDoc | null;
  letter: string;
  views: { views: RuleView[]; end: boolean } | null;
}) => {
  const select = useMemo(() => doc?.defaults?.select?.[letter], [doc, letter]);
  if (!doc) return <p className="text-sm text-ink-400">未登録</p>;
  if (!views || views.views.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-1">
        {views.views.map((v, i) => (
          <RuleRow key={i} view={v} />
        ))}
      </ol>
      {select && <p className="text-xs text-ink-400">既定 {select}</p>}
    </div>
  );
};
