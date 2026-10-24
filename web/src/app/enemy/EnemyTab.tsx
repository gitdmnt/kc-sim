import React, { useMemo, useState } from "react";
import { getDataApi } from "../../data/api";
import { useAbyssalData } from "../../data/names";
import { ESTIMATE_MIN_N, SERVER_ESTIMATOR_SOURCE } from "@shared/data/types";
import type { ApiEquipment, ApiShip, Confidence, EstimateRow, HiddenStat, ShipEstimate } from "@shared/data/types";
import { useAsync } from "../../data/useAsync";
import { normalizeForSearch } from "../../fleet/catalog";
import { Calculator, Check, CircleHelp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, EquipIcon, ProgressBar, Select, TextInput, cx, S } from "../../ui";
import { useApp } from "../context";
import { DataError, StaleBadge } from "../DataState";
import { CONFIDENCE as CONF } from "./confidence";
import { EstimateValue, ServerEstimates, shifted } from "./ServerEstimates";

const STAT_LABEL: Record<HiddenStat, string> = { ev: "回避", asw: "対潜", los: "索敵", luck: "運", acc: "命中", tacc: "雷撃命中" };
const STAT_ORDER: HiddenStat[] = ["ev", "asw", "los", "luck", "acc", "tacc"];
const RANGE = ["—", "短", "中", "長", "超長", "超超長"];
const SPEED: Record<number, string> = { 0: "陸上", 5: "低速", 10: "高速", 15: "高速+", 20: "最速" };

const NA = <span className="text-ink-500">—</span>;
const fmt = (v: number | null | undefined) => (v === null || v === undefined ? NA : String(v));

/** 同名の深海棲艦 (elite / flagship、難易度・段階ごとの個体) を見分ける印。yomi は start2 の api_yomi */
const VARIANT_CLASS: Record<string, string> = { elite: "text-danger-400", flagship: "text-warn-400" };
const Variant = ({ yomi }: { yomi: string | null }) =>
  yomi && VARIANT_CLASS[yomi] ? <span className={cx("shrink-0 text-xs font-semibold", VARIANT_CLASS[yomi])}>{yomi}</span> : null;

/** 採用されなかった推定候補 (採用値とサーバの推定は上に出すので重複させない) */
const OtherEstimates = ({ estimates }: { estimates: ShipEstimate[] }) => (
  <ul className="mt-2 flex flex-col gap-1 text-sm">
    {STAT_ORDER.flatMap((stat) => estimates.filter((e) => e.stat === stat)).map((e, i) => (
      <li key={`${e.stat}-${e.source}-${i}`} className="flex items-baseline gap-3" title={[e.source, e.note].filter(Boolean).join(" / ")}>
        <span className="w-16 text-ink-300">{STAT_LABEL[e.stat]}</span>
        <span className="w-10 text-right tabular-nums text-ink-100">{e.value}</span>
        <span className="w-12 text-xs text-ink-400 tabular-nums">{e.sd !== null ? `±${e.sd}` : ""}</span>
        <span className="w-16 text-xs text-ink-400 tabular-nums">{e.n !== null ? `n=${e.n}` : ""}</span>
        <span className={cx("text-xs", CONF[e.confidence].className)}>{CONF[e.confidence].label}</span>
      </li>
    ))}
  </ul>
);

const EQUIP_STATS = [["火", "fp"], ["雷", "tp"], ["空", "aa"], ["装", "ar"], ["潜", "asw"], ["索", "los"], ["命", "acc"], ["避", "ev"]] as const;

