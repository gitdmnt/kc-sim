import React, { useEffect, useMemo, useState } from "react";
import { EmptyState, Select, Table, Td, Th, Thead, Tr, Tabs, cx } from "@web/ui";
import type { TabItem } from "@web/ui";
import { formatDateTime, formatShortDateTime } from "@web/ui/format";
import { getResourceDb, onResourceRecorded } from "../../resources";
import type { ResourceSnapshot } from "../../resources";
import { RANGES, RESOURCES, dayDeltas, eventDeltas, rangeStart, snapshotLabel, stepSeries } from "../../resources/view";
import type { DeltaRow, RangeId } from "../../resources/view";
import { L } from "../strings";
import { LineChart } from "./LineChart";

type View = "chart" | "event" | "day";

const VIEW_TABS: TabItem<View>[] = [
  { id: "chart", label: L.resources.chart },
  { id: "event", label: L.resources.byEvent },
  { id: "day", label: L.resources.byDay },
];
const RANGE_TABS: TabItem<RangeId>[] = RANGES.map((r) => ({ id: r.id, label: r.label }));
/** 増減の表の行数の上限 (イベントごとは 1 週で数千行になりうる) */
const MAX_ROWS = 500;

const num = new Intl.NumberFormat("ja-JP");
const signed = new Intl.NumberFormat("ja-JP", { signDisplay: "exceptZero" });

const Delta = ({ d }: { d: number | null }) =>
  d === null ? (
    <span className="text-ink-600">—</span>
  ) : (
    <span className={d > 0 ? "text-ok-400" : d < 0 ? "text-danger-400" : "text-ink-600"}>{d === 0 ? "0" : signed.format(d)}</span>
  );

/** 時刻 t の値 (t 以前の最後の記録) */
const snapshotAt = (snapshots: ResourceSnapshot[], t: number) => snapshots.findLast((s) => s.t <= t);

/**
 * 資源の推移。記録はキャプチャ (startCapture) が poi の game.response ごとに取り、このビューは保存先を読むだけ。
 * 画面はスクロールしない: グラフは残りの高さいっぱいに伸び、増減の表だけが内側でスクロールする。
 */
