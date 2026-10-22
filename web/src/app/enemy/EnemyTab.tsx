import React, { useMemo, useState } from "react";
import { getDataApi } from "../../data/api";
import { useAbyssalData } from "../../data/names";
import type { ApiEquipment, ApiShip, Confidence, HiddenStat, ShipEstimate } from "@shared/data/types";
import { useAsync } from "../../data/useAsync";
import { normalizeForSearch } from "../../fleet/catalog";
import { Badge, Button, Card, EmptyState, Select, Stat, Table, Td, TextInput, Th, Thead, Tr, cx, S } from "../../ui";
import type { BadgeTone } from "../../ui";
import { useApp } from "../context";
import { useNav } from "../nav";
import { DataError, StaleBadge } from "../DataState";

const CONF: Record<Confidence, { label: string; tone: BadgeTone }> = {
  observed: { label: "観測", tone: "ok" },
  datamined: { label: "データマイニング", tone: "accent" },
  db_estimate: { label: "DB推定", tone: "warn" },
  placeholder: { label: "仮値", tone: "danger" },
  unknown: { label: "不明", tone: "neutral" },
};
const STAT_LABEL: Record<HiddenStat, string> = { ev: "回避", asw: "対潜", los: "索敵", luck: "運", acc: "命中(隠し)", tacc: "雷撃命中(基礎)" };
const STAT_ORDER: HiddenStat[] = ["ev", "asw", "los", "luck", "acc", "tacc"];
const RANGE = ["—", "短", "中", "長", "超長", "超超長"];
const SPEED: Record<number, string> = { 0: "陸上", 5: "低速", 10: "高速", 15: "高速+", 20: "最速" };

const NA = <span className="text-ink-500">—</span>;
const fmt = (v: number | null | undefined) => (v === null || v === undefined ? NA : String(v));

/** 採用されなかった推定候補 (採用値は上の Stat に出すので重複させない) */
const EstimateTable = ({ estimates }: { estimates: ShipEstimate[] }) => (
  <Table className="mt-2">
    <Thead>
      <tr>
        <Th>ステータス</Th>
        <Th className="text-right">値</Th>
        <Th>確度</Th>
        <Th>ソース</Th>
        <Th>備考</Th>
      </tr>
    </Thead>
    <tbody>
      {STAT_ORDER.flatMap((stat) => estimates.filter((e) => e.stat === stat)).map((e, i) => (
        <Tr key={`${e.stat}-${e.source}-${i}`}>
          <Td className="font-medium">{STAT_LABEL[e.stat]}</Td>
          <Td className="text-right tabular-nums">
            {e.value}
            {e.sd !== null && <span className="ml-1 text-xs text-ink-400">±{e.sd}</span>}
            {e.n !== null && <span className="ml-1 text-xs text-ink-400">n={e.n}</span>}
          </Td>
          <Td>
            <Badge tone={CONF[e.confidence].tone}>{CONF[e.confidence].label}</Badge>
          </Td>
          <Td className="text-xs text-ink-300">{e.source}</Td>
          <Td className="max-w-56 truncate text-xs text-ink-400">
            <span title={e.note ?? undefined}>{e.note ?? ""}</span>
          </Td>
        </Tr>
      ))}
    </tbody>
  </Table>
);

const EquipTable = ({ ids, equipById }: { ids: number[]; equipById: (id: number) => ApiEquipment | undefined }) => (
  <Table>
    <Thead>
      <tr>
        <Th>装備</Th>
        {["火力", "雷装", "対空", "装甲", "対潜", "索敵", "命中", "回避"].map((h) => (
          <Th key={h} className="text-right">{h}</Th>
        ))}
      </tr>
    </Thead>
    <tbody>
      {ids.map((id, i) => {
        const e = equipById(id);
        return (
          <Tr key={`${id}-${i}`}>
            <Td>{e?.name ?? `装備#${id}`}</Td>
            {e ? (
              [e.fp, e.tp, e.aa, e.ar, e.asw, e.los, e.acc, e.ev].map((v, j) => (
                <Td key={j} className={cx("text-right tabular-nums", v === 0 && "text-ink-500")}>{v}</Td>
              ))
            ) : (
              <Td colSpan={8} className="text-ink-400">装備データなし</Td>
            )}
          </Tr>
        );
      })}
    </tbody>
  </Table>
);

