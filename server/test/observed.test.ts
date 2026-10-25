// poi-observed aggregation (src/observed/*), the observation/enemy-comps/map API, and an end-to-end run from
// the plugin's capture module (CaptureSession -> ObservationDb.uploadPending) through the worker.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  aggregatePending, buildObservedSets, compFromEnemy, deleteClientObservations, graphMismatches, isContinuationBattle,
  layoutKey, observationStatements, resetStatements, type ObservationRow,
} from "../src/observed/aggregate";
import { Budget } from "../src/budget";
import { selectCompSets } from "../src/observed/select";
import {
  battleResponse, drainJobs, EDGES_15, ENEMIES, fleet, FRIENDS, harness, LAYOUT_15 as LAYOUT, mapPackets, seedBasic, sortieOf, uploadAndProcess, type Harness, type UploadOutcome,
} from "./helpers";

const EVENTS_15: Record<string, number> = { A: 4, B: 6, C: 4, D: 4, E: 4, F: 4, G: 6, H: 4, I: 4, J: 5 };
const COMP_X = [1530, 1501, 1501];
const COMP_Y = [1530, 1502, 1502];

async function seed(db: D1Database) {
  await seedBasic(db);
  await db.batch([
    db.prepare(`INSERT INTO sources (key, name, fetched_at) VALUES ('kcnav', 'KCNav', '2026-10-01T00:00:00Z')`),
    ...Object.entries(EVENTS_15).map(([letter, ev]) => db.prepare(
      "INSERT INTO nodes (map_id, letter, event_id, is_boss) VALUES (15, ?1, ?2, ?3)",
    ).bind(letter, ev, letter === "J" ? 1 : 0)),
    // A KCNav set for J with 100 encounters (the fallback).
    db.prepare(`INSERT INTO enemy_comp_sets (id, map_id, node_letter, difficulty, period_start, period_end, total_count, retrieved_at, source_id)
      VALUES (900, 15, 'J', 0, '2026-08-22', '', 100, '2026-10-21T00:00:00Z', (SELECT id FROM sources WHERE key = 'kcnav'))`),
    db.prepare(`INSERT INTO enemy_comps (id, set_id, kcnav_master_id, formation, count, weight) VALUES (901, 900, 7, 1, 100, 1)`),
    db.prepare(`INSERT INTO enemy_comp_ships (comp_id, fleet, position, ship_id, level, hp, fp, tp, aa, ar, equips) VALUES (901, 0, 0, 1530, 1, 90, 50, 0, 40, 60, '[1505]')`),
  ]);
}

/** CapturedEnemy shape (pure helper tests). */
const enemy = (ids: number[], formation: number, escort: number[] = []) => {
  const ship = (masterId: number, idx: number) => ({ idx, masterId, level: 1, maxHp: 30 + idx, nowHp: 30, slots: [1505, -1, -1, -1, -1], params: [10, 20, 5, 6] });
  return { ships: ids.map(ship), escort: escort.map(ship), friendFormation: 1, enemyFormation: formation, engagement: 1 };
};
let seq = 0;
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1) + minutes * 60_000).toISOString();
/** A battle observation whose raw response (ENEMIES stats, no attacks) passes validation. */
const battle = (cell: number, ids: number[], formation = 1, extra: Record<string, unknown> & { path?: string } = {}) => {
  const { path, ...rest } = extra;
  return {
    clientObsId: `b${++seq}`, observedAt: at(seq), map: "1-5", cell, layout: LAYOUT, difficulty: 0, kind: "battle", fleet: fleet(),
    raw: { path: path ?? "api_req_sortie/battle", visitId: `visit-${seq}`, sortieId: null, raw: battleResponse(ids, formation), result: null },
    ...rest,
  };
};
const cell = (no: number, from: number | null, eventId: number, next: number, battles: string[] = []) =>
  ({ no, from, colorNo: eventId === 5 ? 5 : 4, eventId, eventKind: 1, bossCellNo: 12, next, selectCells: null, battles });
/** Start → A(1) → D(4) → F(6) → G(7) → J(12), boss; `post` adds the raw map packets (`raw: null` leaves them out). */
const sortie = (battles: string[] = [], extra: Record<string, unknown> = {}) => {
  const cells = [cell(1, null, 4, 1), cell(4, 1, 4, 2), cell(6, 4, 4, 2), cell(7, 6, 6, 1), cell(12, 7, 5, 0, battles)];
  const layout = (extra.layout as number[] | null | undefined) === undefined ? LAYOUT : (extra.layout as number[] | null);
  const cellData = layout?.map((no) => ({ no, colorNo: no === 0 ? 0 : 4, passed: 1, ...(no === 7 ? { distance: 3 } : {}) })) ?? null;
  return {
    clientObsId: `s${++seq}`, observedAt: at(seq), map: "1-5", layout: LAYOUT, difficulty: 0, kind: "sortie",
    fleet: fleet(),
    sortie: { deckId: 1, combined: 0, endKind: "boss", endedAt: at(seq + 1), cells, cellData, features: { stypes: [2, 2, 2], speed: 10, los: null, hqLevel: 120 } },
    ...extra,
  };
};

// Response shapes the assertions read (the API is the system under test; the casts below are unchecked).
interface CompJson { count: number; weight: number; formation: number | null; main: { shipId: number }[] }
interface SetJson { source: string; totalCount: number; comps: CompJson[] }
interface CompsJson { selection: unknown[]; sets: SetJson[] }
interface DetailJson {
  enemyCompNodes: string[]; compSets: unknown[];
  nodes: { letter: string; lbasDistance: number | null }[];
  observed: { layout: unknown; edges: { from: number; to: number; fromLetter: string; toLetter: string; count: number }[]; cells: { no: number }[]; mismatches: unknown[] };
}
interface StatusJson { observations: unknown[]; layouts: unknown[] }
type UploadJson = UploadOutcome;

let h: Harness;
let db: D1Database;
/** Registered clients by test name → {clientId, token}. */
let clients: Map<string, { clientId: string; token: string }>;
const call = <T = unknown>(method: string, path: string, body?: unknown) => h.call<T>(method, path, { body });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obs = Record<string, any>;
/**
 * What the plugin does before an upload: a sortie carries the raw map packets of its (final) cells, and lists the
 * battles fought at its cells, which carry its id. Battles at cells no sortie of the upload visits stay unlinked.
 */
