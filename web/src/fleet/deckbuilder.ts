/**
 * 「デッキビルダー」形式 (制空権シミュレータ / 74EO / kancolle-replay 等が共有) の入出力。
 *
 *   {"version":4,"hqlv":120,
 *    "f1":{"s1":{"id":"131","lv":99,"luck":-1,"hp":..,"asw":..,
 *                "items":{"i1":{"id":3,"rf":7,"mas":7},...,"ix":{"id":43}}}}}
 *
 * rf = 改修値, mas = 熟練度。luck/hp/asw は改修込みの実数値 (任意, 無指定は -1/欠落)。
 */
import { normalizePreset } from "./normalize";
import type { MasterData, Preset, PresetEquip, PresetShip } from "@shared/fleet/types";

export interface DeckBuilderItem {
  id: number;
  rf?: number;
  mas?: number;
}
export interface DeckBuilderShip {
  id: string | number;
  lv?: number;
  luck?: number;
  hp?: number;
  asw?: number;
  items?: Record<string, DeckBuilderItem | undefined>;
}
export interface DeckBuilderData {
  version: number;
  hqlv?: number;
  [fleet: string]: unknown;
}

const orderedKeys = (obj: Record<string, unknown>, prefix: string) =>
  Object.keys(obj)
    .filter((k) => new RegExp(`^${prefix}\\d+$`).test(k))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));

const toEquip = (item: DeckBuilderItem | undefined, slotSize?: number): PresetEquip | null => {
  const id = Number(item?.id);
  if (!item || !Number.isFinite(id) || id <= 0) return null;
  const equip: PresetEquip = {
    masterId: id,
    improvement: Math.min(10, Math.max(0, Number(item.rf) || 0)),
    proficiency: Math.min(7, Math.max(0, Number(item.mas) || 0)),
  };
  if (slotSize !== undefined) equip.slotSize = slotSize;
  return equip;
};

export interface DeckBuilderImportOptions {
  /** 取り込む艦隊番号 (1-4)。既定 1。 */
  fleet?: number;
  name?: string;
  /** 渡すと運の改修値や搭載数を逆算する。 */
  master?: MasterData;
  now?: number;
  genId?: () => string;
}

export const parseDeckBuilder = (
  input: string | DeckBuilderData,
  opts: DeckBuilderImportOptions = {}
): Preset => {
  const data = (typeof input === "string" ? JSON.parse(input) : input) as DeckBuilderData;
  if (!data || typeof data !== "object") throw new Error("Invalid DeckBuilder data");
  const fleetNo = opts.fleet ?? 1;
  const fleet = data[`f${fleetNo}`] as Record<string, DeckBuilderShip> | undefined;
  if (!fleet || typeof fleet !== "object") {
    throw new Error(`DeckBuilder data has no fleet f${fleetNo}`);
  }

  const ships: PresetShip[] = orderedKeys(fleet, "s").map((key) => {
    const s = fleet[key];
    const masterId = Number(s.id);
    const shipMaster = opts.master?.ships[masterId];
    const items = s.items ?? {};
    const equips = orderedKeys(items, "i").map((k, idx) =>
      toEquip(items[k], shipMaster?.api_maxeq?.[idx])
    );
    const ship: PresetShip = {
      masterId,
      level: Number(s.lv) || 1,
      luckMod: 0,
      hpMod: 0,
      aswMod: 0,
      morale: 49,
      equips,
      exSlot: toEquip(items.ix, 0),
    };
    const observed: Record<string, number> = {};
    if (Number(s.luck) > 0) {
      observed.luck = Number(s.luck);
      const base = shipMaster?.api_luck?.[0];
      if (base !== undefined) ship.luckMod = Math.max(0, Number(s.luck) - base);
    }
    if (Number(s.hp) > 0) observed.maxHp = Number(s.hp);
    if (Number(s.asw) > 0) observed.asw = Number(s.asw);
    if (Object.keys(observed).length > 0) ship.observed = observed;
    return ship;
  });

  const now = opts.now ?? Date.now();
  return normalizePreset(
    {
      name: opts.name ?? `DeckBuilder f${fleetNo}`,
      ships,
      hqLevel: data.hqlv,
      source: "deckbuilder",
    },
    opts.genId ?? (() => `p_${now.toString(36)}`),
    now
  );
};

const exportItem = (e: PresetEquip): DeckBuilderItem => {
  const item: DeckBuilderItem = { id: e.masterId, rf: e.improvement };
  if (e.proficiency > 0) item.mas = e.proficiency;
  return item;
};

export const toDeckBuilder = (preset: Preset, master?: MasterData): DeckBuilderData => {
  const f1: Record<string, DeckBuilderShip> = {};
  preset.ships.forEach((ship, i) => {
    const items: Record<string, DeckBuilderItem> = {};
    ship.equips.forEach((e, idx) => {
      if (e) items[`i${idx + 1}`] = exportItem(e);
    });
    if (ship.exSlot) items.ix = exportItem(ship.exSlot);

    const baseLuck = master?.ships[ship.masterId]?.api_luck?.[0];
    const luck =
      ship.observed?.luck ?? (baseLuck !== undefined ? baseLuck + ship.luckMod : -1);
    const out: DeckBuilderShip = {
      id: String(ship.masterId),
      lv: ship.level,
      luck,
      items,
    };
    if (ship.observed?.maxHp !== undefined) out.hp = ship.observed.maxHp;
    if (ship.observed?.asw !== undefined) out.asw = ship.observed.asw;
    f1[`s${i + 1}`] = out;
  });
  return { version: 4, hqlv: preset.hqLevel ?? 120, f1 };
};
