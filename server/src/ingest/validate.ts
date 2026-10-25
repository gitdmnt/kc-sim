// Server-side re-derivation and validation of uploaded observations (private notes API §3 "Validation").
// Battle enemies, attack events and sortie cells are re-derived from the raw game responses with the
// shared capture parser; client-computed summaries are only cross-checked. Each finding has an action:
// reject (not stored), quarantine (stored, excluded from aggregation and estimation) or flag (stored, used).
import { extractAttackEvents, extractCellData, extractEnemy, extractMapCell } from "../../../shared/capture/parser";
import type { CapturedCell, CapturedEnemy, CapturedEnemyShip } from "../../../shared/capture/types";
import { summarizeFleet } from "../../../shared/fleet/calc";
import { capturedKind } from "../../../shared/estimate/observe";
import type { Master } from "../master";
import type { BattleObservationInput, FleetInput, ObservationInput, SortieObservationInput, SortieRecord } from "../schemas";

export type Action = "reject" | "quarantine" | "flag";
export type Rule =
  | "schema" | "too_large" | "timestamp" | "map_unknown" | "difficulty" | "cell_unknown" | "edge_unknown" | "map_graph_unknown"
  | "raw_invalid" | "raw_mismatch" | "formation" | "enemy_ship_unknown" | "enemy_stats" | "equipment_unknown" | "friend_ship"
  | "fleet_mismatch" | "hp_progression" | "client_mismatch" | "sortie_no_raw" | "drop_unknown" | "drop_no_battle" | "drop_rank";
export interface Finding { rule: Rule; action: Action; detail: string }

export const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const FUTURE_SKEW_MS = 5 * 60_000;
export const MAX_LEVEL = 185;

/** Per-map graph knowledge: stored KC3/KCNav edges and cells seen in accepted sorties. */
export interface MapGraph {
  isEvent: boolean;
  /** edge_id (= destination cell) → letters */
  edges: Map<number, { from: string; to: string }>;
  /** poi_cells of every layout */
  observedCells: Set<number>;
}

export interface ValidationContext {
  now: number;
  master: Master;
  /** maps that exist, with their graph */
  maps: Map<number, MapGraph>;
  /** day battle packet (api_req_sortie/battle) of a cell visit, from this upload or stored, by visitId */
  dayPacket: (visitId: string) => Record<string, unknown> | undefined;
}

export interface Derived {
  /** server-derived enemy side (battles) */
  enemy: CapturedEnemy | null;
  /** server-derived sortie record (sorties) */
  sortie: SortieRecord | null;
  layout: number[] | null;
  /** enemy master ids whose hidden stats this battle can inform (estimator queue) */
  estimableShips: number[];
}

export interface Verdict { findings: Finding[]; derived: Derived }

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Per-ship values of a battle array (pre-2017 responses carry a leading -1); non-numbers become null. */
const perShip = (v: unknown): (number | null)[] => {
  const a = list(v);
  return (a.length === 7 && a[0] === -1 ? a.slice(1) : a).map((x) => (isNum(x) && x >= 0 ? x : null));
};

const FORMATIONS = new Set([1, 2, 3, 4, 5, 6, 11, 12, 13, 14]);

/** Every damage number in a battle response (api_damage, api_fydam, …, nested lists included). */
function damageValues(v: unknown, out: number[] = [], key = ""): number[] {
  if (Array.isArray(v)) for (const x of v) damageValues(x, out, key);
  else if (isNum(v)) {
    if (/^api_(damage|fydam|eydam|fdam|edam)(_list_items)?$/.test(key)) out.push(v);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) damageValues(x, out, k);
  }
  return out;
}