const finalize = (observations: unknown[]) => {
  const list = observations as Obs[];
  const sorties = list.filter((o) => o?.kind === "sortie" && Array.isArray(o.sortie?.cells));
  for (const b of list) {
    if (b?.kind !== "battle" || sorties.some((s) => s.sortie.cells.some((c: Obs) => c.battles.includes(b.clientObsId)))) continue;
    const c = sorties.find((s) => s.map === b.map)?.sortie.cells.find((x: Obs) => x.no === b.cell && x.battles.length < 8);
    if (c) c.battles = [...c.battles, b.clientObsId];
  }
  for (const s of sorties) {
    if (!("raw" in s)) s.raw = { packets: mapPackets(Number(s.map.split("-")[0]) * 10 + Number(s.map.split("-")[1]), s.sortie.cells, s.sortie.cellData) };
    for (const c of s.sortie.cells) {
      for (const id of c.battles) {
        const b = list.find((x) => x?.kind === "battle" && x.clientObsId === id);
        if (b) b.raw.sortieId = s.clientObsId;
      }
    }
  }
  return list;
};
/** One upload per call (the clock moves past the 60 s gate), processed by the jobs. */
const post = async (name: string, observations: unknown[]) => {
  if (!clients.has(name)) clients.set(name, await h.register(`198.51.100.${clients.size + 1}`));
  const r: UploadJson = await uploadAndProcess(h, clients.get(name)!.token, finalize(observations));
  return { status: r.status, json: r };
};
const rows = (sql: string) => db.prepare(sql).all<Record<string, unknown>>().then((r) => r.results);
/** Every aggregate table, for before/after comparisons. */
const snapshot = async () => ({
  layouts: await rows("SELECT map_id, layout, version, sorties, encounters, first_seen, last_seen, boss_cell FROM poi_layouts ORDER BY 1, 2"),
  cells: await rows("SELECT * FROM poi_cells ORDER BY map_id, layout, cell_no"),
  edges: await rows("SELECT * FROM poi_edge_counts ORDER BY map_id, layout, difficulty, from_cell, to_cell"),
  comps: await rows("SELECT * FROM poi_comp_counts ORDER BY map_id, layout, cell_no, difficulty, signature"),
  sorties: await rows("SELECT map_id, layout, end_kind, cells, battles, features FROM poi_sorties ORDER BY observed_at"),
  drops: await rows("SELECT * FROM poi_drop_counts ORDER BY map_id, layout, difficulty, cell_no, rank, ship_id"),
  sets: await rows(`SELECT s.node_letter, s.difficulty, s.period_start, s.period_end, s.total_count, s.layout, s.cell_nos, c.signature, c.count, c.weight,
    (SELECT json_group_array(ship_id) FROM (SELECT ship_id FROM enemy_comp_ships WHERE comp_id = c.id ORDER BY fleet, position)) AS ships
    FROM enemy_comp_sets s JOIN enemy_comps c ON c.set_id = s.id WHERE s.source_id = (SELECT id FROM sources WHERE key = 'poi-observed') ORDER BY 1, 2, 6, 8`),
  mismatches: await rows("SELECT map_id, layout, kind, from_cell, to_cell, count FROM poi_graph_mismatches ORDER BY 1, 2, 3, 4, 5"),
});

beforeEach(async () => {
  h = harness();
  db = h.db;
  clients = new Map();
  await seed(db);
  seq = 0;
});

