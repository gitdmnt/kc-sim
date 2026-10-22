/** パラメータ推定タブ: 観測ログから敵艦の回避・命中・運を推定し、送信・シミュレーションに使う。 */
import React, { useEffect, useMemo, useState } from "react";
import { useIntentFor } from "../nav";
import { getObservationDb } from "../../capture";
import { useAbyssalData } from "../../data/names";
import type { Confidence } from "../../data/types";
import { normalizeForSearch } from "../../fleet/catalog";
import { ESTIMATE_MIN_N } from "../../estimate/store";
import type { EstimatedStat, EstimateResult, SkipReason } from "../../estimate/types";
import { useEstimator } from "../../estimate/useEstimator";
import { Badge, Button, Card, Checkbox, EmptyState, ProgressBar, Select, Stat, Table, Td, TextInput, Th, Thead, Tr, cx, useToast } from "../../ui";
import type { BadgeTone } from "../../ui";
import { useApp } from "../context";
import { useSettings } from "../settings";
import { DensityPlot } from "./DensityPlot";

const STAT_LABEL: Record<EstimatedStat, string> = { ev: "回避", acc: "命中", luck: "運" };
const CONF: Record<Confidence | "none", { label: string; tone: BadgeTone }> = {
  observed: { label: "観測", tone: "ok" },
  datamined: { label: "データマイニング", tone: "accent" },
  db_estimate: { label: "DB推定", tone: "warn" },
  placeholder: { label: "仮値 (平坦)", tone: "danger" },
  unknown: { label: "不明 (平坦)", tone: "neutral" },
  none: { label: "なし (平坦)", tone: "neutral" },
};
const SKIP_LABEL: Record<SkipReason, string> = {
  air: "航空戦 (miss が記録されない)",
  protected: "かばう",
  cutin: "モデル外の特殊攻撃",
  unsupportedBattle: "対象外の戦闘 (連合艦隊など)",
  friendData: "味方データ不足",
  enemyData: "敵データ不足",
  inconsistent: "不整合",
  sameSide: "同陣営",
};

const f1 = (v: number) => v.toFixed(1);

/** 事前の中心が 90% 信用区間の外 = データが事前の値を否定している */
const shifted = (r: EstimateResult) => r.n > 0 && r.prior.value !== null && (r.prior.value < r.ci90[0] || r.prior.value > r.ci90[1]);

const Shift = ({ r }: { r: EstimateResult }) => {
  if (r.prior.value === null || r.n === 0) return <span className="text-ink-500">—</span>;
  const d = r.mean - r.prior.value;
  const text = `${d >= 0 ? "+" : "−"}${f1(Math.abs(d))}`;
  return shifted(r) ? (
    <Badge tone="warn" title="事前の値が 90% 信用区間の外">
      {d >= 0 ? "↑" : "↓"} {text}
    </Badge>
  ) : (
    <span className="text-xs text-ink-400 tabular-nums">{text}</span>
  );
};

/** 識別性についての注意 (推定値ごと) */
const notes = (r: EstimateResult): string[] => {
  const out: string[] = [];
  if (r.n === 0) out.push("この役割の観測がなく、事前分布のままです。");
  else if (r.sd > 0.8 * r.prior.sd) out.push(`観測ではほとんど絞れていません (事後 sd は事前の ${Math.round((100 * r.sd) / r.prior.sd)}%)。`);
  if (r.stat === "luck") out.push("運は回避 (+√(2·運)) と命中 (+1.5√運) にしか現れず、回避・命中と区別できないため、ほぼ事前分布で決まります。");
  if (r.stat === "ev" && r.ci90[1] > 60) out.push("回避は 40 / 65 を超えると上限処理 (55 + 2√(e−65) など) で効きが小さくなり、尤度が平坦なので区間が広がります。");
  if (r.stat === "acc" && r.ci90[0] <= 0) out.push("グリッドの下端 (0) に掛かっています。命中が 0 未満の可能性は扱っていません。");
  if (r.stat === "acc" && r.n > 0 && r.sd > 5) out.push("命中率は 10% / 96% で頭打ちになり、その範囲の攻撃は情報を持ちません。");
  return out;
};