/** HP at the end of a single-fleet day battle, or null when it has damage sources the parser does not model. */
export function dayEndHp(packet: Record<string, unknown>): { friend: (number | null)[]; enemy: (number | null)[] } | null {
  if (packet.api_air_base_injection != null || packet.api_friendly_info != null || packet.api_friendly_battle != null) return null;
  const hp = { friend: perShip(packet.api_f_nowhps), enemy: perShip(packet.api_e_nowhps) };
  const hit = (side: "friend" | "enemy", idx: number, dmg: number) => {
    const cur = hp[side][idx];
    if (cur != null) hp[side][idx] = Math.max(0, cur - dmg);
  };
  const support = packet.api_support_info;
  if (support && typeof support === "object") {
    for (const v of [Reflect.get(support, "api_support_hourai"), Reflect.get(support, "api_support_airatack")]) {
      if (!v || typeof v !== "object") continue;
      const stage3 = Reflect.get(v, "api_stage3");
      const dmg = Reflect.get(v, "api_damage") ?? (stage3 && typeof stage3 === "object" ? Reflect.get(stage3, "api_edam") : undefined);
      perShip(dmg).forEach((d, i) => d && hit("enemy", i, Math.floor(d + 1e-9)));
    }
  }
  for (const ev of extractAttackEvents(packet, "api_req_sortie/battle")) hit(ev.defenderSide, ev.defenderIdx, ev.damage);
  return hp;
}

const enemyStatsOf = (s: CapturedEnemyShip) => ({ hp: s.maxHp, fp: s.params?.[0], tp: s.params?.[1], aa: s.params?.[2], ar: s.params?.[3] });

function checkEnemy(enemy: CapturedEnemy, ctx: ValidationContext, isEvent: boolean, out: Finding[]) {
  for (const s of [...enemy.ships, ...enemy.escort]) {
    const row = ctx.master.ships.get(s.masterId);
    if (!row || !row.is_abyssal || s.masterId <= 1500) {
      out.push({ rule: "enemy_ship_unknown", action: "reject", detail: `enemy ship ${s.masterId} is not a known abyssal ship` });
      continue;
    }
    const got = enemyStatsOf(s);
    const diffs = (["hp", "fp", "tp", "aa", "ar"] as const)
      .filter((k) => isNum(got[k]) && row[k] !== null && got[k] !== row[k])
      .map((k) => `${k} ${got[k]} != ${row[k]}`);
    if (diffs.length) {
      out.push({ rule: "enemy_stats", action: isEvent ? "flag" : "reject", detail: `enemy ship ${s.masterId}: ${diffs.join(", ")}` });
    }
    for (const id of s.slots ?? []) {
      if (id > 0 && !ctx.master.equips.has(id)) out.push({ rule: "equipment_unknown", action: "reject", detail: `enemy equipment ${id}` });
    }
  }
}

function checkFleet(fleet: FleetInput, ctx: ValidationContext, out: Finding[]) {
  for (const s of [...fleet.ships, ...(fleet.escort ?? [])]) {
    const row = ctx.master.ships.get(s.masterId);
    if (!row || row.is_abyssal || s.masterId > 1500) out.push({ rule: "friend_ship", action: "reject", detail: `friend ship ${s.masterId} is not a known player ship` });
    if (s.level < 1 || s.level > MAX_LEVEL) out.push({ rule: "friend_ship", action: "reject", detail: `friend ship ${s.masterId} level ${s.level} outside 1..${MAX_LEVEL}` });
    for (const e of [...s.equips, s.exSlot ?? null]) {
      if (e && (!ctx.master.equips.has(e.masterId) || e.masterId > 1500)) {
        out.push({ rule: "equipment_unknown", action: "reject", detail: `friend equipment ${e.masterId}` });
      }
    }
  }
}

/** The fleet snapshot must describe the ships the battle response fought with. */
function checkFleetAgainstPacket(fleet: FleetInput, packet: Record<string, unknown>, out: Finding[]) {
  for (const [ships, key] of [[fleet.ships, ""], [fleet.escort ?? [], "_combined"]] as const) {
    const max = perShip(packet[`api_f_maxhps${key}`]).filter((x) => x !== null);
    if (!max.length && !ships.length) continue;
    if (max.length !== ships.length) {
      out.push({ rule: "fleet_mismatch", action: "quarantine", detail: `fleet${key} has ${ships.length} ships, response ${max.length}` });
      continue;
    }
    ships.forEach((s, i) => {
      const m = s.observed?.maxHp;
      if (m !== undefined && m !== max[i]) out.push({ rule: "fleet_mismatch", action: "quarantine", detail: `ship ${i + 1}${key}: maxHp ${m} != ${max[i]}` });
    });
  }
}

