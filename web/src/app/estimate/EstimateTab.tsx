/** パラメータ推定タブ: サーバが全プレイヤーの観測から推定した敵艦の隠しステータスを表示する (GET /api/v1/estimates)。 */
import React, { useMemo, useState } from "react";
import { useIntentFor } from "../nav";
import { getDataApi } from "../../data/api";
import { useAbyssalData } from "../../data/names";
import { ESTIMATE_MIN_N } from "@shared/data/types";
import type { EstimatedStat, EstimateRow } from "@shared/data/types";
import { useAsync } from "../../data/useAsync";
import { normalizeForSearch } from "../../fleet/catalog";
import { ArrowDown, ArrowUp, RefreshCw, TriangleAlert } from "lucide-react";
import { Button, Card, EmptyState, S, Select, Table, Td, TextInput, Th, Thead, Tr, cx } from "../../ui";
import { DataError } from "../DataState";
import { CONFIDENCE as CONF } from "./confidence";
import { DensityPlot } from "./DensityPlot";
import { formatShortDateTime } from "../../ui/format";

const STAT_LABEL: Record<EstimatedStat, string> = { ev: "回避", acc: "命中", luck: "運" };
const f1 = (v: number) => v.toFixed(1);

/** 事前の中心が 90% 信用区間の外 = データが事前の値を否定している */
const shifted = (r: EstimateRow) => r.n > 0 && r.prior.value !== null && (r.prior.value < r.ci90[0] || r.prior.value > r.ci90[1]);

const Shift = ({ r }: { r: EstimateRow }) => {
  if (r.prior.value === null || r.n === 0) return <span className="text-ink-500">—</span>;
  const d = r.mean - r.prior.value;
  const text = `${d >= 0 ? "+" : "−"}${f1(Math.abs(d))}`;
  return shifted(r) ? (
    <span className="inline-flex items-center gap-0.5 text-warn-400 tabular-nums" title="事前の値が 90% 信用区間の外">
      {d >= 0 ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />}
      {text}
    </span>
  ) : (
    <span className="text-xs text-ink-400 tabular-nums">{text}</span>
  );
};

/** 観測でほとんど絞れていない (観測なし、または事後 sd が事前の 80% 超) */
const weak = (r: EstimateRow) => r.n === 0 || r.sd > 0.8 * r.prior.sd;

const ShipDetail = ({ name, shipId, rows, densityLoading }: { name: string; shipId: number; rows: EstimateRow[]; densityLoading: boolean }) => (
  <Card
    className="flex min-h-0 flex-col"
    bodyClassName="flex min-h-0 flex-1 flex-col gap-6 overflow-auto"
    title={
      <span className="flex items-baseline gap-2">
        {name}
        <span className="text-xs font-normal text-ink-400 tabular-nums">No.{shipId}</span>
      </span>
    }
  >
    {rows.map((r) => (
      <section key={r.stat} className="flex flex-col gap-1">
        <div className="flex items-baseline gap-3">
          <span className="w-10 shrink-0 text-xs text-ink-400">{STAT_LABEL[r.stat]}</span>
          <span className="text-lg font-semibold text-ink-50 tabular-nums">
            {f1(r.mean)} <span className="text-sm font-normal text-ink-400">± {f1(r.sd)}</span>
          </span>
          <span className={cx("ml-auto text-xs tabular-nums", shifted(r) ? "text-warn-400" : "text-ink-400")} title="事前の値">
            事前 {r.prior.value ?? "—"}
          </span>
        </div>
        {r.density ? (
          <DensityPlot density={r.density} ci90={r.ci90} mean={r.mean} priorValue={r.prior.value} label={STAT_LABEL[r.stat]} />
        ) : (
          <p className="py-6 text-center text-sm text-ink-400">{densityLoading ? S.common.loading : "—"}</p>
        )}
        <div className="flex items-center gap-3 text-xs text-ink-400 tabular-nums">
          <span>n={r.n}</span>
          <span>90% [{r.ci90[0]}, {r.ci90[1]}]</span>
          {weak(r) && (
            <span className="inline-flex items-center gap-1 text-warn-400" title={r.n === 0 ? "観測なし" : "観測でほぼ絞れていない"}>
              <TriangleAlert size={12} aria-hidden />
              絞れていない
            </span>
          )}
        </div>
      </section>
    ))}
    <div className="flex flex-wrap gap-4 text-xs text-ink-400">
      <span><span className="mr-1 inline-block h-2 w-3 bg-accent-500/40" />事後</span>
      <span><span className="mr-1 inline-block w-3 border-t border-dashed border-ink-400 align-middle" />事前</span>
      <span><span className="mr-1 inline-block h-3 w-0.5 bg-ink-50 align-middle" />平均</span>
    </div>
  </Card>
);

