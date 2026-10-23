// Test harness: D1 double, env with fake bindings, the app with an injected clock, client tokens, master data
// and battle responses that pass server validation.
import { bunGrid } from "../scripts/lib/sim-core";
import type { ShipInput } from "../../sim-core/pkg/sim_core";
import { battlePacket } from "../../shared/estimate/synthetic";
import { createApp } from "../src/app";
import type { VerifyDeps } from "../src/auth/access";
import type { Env } from "../src/env";
import { createTestD1 } from "./d1-sqlite";

/** Workers Rate Limiting binding double: allows everything unless `block` is set; records keys. */
export class FakeLimiter implements RateLimit {
  keys: string[] = [];
  block = false;
  async limit(o: RateLimitOptions): Promise<RateLimitOutcome> {
    this.keys.push(o.key);
    return { success: !this.block };
  }
}

export interface Harness {
  db: D1Database;
  env: Env;
  limiter: FakeLimiter;
  clock: { t: number };
  call: <T = Record<string, unknown>>(method: string, path: string, o?: { body?: unknown; token?: string; headers?: Record<string, string>; host?: string; raw?: string }) =>
    Promise<{ status: number; json: T; headers: Headers }>;
  /** Registers a client (POST /api/v1/clients) from `ip`. */
  register: (ip?: string) => Promise<{ clientId: string; token: string }>;
  /** fetch() into the app (for client code that takes a fetch function). */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export const T0 = Date.UTC(2026, 9, 10, 3, 0, 0);

export function harness(o: { env?: Partial<Env>; access?: VerifyDeps; cache?: Cache } = {}): Harness {
  const db = createTestD1();
  const limiter = new FakeLimiter();
  const env: Env = {
    DB: db, KCNAV_BASE: "https://kcnav.invalid", KCNAV_MIN_INTERVAL_MS: "65000", ENVIRONMENT: "development", IP_HASH_SALT: "test-salt",
    WRITE_LIMITER: limiter,
    ...o.env,
  };
  const clock = { t: T0 };
  const app = createApp({ gridFn: bunGrid, now: () => clock.t, access: o.access, cache: o.cache });
  const call: Harness["call"] = async (method, path, opt = {}) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...opt.headers };
    if (opt.token) headers.Authorization = `Bearer ${opt.token}`;
    const res = await app.request(`http://${opt.host ?? "localhost"}${path}`, {
      method, headers, body: opt.raw ?? (opt.body === undefined ? undefined : JSON.stringify(opt.body)),
    }, env);
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as never, headers: res.headers };
  };
  const register = async (ip = "203.0.113.7") => {
    const r = await call<{ clientId: string; token: string }>("POST", "/api/v1/clients", { headers: { "CF-Connecting-IP": ip } });
    if (r.status !== 201) throw new Error(`register: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const fetchApp = async (url: string, init?: RequestInit) => app.request(url, init, env);
  return { db, env, limiter, clock, call, register, fetch: fetchApp };
}

// ---- uploads: staged by the request, processed by the jobs ----

export interface UploadOutcome {
  /** the request's answer (202 {queued, duplicates, pending} or an error) */
  status: number;
  response: Record<string, unknown>;
  /** what the jobs made of the upload (stored rows of its request time, findings recorded since the request) */
  accepted: number;
  duplicates: number;
  rejected: { clientObsId: string | null; rule: string; detail: string }[];
  flagged: number;
  quarantined: number;
}

/** Processes staged uploads (POST /admin/ingest/run: ingest + aggregation) until nothing is left; `budgetMs` per run. */
export async function drainJobs(h: Harness, budgetMs = 50) {
  for (let i = 0; i < 1000; i++) {
    const r = await h.call<{ busy: boolean; ingest?: { remaining: number }; aggregation?: { remaining: number; dirtyMaps: number } }>("POST", `/admin/ingest/run?budgetMs=${budgetMs}`);
    if (r.status !== 200 || r.json.busy) throw new Error(`ingest/run: ${r.status} ${JSON.stringify(r.json)}`);
    if (!r.json.ingest?.remaining && !r.json.aggregation?.remaining && !r.json.aggregation?.dirtyMaps) return;
  }
  throw new Error("staged uploads did not drain");
}

/** POST /api/v1/observations 61 s after the previous one, then the jobs until the upload is processed. */
export async function uploadAndProcess(h: Harness, token: string, observations: unknown[]): Promise<UploadOutcome> {
  h.clock.t += 61_000;
  const at = new Date(h.clock.t).toISOString();
  const mark = await h.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM observation_rejections").first<{ id: number }>();
  const r = await h.call<Record<string, unknown>>("POST", "/api/v1/observations", { token, body: { observations } });
  if (r.status === 202) await drainJobs(h);
  const findings = (await h.db.prepare("SELECT client_obs_id, rule, action, detail FROM observation_rejections WHERE id > ?1 ORDER BY id")
    .bind(mark?.id ?? 0).all<{ client_obs_id: string | null; rule: string; action: string; detail: string }>()).results;
  const stored = await h.db.prepare("SELECT COUNT(*) AS n, SUM(quarantine IS NOT NULL) AS q FROM observations WHERE uploaded_at = ?1")
    .bind(at).first<{ n: number; q: number | null }>();
  return {
    status: r.status, response: r.json, accepted: stored?.n ?? 0, duplicates: Number(r.json?.duplicates ?? 0),
    rejected: findings.filter((f) => f.action === "reject").map((f) => ({ clientObsId: f.client_obs_id, rule: f.rule, detail: f.detail })),
    flagged: findings.filter((f) => f.action === "flag").length, quarantined: stored?.q ?? 0,
  };
}

// ---- master data ----

export interface ShipSeed {
  id: number; stype?: number; abyssal?: boolean; hp?: number | null; fp?: number | null; tp?: number | null; aa?: number | null; ar?: number | null;
  luck?: number | null; slots?: number[]; speed?: number; range?: number; fuelMax?: number;
}
export interface EquipSeed {
  id: number; type?: number[]; fp?: number; tp?: number; aa?: number; ar?: number; acc?: number; ev?: number; asw?: number; los?: number;
  bomb?: number; luck?: number; range?: number;
}

export async function seedMaster(db: D1Database, o: { ships?: ShipSeed[]; equips?: EquipSeed[]; maps?: { id: number; event?: boolean }[] }) {
  const now = "2026-10-01T00:00:00Z";
  await db.batch([
    ...(o.ships ?? []).map((s) => db.prepare(
      `INSERT INTO ships (id, name, stype, speed, range, slot_num, is_abyssal, hp, fp, tp, aa, ar, luck, slots, fuel_max, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
    ).bind(s.id, `ship ${s.id}`, s.stype ?? 2, s.speed ?? 10, s.range ?? 1, s.slots?.length ?? 3, (s.abyssal ?? s.id > 1500) ? 1 : 0,
      s.hp ?? null, s.fp ?? null, s.tp ?? null, s.aa ?? null, s.ar ?? null, s.luck ?? null, JSON.stringify(s.slots ?? [0, 0, 0]), s.fuelMax ?? null, now)),
    ...(o.equips ?? []).map((e) => db.prepare(
      `INSERT INTO equipments (id, name, type, type_id, icon, fp, tp, aa, ar, bomb, asw, los, acc, ev, luck, range, is_abyssal, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
    ).bind(e.id, `equip ${e.id}`, JSON.stringify(e.type ?? [1, 1, 1, 1, 0]), (e.type ?? [1, 1, 1])[2] ?? 1, (e.type ?? [1, 1, 1, 1])[3] ?? 1,
      e.fp ?? 0, e.tp ?? 0, e.aa ?? 0, e.ar ?? 0, e.bomb ?? 0, e.asw ?? 0, e.los ?? 0, e.acc ?? 0, e.ev ?? 0, e.luck ?? 0, e.range ?? 0, e.id > 1500 ? 1 : 0, now)),
    ...(o.maps ?? []).map((m) => db.prepare("INSERT INTO maps (id, world, no, name, is_event, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(m.id, Math.floor(m.id / 10), m.id % 10, `map ${m.id}`, m.event ?? m.id >= 100 ? 1 : 0, now)),
  ]);
}

/** Master rows that reproduce synthetic ShipInputs (friend: naked stats live in the snapshot; enemy: visible stats). */
export async function seedSynthetic(db: D1Database, friend: ShipInput[], enemy: ShipInput[]) {
  const equips = new Map<number, EquipSeed>();
  for (const s of [...friend, ...enemy]) {
    for (const e of [...s.slots, s.exSlot ?? null]) {
      if (!e) continue;
      const st = e.stats ?? {};
      equips.set(e.id, {
        id: e.id, type: e.types, fp: st.firepower, tp: st.torpedo, aa: st.antiAir, ar: st.armor, acc: st.accuracy, ev: st.evasion,
        asw: st.asw, los: st.los, bomb: st.bombing, luck: st.luck, range: st.range,
      });
    }
  }
  const ships = new Map<number, ShipSeed>();
  for (const s of friend) ships.set(s.id!, { id: s.id!, stype: s.shipType, range: s.range, fuelMax: s.fuelMax ?? 100, slots: s.slots.map((e) => e?.planes ?? 0) });
  for (const s of enemy) {
    ships.set(s.id!, {
      id: s.id!, stype: s.shipType, hp: s.maxHp, fp: s.stats.firepower, tp: s.stats.torpedo, aa: s.stats.antiAir, ar: s.stats.armor,
      speed: s.speed, range: s.range, slots: s.slots.map((e) => e?.planes ?? 0),
    });
  }
  await seedMaster(db, { ships: [...ships.values()], equips: [...equips.values()] });
}

// ---- 1-5 graph (KC3 / KCNav edges: edge_id = destination cell number) ----

export const EDGES_15: [number, string, string][] = [
  [1, "Start", "A"], [2, "C", "B"], [3, "E", "C"], [4, "A", "D"], [5, "D", "E"], [6, "D", "F"],
  [7, "F", "G"], [8, "G", "H"], [9, "F", "I"], [10, "C", "J"], [11, "E", "J"], [12, "G", "J"],
];
export const LAYOUT_15 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export async function seedEdges15(db: D1Database) {
  await db.batch([
    db.prepare("INSERT INTO sources (key, name, fetched_at) VALUES ('kc3-edges', 'KC3', '2026-10-01T00:00:00Z') ON CONFLICT (key) DO NOTHING"),
    ...EDGES_15.map(([id, from, to]) => db.prepare(
      "INSERT INTO edges (map_id, edge_id, from_letter, to_letter, source_id) VALUES (15, ?1, ?2, ?3, (SELECT id FROM sources WHERE key = 'kc3-edges'))",
    ).bind(id, from, to)),
  ]);
}

// ---- simple valid battles (no attacks) for validation / aggregation tests ----

/** Abyssal ships with fixed visible stats; the battle responses below use exactly these. */
export const ENEMIES: Record<number, { hp: number; params: [number, number, number, number]; slots: number[] }> = {
  1501: { hp: 20, params: [5, 15, 6, 5], slots: [1505] },
  1502: { hp: 24, params: [8, 18, 7, 7], slots: [1505] },
  1503: { hp: 28, params: [10, 20, 8, 9], slots: [1506] },
  1530: { hp: 90, params: [50, 0, 40, 60], slots: [1506] },
  1575: { hp: 33, params: [12, 30, 0, 20], slots: [1505] },
};
export const FRIENDS = [{ id: 10, hp: 30 }, { id: 11, hp: 31 }, { id: 12, hp: 32 }];

export async function seedBasic(db: D1Database) {
  await seedMaster(db, {
    ships: [
      ...Object.entries(ENEMIES).map(([id, e]) => ({ id: Number(id), hp: e.hp, fp: e.params[0], tp: e.params[1], aa: e.params[2], ar: e.params[3] })),
      ...FRIENDS.map((f) => ({ id: f.id, hp: f.hp, fp: 10, tp: 20, aa: 10, ar: 10, luck: 10 })),
    ],
    equips: [{ id: 1505 }, { id: 1506, type: [1, 2, 2, 2, 0] }, { id: 2 }, { id: 3, type: [1, 2, 2, 2, 0] }],
    maps: [{ id: 15 }, { id: 601, event: true }],
  });
  await seedEdges15(db);
}

export const fleet = (n = 3) => ({
  deckId: 1,
  ships: FRIENDS.slice(0, n).map((f) => ({
    masterId: f.id, level: 50, luckMod: 0, hpMod: 0, aswMod: 0, morale: 49, equips: [{ masterId: 2, improvement: 0, proficiency: 0 }, null],
    observed: { maxHp: f.hp, nowHp: f.hp, firepower: 12, torpedo: 20, antiAir: 10, armor: 10, evasion: 40, asw: 20, los: 10, luck: 10, range: 1, speed: 10 },
  })),
  supply: FRIENDS.slice(0, n).map(() => ({ fuel: 15, fuelMax: 15, ammo: 20, ammoMax: 20 })),
});

/** A battle response for `ids` (fixed stats from ENEMIES) against FRIENDS, with no attacks unless given. */
export function battleResponse(ids: number[], formation = 1, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const enemy = ids.map((id): ShipInput => {
    const e = ENEMIES[id]!;
    return {
      id, shipType: 2, level: 1, maxHp: e.hp, stats: { firepower: e.params[0], torpedo: e.params[1], antiAir: e.params[2], armor: e.params[3] },
      slots: e.slots.map((s) => ({ id: s, types: [1, 1, 1, 1, 0] })),
    };
  });
  const friend = FRIENDS.map((f): ShipInput => ({ id: f.id, shipType: 2, level: 50, maxHp: f.hp, stats: { firepower: 0, torpedo: 0, antiAir: 0, armor: 0 }, slots: [] }));
  return {
    ...battlePacket({
      path: "api_req_sortie/battle", formation: [1, formation, 1], friend, enemy,
      startHp: [friend.map((s) => s.maxHp), enemy.map((s) => s.maxHp)], events: [],
    }),
    ...extra,
  };
}
