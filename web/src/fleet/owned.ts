/** 所持装備・所持艦 (poi の state.info.equips / ships) の集計と、艦ごとの装備可否によるピッカー選択肢の組み立て。 */
import type { Catalog, PickerOption } from "./catalog";

export interface OwnedEquip {
  masterId: number;
  improvement: number;
  proficiency: number;
  count: number;
}

/** 選択肢が指す装備の内容。所持グループなら ★/熟練 も持つ。 */
export interface EquipChoice {
  masterId: number;
  improvement: number;
  proficiency: number;
}

export interface EquipPicker {
  options: PickerOption[];
  /** PickerOption.key → 選択内容 */
  choices: Map<string, EquipChoice>;
}

/** poi の state のうちここで読む部分。 */
export interface PoiEquipState {
  info?: { equips?: Record<string, { api_slotitem_id?: number; api_level?: number; api_alv?: number }> };
  const?: { $shipTypes?: Record<string, { api_equip_type?: Record<string, number> }> };
}

export const OWNED_GROUP_PREFIX = "所持・";

export const equipKey = (masterId: number, improvement = 0, proficiency = 0): string =>
  `o:${masterId}:${improvement}:${proficiency}`;

/** 装備インスタンスを (マスターID, ★, 熟練) ごとにまとめる。順序は未定義。 */
export const ownedEquipGroups = (state: PoiEquipState | null | undefined): OwnedEquip[] => {
  const instances = state?.info?.equips;
  if (!instances || typeof instances !== "object") return [];
  const groups = new Map<string, OwnedEquip>();
  for (const inst of Object.values(instances)) {
    const masterId = inst?.api_slotitem_id;
    if (typeof masterId !== "number") continue;
    const improvement = Number.isFinite(inst.api_level) ? inst.api_level! : 0;
    const proficiency = Number.isFinite(inst.api_alv) ? inst.api_alv! : 0;
    const key = equipKey(masterId, improvement, proficiency);
    const g = groups.get(key);
    if (g) g.count += 1;
    else groups.set(key, { masterId, improvement, proficiency, count: 1 });
  }
  return [...groups.values()];
};

/** 艦種の装備可否表 ($shipTypes[stype].api_equip_type) が無ければ制限しない。 */
export const canEquip = (state: PoiEquipState | null | undefined, catalog: Catalog, shipMasterId: number | undefined, equipMasterId: number): boolean => {
  if (shipMasterId === undefined) return true;
  const stype = catalog.master.ships[shipMasterId]?.api_stype;
  const table = stype === undefined ? undefined : state?.const?.$shipTypes?.[stype]?.api_equip_type;
  if (!table || typeof table !== "object") return true;
  const category = catalog.master.equips[equipMasterId]?.api_type?.[2];
  if (category === undefined) return true;
  return table[category] === 1;
};

/** 熟練度 (0-7) の表示記号。 */
export const PROFICIENCY_GLYPH = ["", "|", "||", "|||", "/", "//", "///", ">>"];

const ownedSub = (g: OwnedEquip) =>
  [
    g.improvement > 0 ? `★${g.improvement}` : "",
    g.proficiency > 0 ? PROFICIENCY_GLYPH[g.proficiency] ?? "" : "",
    `×${g.count}`,
  ]
    .filter(Boolean)
    .join(" ");

/**
 * 所持装備 (★/熟練ごと) を先頭に、所持していないマスター装備を後ろ (dim) に並べた選択肢を作る。
 * 所持データが無ければマスター全件をそのまま返す。shipMasterId があれば装備できる種別だけに絞る。`only` はさらに絞る条件 (基地の中隊 = 航空機)。
 */
