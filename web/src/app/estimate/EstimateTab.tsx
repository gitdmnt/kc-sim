/** パラメータ推定タブ: サーバが全プレイヤーの観測から推定した敵艦の隠しステータスを表示する (GET /api/v1/estimates)。 */
import React, { useMemo, useState } from "react";
import { useIntentFor } from "../nav";
import { getDataApi } from "../../data/api";
import { useAbyssalData } from "../../data/names";
import { ESTIMATE_MIN_N } from "@shared/data/types";
import type { Confidence, EstimatedStat, EstimateRow } from "@shared/data/types";
import { useAsync } from "../../data/useAsync";
import { normalizeForSearch } from "../../fleet/catalog";
import { Badge, Button, Card, Checkbox, EmptyState, S, Select, Stat, Table, Td, TextInput, Th, Thead, Tr, cx } from "../../ui";
import { useSettings } from "../settings";
import { DensityPlot } from "./DensityPlot";
import { formatShortDateTime } from "../../ui/format";

const STAT_LABEL: Record<EstimatedStat, string> = { ev: "回避", acc: "命中", luck: "運" };
/** 事前分布の出どころ。表では毎行出るので、確度の低いもの (DB推定・仮値) だけ色を付ける。 */
const CONF: Record<Confidence | "none", { label: string; className: string }> = {
  observed: { label: "観測", className: "text-ink-400" },
  datamined: { label: "データマイニング", className: "text-ink-400" },
  db_estimate: { label: "DB推定", className: "text-warn-400" },
  placeholder: { label: "仮値", className: "text-danger-400" },
  unknown: { label: "不明", className: "text-ink-500" },
  none: { label: "なし", className: "text-ink-500" },
};
const f1 = (v: number) => v.toFixed(1);

/** 事前の中心が 90% 信用区間の外 = データが事前の値を否定している */
const shifted = (r: EstimateRow) => r.n > 0 && r.prior.value !== null && (r.prior.value < r.ci90[0] || r.prior.value > r.ci90[1]);

const Shift = ({ r }: { r: EstimateRow }) => {
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
const notes = (r: EstimateRow): string[] => {
  const out: string[] = [];
  if (r.n === 0) out.push("観測なし (事前分布のまま)");
  else if (r.sd > 0.8 * r.prior.sd) out.push(`観測でほぼ絞れていない (事後 sd は事前の ${Math.round((100 * r.sd) / r.prior.sd)}%)`);
  if (r.stat === "luck") out.push("運は回避・命中と区別しにくく、ほぼ事前分布で決まる");
  if (r.stat === "ev" && r.ci90[1] > 60) out.push("回避 40 / 65 超は上限処理で効きが鈍く、区間が広い");
  if (r.stat === "acc" && r.ci90[0] <= 0) out.push("区間が下端 0 に掛かっている (0 未満は扱わない)");
  if (r.stat === "acc" && r.n > 0 && r.sd > 5) out.push("命中率 10% / 96% の頭打ちで情報が少ない");
  return out;
};

const ShipDetail = ({ name, shipId, rows, densityLoading }: { name: string; shipId: number; rows: EstimateRow[]; densityLoading: boolean }) => (
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
          sub={`事前: ${r.prior.value ?? "なし"}`}
          subTone={shifted(r) ? "accent" : "muted"}
        />
      ))}
    </div>
    {rows.map((r) => (
      <section key={r.stat}>
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold text-ink-100">{STAT_LABEL[r.stat]}</span>
          <span className="text-xs text-ink-400 tabular-nums">
            90% CI [{r.ci90[0]}, {r.ci90[1]}] · sd {f1(r.prior.sd)} → {f1(r.sd)}
          </span>
        </div>
        {r.density ? (
          <DensityPlot density={r.density} ci90={r.ci90} mean={r.mean} priorValue={r.prior.value} label={STAT_LABEL[r.stat]} />
        ) : (
          <p className="rounded-md bg-ink-900/70 px-3 py-4 text-center text-sm text-ink-400">{densityLoading ? S.common.loading : "分布を取得できませんでした"}</p>
        )}
        {notes(r).map((n) => (
          <p key={n} className="mt-1 text-sm text-ink-300">
            {n}
          </p>
        ))}
      </section>
    ))}
    <div className="flex flex-wrap gap-3 text-xs text-ink-400">
      <span><span className="mr-1 inline-block h-2 w-3 rounded-sm bg-accent-500/40" />事後分布</span>
      <span><span className="mr-1 inline-block w-3 border-t border-dashed border-ink-400 align-middle" />事前分布・事前の中心</span>
      <span><span className="mr-1 inline-block h-2 w-0.5 bg-brass-400 align-middle" />事後平均</span>
      <span><span className="mr-1 inline-block h-2 w-3 bg-accent-500/10" />90% 信用区間</span>
    </div>
    <details className="text-sm text-ink-300">
      <summary className="cursor-pointer text-xs text-ink-400">推定値の意味</summary>
      <p className="mt-1">
        sim-core のモデルで観測の命中・回避率を再現する値です。モデル外の効果 (特殊砲撃・フィット砲・特効など) も推定値に吸収されます。
      </p>
    </details>
  </Card>
);

type SortKey = "id" | "n" | "shift";

