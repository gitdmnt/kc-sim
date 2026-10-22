/**
 * 合成データでの回復テスト: 既知の隠しステータスを持つ敵で runBattle(log) を回し、ログを捕捉形式に
 * 変換して推定器に通す。wasm は sim-core/pkg から読み込む。
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { hitProbability, initSync, runBattle } from "@sim-core";
import type { BattleInput, EquipmentInput, Formation, ShipInput } from "@sim-core";
import { estimateFromObservations } from "./infer";
import type { PriorInput, PriorTable } from "./infer";
import { buildObservations } from "./observe";
import { captureFromRun, syntheticWorld } from "./synthetic";
import type { SyntheticRecord } from "./synthetic";
import type { EstimatedStat, EstimateResult, Observation } from "./types";

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../sim-core/pkg/sim_core_bg.wasm", import.meta.url)) });
});

// ---- 検証用の艦隊 ----

const gun = (id: number, fp: number, acc: number): EquipmentInput => ({ id, types: [1, 1, 2, 2, 0], stats: { firepower: fp, accuracy: acc, range: 2 } });
const smallGun = (id: number): EquipmentInput => ({ id, types: [1, 1, 1, 1, 0], stats: { firepower: 2, accuracy: 1, range: 1 } });
const torp = (id: number): EquipmentInput => ({ id, types: [5, 5, 5, 5, 0], stats: { torpedo: 10, accuracy: 1, range: 1 } });
const sonar = (id: number): EquipmentInput => ({ id, types: [17, 18, 14, 18, 0], stats: { asw: 10, accuracy: 2 } });
const charge = (id: number): EquipmentInput => ({ id, types: [17, 7, 15, 17, 0], stats: { asw: 8 } });

type FriendOpts = Partial<Omit<ShipInput, "stats">> & { ev: number; luck: number; asw?: number };
const friendShip = (id: number, shipType: number, level: number, o: FriendOpts, slots: (EquipmentInput | null)[]): ShipInput => {
  const { ev, luck, asw, ...rest } = o;
  return {
    id, shipType, level, maxHp: 60, morale: 49,
    stats: { firepower: 40, torpedo: 60, antiAir: 30, armor: 90, evasion: ev, asw: asw ?? 40, los: 20, luck },
    slots,
    ...rest,
  };
};

const FRIEND: ShipInput[] = [
  friendShip(9001, 5, 60, { ev: 45, luck: 12, morale: 53 }, [gun(101, 8, 2), gun(101, 8, 2), null]),
  friendShip(9002, 3, 50, { ev: 60, luck: 15 }, [smallGun(102), torp(103), null]),
  friendShip(9003, 2, 45, { ev: 75, luck: 20, fuel: 8, fuelMax: 16 }, [smallGun(102), smallGun(102), null]),
  friendShip(9004, 2, 55, { ev: 70, luck: 30 }, [torp(103), torp(103), null]),
  friendShip(9005, 2, 40, { ev: 65, luck: 10 }, [smallGun(102), torp(103), sonar(104)]),
  friendShip(9006, 2, 50, { ev: 80, luck: 8, asw: 85, maxHp: 34 }, [sonar(104), charge(105), smallGun(102)]),
];

const TRUE = { ev: 40, luck: 10, acc: 30 };
const target = (o: Partial<ShipInput> = {}): ShipInput => ({
  id: 1700, shipType: 3, level: 1, maxHp: 400,
  stats: { firepower: 10, torpedo: 20, antiAir: 10, armor: 250, evasion: TRUE.ev, luck: TRUE.luck },
  hiddenAccuracy: TRUE.acc,
  slots: [{ id: 1550, types: [1, 1, 1, 1, 0], stats: { firepower: 3, accuracy: 2 } }, { id: 1551, types: [3, 5, 5, 5, 0], stats: { torpedo: 10 } }],
  ...o,
});
const SUB = { ev: 25, luck: 5, acc: 10 };
const sub = (): ShipInput => ({
  id: 1701, shipType: 13, level: 50, maxHp: 300,
  stats: { firepower: 0, torpedo: 20, antiAir: 0, armor: 200, evasion: SUB.ev, luck: SUB.luck },
  hiddenAccuracy: SUB.acc,
  slots: [{ id: 1552, types: [5, 5, 5, 5, 0], stats: { torpedo: 8 } }],
});

/** 決定的な疑似乱数 (mulberry32) */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

interface Dataset {
  records: SyntheticRecord[];
  observations: Observation[];
}