describe("pure helpers", () => {
  test("layout key, night continuation, comp signature", () => {
    expect(layoutKey([3, 0, 1, 3])).toBe("0,1,3");
    expect(layoutKey(null)).toBe("");
    for (const p of ["api_req_battle_midnight/battle", "api_req_combined_battle/midnight_battle", "api_req_combined_battle/ec_midnight_battle"]) {
      expect(isContinuationBattle(p)).toBe(true);
    }
    for (const p of ["api_req_sortie/battle", "api_req_battle_midnight/sp_midnight", "api_req_combined_battle/ec_battle", null]) {
      expect(isContinuationBattle(p)).toBe(false);
    }
    const c = compFromEnemy(enemy([1530, 1501, -1], 4, [1575]))!;
    expect(c.signature).toBe("4|1530,1501|1575");
    expect(c.ships[0]).toEqual({ fleet: 0, position: 0, shipId: 1530, level: 1, hp: 30, fp: 10, tp: 20, aa: 5, ar: 6, equips: [1505, -1, -1, -1, -1] });
    expect(c.ships[2]).toMatchObject({ fleet: 1, position: 0, shipId: 1575 });
    expect(compFromEnemy({ shipKe: [1] })).toBeNull();
    expect(compFromEnemy({ ships: [] })).toBeNull();
  });

  test("sets merge the cells of one letter; weights = count / total; old layouts close their period", () => {
    const row = (layout: string, cell: number, signature: string, count: number, first: string, last: string) =>
      ({ layout, cell_no: cell, difficulty: 0, signature, formation: 1, ships: "[]", count, first_seen: first, last_seen: last });
    const sets = buildObservedSets(
      [row("a", 10, "X", 2, "2026-10-02", "2026-10-05"), row("a", 12, "X", 4, "2026-10-01", "2026-10-03"), row("a", 12, "Y", 2, "2026-10-04", "2026-10-04"),
        row("b", 12, "X", 1, "2026-10-09", "2026-10-09"), row("b", 99, "Z", 1, "2026-10-09", "2026-10-09")],
      [{ layout: "a", version: 1 }, { layout: "b", version: 2 }],
      new Map([[10, "J"], [12, "J"]]),
    );
    const j1 = sets.find((s) => s.node === "J" && s.layout === 1)!;
    expect(j1).toMatchObject({ cells: [10, 12], totalCount: 8, periodStart: "2026-10-01", periodEnd: "2026-10-05", retrievedAt: "2026-10-05" });
    expect(j1.comps.map((c) => [c.signature, c.count, c.weight, c.firstSeen, c.lastSeen])).toEqual([
      ["X", 6, 0.75, "2026-10-01", "2026-10-05"], ["Y", 2, 0.25, "2026-10-04", "2026-10-04"],
    ]);
    expect(sets.find((s) => s.node === "J" && s.layout === 2)!.periodEnd).toBe("");
    // unresolvable cells keep their number
    expect(sets.find((s) => s.node === "99")!.cells).toEqual([99]);
  });

  test("graph mismatches against stored edges", () => {
    const edges = EDGES_15.map(([edge_id, from_letter, to_letter]) => ({ edge_id, from_letter, to_letter }));
    const nodes = Object.entries(EVENTS_15).map(([letter, event_id]) => ({ letter, event_id, is_boss: letter === "J" ? 1 : 0 }));
    const oe = (from_cell: number, to_cell: number) => ({ layout: "L", from_cell, to_cell, count: 2 });
    const oc = (cell_no: number, event_id: number, is_boss = 0) => ({ layout: "L", cell_no, event_id, visits: 2, is_boss });
    const out = graphMismatches({
      edges, nodes,
      observedEdges: [oe(0, 1), oe(1, 4), oe(4, 6), oe(6, 12), oe(0, 4), oe(7, 13)],
      cells: [oc(12, 5, 1), oc(4, 4), oc(7, 4), oc(9, 4, 1)],
    });
    expect(out.map((m) => [m.kind, m.fromCell, m.toCell])).toEqual([
      ["from_mismatch", 6, 12], // stored edge 12 is G -> J, observed from F (cell 6)
      ["from_mismatch", 0, 4], // stored edge 4 leaves A, observed from a start
      ["unknown_edge", 7, 13],
      ["event_mismatch", -1, 7], // G is stored as event 6
      ["boss_mismatch", -1, 9],
    ]);
    expect(graphMismatches({ edges: [], nodes, observedEdges: [oe(0, 1)], cells: [] })).toEqual([]);
  });

  test("source policy: threshold, forced sources, since", () => {
    const set = (source: string, total: number, periodEnd: string | null = null, difficulty = 0) => ({
      difficulty, periodEnd, totalCount: total, source,
      comps: [{ count: total - 1, weight: (total - 1) / total, lastSeen: "2026-10-10T00:00:00Z" }, { count: 1, weight: 1 / total, lastSeen: "2026-09-01T00:00:00Z" }],
    });
    const sets = [set("kcnav", 100), set("poi-observed", 31), set("poi-observed", 500, "2026-01-01")];
    expect(selectCompSets(sets, { minObserved: 30, prefer: "auto" }).sets.map((s) => s.source)).toEqual(["poi-observed"]);
    expect(selectCompSets(sets, { minObserved: 30, prefer: "auto" }).selection).toEqual([{ difficulty: 0, source: "poi-observed", observedCount: 31, minObserved: 30 }]);
    expect(selectCompSets(sets, { minObserved: 32, prefer: "auto" }).sets.map((s) => s.source)).toEqual(["kcnav"]);
    expect(selectCompSets(sets, { minObserved: 32, prefer: "all" })).toMatchObject({ sets: { length: 3 }, selection: [{ source: "kcnav" }] });
    expect(selectCompSets(sets, { minObserved: 0, prefer: "kcnav" }).sets.map((s) => s.source)).toEqual(["kcnav"]);
    expect(selectCompSets([set("poi-observed", 3)], { minObserved: 30, prefer: "auto" }).selection[0]!.source).toBe("poi-observed");
    // since: the old comp drops out and weights renormalise; closed KCNav periods before `since` drop out
    const since = selectCompSets([set("poi-observed", 31), set("kcnav", 100, "2026-09-15")], { minObserved: 30, prefer: "all", since: "2026-10-01" });
    expect(since.sets).toHaveLength(1);
    expect(since.sets[0]).toMatchObject({ totalCount: 30, comps: [{ count: 30, weight: 1 }] });
    expect(since.selection[0]).toMatchObject({ observedCount: 30, source: "poi-observed" });
  });
});

