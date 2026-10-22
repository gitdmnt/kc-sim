import React from "react";
import { FORMATION_NAME } from "../../data/routing";
import { cx } from "../../ui";

/** 陣形 (api の番号) ごとの艦の並び。上が進行方向、1 点 = 1 隻 (6 隻)。 */
const FORMATION_DOTS: Record<number, [number, number][]> = {
  1: [[0, -5], [0, -3], [0, -1], [0, 1], [0, 3], [0, 5]],
  2: [[-2, -4], [-2, 0], [-2, 4], [2, -4], [2, 0], [2, 4]],
  3: [[0, -4], [-4, 0], [4, 0], [0, 0], [-2.5, 3.5], [2.5, 3.5]],
  4: [[-5, -5], [-3, -3], [-1, -1], [1, 1], [3, 3], [5, 5]],
  5: [[-5, 0], [-3, 0], [-1, 0], [1, 0], [3, 0], [5, 0]],
  6: [[0, -5], [-2, -2], [2, -2], [0, 1], [-2, 4], [2, 4]],
};

/** 陣形の小さな図 (名前は title)。連合艦隊の警戒航行序列など図の無いものは名前の頭文字。 */
export const FormationGlyph = ({ formation }: { formation: number | null }) => {
  const name = formation === null ? "陣形不明" : (FORMATION_NAME[formation] ?? `陣形 ${formation}`);
  const dots = formation === null ? undefined : FORMATION_DOTS[formation];
  if (!dots) return <span className="text-xs text-ink-400" title={name}>{formation === null ? "—" : name.slice(0, 2)}</span>;
  return (
    <svg viewBox="-7 -7 14 14" className="h-5 w-5 text-ink-300" role="img" aria-label={name}>
      <title>{name}</title>
      {dots.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={1.1} fill="currentColor" />
      ))}
    </svg>
  );
};

/** 深海棲艦の名前から短い印: 級のカナ 1 字 + 改/elite (e)/flagship (f)。例: 「空母ヲ級flagship」→「ヲf」 */
export const enemyMark = (name: string): { cls: string; tier: string } => {
  const m = /([ァ-ヶ])級(改)?/.exec(name);
  const tier = `${m?.[2] ?? ""}${/flagship/i.test(name) ? "f" : /elite/i.test(name) ? "e" : ""}`;
  return { cls: m ? m[1] : name.slice(0, 2), tier };
};

/**
 * 敵編成の 1 行: 艦ごとの印を固定幅の列に並べる。全編成で同じ艦の位置は薄く、違う位置は明るく出すので、
 * 編成どうしの差が縦に見比べられる。名前は各印の title。
 */
export const CompMarks = ({ ids, same, name, slots }: { ids: number[]; same: boolean[]; name: (id: number) => string; slots: number }) => (
  <span className="grid gap-x-1" style={{ gridTemplateColumns: `repeat(${slots}, 1.75rem)` }}>
    {Array.from({ length: slots }, (_, i) => {
      const id = ids[i];
      if (id === undefined) return <span key={i} />;
      const n = name(id);
      const { cls, tier } = enemyMark(n);
      return (
        <span key={i} title={n} className={cx("text-center whitespace-nowrap", same[i] ? "text-ink-500" : "font-semibold text-ink-50")}>
          {cls}
          {tier && <span className={cx("text-xs", same[i] ? "text-ink-600" : "text-ink-300")}>{tier}</span>}
        </span>
      );
    })}
  </span>
);
