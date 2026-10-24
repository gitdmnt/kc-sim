// Quest prerequisite trees, player status inference and requirement aggregation for the web's 任務 tab.
// Pure functions over GET /api/v1/quests (./types.ts) and the poi state the plugin forwards (../embed/protocol.ts).
import type { PoiQuestEntry, PoiQuests } from "../embed/protocol";
import type { QuestEntry, QuestItemReq, QuestRequirement } from "./types";

export interface QuestGraph {
  byId: Map<number, QuestEntry>;
  /** prerequisite id -> the quests it is a prerequisite of, ascending */
  unlocks: Map<number, number[]>;
}

export const buildQuestGraph = (quests: readonly QuestEntry[]): QuestGraph => {
  const byId = new Map(quests.map((q) => [q.id, q]));
  const unlocks = new Map<number, number[]>();
  for (const q of quests) {
    for (const p of q.pre) {
      const list = unlocks.get(p.id);
      if (list) list.push(q.id);
      else unlocks.set(p.id, [q.id]);
    }
  }
  for (const list of unlocks.values()) list.sort((a, b) => a - b);
  return { byId, unlocks };
};

export interface PrerequisiteTree {
  /** Every quest needed to unlock the target, then the target: each after all its prerequisites (by depth, then id) */
  order: number[];
  /** Longest prerequisite chain below each quest of `order` (0 = none) */
  depth: Map<number, number>;
  /** Prerequisite ids the data does not know (kept in `order` as unknown quests) */
  missing: number[];
  /** Edges [prerequisite, quest] dropped because they close a cycle */
  cycleEdges: [number, number][];
}

/** All ancestors of `target` over prerequisite edges. Cycles are cut at the edge that closes them; unknown ids are kept. */
export const resolvePrerequisites = (graph: QuestGraph, target: number): PrerequisiteTree => {
  const depth = new Map<number, number>();
  const missing: number[] = [];
  const cycleEdges: [number, number][] = [];
  const visiting = new Set<number>();
  const visit = (id: number) => {
    visiting.add(id);
    const q = graph.byId.get(id);
    if (!q) missing.push(id);
    let d = 0;
    for (const p of [...(q?.pre ?? [])].sort((a, b) => a.id - b.id)) {
      if (visiting.has(p.id)) {
        cycleEdges.push([p.id, id]);
        continue;
      }
      if (!depth.has(p.id)) visit(p.id);
      d = Math.max(d, depth.get(p.id)! + 1);
    }
    visiting.delete(id);
    depth.set(id, d);
  };
  visit(target);
  // depth(prerequisite) < depth(quest) on every kept edge, so this order is topological
  const order = [...depth.keys()].sort((a, b) => depth.get(a)! - depth.get(b)! || a - b);
  return { order, depth, missing: missing.sort((a, b) => a - b), cycleEdges };
};

