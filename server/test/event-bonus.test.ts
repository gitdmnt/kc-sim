// Event bonus files -> flat rows -> GET /maps/{map}/bonuses (fixture: kancolle-replay Summer 2023 E5, MIT).
import { beforeEach, expect, test } from "bun:test";
import doc from "./fixtures/replay-bonus-57-5.json";
import manualFile from "../data/event-bonuses.json";
import { eventBonusDoc, flattenEventBonus, mergeEventBonuses, type FlatEventBonus } from "../src/eventBonus";
import { harness, type Harness } from "./helpers";

const source = eventBonusDoc.parse(doc);
let h: Harness;
beforeEach(() => {
  h = harness();
});

const insert = async (f: FlatEventBonus, sourceKey: string) => {
  await h.db.prepare("INSERT OR IGNORE INTO sources (key, name, url, licence, revision, fetched_at) VALUES (?1, 'x', 'u', 'MIT', 'abc123', '2026-10-23T00:00:00Z')")
    .bind(sourceKey).run();
  await h.db.prepare(
    `INSERT INTO event_bonuses (map_id, date, note, bonuses, lbas_bonuses, debuffs, source_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT id FROM sources WHERE key = ?7))`,
  ).bind(f.mapId, f.date, f.note, JSON.stringify(f.bonuses), JSON.stringify(f.lbasBonuses), JSON.stringify(f.debuffs), sourceKey).run();
};

test("flatten folds node filters into every bonus and keeps the source keys", () => {
  const f = flattenEventBonus(source);
  expect(f.mapId).toBe(575);
  expect(f.date).toBe("2023-10-05");
  expect(f.bonuses.length).toBe(source.listBonus!.flatMap((i) => i.bonuses).length);
  expect(f.lbasBonuses.length).toBe(5);
  expect(f.debuffs.length).toBe(3);
  const first = source.listBonus![0]!;
  expect(f.bonuses[0]).toEqual({ nodes: null, nodesExclude: null, ...first.bonuses[0] });
  // Node filters are folded in: the T-only entry carries nodes ["T"].
  expect(f.bonuses.find((b) => b.dmg === 1.05 && Array.isArray(b.shipClass) && (b.nodes as string[] | null)?.[0] === "T")).toBeDefined();
  expect(f.bonuses.some((b) => b.requireEquipType !== undefined && b.perEquip === 1)).toBe(true);
  expect(f.lbasBonuses.every((b) => b.basewide === 1)).toBe(true);
  expect(f.debuffs[0]).toEqual({ nodes: ["Y"], nodesExclude: null, shipId: [2182, 2183, 2184, 2185, 2186, 2187], amount: 44 });
  expect(flattenEventBonus({ world: 5, mapnum: 6, listBonus: [{ bonuses: [{ dmg: 1.1, shipType: [2] }] }] })).toEqual({
    mapId: 56, date: null, note: null, lbasBonuses: [], debuffs: [],
    bonuses: [{ nodes: null, nodesExclude: null, dmg: 1.1, shipType: [2] }],
  });
});

test("the manual file parses; malformed docs are rejected", () => {
  expect(eventBonusDoc.array().safeParse(manualFile).success).toBe(true);
  expect(eventBonusDoc.safeParse({ world: 62, mapnum: 1, listBonus: [{ nodes: "A", bonuses: [] }] }).success).toBe(false);
  expect(eventBonusDoc.safeParse({ mapnum: 1 }).success).toBe(false);
});

test("a manual file replaces the replay file of the same map", () => {
  const replay = [flattenEventBonus(source), flattenEventBonus({ world: 5, mapnum: 6, listBonus: [{ bonuses: [{ dmg: 1.1 }] }] })];
  const manual = [flattenEventBonus({ world: 57, mapnum: 5, note: "manual", listBonus: [{ bonuses: [{ dmg: 1.3, shipType: [2] }] }] })];
  const merged = mergeEventBonuses(replay, manual);
  expect(merged.map((m) => [m.mapId, m.manual])).toEqual([[56, false], [575, true]]);
  expect(merged[1]!.bonuses).toEqual([{ nodes: null, nodesExclude: null, dmg: 1.3, shipType: [2] }]);
});

test("GET /maps/{map}/bonuses serves the stored rows; unknown maps are 404", async () => {
  const f = flattenEventBonus(source);
  await insert(f, "kancolle-replay-event-bonus");
  const r = await h.call<Record<string, unknown>>("GET", "/api/v1/maps/57-5/bonuses");
  expect(r.status).toBe(200);
  expect(r.json).toEqual({
    map: "57-5", date: f.date, note: f.note, source: "kancolle-replay", revision: "abc123",
    bonuses: f.bonuses, lbasBonuses: f.lbasBonuses, debuffs: f.debuffs,
  });
  await insert(flattenEventBonus({ world: 62, mapnum: 1, listBonus: [{ bonuses: [{ dmg: 1.2 }] }] }), "manual-event-bonus");
  expect((await h.call<{ source: string }>("GET", "/api/v1/maps/62-1/bonuses")).json.source).toBe("manual");
  expect((await h.call("GET", "/api/v1/maps/1-1/bonuses")).status).toBe(404);
  expect((await h.call("GET", "/api/v1/maps/x/bonuses")).status).toBe(400);
});
