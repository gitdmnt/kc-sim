/** 資源タブの表示用の計算 (期間の切り出し・増減・目盛り)。React には依存しない。 */
import { DAY, HOUR, localStartOfDay } from "./history";
import type { ResourceSnapshot, ResourceValues } from "./history";

export interface ResourceMeta {
  label: string;
  /** 線の色 (テーマの CSS 変数) */
  color: string;
  /** material = 燃料・弾薬・鋼材・ボーキ (数十万)、item = 資材 (数千)。目盛りの桁が違うので別のグラフに描く */
  group: "material" | "item";
}

/** poi の info.resources の並び */
export const RESOURCES: ResourceMeta[] = [
  { label: "燃料", color: "var(--color-ok-400)", group: "material" },
  { label: "弾薬", color: "var(--color-brass-400)", group: "material" },
  { label: "鋼材", color: "var(--color-ink-200)", group: "material" },
  { label: "ボーキ", color: "var(--color-warn-400)", group: "material" },
  { label: "高速建造材", color: "var(--color-danger-400)", group: "item" },
  { label: "高速修復材", color: "var(--color-accent-400)", group: "item" },
  { label: "開発資材", color: "var(--color-rank-a)", group: "item" },
  { label: "改修資材", color: "var(--color-ink-200)", group: "item" },
];

export type RangeId = "day" | "week" | "month" | "all";

export const RANGES: { id: RangeId; label: string; ms: number | null }[] = [
  { id: "day", label: "1日", ms: DAY },
  { id: "week", label: "1週", ms: 7 * DAY },
  { id: "month", label: "1月", ms: 30 * DAY },
  { id: "all", label: "全期間", ms: null },
];

/** 期間の始まり。全期間は最初の記録から。 */
export const rangeStart = (range: RangeId, snapshots: ResourceSnapshot[], now: number): number => {
  const ms = RANGES.find((r) => r.id === range)?.ms ?? null;
  if (ms !== null) return now - ms;
  return snapshots.length ? Math.min(snapshots[0].t, now - HOUR) : now - DAY;
};

const EVENT_LABEL: Record<string, string> = {
  "api_port/port": "母港",
  "api_get_member/material": "資源更新",
  "api_req_hokyu/charge": "補給",
  "api_req_kousyou/createitem": "開発",
  "api_req_kousyou/createship": "建造",
  "api_req_kousyou/createship_speedchange": "高速建造",
  "api_req_kousyou/destroyship": "解体",
  "api_req_kousyou/destroyitem2": "廃棄",
  "api_req_kousyou/remodel_slot": "改修",
  "api_req_nyukyo/start": "入渠",
  "api_req_nyukyo/speedchange": "高速修復",
  "api_req_air_corps/supply": "基地補給",
  "api_req_air_corps/set_plane": "基地配備",
  "api_req_mission/result": "遠征",
  "api_req_quest/clearitemget": "任務",
  "api_req_map/start": "資源マス",
  "api_req_map/next": "資源マス",
  "api_req_kaisou/remodeling": "改造",
  "api_req_member/itemuse": "アイテム使用",
};

export const eventLabel = (path: string): string => EVENT_LABEL[path] ?? path;

/** 「母港 (遠征・任務)」のように、原因の API と、その前に来て値に効いた API (via) を並べる */
export const snapshotLabel = (s: ResourceSnapshot): string => {
  const via = [...new Set((s.via ?? []).map(eventLabel))];
  return via.length ? `${eventLabel(s.event)} (${via.join("・")})` : eventLabel(s.event);
};

const diff = (a: ResourceValues, b: ResourceValues): (number | null)[] =>
  a.map((n, i) => (n === null || b[i] === null ? null : n - b[i]!));

export interface DeltaRow {
  /** イベントごとは記録の時刻、日ごとはその日の 0 時 */
  t: number;
  label: string;
  d: (number | null)[];
  /** その時点 (日ごとは日の終わり) の値 */
  v: ResourceValues;
}

/** [from, to] の記録ごとに、直前の記録からの増減 (新しい順)。最初の記録 (前が無い) は出さない。 */
export const eventDeltas = (snapshots: ResourceSnapshot[], from: number, to: number): DeltaRow[] => {
  const rows: DeltaRow[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const s = snapshots[i];
    if (s.t < from || s.t > to) continue;
    const label = s.merged ? `${snapshotLabel(s)} ほか ${s.merged} 件` : snapshotLabel(s);
    rows.push({ t: s.t, label, d: diff(s.v, snapshots[i - 1].v), v: s.v });
  }
  return rows.reverse();
};

/** 期間の増減に、その中の記録ごとの増減を原因 (snapshotLabel) ごとに足した内訳を付けたもの */
export interface PeriodDelta extends DeltaRow {
  /** 現れた順。値の無い資源は 0 */
  by: { label: string; d: number[] }[];
}

/**
 * [from, to] の区切り (startOf が返す区切りの始まりごと) の増減 (新しい順): 区切りの最後の値 − 前の区切りまでの最後の値。
 * 記録の無い区切り (変化なし) は出さない。最初の区切りは前の値が無いので、その区切りの最初の記録からの増減。
 */
