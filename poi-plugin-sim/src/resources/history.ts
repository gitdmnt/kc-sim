/**
 * 資源の推移の記録 (poi / DOM / IndexedDB に依存しない部分)。
 *
 * 値は poi の `info.resources` と同じ並び: 燃料, 弾薬, 鋼材, ボーキ, 高速建造材, 高速修復材, 開発資材, 改修資材。
 * poi は game.response を発火する前に redux を更新する (data-resolver: dispatch → dispatchEvent) ので、応答ごとに
 * その時点の値を読み、前回の記録と違えば「その応答の API」を原因として 1 件記録する。
 */

export const RESOURCE_COUNT = 8;

/** 各資源の値。読めなかった資源は null (poi の state が 8 個そろっていないとき)。 */
export type ResourceValues = (number | null)[];

export interface ResourceSnapshot {
  /** IndexedDB のキー (保存後に付く) */
  id?: number;
  /** 提督 ID (poi の info.basic.api_member_id) */
  admiral: string;
  /** 記録時刻 (ms) */
  t: number;
  v: ResourceValues;
  /** 値が変わった応答の API (`/kcsapi/` を除いたパス) */
  event: string;
  /**
   * 前回の記録から今回までに来た、資源を動かすが poi の state にはその場で反映されない API (遠征帰投・任務達成・
   * 資源マス・改造・アイテム使用)。その増減は次の母港 (api_port/port) などでまとめて反映される。
   */
  via?: string[];
  /** 間引きでこの記録にまとめた記録の数 */
  merged?: number;
}

const ROOT = /^\/?kcsapi\//;

export const normalizePath = (path: string): string => path.replace(ROOT, "");

/** poi の info.resources を記録用の値にする。主要 4 資源が数値でなければ null (母港を開く前の [] など)。 */
export const normalizeValues = (raw: unknown): ResourceValues | null => {
  if (!Array.isArray(raw)) return null;
  const v: ResourceValues = [];
  for (let i = 0; i < RESOURCE_COUNT; i++) {
    const n = raw[i];
    v.push(typeof n === "number" && Number.isFinite(n) ? n : null);
  }
  return v.slice(0, 4).every((n) => n !== null) ? v : null;
};

export const sameValues = (a: ResourceValues, b: ResourceValues): boolean =>
  a.length === b.length && a.every((n, i) => n === b[i]);

/** 応答そのものでは poi の資源が変わらないが、ゲーム内では資源が動いた (次の同期で反映される) API か。 */
export const affectsLater = (path: string, body: unknown): boolean => {
  switch (path) {
    case "api_req_mission/result":
    case "api_req_quest/clearitemget":
    case "api_req_kaisou/remodeling":
    case "api_req_member/itemuse":
      return true;
    case "api_req_map/start":
    case "api_req_map/next": {
      const b = body as Record<string, unknown> | null | undefined;
      return !!b && typeof b === "object" && (b.api_itemget != null || b.api_itemget_eo_comment != null);
    }
    default:
      return false;
  }
};

/** 資源を全て送り直す API。ここで値が変わらなければ、それまでの via は資源を動かさなかったとみなして捨てる。 */
const FULL_SYNC: Record<string, true> = { "api_port/port": true, "api_get_member/material": true };

/** 保存先。IndexedDB の実装は store.ts。 */
export interface ResourceStore {
  /** その提督の最新の記録 */
  last(admiral: string): Promise<ResourceSnapshot | undefined>;
  add(snapshot: ResourceSnapshot): Promise<ResourceSnapshot>;
  /** その提督の記録 (時刻の昇順)。from 以降だけにもできる。 */
  list(admiral: string, from?: number): Promise<ResourceSnapshot[]>;
  /** 間引きの結果を反映する: remove の id を消し、update を上書きする。 */
  apply(remove: number[], update: ResourceSnapshot[]): Promise<void>;
  /** 接続を閉じる (任意。次の呼び出しで開き直す) */
  close?(): Promise<void>;
}

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

/** 間引きの段: 古さが maxAge 未満の記録をこの粒度に畳む (all = 畳まない)。古さの昇順。 */
export interface ThinTier {
  maxAge: number;
  bucket: "all" | "hour" | "day";
}

/**
 * 直近 7 日は全件 (イベントごとの増減を見られる)、90 日までは 1 時間ごとの最後の値、それより古いものは
 * 1 日ごとの最後の値。重い使い方 (1 日数百回の変化) でも 7 日分 + 2 160 件 + 365 件/年 程度に収まる。
 */
export const THIN_TIERS: ThinTier[] = [
  { maxAge: 7 * DAY, bucket: "all" },
  { maxAge: 90 * DAY, bucket: "hour" },
  { maxAge: Infinity, bucket: "day" },
];

/** その時刻を含むローカル日の 0 時。 */
export const localStartOfDay = (t: number): number => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

export interface ThinResult {
  keep: ResourceSnapshot[];
  /** 消す記録 */
  drop: ResourceSnapshot[];
  /** 残すうち merged が変わった記録 */
  update: ResourceSnapshot[];
}