describe("aggregation", () => {
  test("upload aggregates: comps per letter, weights, letters from cells, graph, sortie features", async () => {
    const b = [battle(12, COMP_X, 4), battle(12, COMP_X, 4), battle(12, COMP_Y, 4), battle(10, COMP_X, 4), battle(1, [1501, 1501])];
    const night = battle(12, COMP_X, 4, { path: "api_req_battle_midnight/battle" }); // continuation: not an encounter
    const s = sortie([b[0]!.clientObsId, night.clientObsId]);
    const r = await post("poi-a", [...b, night, s]);
    expect(r.status).toBe(202);
    // the battle at cell 10 is not on the sortie's route: it stays quarantined 'unlinked'
    expect(r.json).toMatchObject({ accepted: 7, duplicates: 0, rejected: [], quarantined: 1 });
    expect((await rows("SELECT COUNT(*) AS n FROM observations WHERE aggregated_at IS NOT NULL AND agg_error IS NULL"))[0]!.n).toBe(6);

    // letters are resolved on the server from the cell (edge_id = destination cell)
    expect((await rows("SELECT node_letter FROM observations WHERE kind = 'battle' ORDER BY id")).map((x) => x.node_letter)).toEqual(["J", "J", "J", "J", "A", "J"]);
    const snap = await snapshot();
    expect(snap.layouts).toEqual([{ map_id: 15, layout: LAYOUT.join(","), version: 1, sorties: 1, encounters: 4, first_seen: at(1), last_seen: at(7), boss_cell: 12 }]);
    const j = snap.sets.filter((x) => x.node_letter === "J");
    expect(j.map((x) => [x.signature, x.count, x.total_count, x.cell_nos, x.ships])).toEqual([
      ["4|1530,1501,1501|", 2, 3, "[12]", "[1530,1501,1501]"],
      ["4|1530,1502,1502|", 1, 3, "[12]", "[1530,1502,1502]"],
    ]);
    expect(j[0]).toMatchObject({ layout: 1, period_start: at(1), period_end: "" });
    expect(snap.edges.map((e) => [e.from_cell, e.to_cell, e.count])).toEqual([[0, 1, 1], [1, 4, 1], [4, 6, 1], [6, 7, 1], [7, 12, 1]]);
    expect(snap.cells.find((c) => c.cell_no === 12)).toMatchObject({ visits: 1, is_boss: 1, event_id: 5 });
    expect(snap.cells.find((c) => c.cell_no === 2)).toMatchObject({ visits: 0, color_no: 4 });
    expect(snap.sorties).toEqual([{ map_id: 15, layout: LAYOUT.join(","), end_kind: "boss", cells: "[1,4,6,7,12]", battles: 5, features: expect.any(String) }]);
    // fleet features are re-derived from the fleet snapshot and master data, not taken from the client
    expect(JSON.parse(snap.sorties[0]!.features as string)).toMatchObject({ stypes: [2, 2, 2], escortStypes: null, speed: 10, hqLevel: 120 });
    expect(snap.mismatches).toEqual([]);
  });

  test("idempotent: duplicate uploads and re-running statements never double count", async () => {
    const payload = [battle(12, COMP_X), battle(12, COMP_Y), sortie()];
    await post("poi-a", payload);
    const before = await snapshot();
    expect(await post("poi-a", payload)).toMatchObject({ json: { accepted: 0, duplicates: 3 } });
    expect((await aggregatePending(db, new Budget(50))).aggregated).toBe(0);
    // replaying an already aggregated observation's statements is a no-op (guarded by aggregated_at)
    const obs = await db.prepare(`SELECT id, client_id, kind, map_id, node_letter, cell_no, difficulty, layout, observed_at, enemy,
      json_extract(raw, '$.path') AS battle_path, sortie FROM observations`).all<ObservationRow>();
    for (const o of obs.results) await db.batch(observationStatements(db, o));
    expect(await snapshot()).toEqual(before);
    // the same clientObsId from another client is a different observation
    expect((await post("poi-b", payload)).json.accepted).toBe(3);
    expect((await snapshot()).layouts[0]).toMatchObject({ sorties: 2, encounters: 4 });
  });

  test("rebuild from scratch reproduces the incremental aggregates", async () => {
    await post("poi-a", [battle(12, COMP_X), battle(10, COMP_X), sortie()]);
    await post("poi-b", [battle(12, COMP_Y), sortie(), battle(1, [1501])]);
    await post("poi-a", [battle(12, COMP_X, 1, { layout: [...LAYOUT, 13] }), sortie([], { layout: [...LAYOUT, 13] })]);
    const before = await snapshot();
    await db.prepare("DELETE FROM poi_comp_counts").run(); // damage: rebuild must not depend on current aggregates
    await db.batch(resetStatements(db));
    await drainJobs(h);
    expect(await snapshot()).toEqual(before);
    // KCNav data is untouched
    expect((await rows("SELECT COUNT(*) AS n FROM enemy_comp_sets WHERE id = 900"))[0]!.n).toBe(1);
  });

  test("layout versions: a new layout opens a new period and closes the old one", async () => {
    await post("poi-a", [battle(12, COMP_X), sortie()]);
    await post("poi-a", [battle(12, COMP_Y, 1, { layout: [...LAYOUT, 13] }), sortie([], { layout: [...LAYOUT, 13] })]);
    const sets = (await snapshot()).sets.filter((s) => s.node_letter === "J");
    expect(sets.map((s) => [s.layout, s.signature, s.period_end])).toEqual([
      [1, "1|1530,1501,1501|", at(1)],
      [2, "1|1530,1502,1502|", ""],
    ]);
  });

  test("mismatch report: observed transitions that the stored edges do not have", async () => {
    // cell 13 is in the sortie's layout but not in the stored edges: accepted and flagged (maps change)
    const s = sortie([], { layout: [...LAYOUT, 13] });
    s.sortie.cells = [cell(1, null, 4, 1), cell(4, 1, 4, 2), cell(6, 4, 4, 2), cell(12, 6, 5, 0), cell(13, 12, 4, 0)];
    expect((await post("poi-a", [s])).json).toMatchObject({ accepted: 1, rejected: [] });
    expect((await snapshot()).mismatches.map((m) => [m.kind, m.from_cell, m.to_cell, m.count])).toEqual([
      ["from_mismatch", 6, 12, 1],
      ["unknown_edge", 12, 13, 1],
    ]);
    // stored data is kept
    expect((await rows("SELECT COUNT(*) AS n FROM edges WHERE map_id = 15"))[0]!.n).toBe(12);
  });

  test("delete by client re-aggregates the affected maps from the remaining observations", async () => {
    await post("poi-a", [battle(12, COMP_X), sortie()]);
    await post("smoke", [battle(12, COMP_Y), battle(12, COMP_Y), sortie()]);
    const r = await deleteClientObservations(db, clients.get("smoke")!.clientId);
    expect(r).toMatchObject({ deleted: 3, maps: [15] });
    await drainJobs(h);
    const snap = await snapshot();
    expect(snap.sets.map((s) => [s.signature, s.count, s.weight])).toEqual([["1|1530,1501,1501|", 1, 1]]);
    expect(snap.layouts[0]).toMatchObject({ sorties: 1, encounters: 1 });
  });

  test("unusable observations are rejected; event maps without a difficulty only feed the graph", async () => {
    const ev = { ...battle(3, COMP_X), map: "60-1", difficulty: null, layout: null };
    const r = await post("poi-a", [
      battle(12, [], 1), // no ships
      { ...battle(5, COMP_X), cell: null, node: "E" }, // legacy letter without a cell
      ev, sortieOf([ev]),
    ]);
    expect(r.json.accepted).toBe(2);
    expect(r.json.rejected.map((x) => x.rule).sort()).toEqual(["raw_invalid", "schema"]);
    const snap = await snapshot();
    expect(snap.comps).toEqual([]);
    expect((await rows("SELECT COUNT(*) AS n FROM observations WHERE aggregated_at IS NOT NULL AND agg_error IS NULL"))[0]!.n).toBe(2);
  });
});

