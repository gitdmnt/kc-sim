import React from "react";
import { StackedBar } from "../../ui";
import { SERVER_ESTIMATOR_SOURCE } from "@shared/data/types";
import type { EnemyBuild, FriendBuild } from "./types";

const STAT_LABEL: Record<string, string> = { ev: "回避", asw: "対潜", los: "索敵", luck: "運", acc: "命中(隠し)", tacc: "雷撃命中(基礎)" };
/** 出典の確からしさ: 色は確かな (緑・灰) → 不確か (橙・赤) */
const CONF_LABEL: Record<string, { label: string; color: string }> = {
  observed: { label: "観測", color: "var(--color-ok-400)" },
  datamined: { label: "データマイニング", color: "var(--color-ink-400)" },
  db_estimate: { label: "DB推定", color: "var(--color-warn-400)" },
  placeholder: { label: "仮値", color: "var(--color-danger-400)" },
  unknown: { label: "不明 (0扱い)", color: "var(--color-danger-600)" },
};
const confOf = (c: string) => CONF_LABEL[c] ?? { label: c, color: "var(--color-ink-500)" };

const Dot = ({ color }: { color: string }) => <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />;

export interface AssumptionData {
  friend: FriendBuild;
  enemy: EnemyBuild[];
  applyFit: boolean;
  /** 設定「シミュレーションで推定値を使う」が有効だった (サーバの推定値 = estimator:server を使った) */
  serverEstimates: boolean;
  /** 入力の組み立てと計算の警告 (重複なし) */
  warnings: string[];
}

/** 仮値・不明の敵隠しステータスの数 (前提タブの件数表示用) */
export const weakCount = (data: AssumptionData): number => {
  const seen = new Set<string>();
  for (const e of data.enemy)
    for (const r of e.reliability) if (r.confidence !== "datamined" && r.confidence !== "observed") seen.add(`${r.shipId}:${r.stat}`);
  return seen.size;
};

const H = ({ children, tone }: { children: React.ReactNode; tone?: "warn" }) => (
  <h4 className={tone === "warn" ? "mb-1 text-xs font-semibold text-warn-400" : "mb-1 text-xs font-semibold text-ink-300"}>{children}</h4>
);

/** 計算の前提: 敵の隠しステータスの出典、サーバ推定値、装備ボーナス、警告。 */
export const Assumptions = ({ data }: { data: AssumptionData }) => {
  // 艦×ステータスごとに一意化
  const seen = new Map<string, EnemyBuild["reliability"][number]>();
  for (const e of data.enemy) for (const r of e.reliability) seen.set(`${r.shipId}:${r.stat}`, r);
  const all = [...seen.values()];
  const counts = new Map<string, number>();
  all.forEach((r) => counts.set(r.confidence, (counts.get(r.confidence) ?? 0) + 1));
  // 艦ごとに同じ注記が並ばないよう、ステータス×出典ごとに艦名をまとめる
  const weakGroups = new Map<string, { stat: string; confidence: string; names: Set<string> }>();
  all
    .filter((r) => r.confidence !== "datamined" && r.confidence !== "observed")
    .forEach((r) => {
      const key = `${r.stat}:${r.confidence}`;
      const g = weakGroups.get(key) ?? { stat: r.stat, confidence: r.confidence, names: new Set<string>() };
      g.names.add(r.value === null ? r.name : `${r.name} (${r.value})`);
      weakGroups.set(key, g);
    });
  const usedShips = new Map<number, { name: string; items: typeof all }>();
  all
    .filter((r) => r.source === SERVER_ESTIMATOR_SOURCE)
    .forEach((r) => {
      const e = usedShips.get(r.shipId) ?? { name: r.name, items: [] };
      e.items.push(r);
      usedShips.set(r.shipId, e);
    });

  return (
    <div className="flex flex-col gap-4 text-sm">
      {data.warnings.length > 0 && (
        <section>
          <H tone="warn">警告 {data.warnings.length}</H>
          <ul className="list-inside list-disc text-xs text-ink-200">
            {data.warnings.slice(0, 30).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <H>敵の隠しステータス</H>
        <StackedBar parts={[...counts].map(([c, n]) => ({ label: confOf(c).label, value: n / Math.max(1, all.length), color: confOf(c).color }))} />
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-300">
          {[...counts].map(([c, n]) => (
            <span key={c} className="flex items-center gap-1">
              <Dot color={confOf(c).color} />
              {confOf(c).label}
              <span className="tabular-nums text-ink-100">{n}</span>
            </span>
          ))}
        </div>
        {weakGroups.size > 0 && (
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {[...weakGroups.values()].map((g) => (
              <li key={`${g.stat}:${g.confidence}`} className="flex items-baseline gap-2">
                <span className="flex shrink-0 items-center gap-1 text-ink-300">
                  <Dot color={confOf(g.confidence).color} />
                  {STAT_LABEL[g.stat] ?? g.stat}
                </span>
                <span className="text-ink-200" title={confOf(g.confidence).label}>
                  {[...g.names].join("、")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.serverEstimates && (
        <section>
          <H>サーバ推定値 (n ≥ 30)</H>
          {usedShips.size === 0 ? (
            <span className="text-xs text-ink-400">該当なし</span>
          ) : (
            <ul className="flex flex-col gap-1 text-xs">
              {[...usedShips.entries()].map(([id, e]) => (
                <li key={id} className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-ink-100">{e.name}</span>
                  {e.items.map((r) => (
                    <span key={r.stat} className="text-ink-400" title={r.n === null ? undefined : `n=${r.n}`}>
                      {STAT_LABEL[r.stat]} <span className="tabular-nums text-ink-100">{r.value === null ? "—" : Math.round(r.value * 10) / 10}</span>
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="text-xs text-ink-300">
        <H>味方</H>
        装備ボーナス: {data.applyFit ? `差し引く (評価できない定義 ${data.friend.fitUnresolved} 件)` : "差し引かない"}
      </section>
    </div>
  );
};