/** 被弾側・攻撃側の観測がそれぞれ `want` 件以上になるまで戦闘を回す。 */
const simulate = (enemy: ShipInput[], want: number, seed: number, formations: Formation[]): Dataset => {
  const world = syntheticWorld(FRIEND, enemy);
  const rand = rng(seed);
  const records: SyntheticRecord[] = [];
  let observations: Observation[] = [];
  for (let i = 0; ; i++) {
    const input: BattleInput = {
      friend: { ships: FRIEND, formation: formations[Math.floor(rand() * formations.length)] },
      enemy: { ships: enemy, formation: formations[Math.floor(rand() * formations.length)] },
      options: { kind: "dayNight", log: true },
    };
    const out = runBattle(input, seed * 100_000 + i);
    records.push(...captureFromRun(input, out, { id: `b${seed}-${i}`, capturedAt: i * 10, step: 1 }));
    if (i % 20 === 19) {
      observations = buildObservations(records, { ...world }).observations;
      const ev = observations.filter((o) => o.role === "evasion" && o.shipId === 1700).length;
      const acc = observations.filter((o) => o.role === "accuracy" && o.shipId === 1700).length;
      if (ev >= want && acc >= want) return { records, observations };
    }
  }
};

/** 対象艦 1700 の evasion / accuracy 観測を先頭からそれぞれ n 件 */
const take = (obs: Observation[], n: number) => [
  ...obs.filter((o) => o.shipId === 1700 && o.role === "evasion").slice(0, n),
  ...obs.filter((o) => o.shipId === 1700 && o.role === "accuracy").slice(0, n),
];

/** 対象艦 1700 の事前分布 */
const priors = (p: PriorTable[number]): PriorTable => ({ 1700: p });
const datamined = (value: number): PriorInput => ({ value, confidence: "datamined", source: "test" });
const placeholder = (value: number): PriorInput => ({ value, confidence: "placeholder", source: "test" });
const pick = (r: EstimateResult[], stat: EstimatedStat) => r.find((x) => x.shipId === 1700 && x.stat === stat)!;
const width = (r: EstimateResult) => r.ci90[1] - r.ci90[0];
const fmt = (r: EstimateResult) => `${r.mean.toFixed(1)} ± ${r.sd.toFixed(1)} [${r.ci90[0]}, ${r.ci90[1]}] n=${r.n}`;

