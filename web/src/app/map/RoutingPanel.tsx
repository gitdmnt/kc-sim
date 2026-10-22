import React, { useMemo } from "react";
import { describeRule } from "../../data/routing";
import type { RuleView } from "../../data/routing";
import type { RoutingDoc } from "@shared/data/types";
import { Badge, cx } from "../../ui";

// 枠は付けず、入れ子は左罫線のインデントだけで表す。不確実ルールだけ背景で目立たせる
const RuleRow = ({ view, depth }: { view: RuleView; depth: number }) => (
  <li className={cx("rounded px-2 py-1", view.uncertain && "bg-warn-600/10 ring-1 ring-warn-600/40")}>
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className={cx("shrink-0 text-xs font-semibold", view.condition ? "text-accent-400" : "text-ink-400")}>
        {view.condition === null ? "上記以外" : "もし"}
      </span>
      {view.condition && <span className="text-ink-100">{view.condition}</span>}
      {view.action && <span className="font-medium text-ink-50">{view.action}</span>}
      {view.uncertain && <Badge tone="warn" title="条件・閾値・比率が未確認の推定ルール">不確実</Badge>}
      {view.note && (
        <span className="cursor-help text-xs text-ink-400" title={view.note} aria-label={`注記: ${view.note}`}>
          ⓘ
        </span>
      )}
    </div>
    {view.children.length > 0 && (
      <ol className="mt-1 ml-2 flex flex-col gap-0.5 border-l border-ink-600 pl-2">
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
  if (!doc) return <p className="text-sm text-ink-400">未登録</p>;
  if (!views || views.views.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <ol className="flex flex-col gap-0.5">
        {views.views.map((v, i) => (
          <RuleRow key={i} view={v} depth={0} />
        ))}
      </ol>
      {select && <p className="text-xs text-ink-400" title="能動分岐の既定">既定: {select}</p>}
    </div>
  );
};