function checkHp(path: string, packet: Record<string, unknown>, visitId: string, ctx: ValidationContext, out: Finding[]) {
  const bad: string[] = [];
  for (const side of ["f", "e"] as const) {
    for (const key of ["", "_combined"]) {
      const now = perShip(packet[`api_${side}_nowhps${key}`]);
      const max = perShip(packet[`api_${side}_maxhps${key}`]);
      now.forEach((h, i) => {
        const m = max[i];
        if (h !== null && m != null && h > m) bad.push(`${side}${key}[${i}] hp ${h} > max ${m}`);
      });
    }
  }
  for (const d of damageValues(packet)) {
    const frac = d - Math.floor(d);
    if (d < 0 || (frac > 1e-6 && Math.abs(frac - 0.1) > 1e-6)) bad.push(`damage ${d} (only n or n.1 for protection)`);
  }
  // A night continuation starts with the HP the day battle at the same cell visit ended with.
  if (path === "api_req_battle_midnight/battle") {
    const day = ctx.dayPacket(visitId);
    const end = day ? dayEndHp(day) : null;
    if (end) {
      for (const [side, key] of [["friend", "f"], ["enemy", "e"]] as const) {
        perShip(packet[`api_${key}_nowhps`]).forEach((h, i) => {
          const want = end[side][i];
          if (h === null || want == null || h === want) return;
          if (side === "friend" && want === 0 && h > 0) return; // emergency repair (ダメコン) revived the ship
          bad.push(`${side}[${i}] night start hp ${h} != day end ${want}`);
        });
      }
    }
  }
  if (bad.length) out.push({ rule: "hp_progression", action: "quarantine", detail: bad.slice(0, 5).join("; ") });
}

/**
 * Cells must belong to the sortie's layout (api_cell_data) when it is known, and to the map's stored edges or
 * observed cells otherwise. A layout cell the stored graph does not have yet (a new event phase) is flagged.
 */
function checkCells(mapId: number, cells: number[], layout: number[] | null, ctx: ValidationContext, out: Finding[]) {
  const g = ctx.maps.get(mapId)!;
  const inLayout = layout ? new Set(layout) : null;
  const known = g.edges.size > 0 || g.observedCells.size > 0;
  if (!known) out.push({ rule: "map_graph_unknown", action: "flag", detail: "no stored edges or observed cells for this map" });
  for (const c of cells) {
    const inGraph = c === 0 || g.edges.has(c) || g.observedCells.has(c);
    if (inLayout && !inLayout.has(c)) out.push({ rule: "cell_unknown", action: "reject", detail: `cell ${c} not in the sortie layout` });
    else if (known && !inGraph && !inLayout) out.push({ rule: "cell_unknown", action: "reject", detail: `cell ${c} is not a known cell of the map` });
    else if (known && !inGraph) out.push({ rule: "cell_unknown", action: "flag", detail: `cell ${c} is in the layout but not in the stored graph (map changed?)` });
  }
}

/** Consecutive cells must form a stored edge (edge_id = destination cell). Maps change, so this only flags. */
function checkEdges(mapId: number, cells: CapturedCell[], ctx: ValidationContext, out: Finding[]) {
  const g = ctx.maps.get(mapId)!;
  if (!g.edges.size) return;
  let prev: number | null = null;
  for (const c of cells) {
    const from = c.from ?? prev ?? 0;
    const e = g.edges.get(c.no);
    const fromLetter = g.edges.get(from)?.to;
    if (!e) out.push({ rule: "edge_unknown", action: "flag", detail: `${from} -> ${c.no}: no stored edge into ${c.no}` });
    else if (fromLetter === undefined ? !e.from.startsWith("Start") : fromLetter !== e.from) {
      out.push({ rule: "edge_unknown", action: "flag", detail: `${from}(${fromLetter ?? "start"}) -> ${c.no}: stored edge is ${e.from} -> ${e.to}` });
    }
    prev = c.no;
  }
}

