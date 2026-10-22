/**
 * 開発用 (vite dev のみ): runBattle のログから捕捉形式の戦闘を作って IndexedDB に入れる。
 * 推定タブの動作確認とスクリーンショット用。設定タブのデバッグ欄から動的 import される
 * (本番ビルドには入らない。poi のウィンドウではページ内の wasm が CSP で動かない)。
 *
 * 味方: poi (またはサンプル state) の第1艦隊。敵: 実在の深海棲艦 (API のマスター・装備)。
 * 真の隠しステータスは API の best に既知のずれ (TRUE_SHIFT) を足した値なので、推定タブで
 * 事前分布からのずれとして見える。送信対象にはしない (pending = 0)。
 */
import init, { runBattle } from "@sim-core";
import type { BattleInput, Formation, ShipInput } from "@sim-core";
import wasmBytes from "@sim-core/sim_core_bg.wasm?bytes";
import type { ObservationDb } from "../capture/db";
import type { DataApi } from "../data/api";
import type { ShipDetail } from "../data/types";
import { importFromPoi } from "../fleet/poiImport";
import type { MasterData } from "../fleet/types";
import { buildEnemyShips, buildFriendShips } from "../sim/adapter";
import { captureFromRun } from "./synthetic";

/** 合成データに使う敵 (駆逐・軽巡・重巡) */
const POOL = [1501, 1502, 1503, 1505, 1509, 1514];
/** 真値 = best + ずれ */
export const TRUE_SHIFT = { ev: 12, acc: -6, luck: 0 };
const FORMATIONS: Formation[] = ["lineAhead", "doubleLine", "diamond", "echelon", "lineAbreast"];

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export interface SeedResult {
  battles: number;
  truth: { shipId: number; name: string; ev: number; acc: number; luck: number }[];
}

export const seedSyntheticObservations = async (
  state: unknown,
  master: MasterData,
  db: ObservationDb,
  api: DataApi,
  opts: { battles?: number; seed?: number } = {}
): Promise<SeedResult> => {
  await init({ module_or_path: wasmBytes });
  const preset = importFromPoi(state, 0);
  if (!preset) throw new Error("第1艦隊を取得できません (サンプルデータを使う設定にしてください)");
  const [ships, equips] = await Promise.all([api.abyssalShips(), api.abyssalEquipments()]);
  const fit = await api.fitBonuses().then((r) => r.data).catch(() => undefined);
  const shipById = new Map(ships.data.map((s) => [s.id, s]));
  const equipById = new Map(equips.data.map((e) => [e.id, e]));
  const details = new Map<number, ShipDetail>();
  await Promise.all(POOL.map((id) => api.ship(id).then((r) => void details.set(id, r.data)).catch(() => undefined)));
  const lookup = { ship: (id: number) => shipById.get(id), equip: (id: number) => equipById.get(id), detail: (id: number) => details.get(id) };

  const friend = buildFriendShips(preset, master, { fitBonuses: fit }).input;
  const enemies = new Map<number, ShipInput>();
  for (const id of POOL) {
    const s = shipById.get(id);
    if (!s) continue;
    const comp = { shipId: id, level: 1, hp: s.hp ?? 20, fp: s.fp ?? 0, tp: s.tp ?? 0, aa: s.aa ?? 0, ar: s.ar ?? 0, equips: s.equips ?? [] };
    const base = buildEnemyShips([comp], lookup).input[0];
    enemies.set(id, {
      ...base,
      stats: {
        ...base.stats,
        evasion: Math.max(0, (base.stats.evasion ?? 0) + TRUE_SHIFT.ev),
        luck: Math.max(0, (base.stats.luck ?? 0) + TRUE_SHIFT.luck),
      },
      hiddenAccuracy: Math.max(0, (base.hiddenAccuracy ?? 0) + TRUE_SHIFT.acc),
    });
  }
  const pool = [...enemies.values()];
  if (pool.length === 0) throw new Error("API から深海棲艦のマスターを取得できません");

  const rand = rng(opts.seed ?? 1);
  const n = opts.battles ?? 500;
  const t0 = Date.now() - n * 60_000;
  for (let i = 0; i < n; i++) {
    const size = 4 + Math.floor(rand() * 3);
    const input: BattleInput = {
      friend: { ships: friend, formation: FORMATIONS[Math.floor(rand() * FORMATIONS.length)] },
      enemy: { ships: Array.from({ length: size }, () => pool[Math.floor(rand() * pool.length)]), formation: FORMATIONS[Math.floor(rand() * FORMATIONS.length)] },
      options: { kind: "dayNight", log: true },
    };
    const records = captureFromRun(input, runBattle(input, (opts.seed ?? 1) * 1_000_003 + i), {
      id: `synthetic-${opts.seed ?? 1}-${i}`,
      capturedAt: t0 + i * 60_000,
      map: "1-5",
    });
    for (const r of records) {
      await db.saveBattle(
        { ...r.battle, pending: 0 },
        r.events.map((e) => ({ ...e, battleId: r.battle.id, map: "1-5", node: "A" }))
      );
    }
  }
  return {
    battles: n,
    truth: pool.map((s) => ({ shipId: s.id ?? 0, name: s.name ?? "", ev: s.stats.evasion ?? 0, acc: s.hiddenAccuracy ?? 0, luck: s.stats.luck ?? 0 })),
  };
};
