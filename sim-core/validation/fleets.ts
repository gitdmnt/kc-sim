// Archetype fleet library shared by the routing validation scripts (routing-vs-kcnav.ts,
// routing-inference.ts): compositions, speeds and LoS gear of plausible player fleets.
import type { EquipmentInput, ShipInput } from "../pkg/sim_core.js";

export type Code = "DE" | "DD" | "CL" | "CLT" | "CT" | "CA" | "CAV" | "CVL" | "FBB" | "BB" | "BBV" | "CV" | "CVB" | "SS" | "AV" | "AO";
export const STYPE: Record<Code, number> = { DE: 1, DD: 2, CL: 3, CLT: 4, CA: 5, CAV: 6, CVL: 7, FBB: 8, BB: 9, BBV: 10, CV: 11, SS: 13, AV: 16, CVB: 18, CT: 21, AO: 22 };
/** Rough Lv99 naked LoS per type. */
export const NAKED_LOS: Record<Code, number> = { DE: 30, DD: 45, CL: 50, CLT: 45, CT: 50, CA: 50, CAV: 60, CVL: 60, FBB: 60, BB: 60, BBV: 60, CV: 70, CVB: 70, SS: 25, AV: 60, AO: 30 };
export const SPEEDS = { slow: 5, fast: 10, fastPlus: 15, fastest: 20 } as const;
export type Speed = keyof typeof SPEEDS;
export type LosLevel = "none" | "mid" | "high";

/** LoS equipment per type and level (none: no LoS equipment). */
export function losGear(code: Code, level: LosLevel): EquipmentInput[] {
  if (level === "none") return [];
  const n = level === "mid" ? 1 : 2;
  if (code === "CV" || code === "CVB" || code === "CVL") return Array.from({ length: n }, () => ({ id: 61, types: [0, 0, 9, 9, 0], stats: { los: 7 }, planes: 18 }));
  if (code === "CA" || code === "CAV" || code === "BBV" || code === "AV" || code === "FBB" || code === "BB") {
    return Array.from({ length: n }, () => ({ id: 25, types: [0, 0, 10, 10, 0], stats: { los: level === "mid" ? 5 : 8 }, planes: 2 }));
  }
  if (code === "DD" || code === "CL" || code === "CT" || code === "CLT" || code === "DE") return level === "high" ? [{ id: 28, types: [0, 0, 12, 11, 0], stats: { los: 8 } }] : [];
  return [];
}

/** Compositions in the library (flagship first). Broad on purpose: the fit picks the population. */
export const COMPS: string[] = [
  "DD", "DE DE DE", "DE DE DE DE", "CVL DE DE DE", "CT DE DE DE", "CL DE DE DE", "CL DD DD DD", "DD DD DD DD",
  "CL DD DD DD DD", "CL DD DD DD DD DD", "AO DE DE DE", "CVL CL DD DD", "CL DD DD CA CA CAV", "CL DD DD DD CA CA",
  "CL DD DD DD DD CAV", "CL CAV DD DD DD DD", "CAV CAV DD DD CL DD", "BBV BBV CA CA CL DD", "BBV BBV CL DD DD DD",
  "CLT CLT CL DD DD DD", "CLT CLT CLT CL DD DD", "AV AV CL DD DD DD", "CVL CVL CL DD DD DD", "CV CV CL DD DD DD",
  "CV CV CA CA DD DD", "BB BB CA CA DD DD", "BB BB CL DD DD DD", "BB BB CAV CAV DD DD", "BB BB CV CV DD DD",
  "FBB FBB CV CV DD DD", "BB BB CV DD DD AO", "BB CV CV DD DD AO", "BB BB CV CL DD DD", "BB CV CV CL DD DD",
  "BB BB CVL CL DD DD", "BB BB CV CV CA CA", "BB BB CV CV CAV CL", "BB BB BB CV CV CV", "CV CV CV BB CA DD",
  "BB BB CLT CLT CA CA", "SS SS SS SS", "SS SS SS SS SS SS", "AS SS SS SS SS SS",
].map((c) => c.replace("AS", "AV"));

/** Speeds a composition can plausibly sail at. */
export function speedsFor(codes: Code[]): Speed[] {
  const out: Speed[] = [];
  if (codes.some((c) => ["DE", "BB", "BBV", "CVL", "AV", "AO", "SS", "CV"].includes(c))) out.push("slow");
  out.push("fast");
  if (!codes.some((c) => ["DE", "AO", "AV", "SS", "CT"].includes(c))) out.push("fastPlus", "fastest");
  return out;
}

export function fleetShips(codes: Code[], speed: Speed, los: LosLevel): ShipInput[] {
  return codes.map((code) => ({
    shipType: STYPE[code], level: 99, maxHp: 50, speed: SPEEDS[speed],
    stats: { firepower: 50, torpedo: 50, antiAir: 50, armor: 50, evasion: 60, asw: 50, los: NAKED_LOS[code], luck: 20 },
    slots: losGear(code, los),
  }));
}
