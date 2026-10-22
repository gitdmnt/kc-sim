import { DataApi, getDataApi } from "./api";
import { StaticBundleLoader, defaultBundleBase } from "./bundle";
import type { MapBundleLoader } from "./bundle";
import type { ApiEquipment, CompSelection, EnemyCompSet, MapDetail, MapSummary, ShipDetail } from "@shared/data/types";

/** シミュレーションに必要な海域データ一式 (API か静的バンドルから)。 */
export interface MapData {
  key: string;
  detail: MapDetail;
  comps: Record<string, EnemyCompSet[]>;
  /** ノード → 難易度ごとの出典 (観測 n と KCNav のどちらを使ったか)。古い API・バンドルでは空 */
  compSelection: Record<string, CompSelection[]>;
  ships: Map<number, ShipDetail>;
  equips: Map<number, ApiEquipment>;
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

const shouldFallback = (e: unknown) => {
  const err = e as { kind?: string; status?: number };
  return err.kind === "offline" || (err.status ?? 0) >= 500;
};

export const loadMapData = async (
  key: string,
  opts: { api?: DataApi; bundle?: MapBundleLoader; bundleBase?: string; minObserved?: number } = {}
): Promise<MapData> => {
  const api = opts.api ?? getDataApi();
  try {
    const d = await api.map(key);
    const nodes = d.data.enemyCompNodes;
    const comps: Record<string, EnemyCompSet[]> = {};
    const compSelection: Record<string, CompSelection[]> = {};
    let stale = d.stale;
    const loaded = await Promise.all(nodes.map((n) => api.enemyComps(key, n, opts.minObserved)));
    nodes.forEach((n, i) => {
      comps[n] = loaded[i].data.sets;
      compSelection[n] = loaded[i].data.selection ?? [];
      stale ||= loaded[i].stale;
    });
    const ids = [...new Set(Object.values(comps).flatMap((sets) => sets.flatMap((s) => s.comps.flatMap((c) => [...c.main, ...c.escort].map((x) => x.shipId)))))];
    const ships = new Map<number, ShipDetail>();
    await Promise.all(
      ids.map(async (id) => {
        try {
          const r = await api.ship(id);
          ships.set(id, r.data);
          stale ||= r.stale;
        } catch {
          // 取得できない艦は警告つきで扱われる
        }
      })
    );
    const eq = await api.abyssalEquipments();
    return {
      key,
      detail: d.data,
      comps,
      compSelection,
      ships,
      equips: new Map(eq.data.map((e) => [e.id, e])),
      source: "api",
      stale: stale || eq.stale,
    };
  } catch (e) {
    if (!shouldFallback(e)) throw e;
    const loader = opts.bundle ?? new StaticBundleLoader(defaultBundleBase(opts.bundleBase ?? ""));
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

export const loadMapList = async (opts: { api?: DataApi; bundleBase?: string; fetch?: typeof fetch } = {}): Promise<MapList> => {
  const api = opts.api ?? getDataApi();
  try {
    const r = await api.maps();
    return { maps: r.data, source: "api", stale: r.stale };
  } catch (e) {
    if (!shouldFallback(e)) throw e;
    const base = defaultBundleBase(opts.bundleBase ?? "").replace(/\/+$/, "");
    try {
      const res = await (opts.fetch ?? globalThis.fetch)(`${base}/index.json`);
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