function checkCommon(o: ObservationInput, ctx: ValidationContext, out: Finding[]): MapGraph | null {
  const t = Date.parse(o.observedAt);
  if (t > ctx.now + FUTURE_SKEW_MS) out.push({ rule: "timestamp", action: "reject", detail: `observedAt ${o.observedAt} is in the future` });
  if (t < ctx.now - MAX_AGE_MS) out.push({ rule: "timestamp", action: "reject", detail: `observedAt ${o.observedAt} is older than 30 days` });
  const g = ctx.maps.get(o.map);
  if (!g) {
    out.push({ rule: "map_unknown", action: "reject", detail: `map ${o.map} does not exist` });
    return null;
  }
  const d = o.difficulty;
  if (d != null && (g.isEvent ? d < 1 : d !== 0)) out.push({ rule: "difficulty", action: "reject", detail: `difficulty ${d} on ${g.isEvent ? "an event" : "a normal"} map` });
  if (o.fleet) checkFleet(o.fleet, ctx, out);
  return g;
}

/** Same ships, levels and HP: the client's enemy summary is not used, only compared. */
function crossCheckEnemy(client: unknown, enemy: CapturedEnemy, out: Finding[]) {
  if (client === undefined || client === null) return;
  const key = (e: unknown) => {
    const ships = e && typeof e === "object" ? [...list(Reflect.get(e, "ships")), ...list(Reflect.get(e, "escort"))] : [];
    return JSON.stringify(ships.map((s) => (s && typeof s === "object" ? [Reflect.get(s, "masterId"), Reflect.get(s, "level"), Reflect.get(s, "maxHp")] : null)));
  };
  if (key(client) !== key(enemy)) out.push({ rule: "client_mismatch", action: "flag", detail: "client enemy summary differs from the battle response" });
}

function validateBattle(o: BattleObservationInput, ctx: ValidationContext): Verdict {
  const out: Finding[] = [];
  const derived: Derived = { enemy: null, sortie: null, layout: o.layout ?? null, estimableShips: [] };
  const g = checkCommon(o, ctx, out);
  const { path, raw: packet, visitId } = o.raw;
  if (!/^api_req_(sortie|battle_midnight|combined_battle)\/[a-z_]+$/.test(path) || /battleresult|goback_port/.test(path)) {
    out.push({ rule: "raw_invalid", action: "reject", detail: `not a battle response path: ${path}` });
    return { findings: out, derived };
  }
  const f = list(packet.api_formation);
  if (!FORMATIONS.has(Number(f[0])) || !FORMATIONS.has(Number(f[1])) || !(Number(f[2]) >= 1 && Number(f[2]) <= 4)) {
    out.push({ rule: "formation", action: "reject", detail: `api_formation ${JSON.stringify(packet.api_formation)}` });
  }
  const enemy = extractEnemy(packet);
  derived.enemy = enemy;
  if (!enemy.ships.length) out.push({ rule: "raw_invalid", action: "reject", detail: "battle response without enemy ships" });
  if (g) {
    checkEnemy(enemy, ctx, g.isEvent, out);
    checkCells(o.map, [o.cell], o.layout ?? null, ctx, out);
  }
  if (o.fleet) checkFleetAgainstPacket(o.fleet, packet, out);
  checkHp(path, packet, visitId, ctx, out);
  crossCheckEnemy(o.enemy, enemy, out);
  if (o.fleet && !o.fleet.escort?.length && !enemy.escort.length && capturedKind(path)) {
    derived.estimableShips = [...new Set(enemy.ships.map((s) => s.masterId))].sort((a, b) => a - b);
  }
  return { findings: out, derived };
}

/** Sortie fleet features (shared/capture SortieFleetFeatures, re-derived; escortStypes null for single fleets). */
type ServerFeatures = {
  stypes: number[]; escortStypes: number[] | null; speed: number | null;
  los: { cn1: number; cn2: number; cn3: number; cn4: number } | null; hqLevel: number | null;
};

/** stypes / speed / LoS from the fleet snapshot and master data; hqLevel is the client's (1..120). */
function sortieFeatures(fleet: FleetInput | null | undefined, client: unknown, ctx: ValidationContext): ServerFeatures | null {
  if (!fleet) return null;
  const hq = client && typeof client === "object" ? Reflect.get(client, "hqLevel") : null;
  const hqLevel = Number.isInteger(hq) && Number(hq) >= 1 && Number(hq) <= 120 ? Number(hq) : null;
  const summary = summarizeFleet([...fleet.ships, ...(fleet.escort ?? [])], ctx.master.data, hqLevel ?? 120, !!fleet.escort?.length);
  const stypes = (ships: FleetInput["ships"]) => ships.map((s) => ctx.master.ships.get(s.masterId)?.stype ?? 0);
  return {
    stypes: stypes(fleet.ships),
    escortStypes: fleet.escort ? stypes(fleet.escort) : null,
    speed: summary.speed,
    los: summary.los && { ...summary.los },
    hqLevel,
  };
}

