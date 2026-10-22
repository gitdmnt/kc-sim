import type { MapBundle } from "@shared/data/types";

/** 静的バンドル (`server/dist/maps/{W-M}.json`, API.md §5) の読み込み口。 */
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

/** バンドルの置き場。web のビルドが `server/dist/maps` を dist/maps に同梱し、Worker の静的アセットとして配る。 */
export const BUNDLE_BASE = "/maps";
