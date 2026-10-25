// Screen-level read API (private notes API "Views"): one request per screen of the web UI, each body the union of the
// per-resource responses it replaces (built by the same helpers in ./read.ts). Cached like every GET (src/cache.ts).
import { Hono } from "hono";
import type { Env } from "../env";
import { dataVersion } from "../cache";
import { mapName, parseMapKey } from "../maps";
import {
  JSON_HEADERS, compOpts, compsByNode, equipmentListJson, estimatesJson, eventBonuses, fitBonusList, mapDetail, mapList, shipDetails, shipListJson,
} from "./read";

export const views = new Hono<{ Bindings: Env }>();

// Shared by every screen, downloaded once per session: GET /maps, /equipments?abyssal=1, /fit-bonuses.
views.get("/views/boot", async (c) => {
  const db = c.env.DB;
  const [version, maps, equipments, fit] = await Promise.all([dataVersion(db), mapList(db), equipmentListJson(db, 1), fitBonusList(db)]);
  return c.body(`{"dataVersion":${version},"maps":${JSON.stringify(maps)},"equipments":${equipments},"fitBonuses":${JSON.stringify(fit)}}`, 200, JSON_HEADERS);
});

// One map (出撃 and 海域): GET /maps/{map}, every node's enemy comps, GET /ships/{id} of every ship in them, and the event bonuses.
views.get("/views/map/:map", async (c) => {
  const key = parseMapKey(c.req.param("map"));
  if (!key) return c.json({ error: "bad map key" }, 400);
  const o = compOpts((name) => c.req.query(name));
  if (typeof o === "string") return c.json({ error: o }, 400);
  const db = c.env.DB;
  const [detail, nodes, bonuses] = await Promise.all([mapDetail(db, key.id), compsByNode(db, key.id, null, o), eventBonuses(db, key.id)]);
  if (!detail) return c.json({ error: "map not found" }, 404);
  const ids = new Set<number>();
  for (const { sets } of Object.values(nodes)) for (const s of sets) for (const comp of s.comps) for (const m of [...comp.main, ...comp.escort]) ids.add(m.shipId as number);
  const ships = await shipDetails(db, [...ids]);
  return c.json({ detail, enemyComps: { map: mapName(key.id), minObserved: o.minObserved, source: o.prefer, nodes }, ships, bonuses });
});

/** The 敵艦 detail of one ship: GET /ships/{id} and its estimator posteriors with densities. Null for an unknown ship. */
async function enemyShipJson(db: D1Database, id: number) {
  const [[detail], estimates] = await Promise.all([shipDetails(db, [id]), estimatesJson(db, { ids: [id], density: true })]);
  return detail ? `{"detail":${JSON.stringify(detail)},"estimates":${estimates}}` : null;
}

// The 敵艦 list: GET /ships?abyssal=1, /estimates?density=0, and the detail of the list's first ship (shown before any selection).
views.get("/views/enemy", async (c) => {
  const db = c.env.DB;
  const [ships, estimates, first] = await Promise.all([
    shipListJson(db, 1),
    estimatesJson(db, { ids: null, density: false }),
    db.prepare("SELECT MIN(id) AS id FROM ships WHERE is_abyssal = 1").first<{ id: number | null }>(),
  ]);
  const firstShip = first?.id == null ? null : await enemyShipJson(db, first.id);
  return c.body(`{"ships":${ships},"estimates":${estimates},"firstShip":${firstShip}}`, 200, JSON_HEADERS);
});

views.get("/views/enemy/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad ship id" }, 400);
  const body = await enemyShipJson(c.env.DB, id);
  return body ? c.body(body, 200, JSON_HEADERS) : c.json({ error: "ship not found" }, 404);
});