/**
 * 時刻の昇順の記録を間引く。同じ段・同じ枠 (時・日) の記録は最後の 1 件に畳み、畳んだ結果 前と同じ値になった記録も
 * 前の記録に畳む。最新の値は必ず残る (再起動後の重複判定が崩れない)。日の境目は startOfDay (既定はローカル時刻)。
 */
export const thinSnapshots = (
  snapshots: ResourceSnapshot[],
  now: number,
  tiers: ThinTier[] = THIN_TIERS,
  startOfDay: (t: number) => number = localStartOfDay
): ThinResult => {
  const keyOf = (s: ResourceSnapshot, i: number): string => {
    const found = tiers.findIndex((x) => now - s.t < x.maxAge);
    const tier = found === -1 ? tiers.length - 1 : found;
    const bucket = tiers[tier].bucket;
    if (bucket === "hour") return `${tier}h${Math.floor(s.t / HOUR)}`;
    if (bucket === "day") return `${tier}d${startOfDay(s.t)}`;
    return `${tier}a${i}`;
  };
  const keep: ResourceSnapshot[] = [];
  const drop: ResourceSnapshot[] = [];
  const changed = new Set<ResourceSnapshot>();
  /** 残す記録 into (コピー) に s を畳む */
  const foldInto = (into: ResourceSnapshot, s: ResourceSnapshot) => {
    into.merged = (into.merged ?? 0) + 1 + (s.merged ?? 0);
    drop.push(s);
    changed.add(into);
  };
  // 同じ枠の記録は時刻順で連続する (段は古さで決まり、古さは時刻順に単調) ので、枠ごとに最後の 1 件を残す
  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    const key = keyOf(s, i);
    let j = i;
    while (j + 1 < snapshots.length && keyOf(snapshots[j + 1], j + 1) === key) j++;
    const last = { ...snapshots[j] };
    for (const folded of snapshots.slice(i, j)) foldInto(last, folded);
    i = j;
    const prev = keep[keep.length - 1];
    if (prev && sameValues(prev.v, last.v)) {
      changed.delete(last);
      foldInto(prev, last);
    } else {
      keep.push(last);
    }
  }
  return { keep, drop, update: keep.filter((s) => changed.has(s)) };
};

export interface RecordInput {
  admiral: string | null;
  values: ResourceValues | null;
  /** game.response の path (`/kcsapi/` 付きでもよい) */
  path: string;
  body?: unknown;
  /** 応答の時刻 (ms)。無ければ now() */
  time?: number;
}

export interface RecorderDeps {
  store: ResourceStore;
  now?: () => number;
  onRecord?: (snapshot: ResourceSnapshot) => void;
  onError?: (error: unknown) => void;
  tiers?: ThinTier[];
  /** 間引きの間隔。提督ごとに、そのセッションで最初の記録の後と、以後この間隔ごと。 */
  thinEvery?: number;
}

/**
 * 応答ごとの値を受けて、変わったときだけ記録する。応答は届いた順に 1 つずつ処理する (保存の完了を待ってから
 * 次の重複判定をする)。直前の値は提督ごとにメモリに持ち、無ければ保存先の最新の記録から読む (再起動をまたいで重複しない)。
 */
export class ResourceRecorder {
  private lastValues = new Map<string, ResourceValues>();
  private via = new Set<string>();
  private thinnedAt = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private deps: RecorderDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** 記録したらその記録、しなければ null。 */
  observe(input: RecordInput): Promise<ResourceSnapshot | null> {
    const run = this.queue.then(() => this.observeNow(input));
    this.queue = run.catch((e) => this.deps.onError?.(e));
    return run;
  }

  private async observeNow({ admiral, values, path, body, time }: RecordInput): Promise<ResourceSnapshot | null> {
    const event = normalizePath(path);
    if (affectsLater(event, body)) this.via.add(event);
    if (!admiral || !values) return null;

    let last = this.lastValues.get(admiral);
    if (!last) {
      last = (await this.deps.store.last(admiral))?.v;
      if (last) this.lastValues.set(admiral, last);
    }
    if (last && sameValues(last, values)) {
      if (FULL_SYNC[event]) this.via.clear();
      return null;
    }

    const t = typeof time === "number" && Number.isFinite(time) ? time : this.now();
    const via = [...this.via];
    const saved = await this.deps.store.add({ admiral, t, v: values, event, ...(via.length ? { via } : {}) });
    this.via.clear();
    this.lastValues.set(admiral, values);
    // 間引きの失敗は記録を取り消さない。通知は間引きの後 (受け取った側が読み直すと間引き済み)
    try {
      await this.maybeThin(admiral);
    } catch (e) {
      this.deps.onError?.(e);
    }
    this.deps.onRecord?.(saved);
    return saved;
  }

  private async maybeThin(admiral: string) {
    const now = this.now();
    const at = this.thinnedAt.get(admiral);
    if (at !== undefined && now - at < (this.deps.thinEvery ?? DAY)) return;
    this.thinnedAt.set(admiral, now);
    const { drop, update } = thinSnapshots(await this.deps.store.list(admiral), now, this.deps.tiers);
    if (drop.length === 0 && update.length === 0) return;
    await this.deps.store.apply(
      drop.flatMap((s) => (s.id === undefined ? [] : [s.id])),
      update
    );
  }
}