export const ResourcesTab = ({ currentAdmiral }: { currentAdmiral: string | null }) => {
  const db = getResourceDb();
  const [admirals, setAdmirals] = useState<string[] | null>(null);
  /** 選んだ提督 (null なら現在の提督、記録が無ければ最近の提督) */
  const [chosen, setChosen] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<ResourceSnapshot[]>([]);
  const [range, setRange] = useState<RangeId>("week");
  const [view, setView] = useState<View>("chart");
  const [shown, setShown] = useState<boolean[]>(() => RESOURCES.map(() => true));
  const [now, setNow] = useState(Date.now);
  /** 新しい記録が来るたびに増やして読み直す */
  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => onResourceRecorded(() => setVersion((v) => v + 1)), []);

  useEffect(() => {
    let alive = true;
    db.admirals().then(
      (list) => alive && setAdmirals(list.map((a) => a.admiral)),
      (e) => {
        // IndexedDB が使えない環境は記録なしとして表示する
        console.error("[kcsim] failed to load resource history", e);
        if (alive) setAdmirals([]);
      }
    );
    return () => {
      alive = false;
    };
  }, [db, version]);

  const admiral = [chosen, currentAdmiral].find((a) => a && admirals?.includes(a)) ?? admirals?.[0] ?? null;

  // admirals は記録が来るたびに読み直すので、それに続いて記録も読み直す
  useEffect(() => {
    if (admirals === null) return;
    let alive = true;
    (admiral ? db.list(admiral) : Promise.resolve([])).then(
      (list) => {
        if (!alive) return;
        setSnapshots(list);
        setNow(Date.now());
        setLoaded(true);
      },
      (e) => {
        console.error("[kcsim] failed to load resource history", e);
        if (alive) setLoaded(true);
      }
    );
    return () => {
      alive = false;
    };
  }, [db, admirals, admiral]);

  const from = rangeStart(range, snapshots, now);
  const latest = snapshots[snapshots.length - 1];
  const before = snapshotAt(snapshots, from) ?? snapshots[0];

  const charts = useMemo(
    () =>
      (["material", "item"] as const).map((group) => ({
        group,
        series: RESOURCES.flatMap((r, i) =>
          r.group === group && shown[i] ? [{ key: r.label, color: r.color, lines: stepSeries(snapshots, i, from, now) }] : []
        ),
      })),
    [snapshots, shown, from, now]
  );

  const rows: DeltaRow[] = useMemo(
    () => (view === "event" ? eventDeltas(snapshots, from, now) : view === "day" ? dayDeltas(snapshots, from, now) : []),
    [view, snapshots, from, now]
  );

  if (admirals === null || !loaded) return null;
  if (!latest) {
    return <EmptyState title={L.resources.empty} description={L.resources.emptyHint} className="py-16" />;
  }

  const columns = RESOURCES.map((r, i) => ({ ...r, i })).filter((r) => shown[r.i]);
  const tooltip = (t: number, group: "material" | "item") => {
    const s = snapshotAt(snapshots, t);
    return (
      <div className="flex flex-col gap-1">
        <span className="text-ink-400">{formatShortDateTime(t)}</span>
        {RESOURCES.map((r, i) =>
          r.group === group && shown[i] ? (
            <span key={r.label} className="flex items-center gap-2 whitespace-nowrap">
              <span className="h-2 w-2 rounded-full" style={{ background: r.color }} />
              <span className="flex-1">{r.label}</span>
              <span className="text-ink-50">{s?.v[i] == null ? "—" : num.format(s.v[i]!)}</span>
            </span>
          ) : null
        )}
        {s && <span className="text-ink-400">{snapshotLabel(s)}</span>}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <Tabs tabs={VIEW_TABS} value={view} onChange={setView} variant="pill" size="sm" />
        <Tabs tabs={RANGE_TABS} value={range} onChange={setRange} variant="pill" size="sm" />
        {admirals.length > 1 && (
          <Select className="w-44" value={admiral ?? ""} onChange={(e) => setChosen(e.target.value)} aria-label={L.resources.admiral}>
            {admirals.map((a) => (
              <option key={a} value={a}>
                {L.resources.admiralOption(a, a === currentAdmiral)}
              </option>
            ))}
          </Select>
        )}
        <span className="ml-auto text-xs text-ink-400 tabular-nums" title={formatDateTime(latest.t)}>
          {L.resources.summary(snapshots.length, formatShortDateTime(latest.t))}
        </span>
      </div>

      {/* 凡例を兼ねた切り替え: 現在の値と期間内の増減 */}
      <div className="flex shrink-0 flex-wrap gap-1" role="group" aria-label={L.resources.toggle}>
        {RESOURCES.map((r, i) => {
          const v = latest.v[i];
          const b = before.v[i];
          return (
            <button
              key={r.label}
              type="button"
              aria-pressed={shown[i]}
              onClick={() => setShown(shown.map((x, j) => (j === i ? !x : x)))}
              className={cx(
                "inline-flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-accent-400",
                shown[i] ? "bg-ink-800 text-ink-100" : "text-ink-500 hover:bg-ink-800/60"
              )}
            >
              <span className={cx("h-2 w-2 rounded-full", !shown[i] && "opacity-30")} style={{ background: r.color }} />
              {r.label}
              <span className={shown[i] ? "text-ink-50" : undefined}>{v === null ? "—" : num.format(v)}</span>
              <span className="text-xs">
                <Delta d={v === null || b === null ? null : v - b} />
              </span>
            </button>
          );
        })}
      </div>

      {view === "chart" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {charts.map(({ group, series }) => (
            <section
              key={group}
              className={cx("flex min-h-0 flex-col rounded-md border border-ink-800 bg-ink-900", group === "material" ? "flex-[3]" : "flex-[2]")}
            >
              <h3 className="shrink-0 px-3 pt-2 text-xs text-ink-400">{group === "material" ? L.resources.materials : L.resources.items}</h3>
              {series.length ? (
                <LineChart
                  series={series}
                  from={from}
                  to={now}
                  tooltip={(t) => tooltip(t, group)}
                  ariaLabel={group === "material" ? L.resources.materials : L.resources.items}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center text-xs text-ink-500">{L.resources.noneShown}</div>
              )}
            </section>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title={L.resources.noChange} className="min-h-0 flex-1" />
      ) : (
        <Table className="min-h-0 flex-1 rounded-md border border-ink-800 bg-ink-900">
          <Thead>
            <tr>
              <Th>{view === "day" ? L.resources.date : L.resources.time}</Th>
              {view === "event" && <Th>{L.resources.event}</Th>}
              {columns.map((c) => (
                <Th key={c.label} className="text-right">
                  {c.label}
                </Th>
              ))}
            </tr>
          </Thead>
          <tbody>
            {rows.slice(0, MAX_ROWS).map((row, k) => (
              <Tr key={`${row.t}-${k}`}>
                <Td className="whitespace-nowrap text-xs text-ink-400 tabular-nums">
                  {view === "day" ? new Date(row.t).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", weekday: "short" }) : formatShortDateTime(row.t)}
                </Td>
                {view === "event" && <Td className="max-w-64 truncate text-ink-100">{row.label}</Td>}
                {columns.map((c) => (
                  <Td key={c.label} className="text-right tabular-nums" title={row.v[c.i] == null ? undefined : num.format(row.v[c.i]!)}>
                    <Delta d={row.d[c.i]} />
                  </Td>
                ))}
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
};