/** 装備: 種別アイコン + 名前 + 0 でない能力だけ */
const EquipList = ({ ids, equipById }: { ids: number[]; equipById: (id: number) => ApiEquipment | undefined }) => (
  <ul className="flex max-w-3xl flex-col gap-1">
    {ids.map((id, i) => {
      const e = equipById(id);
      const stats = e ? EQUIP_STATS.filter(([, k]) => e[k] !== 0).map(([label, k]) => `${label}${e[k]}`) : [];
      return (
        <li key={`${id}-${i}`} className="flex items-center gap-2 text-sm">
          <EquipIcon iconId={e?.icon ?? e?.type?.[3] ?? 0} />
          <span className="min-w-0 flex-1 truncate text-ink-100">{e?.name ?? "不明"}</span>
          <span className="shrink-0 text-xs tabular-nums text-ink-400">{stats.join(" ")}</span>
        </li>
      );
    })}
  </ul>
);

const MAIN_STATS = [["耐久", "hp"], ["火力", "fp"], ["雷装", "tp"], ["対空", "aa"], ["装甲", "ar"]] as const;
type MainKey = (typeof MAIN_STATS)[number][1];

/** 主要 5 能力を、深海棲艦全体の最大値に対する棒で示す */
const MainStats = ({ ship, max }: { ship: ApiShip; max: Record<MainKey, number> }) => (
  <div className="grid auto-rows-[1.5rem] grid-cols-[3rem_minmax(0,1fr)_3rem] content-start items-center gap-x-3">
    {MAIN_STATS.map(([label, k]) => (
      <React.Fragment key={k}>
        <span className="text-xs text-ink-400">{label}</span>
        <ProgressBar value={ship[k] ?? 0} max={max[k]} tone="accent" />
        <span className="text-right text-sm tabular-nums text-ink-50">{fmt(ship[k])}</span>
      </React.Fragment>
    ))}
  </div>
);

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <>
    <dt className="text-xs text-ink-400">{label}</dt>
    <dd className="min-w-0 truncate text-sm tabular-nums text-ink-50">{value}</dd>
  </>
);

const CONF_ICON: Partial<Record<Confidence | "none", LucideIcon>> = { observed: Check, datamined: Check, db_estimate: Calculator, placeholder: CircleHelp };