type SortKey = "id" | "n" | "shift";

export const EstimateTab = () => {
  const names = useAbyssalData();
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [stat, setStat] = useState<EstimatedStat | "">("");
  const [filter, setFilter] = useState<"" | "shifted" | "enough">("");
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
        (filter !== "shifted" || shifted(r)) &&
        (filter !== "enough" || r.n >= ESTIMATE_MIN_N) &&
        (!q || normalizeForSearch(`${names.shipName(r.shipId)}${r.shipId}`).includes(q))
    );
    const shift = (r: EstimateRow) => (r.prior.value === null || r.n === 0 ? 0 : Math.abs(r.mean - r.prior.value) / Math.max(r.sd, 0.5));
    const key: Record<SortKey, (r: EstimateRow) => number> = { id: (r) => r.shipId, n: (r) => -r.n, shift: (r) => -shift(r) };
    return [...filtered].sort((a, b) => key[sort](a) - key[sort](b) || a.shipId - b.shipId);
  }, [all, query, stat, filter, sort, names]);

  const current = selected ?? rows[0]?.shipId ?? null;
  // 分布 (事前・事後) は 1 隻ずつ取る
  const detail = useAsync(current === null ? null : () => getDataApi().estimates({ shipId: current, density: true }, reload > 0), [current, reload]);
  const detailRows = detail.data?.estimates.filter((r) => r.shipId === current);

  return (
    <div className="flex flex-col gap-4 lg:h-[calc(100vh-3.75rem)]">
      {list.error ? (
        <DataError error={list.error} onRetry={() => setReload((n) => n + 1)} />
      ) : list.loading && !all ? (
        <EmptyState title={S.common.loading} />
      ) : !all || all.length === 0 ? (
        <EmptyState title="推定なし" />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-rows-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_30rem]">
          <Card
            className="flex min-h-0 flex-col"
            title={`推定値 (${rows.length})`}
            actions={
              <>
                {list.data?.updatedAt && (
                  <span className="text-xs text-ink-400" title="最終推定">{formatShortDateTime(Date.parse(list.data.updatedAt))}</span>
                )}
                <Button size="sm" variant="ghost" icon onClick={() => setReload((n) => n + 1)} disabled={list.loading} title="サーバから取り直す" aria-label="再読み込み">
                  <RefreshCw size={14} aria-hidden />
                </Button>
              </>
            }
            bodyClassName="flex min-h-0 flex-1 flex-col gap-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="検索" aria-label="検索" className="w-36" />
              <Select value={stat} onChange={(e) => setStat(e.target.value as EstimatedStat | "")} aria-label="ステータス" className="w-40">
                <option value="">ステータス: すべて</option>
                {(Object.keys(STAT_LABEL) as EstimatedStat[]).map((s) => (
                  <option key={s} value={s}>
                    {STAT_LABEL[s]}
                  </option>
                ))}
              </Select>
              <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="並び順" className="w-28">
                <option value="id">図鑑順</option>
                <option value="n">観測数順</option>
                <option value="shift">ずれの大きい順</option>
              </Select>
              <Select value={filter} onChange={(e) => setFilter(e.target.value as "" | "shifted" | "enough")} aria-label="絞り込み" className="w-28">
                <option value="">すべて</option>
                <option value="shifted">ずれあり</option>
                <option value="enough">{`n ≥ ${ESTIMATE_MIN_N}`}</option>
              </Select>
            </div>
            <Table className="min-h-0 flex-1">
              <Thead>
                <tr>
                  <Th>敵艦</Th>
                  <Th>能力</Th>
                  <Th>
                    <span title="API の値 (実測 > 推定 > 仮)">事前</span>
                  </Th>
                  <Th className="text-right">推定</Th>
                  <Th className="text-right">90%区間</Th>
                  <Th className="text-right">
                    <span title={`推定に効いた命中判定の数。n < ${ESTIMATE_MIN_N} は灰色でシミュレーションに使わない`}>観測数</span>
                  </Th>
                  <Th className="text-right">差</Th>
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
                            <span className={cx("ml-2 text-xs", CONF[r.prior.confidence].className)}>{CONF[r.prior.confidence].label}</span>
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