describe("gauge, drops, FCF retreats, striking force", () => {
  type Result = { rank: string; drop: { shipId: number; name?: string } | null; escapeFlag: number; [k: string]: unknown };
  const res = (rank: string, shipId: number | null, extra: Record<string, unknown> = {}): Result => ({ rank, drop: shipId === null ? null : { shipId, name: `ship${shipId}` }, escapeFlag: 0, ...extra });
  const GAUGE = { gaugeNum: 2, gaugeType: 2, nowHp: 1200, maxHp: 1800, state: 2, rank: 3, cleared: 0, defeatCount: 0 };
  /** Start → A(1) → D(4) → F(6): a battle with a result at every cell; the drops/results are the caller's. */
  const withResults = (results: (Result | null)[], extra: Record<string, unknown> = {}, sortieExtra: Record<string, unknown> = {}) => {
    const s = sortie([], extra);
    const cells = [cell(1, null, 4, 1, ["x1"]), cell(4, 1, 4, 2, ["x2"]), cell(6, 4, 4, 2, ["x3"])];
    s.sortie.cells = cells.map((c, i) => (results[i] ? { ...c, result: results[i] } : c)) as typeof s.sortie.cells;
    Object.assign(s.sortie, sortieExtra);
    return s;
  };
  /** Findings of the uploads. */
  const findings = () => rows("SELECT rule, action FROM observation_rejections ORDER BY id");
  const storedSortie = async () => JSON.parse((await rows("SELECT sortie FROM observations WHERE kind = 'sortie' ORDER BY id DESC LIMIT 1"))[0]!.sortie as string);

  test("an upload with drops lands in poi_drop_counts keyed by map, layout, difficulty, cell and rank", async () => {
    const up = [
      withResults([res("A", 10), res("B", null), res("S", 11)]),
      withResults([res("A", 10), res("B", 12), null]),
      withResults([res("A", null), res("B", null), res("S", 11)]),
    ];
    expect(await post("poi-a", up)).toMatchObject({ json: { accepted: 3, quarantined: 0, rejected: [] } });
    const layout = LAYOUT.join(",");
    const key = (cell_no: number, rank: string, ship_id: number, count: number) => ({ map_id: 15, layout, difficulty: 0, cell_no, rank, ship_id, count });
    expect((await snapshot()).drops.map(({ first_seen, last_seen, ...d }) => d)).toEqual([
      key(1, "A", 0, 1), key(1, "A", 10, 2),
      key(4, "B", 0, 2), key(4, "B", 12, 1),
      key(6, "S", 11, 2),
    ]);
    // first/last seen follow the observation times
    expect((await rows("SELECT first_seen, last_seen FROM poi_drop_counts WHERE cell_no = 1 AND ship_id = 10"))[0]).toEqual({ first_seen: at(1), last_seen: at(2) });
    // drop rate of (1-5, cell 1, A): 2 ships of 3 results
    const rate = (await rows("SELECT SUM(CASE WHEN ship_id = 10 THEN count END) * 1.0 / SUM(count) AS n FROM poi_drop_counts WHERE cell_no = 1 AND rank = 'A'"))[0]!.n as number;
    expect(rate).toBeCloseTo(2 / 3, 10);
  });

  test("drops are re-counted exactly by a rebuild, and removed with a deleted client", async () => {
    await post("poi-a", [withResults([res("A", 10), null, null])]);
    await post("poi-b", [withResults([res("A", 10), res("S", 11), null])]);
    const before = await snapshot();
    expect(before.drops.find((d) => d.cell_no === 1 && d.ship_id === 10)).toMatchObject({ count: 2 });
    await db.batch(resetStatements(db));
    expect((await snapshot()).drops).toEqual([]);
    await drainJobs(h);
    expect(await snapshot()).toEqual(before);
    await deleteClientObservations(db, clients.get("poi-b")!.clientId);
    await drainJobs(h);
    expect((await snapshot()).drops.map((d) => [d.cell_no, d.ship_id, d.count])).toEqual([[1, 10, 1]]);
  });

  test("event maps count drops per difficulty; an unknown rank is not counted", async () => {
    const ev = (difficulty: number | null) => {
      const s = withResults([res("S", 10), null, null]);
      return { ...s, map: "60-1", difficulty, layout: null, sortie: { ...s.sortie, cellData: null } };
    };
    await post("poi-a", [ev(2), ev(2), ev(4), ev(null)]);
    expect((await snapshot()).drops.map((d) => [d.map_id, d.layout, d.difficulty, d.ship_id, d.count])).toEqual([[601, "", 2, 10, 2], [601, "", 4, 10, 1]]);
  });

  test("implausible drops are quarantined and never counted: abyssal or unknown ship, no battle at the cell", async () => {
    const noBattle = withResults([res("A", 10), null, null]);
    noBattle.sortie.cells[0]!.battles = [];
    const r = await post("poi-a", [withResults([res("A", 1501), null, null]), withResults([res("A", 9999), null, null]), noBattle]);
    expect(r.json).toMatchObject({ accepted: 3, quarantined: 3 });
    expect((await rows("SELECT rule FROM observation_rejections WHERE action = 'quarantine' ORDER BY id")).map((x) => x.rule)).toEqual(["drop_unknown", "drop_unknown", "drop_no_battle"]);
    expect((await snapshot()).drops).toEqual([]);
    expect((await snapshot()).sorties).toEqual([]);
  });

  test("a ship drop at rank C-E is flagged but used", async () => {
    const r = await post("poi-a", [withResults([res("C", 10), null, null])]);
    expect(r.json).toMatchObject({ accepted: 1, quarantined: 0 });
    expect((await findings())).toEqual([{ rule: "drop_rank", action: "flag" }]);
    expect((await snapshot()).drops).toHaveLength(1);
  });

  test("gauge, deck and fleet size, FCF escape and results are kept on the stored sortie", async () => {
    const escape = { idx: [2], towIdx: [1], shipIds: [11], towShipIds: [10], type: null, retreated: true };
    const s = withResults([res("S", null, { escapeFlag: 1, escape, useItem: { id: 44, name: "勲章" }, eventItems: [{ type: 1, id: 123, value: 1 }] }), null, null],
      {}, { gauge: GAUGE, fleetSize: 3, escortSize: 0 });
    expect(await post("poi-a", [s])).toMatchObject({ json: { accepted: 1, quarantined: 0, rejected: [] } });
    const stored = await storedSortie();
    expect(stored).toMatchObject({ deckId: 1, fleetSize: 3, escortSize: 0, fleetType: "single", gauge: GAUGE });
    expect(stored.cells[0].result).toEqual({ rank: "S", drop: null, escapeFlag: 1, escape, useItem: { id: 44, name: "勲章" }, eventItems: [{ type: 1, id: 123, value: 1 }] });
    expect(stored.cells[1].result).toBeUndefined();
    expect((await findings())).toEqual([]);
  });

  test("an escape that does not fit the fleet snapshot is flagged", async () => {
    const wrong = { idx: [2], towIdx: [], shipIds: [12], towShipIds: [], type: null, retreated: false };
    const r = await post("poi-a", [withResults([res("S", null, { escapeFlag: 1, escape: wrong }), null, null])]);
    expect(r.json).toMatchObject({ accepted: 1, quarantined: 0 });
    expect((await findings())).toEqual([{ rule: "client_mismatch", action: "flag" }]);
  });

  test("striking force: a 7-ship single fleet is derived as fleetType striking; combined flags map to ctf/stf/tcf", async () => {
    const seven = { ...fleet(3), deckId: 3 };
    seven.ships = Array.from({ length: 7 }, (_, i) => ({ ...seven.ships[i % 3]! }));
    seven.supply = seven.ships.map(() => ({ fuel: 15, fuelMax: 15, ammo: 20, ammoMax: 20 }));
    const striking = withResults([null, null, null], { fleet: seven }, { deckId: 3, fleetSize: 7, escortSize: 0, features: { stypes: Array(7).fill(2), speed: 10, los: null, hqLevel: 120 } });
    const ctf = withResults([null, null, null], { fleet: { ...fleet(3), escort: fleet(2).ships } }, { combined: 1, fleetSize: 3, escortSize: 2 });
    const single = withResults([null, null, null], {}, { fleetSize: 6 }); // client's size is wrong: flagged, the server value wins
    expect(await post("poi-a", [striking, ctf, single])).toMatchObject({ json: { accepted: 3, rejected: [] } });
    const types = (await rows("SELECT sortie FROM observations WHERE kind = 'sortie' ORDER BY id")).map((r) => JSON.parse(r.sortie as string));
    expect(types.map((t) => [t.deckId, t.fleetSize, t.escortSize, t.fleetType])).toEqual([[3, 7, 0, "striking"], [1, 3, 2, "ctf"], [1, 3, 0, "single"]]);
    expect((await findings())).toEqual([{ rule: "client_mismatch", action: "flag" }]);
    // LoS (ROUTING_DSL §5): floored to 2 decimals; a combined fleet sums both fleets and uses 12 in the last term
    // (naked LoS 10 per ship: 5·√10 − 48 + 2·(12−5) = −18.1886…; single fleet of 3: 3·√10 − 48 + 2·(6−3) = −32.5132…)
    const los = (await rows("SELECT features FROM poi_sorties ORDER BY observation_id")).map((r) => JSON.parse(r.features as string).los.cn1);
    expect(los).toEqual([expect.any(Number), -18.19, -32.52]);
  });

  test("older plugins (no gauge, sizes or results) are still accepted and counted", async () => {
    expect(await post("poi-a", [sortie([])])).toMatchObject({ json: { accepted: 1, quarantined: 0, rejected: [] } });
    const stored = await storedSortie();
    expect(stored).toMatchObject({ deckId: 1, fleetSize: 3, escortSize: 0, fleetType: "single", gauge: null });
    expect((await snapshot()).drops).toEqual([]);
    expect((await snapshot()).sorties).toHaveLength(1);
  });
});