const ShipDetail = ({ name, shipId, rows }: { name: string; shipId: number; rows: EstimateResult[] }) => (
  <Card
    title={
      <span className="flex items-center gap-2">
        {name}
        <span className="text-xs font-normal text-ink-400">No.{shipId}</span>
      </span>
    }
    bodyClassName="flex flex-col gap-4"
  >
    <div className="grid grid-cols-3 gap-2">
      {rows.map((r) => (
        <Stat
          key={r.stat}
          label={`${STAT_LABEL[r.stat]} (n=${r.n})`}
          value={`${f1(r.mean)} ± ${f1(r.sd)}`}
          sub={r.prior.value === null ? "事前: なし (平坦)" : `事前: ${r.prior.value}`}
          subTone={shifted(r) ? "accent" : "muted"}
        />
      ))}
    </div>
    {rows.map((r) => (
      <section key={r.stat}>
        <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
          <span className="font-semibold text-ink-100">{STAT_LABEL[r.stat]}</span>
          <span className="text-ink-400 tabular-nums">
            90% CI [{r.ci90[0]}, {r.ci90[1]}] · 事前 sd {f1(r.prior.sd)} → 事後 sd {f1(r.sd)}
          </span>
        </div>
        {r.density ? (
          <DensityPlot density={r.density} ci90={r.ci90} mean={r.mean} priorValue={r.prior.value} label={STAT_LABEL[r.stat]} />
        ) : (
          <p className="rounded-md bg-ink-900/70 px-3 py-4 text-center text-xs text-ink-400">分布は推定を実行した直後だけ表示されます (保存した結果には含めません)。</p>
        )}
        <ul className="mt-1 list-inside list-disc text-[11px] text-ink-300">
          {notes(r).map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>
    ))}
    <div className="flex flex-wrap gap-3 text-[11px] text-ink-400">
      <span><span className="mr-1 inline-block h-2 w-3 rounded-sm bg-accent-500/40" />事後分布</span>
      <span><span className="mr-1 inline-block w-3 border-t border-dashed border-ink-300 align-middle" />事前分布・事前の中心</span>
      <span><span className="mr-1 inline-block h-2 w-0.5 bg-ok-400 align-middle" />事後平均</span>
      <span><span className="mr-1 inline-block h-2 w-3 bg-accent-500/10" />90% 信用区間</span>
    </div>
    <p className="text-[11px] text-ink-400">
      推定値は sim-core のモデルで観測の命中・回避率を再現する値です。モデル外の効果 (特殊砲撃・フィット砲・イベント特効など) は推定値に吸収されます。
    </p>
  </Card>
);

type SortKey = "id" | "n" | "shift";

export const EstimateTab = () => {
  const { catalog } = useApp();
  const settings = useSettings();
  const names = useAbyssalData();
  const toast = useToast();
  const est = useEstimator(catalog.master);
  const [battleCount, setBattleCount] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [stat, setStat] = useState<EstimatedStat | "">("");
  const [onlyShifted, setOnlyShifted] = useState(false);
  const [onlyEnough, setOnlyEnough] = useState(false);
  const [sort, setSort] = useState<SortKey>("id");
  const intent = useIntentFor("estimate");
  const [selected, setSelected] = useState<number | null>(intent?.shipId ?? null);
  const [uploading, setUploading] = useState(false);

  const result = est.result;
  useEffect(() => {
    getObservationDb()
      .countBattles()
      .then(setBattleCount, () => setBattleCount(null));
  }, [result]);

  const byShip = useMemo(() => {
    const m = new Map<number, EstimateResult[]>();
    for (const r of result?.results ?? []) m.set(r.shipId, [...(m.get(r.shipId) ?? []), r]);
    return m;
  }, [result]);

  const rows = useMemo(() => {
    const q = normalizeForSearch(query);
    const list = (result?.results ?? []).filter(
      (r) =>
        (!stat || r.stat === stat) &&
        (!onlyShifted || shifted(r)) &&
        (!onlyEnough || r.n >= ESTIMATE_MIN_N) &&
        (!q || normalizeForSearch(`${names.shipName(r.shipId)}${r.shipId}`).includes(q))
    );
    const shift = (r: EstimateResult) => (r.prior.value === null || r.n === 0 ? 0 : Math.abs(r.mean - r.prior.value) / Math.max(r.sd, 0.5));
    const key: Record<SortKey, (r: EstimateResult) => number> = { id: (r) => r.shipId, n: (r) => -r.n, shift: (r) => -shift(r) };
    return [...list].sort((a, b) => key[sort](a) - key[sort](b) || a.shipId - b.shipId);
  }, [result, query, stat, onlyShifted, onlyEnough, sort, names]);

  const current = selected ?? rows[0]?.shipId ?? null;
  const uploadable = (result?.results ?? []).filter((r) => r.n >= ESTIMATE_MIN_N).length;
  const running = est.status === "running";

  const upload = async () => {
    setUploading(true);
    try {
      const n = await est.upload();
      toast.push(`推定値 ${n} 件を送信しました (estimator:poi)`, "ok");
    } catch (e) {
      toast.push((e as Error).message, "danger");
    } finally {
      setUploading(false);
    }
  };

  const skipped = Object.entries(result?.observe.skipped ?? {}).filter(([, n]) => (n ?? 0) > 0) as [SkipReason, number][];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="敵艦の隠しステータス推定 (回避・命中・運)"
        actions={
          <>
            {settings.useEstimates ? <Badge tone="ok">シミュレーションで使用中</Badge> : <Badge tone="neutral" title="設定タブで切り替え">シミュレーション未使用</Badge>}
            {result && (
              <Button size="sm" variant="ghost" onClick={est.clear} disabled={running}>
                結果を消去
              </Button>
            )}
          </>
        }
        bodyClassName="flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-center gap-3">
          {running ? (
            <Button variant="danger" onClick={est.cancel}>
              キャンセル
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void est.run()}>
              {result ? "再推定" : "推定を実行"}
            </Button>
          )}
          <Button onClick={() => void upload()} disabled={running || uploading || uploadable === 0} title={`n ≥ ${ESTIMATE_MIN_N} の推定値を data API に送ります`}>
            {uploading ? "送信中…" : `API に送信 (n ≥ ${ESTIMATE_MIN_N}: ${uploadable} 件)`}
          </Button>
          {running && (
            <div className="min-w-48 flex-1">
              <ProgressBar value={est.progress?.done ?? 0} max={est.progress?.total || 1} tone="accent" className="h-2.5" />
              <div className="mt-1 text-[11px] text-ink-300 tabular-nums">
                {est.progress?.total
                  ? `グリッド計算 ${est.progress.done.toLocaleString()} / ${est.progress.total.toLocaleString()} 種類の攻撃`
                  : "観測ログと事前分布を読み込み中…"}
              </div>
            </div>
          )}
          {!running && result && <span className="text-xs text-ink-400">最終推定: {new Date(result.at).toLocaleString()}</span>}
        </div>
        {est.error && <p className="text-xs text-danger-400">{est.error.message}</p>}

        {result && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Stat label="観測ログの戦闘" value={battleCount?.toLocaleString() ?? "—"} />
              <Stat label="使った戦闘" value={result.observe.battles.toLocaleString()} />
              <Stat label="使えた命中判定" value={result.observe.observations.toLocaleString()} />
              <Stat label="推定した敵艦" value={byShip.size} sub={result.priorErrors.length ? `事前分布の取得失敗 ${result.priorErrors.length}` : undefined} />
              <Stat label={`n ≥ ${ESTIMATE_MIN_N} の推定値`} value={uploadable} sub="送信・シミュレーションの対象" />
            </div>
            {skipped.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-300">
                <span>使わなかった攻撃:</span>
                {skipped.map(([k, n]) => (
                  <Badge key={k} tone="neutral">
                    {SKIP_LABEL[k]} {n.toLocaleString()}
                  </Badge>
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      {!result ? (
        <EmptyState
          title="推定結果がありません"
          description="観測ログ (出撃中の戦闘) から、敵艦の回避・命中・運をベイズ推定します。命中/ミス/クリティカルの記録を sim-core の命中モデルに当てはめ、API の推定値を事前分布にします。"
          action={!running && <Button variant="primary" onClick={() => void est.run()}>推定を実行</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_30rem]">
          <Card title={`推定値 (${rows.length})`} bodyClassName="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="艦名・ID で検索" aria-label="検索" className="w-48" />
              <Select value={stat} onChange={(e) => setStat(e.target.value as EstimatedStat | "")} aria-label="ステータス" className="w-44">
                <option value="">ステータス: すべて</option>
                {(Object.keys(STAT_LABEL) as EstimatedStat[]).map((s) => (
                  <option key={s} value={s}>
                    {STAT_LABEL[s]}
                  </option>
                ))}
              </Select>
              <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="並び順" className="w-36">
                <option value="id">艦 ID 順</option>
                <option value="n">観測数順</option>
                <option value="shift">ずれの大きい順</option>
              </Select>
              <Checkbox label="事前値からずれたもの" checked={onlyShifted} onChange={(e) => setOnlyShifted(e.target.checked)} />
              <Checkbox label={`n ≥ ${ESTIMATE_MIN_N}`} checked={onlyEnough} onChange={(e) => setOnlyEnough(e.target.checked)} />
            </div>
            <Table className="max-h-[42rem]">
              <Thead>
                <tr>
                  <Th>敵艦</Th>
                  <Th>ステータス</Th>
                  <Th>事前</Th>
                  <Th className="text-right">事後 (平均 ± sd)</Th>
                  <Th className="text-right">90% CI</Th>
                  <Th className="text-right">n</Th>
                  <Th className="text-right">事前との差</Th>
                </tr>
              </Thead>
              <tbody>
                {rows.map((r, i) => {
                  const first = i === 0 || rows[i - 1].shipId !== r.shipId;
                  return (
                    <Tr key={`${r.shipId}-${r.stat}`} onClick={() => setSelected(r.shipId)} selected={r.shipId === current}>
                      <Td className="whitespace-nowrap">
                        {first && (
                          <>
                            <span className="text-ink-50">{names.shipName(r.shipId)}</span>
                            <span className="ml-1.5 text-[11px] text-ink-400">{r.shipId}</span>
                          </>
                        )}
                      </Td>
                      <Td>{STAT_LABEL[r.stat]}</Td>
                      <Td className="whitespace-nowrap">
                        <span className="mr-1.5 tabular-nums">{r.prior.value ?? "—"}</span>
                        <Badge tone={CONF[r.prior.confidence].tone}>{CONF[r.prior.confidence].label}</Badge>
                      </Td>
                      <Td className={cx("text-right tabular-nums", r.n < ESTIMATE_MIN_N ? "text-ink-400" : "text-ink-50")}>
                        {f1(r.mean)} <span className="text-ink-400">± {f1(r.sd)}</span>
                      </Td>
                      <Td className="text-right text-xs text-ink-300 tabular-nums">
                        [{r.ci90[0]}, {r.ci90[1]}]
                      </Td>
                      <Td className="text-right tabular-nums">
                        {r.n < ESTIMATE_MIN_N ? <span className="text-ink-400">{r.n}</span> : r.n.toLocaleString()}
                      </Td>
                      <Td className="text-right">
                        <Shift r={r} />
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
            <p className="text-[11px] text-ink-400">
              n は推定に効いた命中判定の数 (回避: 味方の攻撃、命中: 敵の攻撃、運: 両方)。n &lt; {ESTIMATE_MIN_N} の値は灰色で、送信・シミュレーションには使いません。
              事前分布は API の推定値 (データマイニング: 狭い、DB推定: 中程度、仮値: 平坦) で、推定器自身の送信値は二重計上を避けるため使いません。
            </p>
          </Card>

          {current !== null && byShip.has(current) && (
            <ShipDetail name={names.shipName(current)} shipId={current} rows={byShip.get(current)!} />
          )}
        </div>
      )}
    </div>
  );
};