const ShipDetailView = ({ id, equipById }: { id: number; equipById: (id: number) => ApiEquipment | undefined }) => {
  const res = useAsync(() => getDataApi().ship(id), [id]);
  const { catalog } = useApp();
  const nav = useNav();
  if (res.loading) return <p className="p-4 text-sm text-ink-300">{S.common.loading}</p>;
  if (res.error) return <DataError error={res.error} />;
  const { ship, estimates, best } = res.data!;
  const stype = catalog.shipTypes[ship.stype] ?? `艦種${ship.stype}`;
  const isBest = (e: ShipEstimate) => best[e.stat]?.source === e.source && best[e.stat]?.value === e.value;
  const adopted = STAT_ORDER.filter((s) => best[s]);
  const missing = STAT_ORDER.filter((s) => !best[s]);
  const others = estimates.filter((e) => !isBest(e));
  // 採用値の確度が全項目同じなら見出し横に1回だけ出す
  const confs = new Set(adopted.map((s) => best[s]!.confidence));
  const sharedConf = adopted.length > 1 && confs.size === 1 ? best[adopted[0]]!.confidence : null;

  return (
    <div className="flex flex-col gap-4">
      <Card
        title={
          <span className="flex items-center gap-2">
            {ship.name}
            <span className="text-xs font-normal text-ink-400">No.{ship.id}{ship.nameEn ? ` · ${ship.nameEn}` : ""}</span>
          </span>
        }
        actions={<>{res.stale && <StaleBadge />}<Badge tone="neutral">{stype}</Badge></>}
        bodyClassName="grid grid-cols-3 gap-2 sm:grid-cols-5"
      >
        <Stat label="耐久" value={fmt(ship.hp)} />
        <Stat label="火力" value={fmt(ship.fp)} />
        <Stat label="雷装" value={fmt(ship.tp)} />
        <Stat label="対空" value={fmt(ship.aa)} />
        <Stat label="装甲" value={fmt(ship.ar)} />
        <Stat label="速力" value={ship.speed === null ? NA : (SPEED[ship.speed] ?? ship.speed)} />
        <Stat label="射程" value={ship.range === null ? NA : (RANGE[ship.range] ?? ship.range)} />
        <Stat label="スロット数" value={fmt(ship.slotNum)} />
        <Stat label="搭載数" value={ship.slots?.length ? ship.slots.join("/") : NA} />
        <Stat label="運(表示)" value={fmt(ship.luck)} />
      </Card>

      <Card
        title={
          <span className="flex items-center gap-2">
            隠しステータス推定
            {sharedConf && <Badge tone={CONF[sharedConf].tone}>{CONF[sharedConf].label}</Badge>}
          </span>
        }
        actions={<Button size="sm" onClick={() => nav.go({ tab: "estimate", shipId: ship.id })}>推定の詳細を見る</Button>}
        bodyClassName="flex flex-col gap-3"
      >
        {estimates.length === 0 ? (
          <p className="text-sm text-ink-400">推定値がありません。</p>
        ) : (
          <>
            {adopted.length > 0 && (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
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
            )}
            {missing.length > 0 && <p className="text-xs text-ink-400">推定なし: {missing.map((s) => STAT_LABEL[s]).join("・")}</p>}
            {others.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm text-ink-300">他の推定候補 ({others.length})</summary>
                <EstimateTable estimates={others} />
              </details>
            )}
          </>
        )}
      </Card>

      <Card title={`装備 (${ship.equips?.length ?? 0})`}>
        {ship.equips?.length ? <EquipTable ids={ship.equips} equipById={equipById} /> : <p className="text-sm text-ink-400">装備データがありません。</p>}
      </Card>
    </div>
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
  const filtered = useMemo(() => {
    const q = normalizeForSearch(query);
    return (data.ships ?? []).filter(
      (s: ApiShip) =>
        (!stype || String(s.stype) === stype) &&
        (!q || normalizeForSearch(`${s.name}${s.nameEn ?? ""}${s.id}`).includes(q))
    );
  }, [data.ships, query, stype]);

  if (data.error) return <DataError error={data.error} />;
  if (data.loading && !data.ships) return <p className="text-sm text-ink-300">{S.common.loading}</p>;

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <Card
        title={`深海棲艦 (${filtered.length})`}
        actions={data.stale ? <StaleBadge /> : undefined}
        className="flex flex-col"
        bodyClassName="flex flex-col gap-2 p-3"
      >
        <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="名前・ID で検索" aria-label="検索" />
        <Select value={stype} onChange={(e) => setStype(e.target.value)} aria-label="艦種">
          <option value="">艦種: すべて</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {catalog.shipTypes[t] ?? `艦種${t}`}
            </option>
          ))}
        </Select>
        <ul className="-mx-1 flex max-h-[40rem] flex-col gap-0.5 overflow-auto px-1">
          {filtered.slice(0, MAX_LIST).map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setSelected(s.id)}
                className={cx(
                  "flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2.5 py-1.5 text-left text-sm",
                  s.id === selected ? "bg-accent-600/20 text-ink-50" : "text-ink-100 hover:bg-ink-700/70"
                )}
              >
                <span className="truncate">{s.name}</span>
                <span className="shrink-0 text-xs text-ink-400 tabular-nums">
                  {catalog.shipTypes[s.stype] ?? ""} · {s.id}
                </span>
              </button>
            </li>
          ))}
          {filtered.length > MAX_LIST && <li className="py-1 text-center text-xs text-ink-400">他 {filtered.length - MAX_LIST} 件 — 検索で絞り込み</li>}
        </ul>
      </Card>
      {selected !== null ? (
        <ShipDetailView key={selected} id={selected} equipById={data.equipById} />
      ) : (
        <EmptyState title="深海棲艦を選択" description="左の一覧から選ぶと、ステータスと隠しステータスの推定を表示します。" className="py-24" />
      )}
    </div>
  );
};
