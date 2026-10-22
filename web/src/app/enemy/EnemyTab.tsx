import React, { useMemo, useState } from "react";
import { getDataApi } from "../../data/api";
import { useAbyssalData } from "../../data/names";
import type { ApiEquipment, ApiShip, HiddenStat, ShipEstimate } from "@shared/data/types";
import { useAsync } from "../../data/useAsync";
import { normalizeForSearch } from "../../fleet/catalog";
import { ArrowRight } from "lucide-react";
import { Button, Card, EquipIcon, ProgressBar, Select, Stat, TextInput, cx, S } from "../../ui";
import { useApp } from "../context";
import { useNav } from "../nav";
import { DataError, StaleBadge } from "../DataState";
import { CONFIDENCE as CONF } from "../estimate/confidence";

const STAT_LABEL: Record<HiddenStat, string> = { ev: "回避", asw: "対潜", los: "索敵", luck: "運", acc: "命中", tacc: "雷撃命中" };
const STAT_ORDER: HiddenStat[] = ["ev", "asw", "los", "luck", "acc", "tacc"];
const RANGE = ["—", "短", "中", "長", "超長", "超超長"];
const SPEED: Record<number, string> = { 0: "陸上", 5: "低速", 10: "高速", 15: "高速+", 20: "最速" };

const NA = <span className="text-ink-500">—</span>;
const fmt = (v: number | null | undefined) => (v === null || v === undefined ? NA : String(v));

/** 採用されなかった推定候補 (採用値は上の Stat に出すので重複させない) */
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
  <ul className="flex flex-col gap-1">
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
  <div className="grid grid-cols-[3rem_minmax(0,1fr)_3rem] items-center gap-x-3 gap-y-1">
    {MAIN_STATS.map(([label, k]) => (
      <React.Fragment key={k}>
        <span className="text-xs text-ink-400">{label}</span>
        <ProgressBar value={ship[k] ?? 0} max={max[k]} tone="accent" />
        <span className="text-right text-sm tabular-nums text-ink-50">{fmt(ship[k])}</span>
      </React.Fragment>
    ))}
  </div>
);