describe("API", () => {
  test("validation: sortie record required for kind sortie, strict cells (per observation)", async () => {
    const bad = sortie();
    (bad.sortie.cells[0] as Record<string, unknown>).letter = "A";
    const r = await post("c", [{ ...sortie(), sortie: undefined }, { ...battle(1, COMP_X), kind: "sortie" }, bad, battle(1, COMP_X)]);
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ accepted: 1, rejected: [{ rule: "schema" }, { rule: "schema" }, { rule: "schema" }] });
    expect((await h.call("POST", "/api/v1/observations", { token: clients.get("c")!.token, body: { observations: [] } })).status).toBe(429);
    h.clock.t += 61_000;
    expect((await h.call("POST", "/api/v1/observations", { token: clients.get("c")!.token, body: { observations: [] } })).status).toBe(400);
  });

  test("enemy-comps: source per set, policy with minObserved, source and since; map detail", async () => {
    await post("poi-a", [battle(12, COMP_X), battle(12, COMP_X), battle(12, COMP_Y), sortie()]);
    const comps = (query = "") => call<CompsJson>("GET", `/api/v1/maps/1-5/nodes/J/enemy-comps${query}`);
    const auto = await comps();
    expect(auto.json).toMatchObject({ minObserved: 30, source: "auto", selection: [{ difficulty: 0, source: "kcnav", observedCount: 3, minObserved: 30 }] });
    expect(auto.json.sets.map((s) => s.source)).toEqual(["kcnav"]);
    const low = await comps("?minObserved=3");
    expect(low.json.selection[0]).toMatchObject({ source: "poi-observed", observedCount: 3 });
    expect(low.json.sets).toHaveLength(1);
    expect(low.json.sets[0]).toMatchObject({ source: "poi-observed", totalCount: 3, layout: 1, cells: [12], periodEnd: null });
    expect(low.json.sets[0]!.comps.map((c) => [c.weight, c.main.map((m) => m.shipId)])).toEqual([
      [2 / 3, COMP_X], [1 / 3, COMP_Y],
    ]);
    expect(low.json.sets[0]!.comps[0]).toMatchObject({ firstSeen: at(1), lastSeen: at(2), kcnavMasterId: null, airpower: null });
    expect((await comps("?source=all")).json.sets.map((s) => s.source).sort()).toEqual(["kcnav", "poi-observed"]);
    expect((await comps("?source=poi-observed")).json.sets).toHaveLength(1);
    // since: comp X was last seen at(2), so only comp Y (at(3)) remains
    expect((await comps(`?source=poi-observed&since=${at(3)}`)).json.sets[0]).toMatchObject({ totalCount: 1, comps: [{ weight: 1 }] });
    for (const q of ["minObserved=-1", "minObserved=x", "source=foo", "since=yesterday"]) {
      expect((await comps(`?${q}`)).status).toBe(400);
    }
    // the map view: every node in one response, each as the per-node route answers it
    for (const q of ["", "?minObserved=3", "?source=all"]) {
      const all = (await call<{ enemyComps: { nodes: Record<string, Pick<CompsJson, "selection" | "sets">>; minObserved: number } }>("GET", `/api/v1/views/map/1-5${q}`)).json.enemyComps;
      const one = (await comps(q)).json;
      expect(Object.keys(all.nodes)).toEqual(["J"]);
      expect(all.nodes.J).toEqual({ selection: one.selection, sets: one.sets });
      expect(all.minObserved).toBe(q === "?minObserved=3" ? 3 : 30);
    }
    expect((await call("GET", "/api/v1/views/map/1-5?source=foo")).status).toBe(400);

    const detail = (await call<DetailJson>("GET", "/api/v1/maps/1-5")).json;
    expect(detail.enemyCompNodes).toEqual(["J"]);
    expect(detail.compSets).toEqual([
      expect.objectContaining({ node: "J", difficulty: 0, source: "kcnav", totalCount: 100, layout: null }),
      expect.objectContaining({ node: "J", difficulty: 0, source: "poi-observed", totalCount: 3, layout: 1 }),
    ]);
    expect(detail.observed.layout).toMatchObject({ version: 1, cellCount: 13, sorties: 1, encounters: 3, bossCell: 12, bossLetter: "J" });
    expect(detail.observed.edges[0]).toEqual({ from: 0, to: 1, fromLetter: "Start", toLetter: "A", count: 1 });
    expect(detail.observed.cells.find((c) => c.no === 7)).toMatchObject({ letter: "G", eventId: 6, visits: 1 });
    expect(detail.observed.mismatches).toEqual([]);
    expect(detail.observed.cells.find((c) => c.no === 7)).toMatchObject({ lbasDistance: 3 });
    expect(detail.nodes.find((n) => n.letter === "G")).toMatchObject({ lbasDistance: 3 });
    expect(detail.nodes.find((n) => n.letter === "A")).toMatchObject({ lbasDistance: null });
  });

  test("admin: delete by clientId, rebuild, status", async () => {
    await post("poi-smoke-1", [battle(12, COMP_X), sortie()]);
    expect((await call("DELETE", "/admin/observations")).status).toBe(400);
    expect((await call("DELETE", `/admin/observations?clientId=${clients.get("poi-smoke-1")!.clientId}`)).json).toMatchObject({ deleted: 2, maps: ["1-5"] });
    expect((await snapshot()).sets).toEqual([]);
    await post("poi-a", [battle(12, COMP_X), sortie()]);
    expect((await call("POST", "/admin/aggregate/rebuild", { maps: ["1-5"] })).json).toEqual({ maps: [15], pending: 2 });
    await drainJobs(h);
    expect((await call("POST", "/admin/aggregate/rebuild", { maps: ["x"] })).status).toBe(400);
    const status = (await call<StatusJson>("GET", "/admin/aggregate/status")).json;
    expect(status.observations).toEqual([{ kind: "battle", n: 1, pending: 0, failed: 0 }, { kind: "sortie", n: 1, pending: 0, failed: 0 }]);
    expect(status.layouts[0]).toMatchObject({ map: "1-5", version: 1, sorties: 1, encounters: 1 });
  });
});

