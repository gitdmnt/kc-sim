// loadMaster brings in the whole remodel line of each requested ship (migration 0012 `base_id`), so
// shared/sim/fit.ts resolves shipS (first form) and shipNationality (api_sort_id) on the server.
import { beforeEach, expect, test } from "bun:test";
import { loadMaster } from "../src/master";
import { computeFitBonus, fitShipOf } from "../../shared/sim/fit";
import { harness, type Harness } from "./helpers";

let h: Harness;
beforeEach(() => {
  h = harness();
});

const NOW = "2026-10-24T00:00:00Z";

test("remodel line and nationality reach the fit-bonus ship", async () => {
  // 榛名 21 → 榛名改 86 → 榛名改二 151 (first form 21); Johnston 562 (US sort id range)
  await h.db.prepare(
    `INSERT INTO ships (id, name, stype, is_abyssal, after_ship_id, sort_id, base_id, updated_at) VALUES
       (21, '榛名', 8, 0, 86, 1641, 21, ?1), (86, '榛名改', 9, 0, 151, 1642, 21, ?1), (151, '榛名改二', 9, 0, NULL, 1643, 21, ?1),
       (562, 'Johnston', 2, 0, 689, 31661, 562, ?1), (689, 'Johnston改', 2, 0, NULL, 31662, 562, ?1)`,
  ).bind(NOW).run();
  const m = await loadMaster(h.db, [151, 689], []);
  expect(Object.keys(m.data.ships).map(Number).sort((a, b) => a - b)).toEqual([21, 86, 151, 562, 689]);
  const haruna = fitShipOf(151, m.data);
  expect(haruna.baseId).toBe(21);
  // nationality comes from api_sort_id (EO ranges); undefined before (no sort id on the server)
  const johnston = fitShipOf(689, m.data);
  expect(johnston.baseId).toBe(562);
  expect(johnston.nationality).toBeDefined();
  // A shipS entry for the 榛名 line now resolves (not counted as unresolved).
  const entry = { id: 1, ids: [1], types: null, bonuses: [{ shipS: [21], bonus: { houg: 2 } }] };
  const r = computeFitBonus(haruna, [{ masterId: 1, type2: 1, improvement: 0 }], [entry]);
  expect(r.unresolved).toBe(0);
  expect(r.bonus.houg).toBe(2);
});
