// Synthetic sorties for the benchmarks: engine battles (sim-core runBattle) captured as the plugin does and
// turned into upload items that pass server validation (same shapes as test/estimator.test.ts). No bun or Node
// APIs: bench/micro.ts uses it inside workerd too.
import { runBattle } from "../../sim-core/pkg/sim_core";
import type { BattleInput, EquipmentInput, Formation, ShipInput } from "../../sim-core/pkg/sim_core";
import { battlePacket, captureFromRun, type SyntheticRecord } from "../../shared/estimate/synthetic";

/** 1-5's api_cell_data cells (test/helpers.ts LAYOUT_15). */
const LAYOUT_15 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const gun = (id: number, fp: number, acc: number): EquipmentInput => ({ id, types: [1, 1, 2, 2, 0], stats: { firepower: fp, accuracy: acc, range: 2 } });
const smallGun = (id: number): EquipmentInput => ({ id, types: [1, 1, 1, 1, 0], stats: { firepower: 2, accuracy: 1, range: 1 } });
const torp = (id: number): EquipmentInput => ({ id, types: [5, 5, 5, 5, 0], stats: { torpedo: 10, accuracy: 1, range: 1 } });
const friendShip = (id: number, shipType: number, level: number, ev: number, luck: number, slots: (EquipmentInput | null)[], o: Partial<ShipInput> = {}): ShipInput => ({
  id, shipType, level, maxHp: 60, morale: 49, stats: { firepower: 40, torpedo: 60, antiAir: 30, armor: 90, evasion: ev, asw: 40, los: 20, luck }, slots, ...o,
});

export const FRIEND: ShipInput[] = [
  friendShip(101, 5, 60, 45, 12, [gun(201, 8, 2), gun(201, 8, 2), null], { morale: 53 }),
  friendShip(102, 3, 50, 60, 15, [smallGun(202), torp(203), null]),
  friendShip(103, 2, 45, 75, 20, [smallGun(202), smallGun(202), null], { fuel: 8, fuelMax: 16 }),
  friendShip(104, 2, 55, 70, 30, [torp(203), torp(203), null]),
  friendShip(105, 2, 40, 65, 10, [smallGun(202), torp(203), null]),
  friendShip(106, 2, 50, 80, 8, [smallGun(202), torp(203), smallGun(202)]),
];

const enemy = (id: number, shipType: number, ev: number, luck: number, acc: number, armor: number): ShipInput => ({
  id, shipType, level: 1, maxHp: 120, stats: { firepower: 30, torpedo: 40, antiAir: 10, armor, evasion: ev, luck }, hiddenAccuracy: acc,
  slots: [{ id: 1550, types: [1, 1, 1, 1, 0], stats: { firepower: 3, accuracy: 2 } }, { id: 1551, types: [3, 5, 5, 5, 0], stats: { torpedo: 10 } }],
});
/** Four abyssal ship types; a battle meets six ships drawn from them. */
export const ENEMIES: ShipInput[] = [enemy(1700, 3, 40, 10, 30, 60), enemy(1701, 2, 55, 12, 20, 30), enemy(1702, 5, 30, 15, 40, 90), enemy(1703, 9, 20, 20, 50, 150)];
const FORMATIONS: Formation[] = ["lineAhead", "doubleLine", "diamond", "echelon", "lineAbreast"];

/**
 * `battles` day + night battles (two records each) starting at `t0`. Mixed: formations and enemy line-ups rotate
 * (many distinct attack signatures, a pessimistic case). Farm: one fleet, one formation pair, one line-up, as when
 * a player repeats a map node.
 */
export function simulate(battles: number, seed: number, t0: number, mode: "mixed" | "farm" = "mixed"): SyntheticRecord[] {
  const records: SyntheticRecord[] = [];
  const farm = mode === "farm";
  for (let i = 0; i < battles; i++) {
    const ships = [0, 1, 2, 3, 4, 5].map((k) => ENEMIES[farm ? Math.min(k, 3) : (seed + i * 3 + k * 7) % ENEMIES.length]!);
    const input: BattleInput = {
      friend: { ships: FRIEND, formation: farm ? "lineAhead" : FORMATIONS[(seed + i) % 5] },
      enemy: { ships, formation: farm ? "doubleLine" : FORMATIONS[(seed * 7 + i * 3) % 5] },
      options: { kind: "dayNight", log: true },
    };
    records.push(...captureFromRun(input, runBattle(input, seed * 100_000 + i), { id: `s${seed}-b${i}`, capturedAt: t0 + i * 60_000 }));
  }
  return records;
}

/** One upload item as the plugin sends it (db.ts battleObservation). */
export const uploadItem = (r: SyntheticRecord) => ({
  clientObsId: r.battle.id, observedAt: new Date(r.battle.capturedAt).toISOString(), map: "1-5", cell: 1, layout: LAYOUT_15, difficulty: 0,
  kind: "battle", fleet: r.battle.fleet, raw: { path: r.battle.path, visitId: r.battle.visitId, sortieId: null, raw: r.battle.raw, result: null },
});

/** One upload body with a real-data 1-5 A battle: 潜水カ級 (1532, master stats and equipment) against 吹雪 and 睦月. */
export function realUploadBody(seq: number): string {
  const friends = [{ id: 9, hp: 16 }, { id: 1, hp: 13 }];
  const enemy: ShipInput[] = [{
    id: 1532, shipType: 13, level: 50, maxHp: 27, stats: { firepower: 0, torpedo: 64, antiAir: 0, armor: 21 },
    slots: [1515, 1513, 1513].map((s) => ({ id: s, types: [2, 3, 5, 5, 0] })),
  }];
  const friend = friends.map((f): ShipInput => ({ id: f.id, shipType: 2, level: 50, maxHp: f.hp, stats: { firepower: 0, torpedo: 0, antiAir: 0, armor: 0 }, slots: [] }));
  const raw = battlePacket({ path: "api_req_sortie/battle", formation: [1, 1, 1], friend, enemy, startHp: [friend.map((s) => s.maxHp), [27]], events: [] });
  const fleet = {
    deckId: 1,
    ships: friends.map((f) => ({
      masterId: f.id, level: 50, luckMod: 0, hpMod: 0, aswMod: 0, morale: 49, equips: [{ masterId: 2, improvement: 0, proficiency: 0 }, null],
      observed: { maxHp: f.hp, nowHp: f.hp, firepower: 30, torpedo: 60, antiAir: 30, armor: 30, evasion: 60, asw: 40, los: 15, luck: 12, range: 1, speed: 10 },
    })),
    supply: friends.map(() => ({ fuel: 15, fuelMax: 15, ammo: 20, ammoMax: 20 })),
  };
  return JSON.stringify({
    observations: [{
      clientObsId: `cold-${Date.now()}-${seq}`, observedAt: new Date(Date.now() - 60_000).toISOString(), map: "1-5", cell: 1,
      layout: LAYOUT_15, difficulty: 0,
      kind: "battle", fleet, raw: { path: "api_req_sortie/battle", visitId: `cold-v${seq}`, sortieId: null, raw, result: null },
    }],
  });
}