const ShipDetailView = ({
  id,
  rows,
  equipById,
  max,
}: {
  id: number;
  /** 一覧から分かるこの艦のサーバの推定 (分布なし)。一覧を取れていなければ undefined */
  rows: EstimateRow[] | undefined;
  equipById: (id: number) => ApiEquipment | undefined;
  max: Record<MainKey, number>;
}) => {
  const res = useAsync(() => getDataApi().ship(id), [id]);
  // 分布 (事前・事後) は 1 隻ずつ取る。一覧で推定が無いと分かっている艦は取らない
  const dens = useAsync(rows?.length === 0 ? null : () => getDataApi().estimates({ shipId: id, density: true }), [id]);
  const { catalog } = useApp();
  if (res.loading) return <p className="p-4 text-sm text-ink-300">{S.common.loading}</p>;
  if (res.error) return <DataError error={res.error} />;
  const { ship, estimates, best } = res.data!;
  const stype = catalog.shipTypes[ship.stype] ?? "—";
  const isBest = (e: ShipEstimate) => best[e.stat]?.source === e.source && best[e.stat]?.value === e.value;
  const fetched = dens.data?.estimates.filter((r) => r.shipId === id);
  const server = STAT_ORDER.flatMap((st) => (fetched ?? rows ?? []).filter((r) => r.stat === st));
  const hidden = STAT_ORDER.filter((st) => best[st] || server.some((r) => r.stat === st) || (st === "luck" && ship.luck != null));
  const others = estimates.filter((e) => !isBest(e) && e.source !== SERVER_ESTIMATOR_SOURCE);

  return (
    <Card
      className="flex h-full min-h-0 flex-col"
      bodyClassName="flex min-h-0 flex-1 flex-col gap-5 overflow-auto"
      title={
        <span className="flex items-baseline gap-2">
          {ship.name}
          <Variant yomi={ship.yomi} />
          <span className="text-sm font-normal text-ink-400">{stype}</span>
          <span className="text-xs font-normal text-ink-400 tabular-nums">No.{ship.id}</span>
        </span>
      }
      actions={res.stale && <StaleBadge />}
    >
      <div className="grid max-w-3xl grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
        <MainStats ship={ship} max={max} />
        <dl className="grid auto-rows-[1.5rem] grid-cols-[3rem_minmax(0,1fr)] content-start items-center gap-x-3">
          <Row label="速力" value={ship.speed === null ? NA : (SPEED[ship.speed] ?? ship.speed)} />
          <Row label="射程" value={ship.range === null ? NA : (RANGE[ship.range] ?? ship.range)} />
          <Row label="搭載" value={ship.slots?.length ? ship.slots.join("/") : NA} />
          {hidden.map((st) => {
            const b = best[st];
            const r = server.find((x) => x.stat === st);
            const Icon = b ? (CONF_ICON[b.confidence] ?? Calculator) : Calculator;
            const row = estimates.find((e) => e.stat === st && isBest(e));
            return (
              <Row
                key={st}
                label={STAT_LABEL[st]}
                value={
                  <span className="inline-flex items-center gap-2">
                    {/* 採用値がサーバの推定そのものなら、推定値 (EstimateValue) だけを出す。どちらも無い行は運 (艦の値) */}
                    {b && !(b.source === SERVER_ESTIMATOR_SOURCE && r) ? (
                      <span
                        className="inline-flex items-center gap-1"
                        title={[CONF[b.confidence].label, b.source, row?.sd != null && `±${row.sd}`, row?.n != null && `n=${row.n}`, row?.note].filter(Boolean).join(" / ")}
                      >
                        {b.value}
                        <Icon size={12} className={CONF[b.confidence].className} aria-label={CONF[b.confidence].label} />
                      </span>
                    ) : (
                      !b && !r && ship.luck
                    )}
                    {r && <EstimateValue r={r} />}
                  </span>
                }
              />
            );
          })}
        </dl>
      </div>

      {!!ship.equips?.length && <EquipList ids={ship.equips} equipById={equipById} />}
      {server.length > 0 ? (
        <ServerEstimates rows={server} label={(st) => STAT_LABEL[st]} updatedAt={dens.data?.updatedAt} loading={dens.loading} />
      ) : dens.loading ? null : dens.error ? (
        <p className="text-xs text-ink-400">推定を取得できませんでした</p>
      ) : (
        <p className="text-xs text-ink-400" title="サーバの推定器にこの艦の観測がまだない">推定なし</p>
      )}
      {others.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-ink-300">他の推定候補 ({others.length})</summary>
          <OtherEstimates estimates={others} />
        </details>
      )}
    </Card>
  );
};

const MAX_LIST = 200;

type EstimateFilter = "" | "any" | "enough" | "shifted";

