/** 所持装備 (poi の state.info.equips) の集計と、艦ごとの装備可否によるピッカー選択肢の組み立て。 */
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
 * 所持データが無ければマスター全件をそのまま返す。shipMasterId があれば装備できる種別だけに絞る。
 */
export const buildEquipPicker = (catalog: Catalog, state: PoiEquipState | null | undefined, shipMasterId?: number): EquipPicker => {
  const choices = new Map<string, EquipChoice>();
  const allowed = (id: number) => canEquip(state, catalog, shipMasterId, id);
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