/** Every quest reachable from `id` over unlock edges (excluding `id`), ascending. */
export const descendants = (graph: QuestGraph, id: number): number[] => {
  const seen = new Set<number>([id]);
  const queue = [id];
  while (queue.length > 0) {
    for (const next of graph.unlocks.get(queue.shift()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  seen.delete(id);
  return [...seen].sort((a, b) => a - b);
};

// ---- Player status ----

/**
 * done: achieved, reward not taken (api_state 3) / active: in progress (2) / available: unlocked (1) /
 * cleared: inferred, a prerequisite of a quest the game lists / locked: inferred, comes after a listed one-time quest /
 * unknown: nothing says (not listed: cleared earlier, or not unlocked yet).
 */
export type QuestStatus = "done" | "active" | "available" | "cleared" | "locked" | "unknown";

/** The game's api_type of one-time quests (1 daily, 2 weekly, 3 monthly, 4 one-time, 5 other periodic) */
const ONE_TIME = 4;

/** The game's own quests merged: the full list (when the plugin saw one), overridden by poi's active quests. */
export const visibleQuests = (quests: PoiQuests | null | undefined): Map<number, PoiQuestEntry> => {
  const out = new Map<number, PoiQuestEntry>();
  for (const e of quests?.list ?? []) out.set(e.id, e);
  for (const e of quests?.active ?? []) out.set(e.id, e);
  return out;
};

/**
 * Status of every quest something is known about (others are "unknown"). A quest the game lists is unlocked, so all its
 * ancestors were cleared (periodic ones: at least once); a listed one-time quest is not cleared yet, so everything after
 * it is still locked. "cleared" wins where the data's edges would say both.
 */
export const questStatuses = (graph: QuestGraph, quests: PoiQuests | null | undefined): Map<number, QuestStatus> => {
  const visible = visibleQuests(quests);
  const out = new Map<number, QuestStatus>();
  const walk = (starts: number[], next: (id: number) => number[], status: QuestStatus) => {
    const queue = [...starts];
    const seen = new Set(starts);
    while (queue.length > 0) {
      for (const n of next(queue.shift()!)) {
        if (seen.has(n)) continue;
        seen.add(n);
        queue.push(n);
        if (!visible.has(n) && !out.has(n)) out.set(n, status);
      }
    }
  };
  walk([...visible.keys()], (id) => graph.byId.get(id)?.pre.map((p) => p.id) ?? [], "cleared");
  walk([...visible.values()].filter((e) => e.type === ONE_TIME).map((e) => e.id), (id) => graph.unlocks.get(id) ?? [], "locked");
  for (const [id, e] of visible) out.set(id, e.state === 3 ? "done" : e.state === 2 ? "active" : "available");
  return out;
};

// ---- Requirements ----

export type ShipNeedKind = "ship" | "class";

/** Ships one quest needs: any `amount` of the named ships / ship-type words (kind ship) or classes (kind class). */
export interface ShipNeed {
  kind: ShipNeedKind;
  names: string[];
  amount: number;
  /** Used up (modernization material) rather than just present */
  consumed: boolean;
}

/** Equipment one quest needs to own (prepared, equipped for conversion or scrapped: all leave or are tied up). */
export interface EquipNeed {
  name: string;
  amount: number;
}

export interface QuestNeeds {
  ships: ShipNeed[];
  equips: EquipNeed[];
}

/** kcwiki-quest-data ship-type words -> api_stype. 高速艦 is speed-based and not resolved. */
export const SHIP_TYPE_WORDS: Record<string, number[]> = {
  駆逐: [2], 軽巡: [3], 重巡: [5], 航巡: [6], 水母: [16], 空母: [11, 18], 軽母: [7], 装母: [18], 戦艦: [8, 9], 低速戦艦: [9],
  航戦: [10], 潜水艦: [13, 14], 潜水空母: [14], 潜水母艦: [20], 海防艦: [1],
};
/** Words that do not narrow anything down ("any ship", "other ships") */
const ANY_SHIP = ["艦", "他の艦"];

const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const amountOf = (v: number | number[] | undefined): number => {
  const n = list(v).filter((x) => typeof x === "number" && x > 0);
  return n.length > 0 ? Math.min(...n) : 1;
};

/** Ships and equipment named in one quest's requirements (and / then / or lists flattened). */
export const questNeeds = (req: QuestRequirement | null): QuestNeeds => {
  const ships: ShipNeed[] = [];
  const equips: EquipNeed[] = [];
  const items = (v: unknown) => {
    for (const i of Array.isArray(v) ? (v as QuestItemReq[]) : []) {
      if (typeof i?.name === "string" && (i.category === undefined || i.category === "装備")) equips.push({ name: i.name, amount: i.amount ?? 1 });
    }
  };
  const ship = (kind: ShipNeedKind, names: string[], amount: number, consumed = false) => {
    const useful = names.filter((n) => typeof n === "string" && !ANY_SHIP.includes(n));
    if (useful.length > 0) ships.push({ kind, names: useful, amount, consumed });
  };
  const walk = (r: QuestRequirement) => {
    switch (r.category) {
      case "and":
      case "then":
      case "or":
        for (const sub of r.list ?? []) walk(sub);
        return;
      case "scrapequipment":
        items(r.list);
        return;
      case "equipexchange":
        items(r.equipments);
        items(r.scraps);
        items(r.consumptions);
        return;
      case "modelconversion":
        for (const name of list(r.equipment)) equips.push({ name, amount: 1 });
        for (const s of r.slots ?? []) equips.push({ name: s.equipment, amount: s.count ?? 1 });
        items(r.scraps);
        items(r.consumptions);
        ship("ship", list(r.secretary), 1);
        return;
      case "modernization": {
        if (typeof r.ship === "string") ship("ship", [r.ship], 1);
        for (const c of Array.isArray(r.consumptions) ? (r.consumptions as { ship?: string[]; amount?: number }[]) : []) {
          ship("ship", list(c.ship), (c.amount ?? 1) * (r.times ?? 1), true);
        }
        return;
      }
    }
    for (const g of r.groups ?? []) {
      const amount = g.select ?? amountOf(g.amount);
      ship("ship", list(g.ship), amount);
      ship("class", list(g.shipclass), amount);
    }
  };
  if (req) walk(req);
  return { ships, equips };
};

// ---- Ownership ----

interface MasterShip {
  api_id?: number;
  api_name?: string;
  api_stype?: number;
  api_ctype?: number;
  api_aftershipid?: string | number;
}

/** What the player owns, from poi's state (instances by master id) and the master data to resolve names. */
export interface Roster {
  /** Master id of every owned ship */
  ships: number[];
  /** Master id of every owned equipment */
  equips: number[];
  masterShips: Record<string, MasterShip | null | undefined>;
  masterEquips: Record<string, { api_id?: number; api_name?: string } | null | undefined>;
}

const values = (v: unknown): unknown[] => (v && typeof v === "object" ? Object.values(v) : []);
const num = (v: unknown, key: string): number | undefined => {
  const x = v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
  return typeof x === "number" ? x : undefined;
};

/** poi's state (`info.ships`, `info.equips`, `const.$ships`, `const.$equips`) as a Roster; null without master data. */
export const rosterFromPoi = (state: unknown): Roster | null => {
  const s = state as { info?: { ships?: unknown; equips?: unknown }; const?: { $ships?: unknown; $equips?: unknown } } | null | undefined;
  const masterShips = s?.const?.$ships;
  const masterEquips = s?.const?.$equips;
  if (!masterShips || typeof masterShips !== "object" || !masterEquips || typeof masterEquips !== "object") return null;
  return {
    ships: values(s?.info?.ships).flatMap((x) => num(x, "api_ship_id") ?? []),
    equips: values(s?.info?.equips).flatMap((x) => num(x, "api_slotitem_id") ?? []),
    masterShips: masterShips as Roster["masterShips"],
    masterEquips: masterEquips as Roster["masterEquips"],
  };
};

/** Width / case / spacing-insensitive name key (kcwiki and the game write ＋/+, ｍ/m, spaces differently). */
export const nameKey = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/** Player ships have api_id ≤ 1500, player equipment ≤ 1500 (abyssal ones above). */
const PLAYER_MAX_ID = 1500;

/** Resolves requirement names against the master data and counts owned instances. */
export class OwnershipIndex {
  private shipsByName = new Map<string, number[]>();
  private equipsByName = new Map<string, number[]>();
  private shipCount = new Map<number, number>();
  private equipCount = new Map<number, number>();
  private ships: MasterShip[];

  constructor(private roster: Roster) {
    this.ships = values(roster.masterShips).filter(
      (s): s is MasterShip => !!s && typeof (s as MasterShip).api_id === "number" && (s as MasterShip).api_id! <= PLAYER_MAX_ID,
    );
    for (const s of this.ships) if (s.api_name) push(this.shipsByName, nameKey(s.api_name), s.api_id!);
    for (const e of values(roster.masterEquips)) {
      const id = num(e, "api_id");
      const name = (e as { api_name?: unknown } | null)?.api_name;
      if (id !== undefined && id <= PLAYER_MAX_ID && typeof name === "string") push(this.equipsByName, nameKey(name), id);
    }
    for (const id of roster.ships) this.shipCount.set(id, (this.shipCount.get(id) ?? 0) + 1);
    for (const id of roster.equips) this.equipCount.set(id, (this.equipCount.get(id) ?? 0) + 1);
  }

  /** The named form and every later remodel (api_aftershipid chain; remodel loops stop at a repeat). */
  private withRemodels(ids: number[]): number[] {
    const out = new Set<number>();
    for (let id of ids) {
      while (id > 0 && !out.has(id)) {
        out.add(id);
        id = Number(this.roster.masterShips[id]?.api_aftershipid ?? 0);
      }
    }
    return [...out];
  }

  /** Master ids matching one ship name or ship-type word (kind ship) or class name (kind class); null if unknown. */
  resolveShip(kind: ShipNeedKind, name: string): number[] | null {
    if (kind === "ship") {
      const stypes = SHIP_TYPE_WORDS[name];
      if (stypes) return this.ships.filter((s) => stypes.includes(s.api_stype ?? -1)).map((s) => s.api_id!);
      const ids = this.shipsByName.get(nameKey(name));
      return ids ? this.withRemodels(ids) : null;
    }
    // "金剛型" -> the class of the ship named 金剛
    const ctypes = new Set((this.shipsByName.get(nameKey(name.replace(/型$/, ""))) ?? []).map((id) => this.roster.masterShips[id]?.api_ctype));
    const ids = this.ships.filter((s) => s.api_ctype !== undefined && ctypes.has(s.api_ctype)).map((s) => s.api_id!);
    return ids.length > 0 ? ids : null;
  }

  resolveEquip(name: string): number[] | null {
    return this.equipsByName.get(nameKey(name)) ?? null;
  }

  ownedShips(ids: Iterable<number>): number {
    let n = 0;
    for (const id of ids) n += this.shipCount.get(id) ?? 0;
    return n;
  }

  ownedEquips(ids: Iterable<number>): number {
    let n = 0;
    for (const id of ids) n += this.equipCount.get(id) ?? 0;
    return n;
  }
}

const push = (m: Map<string, number[]>, k: string, v: number) => {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
};

/** One aggregated requirement row. owned / ok are null without poi data or when a name does not resolve. */
interface NeedRowBase {
  key: string;
  amount: number;
  /** Quests (in tree order) that ask for it */
  quests: number[];
  owned: number | null;
  ok: boolean | null;
  /** Names the master data does not know */
  unresolved: string[];
}
export interface ShipNeedRow extends NeedRowBase {
  kind: ShipNeedKind;
  names: string[];
  consumed: boolean;
}
export interface EquipNeedRow extends NeedRowBase {
  name: string;
}

/**
 * Requirements of `ids` merged: a ship need keeps the largest amount any quest asks (ships stay; modernization
 * material is summed), equipment is summed (exchanged, converted or scrapped equipment is used up).
 */
export const aggregateNeeds = (
  graph: QuestGraph,
  ids: readonly number[],
  owned: OwnershipIndex | null,
): { ships: ShipNeedRow[]; equips: EquipNeedRow[] } => {
  const ships = new Map<string, ShipNeedRow>();
  const equips = new Map<string, EquipNeedRow>();
  for (const id of ids) {
    const needs = questNeeds(graph.byId.get(id)?.requirements ?? null);
    for (const n of needs.ships) {
      const names = [...n.names].sort();
      const key = `${n.kind}:${n.consumed ? "c" : ""}:${names.map(nameKey).join("/")}`;
      const row = ships.get(key);
      if (row) {
        row.amount = n.consumed ? row.amount + n.amount : Math.max(row.amount, n.amount);
        if (!row.quests.includes(id)) row.quests.push(id);
      } else {
        ships.set(key, { key, kind: n.kind, names, consumed: n.consumed, amount: n.amount, quests: [id], owned: null, ok: null, unresolved: [] });
      }
    }
    for (const n of needs.equips) {
      const key = nameKey(n.name);
      const row = equips.get(key);
      if (row) {
        row.amount += n.amount;
        if (!row.quests.includes(id)) row.quests.push(id);
      } else {
        equips.set(key, { key, name: n.name, amount: n.amount, quests: [id], owned: null, ok: null, unresolved: [] });
      }
    }
  }
  if (owned) {
    for (const row of ships.values()) {
      const ids = new Set<number>();
      for (const name of row.names) {
        const r = owned.resolveShip(row.kind, name);
        if (r) r.forEach((x) => ids.add(x));
        else row.unresolved.push(name);
      }
      if (row.unresolved.length < row.names.length) {
        row.owned = owned.ownedShips(ids);
        row.ok = row.owned >= row.amount;
      }
    }
    for (const row of equips.values()) {
      const r = owned.resolveEquip(row.name);
      if (!r) {
        row.unresolved.push(row.name);
        continue;
      }
      row.owned = owned.ownedEquips(r);
      row.ok = row.owned >= row.amount;
    }
  }
  return { ships: [...ships.values()], equips: [...equips.values()] };
};

// ---- Text ----

/** One-time / periodic / limited from the wiki code (Bd1 daily, Bw1 weekly, Bm1 monthly, Bq1 quarterly, By1 yearly, 2610B3 limited). */
export const questKind = (code: string | null): string => {
  if (!code) return "";
  if (/^\d{4}/.test(code)) return "期間限定";
  const m = /^[A-Z]([dwmqy])\d/.exec(code);
  return m ? { d: "デイリー", w: "ウィークリー", m: "マンスリー", q: "クォータリー", y: "イヤリー" }[m[1] as "d"] : "単発";
};

const SIMPLE: Record<string, string> = {
  equipment: "装備開発", ship: "艦娘建造", scrapequipment: "装備廃棄", scrapship: "艦娘解体", modernization: "近代化改修",
  improvement: "装備改修", resupply: "補給", repair: "入渠", battle: "出撃",
};
const RESOURCE = ["燃料", "弾薬", "鋼材", "ボーキ"];

const itemsText = (v: unknown): string =>
  (Array.isArray(v) ? (v as QuestItemReq[]) : []).map((i) => `${i.name}${i.amount ? `×${i.amount}` : ""}`).join("、");

const groupsText = (r: QuestRequirement): string =>
  (r.groups ?? [])
    .map((g) => {
      const names = [...list(g.ship), ...list(g.shipclass)].join("/");
      const amount = g.select ?? (g.amount === undefined ? undefined : amountOf(g.amount));
      return `${g.flagship ? "旗艦:" : ""}${names}${amount && amount > 1 ? `×${amount}` : ""}${g.lv?.[0] ? ` Lv${g.lv[0]}+` : ""}${g.note ? ` (${g.note})` : ""}`;
    })
    .join("、");

/** The structured clear conditions as short Japanese lines (nested lists indented with "・"). */
export const describeRequirement = (req: QuestRequirement | null): string[] => {
  if (!req) return [];
  const out: string[] = [];
  const add = (line: string, depth: number) => line && out.push(`${"  ".repeat(depth)}${line}`);
  const walk = (r: QuestRequirement, depth: number) => {
    const fleet = groupsText(r);
    const extra = [r.fleetid ? `第${r.fleetid}艦隊` : "", r.disallowed ? `${r.disallowed}不可` : ""].filter(Boolean).join(" ");
    switch (r.category) {
      case "and":
      case "then":
      case "or":
        add(r.category === "or" ? "いずれか:" : r.category === "then" ? "順に:" : "すべて:", depth);
        for (const sub of r.list ?? []) walk(sub, depth + 1);
        return;
      case "sortie":
        add(`出撃 ${list(r.map).join("/") || "任意"}${r.boss ? " ボス" : ""}${r.result ? ` ${r.result === "クリア" ? "クリア" : `${r.result}勝利以上`}` : ""} ×${r.times ?? 1}${extra ? ` ${extra}` : ""}`, depth);
        break;
      case "excercise":
        add(`演習${r.victory ? "勝利" : ""} ×${r.times ?? 1}${r.daily ? " (同日中)" : ""}`, depth);
        break;
      case "expedition":
        for (const o of r.objects ?? []) add(`遠征 ${list(o.id).join("/") || "任意"} 成功 ×${o.times}`, depth);
        break;
      case "fleet":
        add(`編成${extra ? ` ${extra}` : ""}`, depth);
        break;
      case "simple":
        add(`${SIMPLE[r.subcategory ?? ""] ?? r.subcategory ?? ""} ×${r.times ?? 1}`, depth);
        break;
      case "sink":
        add(`${r.ship ?? "敵"}撃沈 ×${r.amount ?? 1}`, depth);
        break;
      case "modernization":
        add(`近代化改修 ${r.ship ?? ""} ×${r.times ?? 1}`, depth);
        break;
      case "modelconversion":
        add(`機種転換 ${[...list(r.equipment), ...(r.slots ?? []).map((s) => s.equipment)].join("/")}${r.secretary ? ` (秘書艦 ${list(r.secretary).join("/")})` : ""}`, depth);
        break;
      case "equipexchange":
        if (r.equipments) add(`準備: ${itemsText(r.equipments)}`, depth);
        break;
      case "scrapequipment":
        add(`廃棄: ${itemsText(r.list)}`, depth);
        break;
      case "a-gou":
        add("あ号作戦 (出撃36・S勝利6・ボス到達24・ボス勝利12)", depth);
        break;
      default:
        add(r.category, depth);
    }
    if (fleet) add(`  ${fleet}`, depth);
    if (r.scraps) add(`  廃棄: ${itemsText(r.scraps)}`, depth);
    if (Array.isArray(r.consumptions) && r.category !== "modernization") add(`  消費: ${itemsText(r.consumptions)}`, depth);
    if (r.resources?.some((x) => x > 0)) add(`  資源: ${r.resources.map((x, i) => (x > 0 ? `${RESOURCE[i]}${x}` : "")).filter(Boolean).join(" ")}`, depth);
  };
  walk(req, 0);
  return out;
};