export const EnemyTab = () => {
  const { catalog } = useApp();
  const data = useAbyssalData();
  const estList = useAsync(() => getDataApi().estimates({ density: false }), []);
  const [query, setQuery] = useState("");
  const [stype, setStype] = useState("");
  const [estFilter, setEstFilter] = useState<EstimateFilter>("");
  const [selected, setSelected] = useState<number | null>(null);

  const types = useMemo(() => [...new Set((data.ships ?? []).map((s) => s.stype))].sort((a, b) => a - b), [data.ships]);
  const max = useMemo(() => {
    // 上位の外れ値 (ボス) に引きずられないよう 95 パーセンタイルを棒の満量にする
    const m: Record<MainKey, number> = { hp: 1, fp: 1, tp: 1, aa: 1, ar: 1 };
    for (const [, k] of MAIN_STATS) {
      const v = (data.ships ?? []).map((s) => s[k] ?? 0).sort((a, b) => a - b);
      m[k] = Math.max(1, v[Math.floor(v.length * 0.95)] ?? 1);
    }
    return m;
  }, [data.ships]);
  const byShip = useMemo(() => {
    const m = new Map<number, EstimateRow[]>();
    for (const r of estList.data?.estimates ?? []) m.set(r.shipId, [...(m.get(r.shipId) ?? []), r]);
    return m;
  }, [estList.data]);
  const filtered = useMemo(() => {
    const q = normalizeForSearch(query);
    return (data.ships ?? []).filter((s: ApiShip) => {
      const est = byShip.get(s.id);
      return (
        (!stype || String(s.stype) === stype) &&
        (!estFilter ||
          (!!est && (estFilter === "any" || (estFilter === "enough" ? est.some((r) => r.n >= ESTIMATE_MIN_N) : est.some(shifted))))) &&
        (!q || normalizeForSearch(`${s.name}${s.yomi ?? ""}${s.nameEn ?? ""}${s.id}`).includes(q))
      );
    });
  }, [data.ships, query, stype, estFilter, byShip]);

  const current = filtered.some((s) => s.id === selected) ? selected : (filtered[0]?.id ?? null);

  if (data.error) return <DataError error={data.error} />;
  if (data.loading && !data.ships) return <p className="text-sm text-ink-300">{S.common.loading}</p>;

  return (
    <div className="grid grid-cols-1 gap-4 lg:h-full lg:grid-cols-[20rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
      <Card
        title={<span className="tabular-nums">{S.common.count(filtered.length)}</span>}
        actions={data.stale ? <StaleBadge /> : undefined}
        className="flex min-h-0 flex-col"
        bodyClassName="flex min-h-0 flex-1 flex-col gap-3"
      >
        <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="検索" aria-label="検索" />
        <div className="grid grid-cols-2 gap-2">
          <Select value={stype} onChange={(e) => setStype(e.target.value)} aria-label="艦種">
            <option value="">艦種: すべて</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {catalog.shipTypes[t] ?? `艦種${t}`}
              </option>
            ))}
          </Select>
          <Select
            value={estFilter}
            onChange={(e) => setEstFilter(e.target.value as EstimateFilter)}
            aria-label="推定"
            disabled={!estList.data}
            title={estList.error ? "推定の一覧を取得できませんでした" : undefined}
          >
            <option value="">推定: すべて</option>
            <option value="any">推定あり</option>
            <option value="enough">{`推定 n ≥ ${ESTIMATE_MIN_N}`}</option>
            <option value="shifted">事前とずれあり</option>
          </Select>
        </div>
        <ul className="-mx-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto px-2">
          {filtered.slice(0, MAX_LIST).map((s) => {
            const est = byShip.get(s.id);
            const off = est?.some(shifted);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setSelected(s.id)}
                  className={cx(
                    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm",
                    s.id === current ? "bg-accent-500/12 text-ink-50" : "text-ink-100 hover:bg-ink-800"
                  )}
                >
                  <span className="truncate">{s.name}</span>
                  <Variant yomi={s.yomi} />
                  {est && (
                    <span
                      role="img"
                      aria-label={off ? "推定あり (事前とずれ)" : "推定あり"}
                      title={off ? "推定あり (事前とずれ)" : "推定あり"}
                      className={cx("size-1.5 shrink-0 rounded-full", off ? "bg-warn-400" : "bg-accent-400")}
                    />
                  )}
                  <span className="ml-auto shrink-0 text-xs text-ink-400">{catalog.shipTypes[s.stype] ?? ""}</span>
                  <span className="w-8 shrink-0 text-right text-xs tabular-nums text-ink-500">{s.id}</span>
                </button>
              </li>
            );
          })}
          {filtered.length > MAX_LIST && <li className="py-1 text-center text-xs text-ink-400">他 {filtered.length - MAX_LIST} 件</li>}
        </ul>
      </Card>
      {current !== null && (
        <ShipDetailView key={current} id={current} rows={estList.data ? (byShip.get(current) ?? []) : undefined} equipById={data.equipById} max={max} />
      )}
    </div>
  );
};