describe("forward-model reconstruction", () => {
  test("observation queries reproduce the engine's pHit / pCrit exactly", () => {
    // 潜水艦 (先制対潜・対潜・開幕雷撃) と警戒陣 (位置依存) も含める
    const enemy = [target(), target(), target(), sub(), target(), sub()];
    const formations: Formation[] = ["lineAhead", "doubleLine", "diamond", "echelon", "lineAbreast", "vanguard"];
    const { records } = simulate(enemy, 600, 7, formations);
    const world = syntheticWorld(FRIEND, enemy);
    const truth: Record<number, typeof TRUE> = { 1700: TRUE, 1701: SUB };
    const kinds = new Set<string>();
    let checked = 0;
    for (const r of records) {
      const { observations } = buildObservations([r], { ...world });
      for (const o of observations) {
        const src = r.source[o.seq];
        const t = truth[o.shipId];
        const q = structuredClone(o.query);
        const ship = o.role === "evasion" ? q.defender : q.attacker;
        ship.stats.evasion = t.ev;
        ship.stats.luck = t.luck;
        ship.hiddenAccuracy = t.acc;
        const hp = hitProbability(q);
        expect([hp.pHit, hp.pCrit, o.outcome]).toEqual([src.pHit, src.pCrit, src.hit === "critical" ? "crit" : src.hit]);
        kinds.add(`${q.kind}/${o.role}/${q.special ?? "normal"}`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
    for (const k of ["shelling/evasion/normal", "shelling/accuracy/normal", "torpedo/evasion/normal", "torpedo/accuracy/normal",
      "night/accuracy/normal", "asw/evasion/normal", "openingAsw/evasion/normal"]) {
      expect(kinds).toContain(k);
    }
    // 夜戦の味方はほぼ全艦が連撃かカットイン装備
    expect([...kinds].some((k) => /^night\/evasion\/night(DoubleAttack|Cutin)/.test(k))).toBe(true);
  });
});

describe("synthetic recovery (true ev 40, acc 30, luck 10)", () => {
  let data: Dataset;
  beforeAll(() => {
    data = simulate([target(), target(), target(), target(), target(), target()], 5000, 1, ["lineAhead", "doubleLine", "diamond", "echelon", "lineAbreast"]);
  });

  test("posterior covers the truth and the 90% CI shrinks with N", () => {
    // 運は datamined の事前分布 (真値)、回避・命中は平坦 (placeholder)
    const prior = priors({ ev: placeholder(80), acc: placeholder(100), luck: datamined(TRUE.luck) });
    const rows: string[] = [];
    let last: Record<"ev" | "acc", number> = { ev: Infinity, acc: Infinity };
    for (const n of [200, 1000, 5000]) {
      const r = estimateFromObservations(take(data.observations, n), prior);
      const ev = pick(r, "ev");
      const acc = pick(r, "acc");
      rows.push(`N=${n}: ev ${fmt(ev)} | acc ${fmt(acc)} | luck ${fmt(pick(r, "luck"))}`);
      for (const [stat, est] of [["ev", ev], ["acc", acc]] as const) {
        expect(est.n).toBe(n);
        expect(est.ci90[0]).toBeLessThanOrEqual(TRUE[stat]);
        expect(est.ci90[1]).toBeGreaterThanOrEqual(TRUE[stat]);
        expect(width(est)).toBeLessThan(last[stat]);
        last = { ...last, [stat]: width(est) };
      }
    }
    console.log(rows.join("\n"));
    expect(last.ev).toBeLessThanOrEqual(8);
    expect(last.acc).toBeLessThanOrEqual(8);
  });

  test("weakly identified luck: flat luck prior widens ev/acc but the CI stays honest", () => {
    const obs = take(data.observations, 5000);
    const flat = estimateFromObservations(obs, priors({}));
    const narrow = estimateFromObservations(obs, priors({ luck: datamined(TRUE.luck) }));
    for (const stat of ["ev", "acc"] as const) {
      const f = pick(flat, stat);
      expect(f.ci90[0]).toBeLessThanOrEqual(TRUE[stat]);
      expect(f.ci90[1]).toBeGreaterThanOrEqual(TRUE[stat]);
      expect(width(f)).toBeGreaterThan(width(pick(narrow, stat)));
    }
    // 運は ev + √(2·luck) と acc + 1.5√luck にしか現れないので、平坦な事前分布のままではほとんど絞れない
    expect(width(pick(flat, "luck"))).toBeGreaterThan(40);
    console.log(`flat luck prior, N=5000: ev ${fmt(pick(flat, "ev"))} | acc ${fmt(pick(flat, "acc"))} | luck ${fmt(pick(flat, "luck"))}`);
  });

  test("no observations of a role: that stat keeps its prior", () => {
    const evOnly = take(data.observations, 300).filter((o) => o.role === "evasion");
    const r = estimateFromObservations(evOnly, priors({ acc: datamined(55), luck: datamined(TRUE.luck) }));
    const acc = pick(r, "acc");
    expect(acc.n).toBe(0);
    expect(acc.mean).toBeCloseTo(55, 6);
    expect(acc.sd).toBeCloseTo(acc.prior.sd, 6);
  });
});

describe("calibration", () => {
  test("90% CIs cover the truth in most replicates (various true values, N = 300 each)", () => {
    const cases = [[10, 0], [15, 10], [25, 20], [40, 30], [40, 45], [55, 30], [70, 50], [70, 15], [100, 25], [130, 60]];
    const covered = { ev: 0, acc: 0 };
    const rows: string[] = [];
    cases.forEach(([ev, acc], i) => {
      const t = target({ stats: { ...target().stats, evasion: ev }, hiddenAccuracy: acc });
      const d = simulate([t, t, t, t, t, t], 300, 100 + i, ["lineAhead", "doubleLine", "diamond", "echelon", "lineAbreast"]);
      const r = estimateFromObservations(take(d.observations, 300), priors({ ev: placeholder(80), acc: placeholder(100), luck: datamined(TRUE.luck) }));
      const truth = { ev, acc };
      for (const stat of ["ev", "acc"] as const) {
        const e = pick(r, stat);
        if (e.ci90[0] <= truth[stat] && truth[stat] <= e.ci90[1]) covered[stat]++;
      }
      rows.push(`true ev ${ev} acc ${acc}: ev ${fmt(pick(r, "ev"))} | acc ${fmt(pick(r, "acc"))}`);
    });
    console.log(rows.join("\n"));
    expect(covered.ev).toBeGreaterThanOrEqual(8);
    expect(covered.acc).toBeGreaterThanOrEqual(8);
  });
});
