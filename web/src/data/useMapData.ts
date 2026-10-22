import { useSettings } from "../app/settings";
import { loadMapData, loadMapList } from "./mapData";
import type { MapData, MapList } from "./mapData";
import { useAsync } from "./useAsync";

/** 海域一覧。API に繋がらなければ静的バンドルの索引で代替する。 */
export const useMapList = (nonce = 0) =>
  useAsync<MapList>(() => loadMapList().then((d) => ({ data: d, stale: d.stale })), [nonce]);

/** 1 海域分のデータ一式 (API または静的バンドル)。key が null なら何もしない。 */
export const useMapData = (key: string | null, nonce = 0) => {
  const { minObserved } = useSettings();
  return useAsync<MapData>(
    key ? () => loadMapData(key, { minObserved }).then((d) => ({ data: d, stale: d.stale })) : null,
    [key, minObserved, nonce]
  );
};