export const EstimateTab = () => {
  const settings = useSettings();
  const names = useAbyssalData();
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [stat, setStat] = useState<EstimatedStat | "">("");
  const [onlyShifted, setOnlyShifted] = useState(false);
  const [onlyEnough, setOnlyEnough] = useState(false);
  const [sort, setSort] = useState<SortKey>("id");
  const intent = useIntentFor("estimate");
  const [selected, setSelected] = useState<number | null>(intent?.shipId ?? null);

  const list = useAsync(() => getDataApi().estimates({ density: false }, reload > 0), [reload]);
  const all = list.data?.estimates;

  const byShip = useMemo(() => {
    const m = new Map<number, EstimateRow[]>();
    for (const r of all ?? []) m.set(r.shipId, [...(m.get(r.shipId) ?? []), r]);
    return m;
  }, [all]);

  const rows = useMemo(() => {
    const q = normalizeForSearch(query);
    const filtered = (all ?? []).filter(
      (r) =>
        (!stat || r.stat === stat) &&
        (!onlyShifted || shifted(r)) &&
        (!onlyEnough || r.n >= ESTIMATE_MIN_N) &&
        (!q || normalizeForSearch(`${names.shipName(r.shipId)}${r.shipId}`).includes(q))
    );
    const shift = (r: EstimateRow) => (r.prior.value === null || r.n === 0 ? 0 : Math.abs(r.mean - r.prior.value) / Math.max(r.sd, 0.5));
    const key: Record<SortKey, (r: EstimateRow) => number> = { id: (r) => r.shipId, n: (r) => -r.n, shift: (r) => -shift(r) };
    return [...filtered].sort((a, b) => key[sort](a) - key[sort](b) || a.shipId - b.shipId);
  }, [all, query, stat, onlyShifted, onlyEnough, sort, names]);

  const current = selected ?? rows[0]?.shipId ?? null;
  // 分布 (事前・事後) は 1 隻ずつ取る
  const detail = useAsync(current === null ? null : () => getDataApi().estimates({ shipId: current, density: true }, reload > 0), [current, reload]);
  const detailRows = detail.data?.estimates.filter((r) => r.shipId === current);
  const usable = (all ?? []).filter((r) => r.n >= ESTIMATE_MIN_N).length;

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="敵艦の隠しステータス推定"
        actions={
          <>
            {settings.useEstimates ? <Badge tone="ok">シミュレーションで使用中</Badge> : <Badge tone="neutral" title="設定タブで切り替え">シミュレーション未使用</Badge>}
            <Button size="sm" variant="ghost" onClick={() => setReload((n) => n + 1)} disabled={list.loading} title="サーバから取り直す" aria-label="再読み込み">
              ↻
            </Button>
          </>
        }
        bodyClassName="flex flex-col gap-3"
      >
        <p className="text-sm text-ink-300">
          データサーバが全プレイヤーの観測 (命中・ミス) からベイズ推定した、敵艦の回避・命中・運です。
          {list.data?.updatedAt && <span className="ml-2 text-xs text-ink-400">最終推定: {formatShortDateTime(Date.parse(list.data.updatedAt))}</span>}
        </p>
        {list.error && <p className="text-sm text-danger-400">{list.error.message}</p>}
        {all && all.length > 0 && (
          <div className="grid w-full grid-cols-2 gap-2 sm:w-[28rem]">
            <Stat size="lg" label="推定された敵艦" value={byShip.size} />
            <Stat size="lg" label="シミュレーションで使える推定値" value={usable} sub={`n ≥ ${ESTIMATE_MIN_N}`} />
          </div>
        )}
      </Card>

      {list.loading && !all ? (
        <EmptyState title={S.common.loading} />
      ) : !all || all.length === 0 ? (
        <EmptyState
          title="推定結果がありません"
          description="サーバがまだ観測から推定していません。観測ログを送信すると、サーバが推定して表示します。"
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
                  <Th>
                    <span title="API の値 (データマイニング > DB推定 > 仮値 の順に確か)">事前</span>
                  </Th>
                  <Th className="text-right">事後 (平均 ± sd)</Th>
                  <Th className="text-right">90% CI</Th>
                  <Th className="text-right">
                    <span title="推定に効いた命中判定の数">n</span>
                  </Th>
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
                            <span className="ml-1.5 text-xs text-ink-400">{r.shipId}</span>
                          </>
                        )}
                      </Td>
                      <Td>{STAT_LABEL[r.stat]}</Td>
                      <Td className="whitespace-nowrap">
                        {r.prior.value === null ? (
                          <span className="text-ink-500" title={CONF[r.prior.confidence].label}>—</span>
                        ) : (
                          <>
                            <span className="tabular-nums">{r.prior.value}</span>
                            <span className={cx("ml-1.5 text-xs", CONF[r.prior.confidence].className)}>{CONF[r.prior.confidence].label}</span>
                          </>
                        )}
                      </Td>
                      <Td className={cx("text-right tabular-nums", r.n < ESTIMATE_MIN_N ? "text-ink-400" : "text-ink-50")}>
                        {f1(r.mean)} <span className="text-ink-400">± {f1(r.sd)}</span>
                      </Td>
                      <Td className="text-right text-ink-300 tabular-nums">
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
            <details className="text-sm text-ink-300">
              <summary className="cursor-pointer text-xs text-ink-400">表の見方</summary>
              <p className="mt-1">
                n は推定に効いた命中判定の数 (回避: 味方の攻撃、命中: 敵の攻撃、運: 両方)。n &lt; {ESTIMATE_MIN_N} は灰色で、シミュレーションに使いません。
                事前は API の値で、推定器自身の過去の値は二重計上を避けるため使いません。
              </p>
            </details>
          </Card>

          {current !== null && byShip.has(current) && (
            <ShipDetail
              name={names.shipName(current)}
              shipId={current}
              rows={detailRows && detailRows.length > 0 ? detailRows : byShip.get(current)!}
              densityLoading={detail.loading}
            />
          )}
        </div>
      )}
    </div>
  );
};
