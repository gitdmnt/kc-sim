/** poi の state.const から、ピッカー用の選択肢と名前引きを作る。 */
import { masterFromPoi } from "@shared/fleet/poiImport";
import type { MasterData } from "@shared/fleet/types";

export interface PickerOption {
  value: number;
  label: string;
  sub?: string;
  group?: string;
  /** 正規化済みの検索文字列 */
  search: string;
}

export interface Catalog {
  master: MasterData;
  shipTypes: Record<number, string>;
  equipTypes: Record<number, string>;
  shipOptions: PickerOption[];
  equipOptions: PickerOption[];
  shipName(id: number): string;
  equipName(id: number): string;
  shipTypeName(shipMasterId: number): string;
  equipTypeName(equipMasterId: number): string;
}

/** 全角/半角・大小・カタカナ/ひらがなの差を無視して検索できるようにする。 */
export const normalizeForSearch = (s: string): string =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, "");

/** 艦娘は api_id < 1500、深海棲艦は 1501 以降。装備は 501 以降が深海棲艦用。 */
export const PLAYER_SHIP_MAX_ID = 1500;
export const PLAYER_EQUIP_MAX_ID = 500;

const nameMap = (obj: any): Record<number, string> => {
  const out: Record<number, string> = {};
  for (const v of Object.values<any>(obj ?? {})) {
    if (v && typeof v.api_id === "number" && typeof v.api_name === "string") out[v.api_id] = v.api_name;
  }
  return out;
};

export const buildCatalog = (state: any): Catalog => {
  const master = masterFromPoi(state);
  const shipTypes = nameMap(state?.const?.$shipTypes);
  const equipTypes = nameMap(state?.const?.$equipTypes);

  const ships = Object.values(master.ships).filter(
    (s): s is NonNullable<typeof s> =>
      !!s && s.api_id < PLAYER_SHIP_MAX_ID && typeof s.api_name === "string"
  );
  ships.sort(
    (a, b) =>
      (a.api_stype ?? 0) - (b.api_stype ?? 0) ||
      (a.api_sort_id ?? a.api_id) - (b.api_sort_id ?? b.api_id)
  );
  const shipOptions: PickerOption[] = ships.map((s) => ({
    value: s.api_id,
    label: s.api_name!,
    sub: `No.${s.api_id}`,
    group: shipTypes[s.api_stype ?? 0] ?? "その他",
    search: normalizeForSearch(`${s.api_name}${s.api_yomi ?? ""}${s.api_id}`),
  }));

  const equips = Object.values(master.equips).filter(
    (e): e is NonNullable<typeof e> =>
      !!e && e.api_id <= PLAYER_EQUIP_MAX_ID && typeof e.api_name === "string"
  );
  equips.sort(
    (a, b) =>
      (a.api_type?.[2] ?? 0) - (b.api_type?.[2] ?? 0) ||
      (a.api_sortno ?? a.api_id) - (b.api_sortno ?? b.api_id)
  );
  const equipOptions: PickerOption[] = equips.map((e) => ({
    value: e.api_id,
    label: e.api_name!,
    group: equipTypes[e.api_type?.[2] ?? 0] ?? "その他",
    search: normalizeForSearch(`${e.api_name}${e.api_id}`),
  }));

  return {
    master,
    shipTypes,
    equipTypes,
    shipOptions,
    equipOptions,
    shipName: (id) => master.ships[id]?.api_name ?? `艦#${id}`,
    equipName: (id) => master.equips[id]?.api_name ?? `装備#${id}`,
    shipTypeName: (id) => shipTypes[master.ships[id]?.api_stype ?? 0] ?? "",
    equipTypeName: (id) => equipTypes[master.equips[id]?.api_type?.[2] ?? 0] ?? "",
  };
};
