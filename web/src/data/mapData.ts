import { DataApi, getDataApi } from "./api";
import { BUNDLE_BASE, StaticBundleLoader } from "./bundle";
import type { MapBundleLoader } from "./bundle";
import type { ApiEquipment, CompSelection, EnemyCompSet, MapDetail, MapSummary, ShipDetail } from "@shared/data/types";
import type { EventBonusResponse } from "@shared/sim/bonuses";

/** シミュレーションに必要な海域データ一式 (API か静的バンドルから)。 */
export interface MapData {
  key: string;
  detail: MapDetail;
  comps: Record<string, EnemyCompSet[]>;
  /** ノード → 難易度ごとの出典 (観測 n と KCNav のどちらを使ったか)。古い API・バンドルでは空 */
  compSelection: Record<string, CompSelection[]>;
  ships: Map<number, ShipDetail>;
  equips: Map<number, ApiEquipment>;
  /** イベント特効。null はデータの無い海域、undefined は取得できなかった (静的バンドルには無い) */
  bonuses?: EventBonusResponse | null;
  source: "api" | "bundle";
  stale: boolean;
  /** 静的バンドルの生成日時 */
  generatedAt?: string;
}

/** バンドルの ships は `Ship & {estimates, best}` (平坦)。API の ShipDetail 形に直す。 */
const normalizeBundleShip = (raw: unknown): ShipDetail => {
  const r = raw as ShipDetail & { ship?: ShipDetail["ship"] };
  if (r.ship) return r;
  const { estimates, best, ...ship } = raw as ShipDetail["ship"] & Pick<ShipDetail, "estimates" | "best">;
  return { ship: ship as ShipDetail["ship"], estimates: estimates ?? [], best: best ?? {} };
};

/** API が使えないとき (オフライン・5xx・取り直しても続くレート制限) は静的バンドルで続ける */
const shouldFallback = (e: unknown) => {
  const err = e as { kind?: string; status?: number };
  return err.kind === "offline" || err.status === 429 || (err.status ?? 0) >= 500;
};

export const loadMapData = async (
  key: string,
  opts: { api?: DataApi; bundle?: MapBundleLoader; minObserved?: number } = {}
): Promise<MapData> => {
  const api = opts.api ?? getDataApi();
  try {
    // 海域の一式 (マス・敵編成・艦・特効) は 1 リクエスト。深海装備は起動時の boot (キャッシュ済み) から
    const [boot, v] = await Promise.all([api.boot(), api.mapView(key, opts.minObserved)]);
    const comps: Record<string, EnemyCompSet[]> = {};
    const compSelection: Record<string, CompSelection[]> = {};
    for (const [n, picked] of Object.entries(v.data.enemyComps.nodes)) {
      comps[n] = picked.sets;
      compSelection[n] = picked.selection;
    }
    return {
      key,
      detail: v.data.detail,
      comps,
      compSelection,
      ships: new Map<number, ShipDetail>(v.data.ships.map((s) => [s.ship.id, s])),
      equips: new Map(boot.data.equipments.map((e) => [e.id, e])),
      bonuses: v.data.bonuses,
      source: "api",
      stale: boot.stale || v.stale,
    };
  } catch (e) {
    if (!shouldFallback(e)) throw e;
    const loader = opts.bundle ?? new StaticBundleLoader(BUNDLE_BASE);
    const b = await loader.loadMap(key).catch(() => null);
    if (!b) throw e; // バンドルも無ければ元のエラー (オフライン) を返す
    return {
      key,
      detail: { map: b.map, nodes: b.nodes, edges: b.edges, routing: b.routing, enemyCompNodes: Object.keys(b.enemyComps) },
      comps: b.enemyComps,
      compSelection: b.enemyCompSelection ?? {},
      ships: new Map(Object.entries(b.ships).map(([id, s]) => [Number(id), normalizeBundleShip(s as unknown)])),
      equips: new Map(Object.entries(b.equipments).map(([id, x]) => [Number(id), x])),
      source: "bundle",
      stale: false,
      generatedAt: b.generatedAt,
    };
  }
};

// ---- 海域一覧 (API → 静的バンドル索引) ----

export interface MapList {
  maps: MapSummary[];
  source: "api" | "bundle";
  stale: boolean;
}

export const loadMapList = async (opts: { api?: DataApi; fetch?: typeof fetch } = {}): Promise<MapList> => {
  const api = opts.api ?? getDataApi();
  try {
    const r = await api.boot();
    return { maps: r.data.maps, source: "api", stale: r.stale };
  } catch (e) {
    if (!shouldFallback(e)) throw e;
    try {
      const res = await (opts.fetch ?? globalThis.fetch)(`${BUNDLE_BASE}/index.json`);
      if (!res.ok) throw new Error(String(res.status));
      const idx = (await res.json()) as { maps: { key: string; routing: boolean; compNodes: number }[] };
      const maps: MapSummary[] = idx.maps.map((m) => {
        const [w, n] = m.key.split("-").map(Number);
        return {
          id: w * 10 + n, key: m.key, world: w, no: n, name: m.key, isEvent: w > 7, nodeCount: 0, edgeCount: 0,
          compSetCount: m.compNodes, routing: m.routing ? { ruleCount: 0, uncertainCount: 0 } : null, approx: true,
        };
      });
      return { maps, source: "bundle", stale: false };
    } catch {
      throw e;
    }
  }
};
