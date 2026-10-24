import React, { useEffect, useRef, useState } from "react";
import { ChevronRight, CornerLeftUp } from "lucide-react";
import type { OutlineRow, QuestGraph } from "@shared/quest/tree";
import { cx } from "../../ui";
import { FINISHED, QuestRow } from "./QuestRow";
import type { Player } from "./QuestRow";

/** Indent levels open at first (0 = the target's own prerequisites) */
const OPEN_LEVELS = 2;
/** px per indent level; the expand toggle column is as wide */
const STEP = 10;
/** Status dot centre from the start of a dense row's button (px-1.5 + half the 8px dot) */
const DOT = 10;

const keyOf = (r: OutlineRow) => r.path.join("/");

/**
 * Branch guides left of a row: one column per level above it. A branch (one of 2+ prerequisites) ends in an elbow; a
 * chained row only continues the lines passing by.
 */
const Guides = ({ row }: { row: OutlineRow }) => (
  <>
    {row.more.slice(1).map((m, c, cols) => {
      const elbow = !row.chained && c === cols.length - 1;
      return (
        <span key={c} aria-hidden className="relative shrink-0" style={{ width: STEP }}>
          {(m || elbow) && <span className={cx("absolute top-0 left-1/2 w-px bg-ink-700", m ? "bottom-0" : "h-1/2")} />}
          {elbow && <span className="absolute top-1/2 right-0 left-1/2 h-px bg-ink-700" />}
        </span>
      );
    })}
  </>
);

/**
 * 前提任務のツリー。前提が 1 件なら、その前提をすぐ下の同じ段に置き、状態の点どうしを縦線でつなぐ (一本の鎖)。前提が 2 件以上
 * なら、それぞれを一段字下げした枝にする。二度目に出てくる任務は参照の一行 (クリックで最初の行へ移動)。開閉は鎖の先頭と枝分かれ
 * の行で。初期表示は 2 段目まで開き、受注可・遂行中の任務へ続く枝も開く。前提がすべて達成済みの行は畳む。
 */
export const PrerequisiteTree = ({ rows, graph, player, title, onSelect }: {
  rows: OutlineRow[];
  graph: QuestGraph;
  player: Player;
  title: React.ReactNode;
  onSelect: (id: number) => void;
}) => {
  const [toggled, setToggled] = useState(() => new Map<string, boolean>());
  const [flash, setFlash] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!flash) return;
    list.current?.querySelector(`[data-row="${flash}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const t = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(t);
  }, [flash]);

  const status = (id: number) => player.statuses.get(id) ?? "unknown";
  // A chain folds at its head (or at a branch point): rows in its middle have no toggle and stay open
  const collapsible = (r: OutlineRow) => r.children > 1 || (r.children === 1 && !r.chained);
  const isOpen = (r: OutlineRow) =>
    !collapsible(r) ||
    (toggled.get(keyOf(r)) ??
      (!r.under.every((id) => FINISHED.includes(status(id))) &&
        (r.level < OPEN_LEVELS || r.under.some((id) => status(id) === "available" || status(id) === "active"))));
  // A row shows when its parent shows and is open (parents come first in the outline)
  const openShown = new Set<string>();
  const shown = rows.filter((r) => {
    if (r.parent !== undefined && !openShown.has(r.parent)) return false;
    if (isOpen(r)) openShown.add(keyOf(r));
    return true;
  });
  const closed = rows.some((r) => !isOpen(r));
  const jump = (key: string) => {
    const path = key.split("/");
    setToggled((m) => {
      const next = new Map(m);
      for (let i = 1; i < path.length; i++) next.set(path.slice(0, i).join("/"), true);
      return next;
    });
    setFlash(key);
  };

  return (
    <div className="flex shrink-0 flex-col">
      <div className="mb-1 flex items-center gap-2">
        <h4 className="min-w-0 flex-1 text-xs font-semibold text-ink-300">{title}</h4>
        {(closed || toggled.size > 0) && (
          <button
            type="button"
            onClick={() => setToggled(closed ? new Map(rows.filter(collapsible).map((r) => [keyOf(r), true])) : new Map())}
            className="shrink-0 cursor-pointer text-xs text-accent-400 hover:underline"
          >
            {closed ? "すべて開く" : "畳む"}
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-ink-500">前提なし</p>
      ) : (
        <ul ref={list} className="-mx-2 flex flex-col px-2" aria-label="前提任務">
          {shown.map((r) => {
            const key = keyOf(r);
            const open = r.children > 0 && isOpen(r);
            const dotX = (r.level + 1) * STEP + DOT;
            const lead = (
              <>
                <Guides row={r} />
                <span className="relative flex shrink-0 items-center justify-center" style={{ width: STEP }}>
                  {collapsible(r) ? (
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-label={open ? "畳む" : "開く"}
                      onClick={() => setToggled((m) => new Map(m).set(key, !open))}
                      className="-mx-[3px] flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-ink-400 hover:bg-ink-800 hover:text-ink-100"
                    >
                      <ChevronRight aria-hidden className={cx("size-3", open && "rotate-90")} />
                    </button>
                  ) : (
                    r.level > 0 && !r.chained && <span aria-hidden className="absolute top-1/2 right-0 left-0 h-px bg-ink-700" />
                  )}
                </span>
                {/* chain: the line between the status dots of a quest and its only prerequisite */}
                {r.chained && <span aria-hidden className="absolute top-0 h-[calc(50%-5px)] w-px bg-ink-500" style={{ left: dotX }} />}
                {open && r.children === 1 && <span aria-hidden className="absolute top-[calc(50%+5px)] bottom-0 w-px bg-ink-500" style={{ left: dotX }} />}
              </>
            );
            return r.ref !== undefined ? (
              <QuestRow
                key={key} rowKey={key} id={r.id} graph={graph} player={player} onSelect={onSelect} lead={lead} muted dense
                onClick={() => jump(r.ref!)}
                trail={<CornerLeftUp role="img" aria-label="上の行へ" className="size-3.5 shrink-0 text-ink-500" />}
              />
            ) : (
              <QuestRow
                key={key} rowKey={key} id={r.id} graph={graph} player={player} onSelect={onSelect} lead={lead} dense
                highlight={flash === key}
                trail={r.children > 0 && !open && <span className="shrink-0 text-xs tabular-nums text-ink-500" title={`前提 ${r.under.length} 件`}>+{r.under.length}</span>}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
};