/** Fleet type of a sortie: combined flag, else a 7-ship single fleet = striking force (遊撃部隊, fleet 3). */
export const sortieFleetType = (combined: number | null | undefined, fleetSize: number, escortSize: number): NonNullable<SortieRecord["fleetType"]> =>
  escortSize > 0 ? ({ 1: "ctf", 2: "stf", 3: "tcf" } as const)[combined as 1 | 2 | 3] ?? "single" : fleetSize >= 7 ? "striking" : "single";

/**
 * Battle results are the client's own report (the battleresult packet is not uploaded with the sortie), so they
 * are plausibility-checked: a drop must be a real friend ship, at a cell that had a battle, and only B or better
 * drops ships. Escape positions and ship ids must fit the sortie fleet.
 */
function checkResults(cells: SortieRecord["cells"], fleet: FleetInput | null | undefined, ctx: ValidationContext, out: Finding[]) {
  const flat = fleet ? [...fleet.ships, ...(fleet.escort ?? [])].map((s) => s.masterId) : null;
  for (const c of cells) {
    const r = c.result;
    if (!r) continue;
    if (r.drop) {
      const ship = ctx.master.ships.get(r.drop.shipId);
      if (!ship || ship.is_abyssal) out.push({ rule: "drop_unknown", action: "quarantine", detail: `cell ${c.no}: dropped ship ${r.drop.shipId} is not a friend ship` });
      if (!c.battles.length) out.push({ rule: "drop_no_battle", action: "quarantine", detail: `cell ${c.no}: a drop without a battle at the cell` });
      if (r.rank && !["S", "A", "B"].includes(r.rank)) out.push({ rule: "drop_rank", action: "flag", detail: `cell ${c.no}: ship drop with rank ${r.rank}` });
    }
    const e = r.escape;
    if (e && flat) {
      const bad = [...e.idx, ...e.towIdx].some((i) => i > flat.length)
        || JSON.stringify(e.shipIds) !== JSON.stringify(e.idx.map((i) => flat[i - 1]))
        || JSON.stringify(e.towShipIds) !== JSON.stringify(e.towIdx.map((i) => flat[i - 1]));
      if (bad) out.push({ rule: "client_mismatch", action: "flag", detail: `cell ${c.no}: escape ships do not match the fleet snapshot` });
    }
  }
}

