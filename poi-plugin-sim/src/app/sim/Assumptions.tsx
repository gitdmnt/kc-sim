import React from "react";
import { Badge, Card } from "../../ui";
import type { BadgeTone } from "../../ui";
import type { EstimateResult } from "../../estimate/types";
import type { EnemyBuild, FriendBuild } from "./types";

const STAT_LABEL: Record<string, string> = { ev: "回避", asw: "対潜", los: "索敵", luck: "運", acc: "命中(隠し)", tacc: "雷撃命中(基礎)" };
const CONF_LABEL: Record<string, { label: string; tone: BadgeTone }> = {
  observed: { label: "観測", tone: "ok" },
  datamined: { label: "データマイニング", tone: "accent" },
  db_estimate: { label: "DB推定", tone: "warn" },
  placeholder: { label: "仮値", tone: "danger" },
  unknown: { label: "不明 (0扱い)", tone: "danger" },
};

export interface AssumptionData {
  friend: FriendBuild;
  enemy: EnemyBuild[];
  applyFit: boolean;
  /** 推定タブの推定値 (n ≥ 30) をシミュレーションに使ったとき、その推定値と推定時刻 */
  estimates?: { results: EstimateResult[]; at: number };
}

export const Assumptions = ({ data }: { data: AssumptionData }) => {
  // 艦×ステータスごとに一意化。推定タブの値で上書きされた項目は「観測」として数える
  const local = new Map((data.estimates?.results ?? []).map((r) => [`${r.shipId}:${r.stat}`, r]));
  const seen = new Map<string, EnemyBuild["reliability"][number]>();
  for (const e of data.enemy) for (const r of e.reliability) seen.set(`${r.shipId}:${r.stat}`, r);
  const all = [...seen.entries()].map(([key, r]) => {
    const l = local.get(key);
    return l ? { ...r, confidence: "observed", value: Math.round(l.mean * 10) / 10 } : r;
  });
  const used = all.filter((r) => local.has(`${r.shipId}:${r.stat}`));
  const counts = new Map<string, number>();
  all.forEach((r) => counts.set(r.confidence, (counts.get(r.confidence) ?? 0) + 1));
  const weak = all.filter((r) => r.confidence !== "datamined" && r.confidence !== "observed");
  const byShip = new Map<number, { name: string; items: typeof weak }>();
  weak.forEach((r) => {
    const e = byShip.get(r.shipId) ?? { name: r.name, items: [] };
    e.items.push(r);
    byShip.set(r.shipId, e);
  });
  const warnings = [...data.friend.warnings, ...data.enemy.flatMap((e) => e.warnings)];
  const usedShips = new Map<number, { name: string; items: typeof used }>();
  used.forEach((r) => {
    const e = usedShips.get(r.shipId) ?? { name: r.name, items: [] };
    e.items.push(r);
    usedShips.set(r.shipId, e);
  });

  return (
    <Card title="前提・信頼性" bodyClassName="flex flex-col gap-4 text-sm">
      <section>
        <h4 className="mb-1.5 text-xs font-semibold text-ink-300">敵の隠しステータス (回避・対潜・索敵・運・命中) の出典</h4>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {[...counts].map(([c, n]) => (
            <Badge key={c} tone={CONF_LABEL[c]?.tone ?? "neutral"}>
              {CONF_LABEL[c]?.label ?? c} {n}
            </Badge>
          ))}
        </div>
        {byShip.size === 0 ? (
          <p className="text-xs text-ink-300">全て観測またはデータマイニング由来です。</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {[...byShip.entries()].map(([id, e]) => (
              <li key={id} className="flex flex-wrap items-center gap-1.5">
                <span className="text-ink-100">{e.name}</span>
                {e.items.map((r) => (
                  <Badge key={r.stat} tone={CONF_LABEL[r.confidence]?.tone ?? "neutral"} title={r.value === null ? "値なし" : `値 ${r.value}`}>
                    {STAT_LABEL[r.stat]}: {CONF_LABEL[r.confidence]?.label ?? r.confidence}
                    {r.value !== null && ` (${r.value})`}
                  </Badge>
                ))}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-ink-400">仮値・不明のステータスを含む結果は、回避・命中・索敵判定の確率がずれる可能性があります。</p>
      </section>

      {data.estimates && (
        <section>
          <h4 className="mb-1.5 text-xs font-semibold text-ok-400">推定タブの推定値を使用</h4>
          {used.length === 0 ? (
            <p className="text-xs text-ink-300">この敵編成の艦には n ≥ 30 の推定値がありません (API の値を使用)。</p>
          ) : (
            <>
              <p className="mb-1.5 text-xs text-ink-300">
                {new Date(data.estimates.at).toLocaleString()} の推定 (n ≥ 30) を {usedShips.size} 隻・{used.length} 項目に適用。API の値より優先しています。
              </p>
              <ul className="flex flex-col gap-1 text-xs">
                {[...usedShips.entries()].map(([id, e]) => (
                  <li key={id} className="flex flex-wrap items-center gap-1.5">
                    <span className="text-ink-100">{e.name}</span>
                    {e.items.map((r) => {
                      const l = local.get(`${r.shipId}:${r.stat}`)!;
                      return (
                        <Badge key={r.stat} tone="ok" title={`90% CI [${l.ci90[0]}, ${l.ci90[1]}]、n=${l.n}`}>
                          {STAT_LABEL[r.stat]} {l.mean.toFixed(1)} ± {l.sd.toFixed(1)}
                        </Badge>
                      );
                    })}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section>
        <h4 className="mb-1.5 text-xs font-semibold text-ink-300">味方艦</h4>
        <ul className="list-inside list-disc text-xs text-ink-200">
          <li>素ステータス = 実測値 − 装備のマスター値{data.applyFit ? " − 装備ボーナス" : ""}。手入力艦は計算値 (近代化・固有ボーナス除く)。</li>
          <li>
            装備ボーナス: {data.applyFit ? `近似計算 (未対応条件 ${data.friend.fitSkipped} 件は加算なし)` : "差し引かない (素ステータスに含まれたまま)"}
          </li>
          <li>戦闘開始時は耐久・燃料・弾薬ともに全快として扱います。</li>
        </ul>
      </section>

      <section>
        <h4 className="mb-1.5 text-xs font-semibold text-ink-300">モデルの範囲 (SIM_INTERFACE.md)</h4>
        <p className="text-xs text-ink-300">
          通常艦隊 1 つ対 1 ノードの戦闘のみ。連合艦隊・基地航空隊・支援・陸上型の特効・特殊攻撃 (一部) ・イベント特効は未対応です。
          敵の陸上型判定は行っていません。
        </p>
      </section>

      {warnings.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-xs font-semibold text-warn-400">警告 ({warnings.length})</h4>
          <ul className="list-inside list-disc text-xs text-ink-200">
            {[...new Set(warnings)].slice(0, 20).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      )}
    </Card>
  );
};