// ---- end to end: the plugin's capture module -> POST -> GET ----

interface CaptureModules {
  CaptureSession: new (deps: Record<string, unknown>) => { handle(path: string, body: unknown, postBody?: unknown): Promise<void> };
  ObservationDb: new (factory: unknown) => {
    uploadPending(apiBase: string, opts: { token: string; fetch: typeof fetch }): Promise<{ sent: number; remaining: number }>;
  };
  fixtures: Record<string, unknown> & { battle15: (ids: number[], formation?: number) => Record<string, unknown>; midnightBattle: Record<string, unknown> };
  IDBFactory: new () => unknown;
}
const PLUGIN = new URL("../../poi-plugin-sim/", import.meta.url).pathname;
// Dynamic on purpose: the plugin is a separate package (DOM/React tsconfig, its own node_modules with
// fake-indexeddb). Static imports would pull its sources into this package's type check.
const loadCapture = async (): Promise<CaptureModules> => ({
  CaptureSession: (await import(`${PLUGIN}src/capture/session.ts`)).CaptureSession,
  ObservationDb: (await import(`${PLUGIN}src/capture/db.ts`)).ObservationDb,
  fixtures: await import(`${PLUGIN}src/capture/fixtures.ts`),
  IDBFactory: (await import(Bun.resolveSync("fake-indexeddb", PLUGIN))).IDBFactory,
});

/** The fixture battle with the master stats of `ids` (the server rejects stats that differ on normal maps). */
const withMasterStats = (packet: Record<string, unknown>, ids: number[]) => ({
  ...packet,
  api_ship_ke: ids,
  api_ship_lv: ids.map(() => 1),
  api_e_nowhps: ids.map((id) => ENEMIES[id]!.hp),
  api_e_maxhps: ids.map((id) => ENEMIES[id]!.hp),
  api_eSlot: ids.map((id) => [...ENEMIES[id]!.slots, -1, -1, -1, -1].slice(0, 5)),
  api_eParam: ids.map((id) => ENEMIES[id]!.params),
});

