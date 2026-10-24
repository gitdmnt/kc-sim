import React, { useEffect, useRef, useState } from "react";
import { ChevronRight, CornerLeftUp } from "lucide-react";
import type { OutlineRow, QuestGraph } from "@shared/quest/tree";
import { cx } from "../../ui";
import { FINISHED, QuestRow } from "./QuestRow";
import type { Player } from "./QuestRow";

/** Levels open at first (0 = the target's own prerequisites) */
const OPEN_LEVELS = 2;

const keyOf = (r: OutlineRow) => r.path.join("/");

/** Guide lines left of a row: one 14px column per level above it, the last one the elbow into this row. */
const Guides = ({ more }: { more: boolean[] }) => (
  <>
    {more.slice(1).map((m, c, cols) => {
      const elbow = c === cols.length - 1;
      return (
        <span key={c} aria-hidden className="relative w-3.5 shrink-0">
          {(m || elbow) && <span className={cx("absolute top-0 left-1/2 w-px bg-ink-700", m ? "bottom-0" : "h-1/2")} />}
          {elbow && <span className="absolute top-1/2 right-0 left-1/2 h-px bg-ink-700" />}
        </span>
      );
    })}
  </>
);

/**
 * 前提任務のツリー: 子 = 直接の前提で、一段ずつ字下げ。二度目に出てくる任務は参照の一行 (クリックで最初の行へ移動)。
 * 初期表示は 2 段目まで開き、受注可・遂行中の任務へ続く枝も開く。前提がすべて達成済みの枝は畳む。
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
  const isOpen = (r: OutlineRow) =>
    toggled.get(keyOf(r)) ??
    (!r.under.every((id) => FINISHED.includes(status(id))) &&
      (r.path.length <= OPEN_LEVELS || r.under.some((id) => status(id) === "available" || status(id) === "active")));
  const shown: OutlineRow[] = [];
  let hideBelow = Infinity;
  for (const r of rows) {
    if (r.path.length > hideBelow) continue;
    hideBelow = r.children > 0 && !isOpen(r) ? r.path.length : Infinity;
    shown.push(r);
  }
  const closed = rows.some((r) => r.children > 0 && !isOpen(r));
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
            onClick={() => setToggled(closed ? new Map(rows.filter((r) => r.children > 0).map((r) => [keyOf(r), true])) : new Map())}
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
            const lead = (
              <>
                <Guides more={r.more} />
                <span className="relative flex w-3.5 shrink-0 items-center justify-center">
                  {r.children > 0 ? (
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-label={open ? "畳む" : "開く"}
                      onClick={() => setToggled((m) => new Map(m).set(key, !open))}
                      className="flex size-3.5 cursor-pointer items-center justify-center rounded text-ink-400 hover:bg-ink-800 hover:text-ink-100"
                    >
                      <ChevronRight aria-hidden className={cx("size-3", open && "rotate-90")} />
                    </button>
                  ) : (
                    r.path.length > 1 && <span aria-hidden className="absolute top-1/2 left-0 h-px w-1/2 bg-ink-700" />
                  )}
                </span>
              </>
            );
            return r.ref !== undefined ? (
              <QuestRow
                key={key} rowKey={key} id={r.id} graph={graph} player={player} onSelect={onSelect} lead={lead} muted
                onClick={() => jump(r.ref!)}
                trail={<CornerLeftUp role="img" aria-label="上の行へ" className="size-3.5 shrink-0 text-ink-500" />}
              />
            ) : (
              <QuestRow
                key={key} rowKey={key} id={r.id} graph={graph} player={player} onSelect={onSelect} lead={lead}
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
