import type {
  Preset,
  PresetEquip,
  PresetFleetType,
  PresetFormation,
  PresetShip,
} from "./types";

const FORMATIONS: PresetFormation[] = [
  "line_ahead",
  "double_line",
  "diamond",
  "echelon",
  "line_abreast",
  "vanguard",
  "combined_anti_sub",
  "combined_forward",
  "combined_diamond",
  "combined_battle",
];
const FLEET_TYPES: PresetFleetType[] = [
  "single",
  "carrier_task_force",
  "surface_task_force",
  "transport_escort",
];

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
};
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.trunc(v)));

export const normalizeEquip = (raw: any): PresetEquip | null => {
  if (!raw || typeof raw !== "object") return null;
  const masterId = num(raw.masterId, 0);
  if (masterId <= 0) return null;
  const equip: PresetEquip = {
    masterId,
    improvement: clamp(num(raw.improvement, 0), 0, 10),
    proficiency: clamp(num(raw.proficiency, 0), 0, 7),
  };
  if (raw.slotSize !== undefined && raw.slotSize !== null) {
    equip.slotSize = Math.max(0, Math.trunc(num(raw.slotSize, 0)));
  }
  return equip;
};

export const normalizeShip = (raw: any): PresetShip => {
  const ship: PresetShip = {
    masterId: num(raw?.masterId, 0),
    level: clamp(num(raw?.level, 1), 1, 185),
    luckMod: Math.max(0, Math.trunc(num(raw?.luckMod, 0))),
    hpMod: Math.max(0, Math.trunc(num(raw?.hpMod, 0))),
    aswMod: Math.max(0, Math.trunc(num(raw?.aswMod, 0))),
    morale: clamp(num(raw?.morale, 49), 0, 100),
    equips: Array.isArray(raw?.equips) ? raw.equips.map(normalizeEquip) : [],
  };
  if (raw?.exSlot) ship.exSlot = normalizeEquip(raw.exSlot);
  if (raw?.observed && typeof raw.observed === "object") {
    const observed: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.observed)) {
      if (typeof v === "number" && Number.isFinite(v)) observed[k] = v;
    }
    ship.observed = observed;
  }
  return ship;
};

/** 外部入力 (JSON import 等) を Preset に整形する。ships が配列でなければ例外。 */
export const normalizePreset = (
  raw: any,
  fallbackId: () => string,
  now: number
): Preset => {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.ships)) {
    throw new Error("Invalid preset: `ships` must be an array");
  }
  const preset: Preset = {
    id: typeof raw.id === "string" && raw.id ? raw.id : fallbackId(),
    name: typeof raw.name === "string" && raw.name ? raw.name : "Untitled",
    createdAt: num(raw.createdAt, now),
    updatedAt: num(raw.updatedAt, now),
    fleetType: FLEET_TYPES.includes(raw.fleetType) ? raw.fleetType : "single",
    formation: FORMATIONS.includes(raw.formation)
      ? raw.formation
      : "line_ahead",
    ships: raw.ships.map(normalizeShip),
  };
  if (Array.isArray(raw.escort)) preset.escort = raw.escort.map(normalizeShip);
  if (raw.hqLevel !== undefined) preset.hqLevel = num(raw.hqLevel, 120);
  if (typeof raw.source === "string") preset.source = raw.source as Preset["source"];
  if (typeof raw.note === "string") preset.note = raw.note;
  return preset;
};
