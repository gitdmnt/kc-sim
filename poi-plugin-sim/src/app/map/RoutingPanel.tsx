import React, { useMemo } from "react";
import { describeRule } from "../../data/routing";
import type { RuleView } from "../../data/routing";
import type { RoutingDoc } from "../../data/types";
import { Badge, cx } from "../../ui";

const RuleRow = ({ view, depth }: { view: RuleView; depth: number }) => (
  <li className={cx("rounded-md border px-2.5 py-1.5", view.uncertain ? "border-warn-600/50 bg-warn-600/10" : "border-ink-600 bg-ink-900/50")}>
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className={cx("shrink-0 text-xs font-semibold", view.condition ? "text-accent-400" : "text-ink-400")}>
        {view.condition === null ? "上記以外" : "もし"}
      </span>
      {view.condition && <span className="text-ink-100">{view.condition}</span>}
      {view.action && <span className="font-medium text-ink-50">{view.action}</span>}
      {view.uncertain && <Badge tone="warn" title="条件・閾値・比率が未確認の推定ルール">不確実</Badge>}
    </div>
    {view.note && <div className="mt-0.5 text-[11px] text-ink-400">{view.note}</div>}
    {view.children.length > 0 && (
      <ol className="mt-1.5 ml-3 flex flex-col gap-1 border-l border-ink-600 pl-2.5">
        {view.children.map((c, i) => (
          <RuleRow key={i} view={c} depth={depth + 1} />
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
  if (!doc) return <p className="text-xs text-ink-400">この海域のルーティングルールは未登録です。</p>;
  if (!views) return <p className="text-xs text-ink-400">このノードのルールはありません (出口なし)。</p>;
  if (views.end && views.views.length === 0) return <p className="text-xs text-ink-400">終端ノード (これ以降の分岐なし)。</p>;
  return (
    <div className="flex flex-col gap-1.5">
      <ol className="flex flex-col gap-1.5">
        {views.views.map((v, i) => (
          <RuleRow key={i} view={v} depth={0} />
        ))}
      </ol>
      {select && <p className="text-[11px] text-ink-400">能動分岐の既定: {select}</p>}
    </div>
  );
};
