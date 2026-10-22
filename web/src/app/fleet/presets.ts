import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { PresetStore } from "../../fleet";
import type { Preset, PresetShip } from "../../fleet";
import type { Catalog } from "../../fleet/catalog";

let store: PresetStore | undefined;
/** 遅延生成 (テスト・SSR で localStorage に触れないため) */
export const getPresetStore = (): PresetStore => (store ??= new PresetStore());

// UI の外 (poi プラグインからの移行) での書き換えの回数。描画前に届いても取りこぼさないよう useSyncExternalStore で読む
let externalRevision = 0;
const changeListeners = new Set<() => void>();
const subscribeChanges = (l: () => void) => {
  changeListeners.add(l);
  return () => void changeListeners.delete(l);
};
/** UI の外で store を書き換えたときに呼ぶ。usePresets が再読込する */
export const notifyPresetsChanged = () => {
  externalRevision++;
  changeListeners.forEach((l) => l());
};

export const blankPreset = (): Omit<Preset, "id"> => {
  const now = Date.now();
  return {
    name: "新規プリセット",
    createdAt: now,
    updatedAt: now,
    fleetType: "single",
    formation: "line_ahead",
    ships: [],
    hqLevel: 120,
    source: "manual",
  };
};

export const newShipFor = (masterId: number, catalog: Catalog, base?: PresetShip): PresetShip => {
  const slots = catalog.master.ships[masterId]?.api_slot_num ?? 0;
  const keep = base?.equips ?? [];
  return {
    masterId,
    level: base?.level ?? 99,
    luckMod: base?.luckMod ?? 0,
    hpMod: base?.hpMod ?? 0,
    aswMod: base?.aswMod ?? 0,
    morale: base?.morale ?? 49,
    equips: Array.from({ length: slots }, (_, i) => keep[i] ?? null),
    exSlot: base?.exSlot ?? null,
  };
};

/** 搭載数の既定値 (master の api_maxeq)。 */
export const defaultSlotSize = (catalog: Catalog, shipMasterId: number, slotIndex: number) =>
  catalog.master.ships[shipMasterId]?.api_maxeq?.[slotIndex];

/** localStorage のプリセットを購読するフック。変更系は保存してから再読込する。 */
export const usePresets = () => {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const external = useSyncExternalStore(subscribeChanges, () => externalRevision);
  const store = getPresetStore();
  const presets = useMemo(() => store.list(), [store, version, external]);

  return {
    presets,
    store,
    save: useCallback(
      (p: Omit<Preset, "id"> & { id?: string }) => {
        const saved = store.save(p);
        bump();
        return saved;
      },
      [store, bump]
    ),
    remove: useCallback(
      (id: string) => {
        store.remove(id);
        bump();
      },
      [store, bump]
    ),
    refresh: bump,
  };
};