function validateSortie(o: SortieObservationInput, ctx: ValidationContext): Verdict {
  const out: Finding[] = [];
  const derived: Derived = { enemy: null, sortie: null, layout: o.layout ?? null, estimableShips: [] };
  const g = checkCommon(o, ctx, out);
  let cells: CapturedCell[] = o.sortie.cells.map((c) => ({
    no: c.no, from: c.from ?? null, colorNo: c.colorNo ?? null, eventId: c.eventId ?? null, eventKind: c.eventKind ?? null,
    bossCellNo: c.bossCellNo ?? null, next: c.next ?? null, selectCells: c.selectCells ?? null, battles: c.battles,
  }));
  let cellData = o.sortie.cellData ?? null;
  const packets = o.raw?.packets;
  if (!packets) {
    out.push({ rule: "sortie_no_raw", action: "flag", detail: "no raw map packets; client cells validated as sent" });
  } else {
    const fromRaw = packets.map((p) => extractMapCell(p.body));
    const area = Math.floor(o.map / 10);
    const mapNo = o.map % 10;
    if (packets[0]!.path !== "api_req_map/start" || packets.slice(1).some((p) => p.path !== "api_req_map/next") || fromRaw.some((c) => !c)) {
      out.push({ rule: "raw_invalid", action: "reject", detail: "packets must be api_req_map/start then api_req_map/next, each with api_no" });
    } else if (packets.some((p) => (p.body.api_maparea_id != null && p.body.api_maparea_id !== area) || (p.body.api_mapinfo_no != null && p.body.api_mapinfo_no !== mapNo))) {
      out.push({ rule: "raw_mismatch", action: "reject", detail: `packets are not for map ${area}-${mapNo}` });
    } else if (fromRaw.length !== cells.length) {
      out.push({ rule: "raw_mismatch", action: "reject", detail: `${fromRaw.length} packets for ${cells.length} cells` });
    } else {
      if (fromRaw.some((c, i) => c!.no !== cells[i]!.no)) out.push({ rule: "client_mismatch", action: "flag", detail: "client cells differ from the map packets" });
      cells = fromRaw.map((c, i) => ({ ...c!, battles: cells[i]!.battles }));
      cellData = extractCellData(packets[0]!.body);
      if (cellData) derived.layout = cellData.map((c) => c.no);
    }
  }
  if (g) {
    checkCells(o.map, cells.map((c) => c.no), derived.layout, ctx, out);
    checkEdges(o.map, cells, ctx, out);
  }
  const last = cells.at(-1);
  const endKind = last && (last.eventId === 5 || (last.bossCellNo !== null && last.no === last.bossCellNo)) ? "boss"
    : last?.next === 0 ? "end_node"
    : o.sortie.endKind === "boss" || o.sortie.endKind === "end_node" ? "retreat" : o.sortie.endKind;
  const features = sortieFeatures(o.fleet, o.sortie.features, ctx);
  const clientStypes = o.sortie.features && typeof o.sortie.features === "object" ? Reflect.get(o.sortie.features, "stypes") : undefined;
  if (features && clientStypes !== undefined && JSON.stringify(clientStypes) !== JSON.stringify(features.stypes)) {
    out.push({ rule: "client_mismatch", action: "flag", detail: "client fleet features differ from the fleet snapshot" });
  }
  const withResults: SortieRecord["cells"] = cells.map(({ result: _unused, ...c }, i) => {
    const result = o.sortie.cells[i]?.result;
    return result ? { ...c, result } : c;
  });
  checkResults(withResults, o.fleet, ctx, out);
  const fleetSize = o.fleet?.ships.length ?? o.sortie.fleetSize ?? null;
  const escortSize = o.fleet ? o.fleet.escort?.length ?? 0 : o.sortie.escortSize ?? 0;
  if (o.fleet && ((o.sortie.fleetSize != null && o.sortie.fleetSize !== fleetSize) || (o.sortie.escortSize != null && o.sortie.escortSize !== escortSize))) {
    out.push({ rule: "client_mismatch", action: "flag", detail: "client fleet sizes differ from the fleet snapshot" });
  }
  derived.sortie = {
    deckId: o.sortie.deckId, fleetSize, escortSize, gauge: o.sortie.gauge ?? null,
    fleetType: fleetSize === null ? null : sortieFleetType(o.sortie.combined, fleetSize, escortSize),
    combined: o.sortie.combined, endKind, endedAt: o.sortie.endedAt,
    cells: withResults, cellData: cellData ?? null, features,
  };
  return { findings: out, derived };
}

export const validateObservation = (o: ObservationInput, ctx: ValidationContext): Verdict =>
  o.kind === "battle" ? validateBattle(o, ctx) : validateSortie(o, ctx);

/** Ship, equipment and map ids an upload refers to (to load the master data once). */
export function referencedIds(obs: ObservationInput[]): { ships: Set<number>; equips: Set<number>; maps: Set<number> } {
  const ships = new Set<number>();
  const equips = new Set<number>();
  const maps = new Set<number>();
  for (const o of obs) {
    maps.add(o.map);
    for (const s of [...(o.fleet?.ships ?? []), ...(o.fleet?.escort ?? [])]) {
      ships.add(s.masterId);
      for (const e of [...s.equips, s.exSlot ?? null]) if (e) equips.add(e.masterId);
    }
    if (o.kind === "sortie") {
      for (const c of o.sortie.cells) if (c.result?.drop) ships.add(c.result.drop.shipId);
    }
    if (o.kind === "battle") {
      const e = extractEnemy(o.raw.raw);
      for (const s of [...e.ships, ...e.escort]) {
        ships.add(s.masterId);
        for (const id of s.slots ?? []) if (id > 0) equips.add(id);
      }
    }
  }
  return { ships, equips, maps };
}