export const periodDeltas = (
  snapshots: ResourceSnapshot[],
  from: number,
  to: number,
  startOf: (t: number) => number
): PeriodDelta[] => {
  const rows: PeriodDelta[] = [];
  let base: ResourceValues | null = null;
  for (let i = 0; i < snapshots.length; i++) {
    const start = startOf(snapshots[i].t);
    let j = i;
    while (j + 1 < snapshots.length && startOf(snapshots[j + 1].t) === start) j++;
    const end = snapshots[j].v;
    if (snapshots[j].t >= from && snapshots[i].t <= to) {
      const by = new Map<string, number[]>();
      for (let k = Math.max(i, 1); k <= j; k++) {
        const label = snapshotLabel(snapshots[k]);
        const sum = by.get(label) ?? snapshots[k].v.map(() => 0);
        diff(snapshots[k].v, snapshots[k - 1].v).forEach((n, r) => (sum[r] += n ?? 0));
        by.set(label, sum);
      }
      rows.push({
        t: start,
        label: "",
        d: diff(end, base ?? snapshots[i].v),
        v: end,
        by: [...by].map(([label, d]) => ({ label, d })),
      });
    }
    base = end;
    i = j;
  }
  return rows.reverse();
};

/** その時刻を含むローカル時刻の時の始まり */
export const localStartOfHour = (t: number): number => {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};

/** 増減のグラフの棒の幅 */
export type BucketId = "hour" | "day";

export const bucketStart = (bucket: BucketId, t: number): number => (bucket === "hour" ? localStartOfHour(t) : localStartOfDay(t));

/** 次の区切りの始まり (日は夏時間で 23・25 時間になりうる) */
export const bucketEnd = (bucket: BucketId, t: number): number =>
  bucket === "hour" ? localStartOfHour(t + HOUR) : localStartOfDay(localStartOfDay(t) + DAY + 2 * HOUR);

/**
 * 増減のグラフの棒の幅。日別は日ごと。イベントごとは 1日・1週なら時間ごと (1 週で 168 本)、
 * それより長い期間は時間ごとでは細かすぎるので日ごと。
 */
export const deltaBucket = (perEvent: boolean, range: RangeId): BucketId =>
  perEvent && (range === "day" || range === "week") ? "hour" : "day";

/** [from, to] の日ごとの増減 (新しい順)。periodDeltas の日の区切り */
export const dayDeltas = (
  snapshots: ResourceSnapshot[],
  from: number,
  to: number,
  startOfDay: (t: number) => number = localStartOfDay
): PeriodDelta[] => periodDeltas(snapshots, from, to, startOfDay);

/**
 * 1 資源の階段状の点列 [t, 値] (値は次の記録まで続く)。期間の前の最後の記録の値から始め、to まで伸ばす。
 * 値が無い (null) 区間は点列を分ける。
 */
export const stepSeries = (snapshots: ResourceSnapshot[], index: number, from: number, to: number): [number, number][][] => {
  const lines: [number, number][][] = [];
  let line: [number, number][] = [];
  let prev: number | null = null;
  const start = snapshots.findLastIndex((s) => s.t <= from);
  for (let i = Math.max(start, 0); i < snapshots.length; i++) {
    const s = snapshots[i];
    if (s.t > to) break;
    const t = Math.max(s.t, from);
    const n = s.v[index];
    if (n === null) {
      if (prev !== null) line.push([t, prev]);
      if (line.length) lines.push(line);
      line = [];
      prev = null;
      continue;
    }
    if (prev !== null) line.push([t, prev]);
    line.push([t, n]);
    prev = n;
  }
  if (prev !== null) line.push([to, prev]);
  if (line.length) lines.push(line);
  return lines;
};

/** min..max を覆うきりのよい目盛り (count 本程度) */
export const niceTicks = (min: number, max: number, count = 4): { lo: number; hi: number; ticks: number[] } => {
  if (!(max > min)) {
    const pad = Math.max(1, Math.abs(min) * 0.05);
    [min, max] = [min - pad, max + pad];
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi, ticks };
};

const TIME_STEPS = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 60 * DAY, 91 * DAY, 182 * DAY, 365 * DAY];

/** 時刻の目盛り (ローカル時刻の区切り)。1 日未満の間隔は時、それ以上は日の 0 時に置く。 */
export const timeTicks = (from: number, to: number, maxTicks = 6): { t: number; label: string }[] => {
  const step = TIME_STEPS.find((s) => (to - from) / s <= maxTicks) ?? TIME_STEPS[TIME_STEPS.length - 1];
  const out: { t: number; label: string }[] = [];
  if (step < DAY) {
    const d = new Date(from);
    d.setMinutes(0, 0, 0);
    const hours = step / HOUR;
    d.setHours(Math.ceil(d.getHours() / hours) * hours);
    for (let t = d.getTime(); t <= to; t += step) {
      if (t < from) continue;
      const x = new Date(t);
      out.push({ t, label: x.getHours() === 0 ? `${x.getMonth() + 1}/${x.getDate()}` : `${x.getHours()}:00` });
    }
    return out;
  }
  const days = Math.round(step / DAY);
  // 日の 0 時を days 日おきに (月をまたいでも等間隔)
  for (let t = localStartOfDay(from) + (localStartOfDay(from) < from ? DAY : 0); t <= to; ) {
    const x = new Date(t);
    out.push({ t, label: days >= 182 ? `${x.getFullYear()}/${x.getMonth() + 1}` : `${x.getMonth() + 1}/${x.getDate()}` });
    t = localStartOfDay(t + days * DAY + 2 * HOUR);
  }
  return out;
};