const ShipDetailView = ({ id, equipById, max }: { id: number; equipById: (id: number) => ApiEquipment | undefined; max: Record<MainKey, number> }) => {
  const res = useAsync(() => getDataApi().ship(id), [id]);
  const { catalog } = useApp();
  const nav = useNav();
  if (res.loading) return <p className="p-4 text-sm text-ink-300">{S.common.loading}</p>;
  if (res.error) return <DataError error={res.error} />;
  const { ship, estimates, best } = res.data!;
  const stype = catalog.shipTypes[ship.stype] ?? "—";
  const isBest = (e: ShipEstimate) => best[e.stat]?.source === e.source && best[e.stat]?.value === e.value;
  const adopted = STAT_ORDER.filter((s) => best[s]);
  const others = estimates.filter((e) => !isBest(e));
  // 採用値の確度が全項目同じなら見出しに 1 回だけ出す
  const confs = new Set(adopted.map((s) => best[s]!.confidence));
  const sharedConf = adopted.length > 1 && confs.size === 1 ? best[adopted[0]]!.confidence : null;

  return (
    <Card
      className="flex h-full min-h-0 flex-col"
      bodyClassName="flex min-h-0 flex-1 flex-col gap-6 overflow-auto"
      title={
        <span className="flex items-baseline gap-2">
          {ship.name}
          <span className="text-sm font-normal text-ink-400">{stype}</span>
          <span className="text-xs font-normal text-ink-400 tabular-nums">No.{ship.id}</span>
        </span>
      }
      actions={
        <>
          {res.stale && <StaleBadge />}
          {estimates.length > 0 && (
            <Button size="sm" onClick={() => nav.go({ tab: "estimate", shipId: ship.id })}>
              推定詳細
              <ArrowRight size={14} aria-hidden />
            </Button>
          )}
        </>
      }
    >
      <div className="flex max-w-md flex-col gap-4">
        <MainStats ship={ship} max={max} />
        <div className="flex gap-6">
        <Stat label="速力" value={ship.speed === null ? NA : (SPEED[ship.speed] ?? ship.speed)} />
        <Stat label="射程" value={ship.range === null ? NA : (RANGE[ship.range] ?? ship.range)} />
        <Stat label="搭載" value={ship.slots?.length ? ship.slots.join("/") : NA} />
        {ship.luck !== null && ship.luck !== undefined && <Stat label="運" value={ship.luck} />}
        </div>
      </div>

      {adopted.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="text-xs text-ink-400">
            推定{sharedConf && <span className={cx("ml-2", CONF[sharedConf].className)}>{CONF[sharedConf].label}</span>}
          </div>
          <div className="flex max-w-md gap-6">
            {adopted.map((s) => {
              const b = best[s]!;
              const row = estimates.find((e) => e.stat === s && isBest(e));
              const detail = [b.source, row?.sd != null && `±${row.sd}`, row?.n != null && `n=${row.n}`, row?.note].filter(Boolean).join(" / ");
              return (
                <Stat
                  key={s}
                  label={STAT_LABEL[s]}
                  value={b.value}
                  sub={sharedConf ? undefined : CONF[b.confidence].label}
                  subTone={b.confidence === "observed" ? "ok" : "accent"}
                  title={detail}
                />
              );
            })}
          </div>
        </section>
      )}
      {!!ship.equips?.length && <EquipList ids={ship.equips} equipById={equipById} />}
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

export const EnemyTab = () => {
  const { catalog } = useApp();
  const data = useAbyssalData();
  const [query, setQuery] = useState("");
  const [stype, setStype] = useState("");
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
  const filtered = useMemo(() => {
    const q = normalizeForSearch(query);
    return (data.ships ?? []).filter(
      (s: ApiShip) =>
        (!stype || String(s.stype) === stype) &&
        (!q || normalizeForSearch(`${s.name}${s.nameEn ?? ""}${s.id}`).includes(q))
    );
  }, [data.ships, query, stype]);

  const current = filtered.some((s) => s.id === selected) ? selected : (filtered[0]?.id ?? null);

  if (data.error) return <DataError error={data.error} />;
  if (data.loading && !data.ships) return <p className="text-sm text-ink-300">{S.common.loading}</p>;

  return (
    <div className="grid grid-cols-1 gap-4 lg:h-[calc(100vh-3.75rem)] lg:grid-cols-[20rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
      <Card
        title={<span className="tabular-nums">{S.common.count(filtered.length)}</span>}
        actions={data.stale ? <StaleBadge /> : undefined}
        className="flex min-h-0 flex-col"
        bodyClassName="flex min-h-0 flex-1 flex-col gap-3"
      >
        <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="検索" aria-label="検索" />
        <Select value={stype} onChange={(e) => setStype(e.target.value)} aria-label="艦種">
          <option value="">艦種: すべて</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {catalog.shipTypes[t] ?? `艦種${t}`}
            </option>
          ))}
        </Select>
        <ul className="-mx-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto px-2">
          {filtered.slice(0, MAX_LIST).map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setSelected(s.id)}
                className={cx(
                  "flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm",
                  s.id === current ? "bg-accent-500/12 text-ink-50" : "text-ink-100 hover:bg-ink-800"
                )}
              >
                <span className="truncate">{s.name}</span>
                <span className="shrink-0 text-xs text-ink-400">{catalog.shipTypes[s.stype] ?? ""}</span>
              </button>
            </li>
          ))}
          {filtered.length > MAX_LIST && <li className="py-1 text-center text-xs text-ink-400">他 {filtered.length - MAX_LIST} 件</li>}
        </ul>
      </Card>
      {current !== null && <ShipDetailView key={current} id={current} equipById={data.equipById} max={max} />}
    </div>
  );
};