export const buildEquipPicker = (
  catalog: Catalog,
  state: PoiEquipState | null | undefined,
  shipMasterId?: number,
  only?: (equipMasterId: number) => boolean
): EquipPicker => {
  const choices = new Map<string, EquipChoice>();
  const allowed = (id: number) => canEquip(state, catalog, shipMasterId, id) && (!only || only(id));
  const owned = ownedEquipGroups(state).filter((g) => catalog.master.equips[g.masterId] && allowed(g.masterId));

  const sortKey = (id: number) => {
    const m = catalog.master.equips[id];
    return [m?.api_type?.[2] ?? 0, m?.api_sortno ?? id, id] as const;
  };
  owned.sort((a, b) => {
    const ka = sortKey(a.masterId);
    const kb = sortKey(b.masterId);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || b.improvement - a.improvement || b.proficiency - a.proficiency;
  });

  const base = new Map(catalog.equipOptions.map((o) => [o.value, o]));
  const ownedIds = new Set(owned.map((g) => g.masterId));
  const options: PickerOption[] = [];

  for (const g of owned) {
    const o = base.get(g.masterId);
    if (!o) continue;
    const key = equipKey(g.masterId, g.improvement, g.proficiency);
    choices.set(key, { masterId: g.masterId, improvement: g.improvement, proficiency: g.proficiency });
    options.push({ ...o, key, sub: ownedSub(g), group: `${OWNED_GROUP_PREFIX}${o.group ?? ""}` });
  }
  const dim = owned.length > 0;
  for (const o of catalog.equipOptions) {
    if (ownedIds.has(o.value) || !allowed(o.value)) continue;
    const key = `m:${o.value}`;
    choices.set(key, { masterId: o.value, improvement: 0, proficiency: 0 });
    options.push({ ...o, key, dim });
  }
  return { options, choices };
};

/** 現在の装備に対応する選択肢のキー。所持グループに一致すればそれ、無ければ未所持側のキー。 */
export const selectedEquipKey = (picker: EquipPicker, e: EquipChoice | null): string | undefined => {
  if (!e) return undefined;
  const owned = equipKey(e.masterId, e.improvement, e.proficiency);
  return picker.choices.has(owned) ? owned : `m:${e.masterId}`;
};

/** 所持艦 (poi の state.info.ships の 1 隻)。 */
export interface OwnedShip {
  /** poi の艦のインスタンス ID (shipFromPoi に渡す) */
  instanceId: number;
  masterId: number;
  level: number;
  /** 艦種 (api_stype)。マスターに無ければ 0 */
  stype: number;
}

export interface PoiShipState {
  info?: { ships?: Record<string, { api_id?: number; api_ship_id?: number; api_lv?: number }> };
}

/** 所持艦をレベルの高い順に並べる (同レベルはマスターの図鑑順、次いで取得順)。マスターに無い艦は除く。 */
export const ownedShips = (state: PoiShipState | null | undefined, catalog: Catalog): OwnedShip[] => {
  const out: OwnedShip[] = [];
  for (const [key, s] of Object.entries(state?.info?.ships ?? {})) {
    const master = typeof s?.api_ship_id === "number" ? catalog.master.ships[s.api_ship_id] : undefined;
    if (!s || !master) continue;
    out.push({ instanceId: s.api_id ?? Number(key), masterId: master.api_id, level: s.api_lv ?? 1, stype: master.api_stype ?? 0 });
  }
  const sortNo = (id: number) => catalog.master.ships[id]?.api_sort_id ?? id;
  return out.sort((a, b) => b.level - a.level || sortNo(a.masterId) - sortNo(b.masterId) || a.instanceId - b.instanceId);
};

/** 装備選択の絞り込みカテゴリ。types は装備のカテゴリ ID (api_type[2])。どれにも当たらない装備は「その他」。 */
export const EQUIP_CATEGORIES: { label: string; types: number[] }[] = [
  { label: "主砲", types: [1, 2, 3] },
  { label: "副砲", types: [4] },
  { label: "魚雷", types: [5, 32] },
  { label: "艦戦", types: [6] },
  { label: "艦爆", types: [7] },
  { label: "艦攻", types: [8] },
  { label: "水偵", types: [10, 11] },
  { label: "電探", types: [12, 13] },
  { label: "ソナー", types: [14] },
  { label: "爆雷", types: [15] },
  { label: "機銃", types: [21] },
  { label: "その他", types: [] },
];

/** 装備のカテゴリ ID (api_type[2]) が属する EQUIP_CATEGORIES の添字。どれにも当たらなければ「その他」 */
export const equipCategory = (typeId: number | undefined): number => {
  const i = EQUIP_CATEGORIES.findIndex((c) => typeId !== undefined && c.types.includes(typeId));
  return i < 0 ? EQUIP_CATEGORIES.length - 1 : i;
};