test("end to end: captured sorties -> uploadPending -> GET enemy-comps returns observed weights", async () => {
  const m = await loadCapture();
  const f = m.fixtures;
  const idb = new m.ObservationDb(new m.IDBFactory());
  let now = Date.UTC(2026, 9, 1);
  const session = new m.CaptureSession({
    sink: idb, getFleet: () => fleet(FRIENDS.length), now: () => (now += 1000),
    onError: (e: unknown) => { throw e; },
  });
  // 40 sorties to the boss: comp X (formation 4) 30 times, comp Y 10 times; one night battle each.
  for (let i = 0; i < 40; i++) {
    await session.handle("/kcsapi/api_port/port", { api_combined_flag: 0 });
    await session.handle("/kcsapi/api_req_map/start", f.mapStart15, { api_deck_id: "1" });
    await session.handle("/kcsapi/api_req_sortie/battle", withMasterStats(f.battle15([1501, 1502, 1503]), [1501, 1502, 1503]), {});
    for (const next of [f.mapNext15D, f.mapNext15F, f.mapNext15G, f.mapNext15J]) await session.handle("/kcsapi/api_req_map/next", next, {});
    const boss = i % 4 === 3 ? COMP_Y : COMP_X;
    await session.handle("/kcsapi/api_req_sortie/battle", withMasterStats(f.battle15(boss, 4), boss), {});
    await session.handle("/kcsapi/api_req_battle_midnight/battle", withMasterStats(f.midnightBattle, [1501, 1502]), {});
  }
  await session.handle("/kcsapi/api_port/port", { api_combined_flag: 0 });
  const { token } = await h.register();
  // as many requests as the plugin's caps need, one per 60 s; then the cron processes them
  let sent = 0;
  for (let i = 0; i < 20; i++) {
    h.clock.t += 61_000;
    const r = await idb.uploadPending("http://localhost", { token, fetch: h.fetch as typeof fetch });
    sent += r.sent;
    if (r.remaining === 0) break;
  }
  expect(sent).toBe(40 * 3 + 40);
  await drainJobs(h);
  // the night fixture does not continue these day battles (and has no friend HP): kept but quarantined
  expect(await db.prepare("SELECT COUNT(*) AS n FROM observations WHERE quarantine IS NOT NULL").first()).toEqual({ n: 40 });

  const r = (await call<CompsJson>("GET", "/api/v1/maps/1-5/nodes/J/enemy-comps")).json;
  expect(r.selection).toEqual([{ difficulty: 0, source: "poi-observed", observedCount: 40, minObserved: 30 }]);
  expect(r.sets).toHaveLength(1);
  expect(r.sets[0]).toMatchObject({ source: "poi-observed", totalCount: 40, cells: [12], layout: 1 });
  expect(r.sets[0]!.comps.map((c) => [c.main.map((s) => s.shipId), c.formation, c.count, c.weight]))
    .toEqual([[COMP_X, 4, 30, 0.75], [COMP_Y, 4, 10, 0.25]]);
  // the start cell's comps are observed too (n=40 at A)
  const a = (await call<CompsJson>("GET", "/api/v1/maps/1-5/nodes/A/enemy-comps")).json;
  expect(a.sets[0]).toMatchObject({ source: "poi-observed", totalCount: 40 });
  const detail = (await call<DetailJson>("GET", "/api/v1/maps/1-5")).json;
  expect(detail.observed.edges.map((e) => `${e.fromLetter}-${e.toLetter}:${e.count}`))
    .toEqual(["Start-A:40", "A-D:40", "D-F:40", "F-G:40", "G-J:40"]);
  expect(detail.observed.mismatches).toEqual([]);
  // sorties carried their map packets: cells were re-derived on the server, nothing flagged for them
  expect(await db.prepare("SELECT COUNT(*) AS n FROM observation_rejections WHERE rule = 'sortie_no_raw'").first()).toEqual({ n: 0 });
});

test("end to end: a captured sortie with a drop, an FCF escape and a gauge is accepted and counted", async () => {
  const m = await loadCapture();
  const f = m.fixtures as Record<string, any>;
  const idb = new m.ObservationDb(new m.IDBFactory());
  let now = Date.UTC(2026, 9, 1);
  const session = new m.CaptureSession({
    sink: idb, getFleet: () => fleet(FRIENDS.length), now: () => (now += 1000), getGauge: () => ({ gaugeNum: 1, gaugeType: 2, nowHp: 10, maxHp: 20, state: 2, rank: null, cleared: 0, defeatCount: 0 }),
    onError: (e: unknown) => { throw e; },
  });
  await session.handle("/kcsapi/api_port/port", { api_combined_flag: 0 });
  await session.handle("/kcsapi/api_req_map/start", f.mapStart15, { api_deck_id: "1" });
  await session.handle("/kcsapi/api_req_sortie/battle", withMasterStats(f.battle15([1501, 1502, 1503]), [1501, 1502, 1503]), {});
  // master ship 11 is a friend ship in the test master; escape position 2 = ship 11
  await session.handle("/kcsapi/api_req_sortie/battleresult", { ...f.resultWithDrop, api_get_ship: { api_ship_id: 11, api_ship_name: "x" }, api_escape_flag: 1, api_escape: { api_escape_idx: [2], api_tow_idx: [] } });
  await session.handle("/kcsapi/api_req_sortie/goback_port", {});
  await session.handle("/kcsapi/api_port/port", { api_combined_flag: 0 });
  const { token } = await h.register();
  h.clock.t += 61_000;
  await idb.uploadPending("http://localhost", { token, fetch: h.fetch as typeof fetch });
  await drainJobs(h);
  const stored = JSON.parse((await rows("SELECT sortie FROM observations WHERE kind = 'sortie'"))[0]!.sortie as string);
  expect(stored).toMatchObject({ deckId: 1, fleetSize: 3, escortSize: 0, fleetType: "single", gauge: { gaugeNum: 1, gaugeType: 2 } });
  expect(stored.cells[0].result).toMatchObject({ rank: "A", drop: { shipId: 11 }, escape: { idx: [2], shipIds: [11], retreated: true } });
  expect((await snapshot()).drops.map((d) => [d.map_id, d.difficulty, d.cell_no, d.rank, d.ship_id, d.count])).toEqual([[15, 0, 1, "A", 11, 1]]);
  expect((await rows("SELECT COUNT(*) AS n FROM observations WHERE quarantine IS NOT NULL"))[0]!.n).toBe(0);
});
