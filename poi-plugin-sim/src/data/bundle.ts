import type { MapBundle } from "./types";

/** 静的バンドル (`data-worker/dist/maps/{W-M}.json`, API.md §5) の読み込み口。 */
export interface MapBundleLoader {
  loadMap(key: string): Promise<MapBundle | null>;
}

export class StaticBundleLoader implements MapBundleLoader {
  constructor(private baseUrl: string, private fetchImpl?: typeof fetch) {}

  async loadMap(key: string): Promise<MapBundle | null> {
    // fetch は window に束縛して呼ぶ必要がある (メソッド呼び出しだと Illegal invocation になる)
    const f = this.fetchImpl ?? ((u: string) => globalThis.fetch(u));
    const res = await f(`${this.baseUrl.replace(/\/+$/, "")}/${key}.json`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`bundle ${key}: ${res.status}`);
    const b = (await res.json()) as MapBundle;
    if (b.format !== "kc-sim-map-bundle") throw new Error(`bundle ${key}: unexpected format`);
    return b;
  }
}

/** バンドルの置き場: 設定の URL があればそれ、無ければプラグイン同梱の `../maps` (file://)。 */
export const defaultBundleBase = (configured: string): string => {
  if (configured.trim()) return configured.trim();
  if (typeof __DEV_BUNDLE_BASE__ === "string") return __DEV_BUNDLE_BASE__;
  const dir = (typeof __dirname === "string" ? __dirname : "").replace(/\\/g, "/");
  if (!dir) return "";
  return encodeURI(`file://${dir.startsWith("/") ? "" : "/"}${dir}/../maps`);
};
