// KC3Kai/kancolle-replay js/kcSHIPDATA.js (MIT) -> abyssal visible stats on `ships` + hidden stats in `estimates`.
import { runInNewContext } from "node:vm";
import { execStatements } from "./lib/d1";
import { fetchGithub } from "./lib/fetch";
import { lit, sourceRef, sourceUpsert, upsert } from "./lib/sql";
import { SHIP_TYPES, type ShipTypeCode } from "../src/routing/schema";

const FILE = { owner: "KC3Kai", repo: "kancolle-replay", ref: "master", path: "js/kcSHIPDATA.js" };
const KEY = "kancolle-replay-shipdata";

/**
 * kcSHIPDATA stat key -> estimates.stat. TACC is kcsim's innate *torpedo* accuracy (`tacc`), not the
 * general hidden accuracy `acc`, which only the estimator produces (private notes API §2).
 */
export const HIDDEN_STATS = { EV: "ev", ASW: "asw", LOS: "los", LUK: "luck", TACC: "tacc" } as const;
/** kancolle-replay STAT_UNKNOWN codes (js/simulator-ui/fleet-editor.js) -> estimates.confidence */
const CONFIDENCE: Record<number, string> = { 1: "unknown", 2: "placeholder", 3: "db_estimate" };

const STAT_KEYS = new Set(["name", "nameJP", "image", "type", "HP", "FP", "TP", "AA", "AR", "EV", "ASW", "LOS", "LUK", "TACC",
  "RNG", "SPD", "SLOTS", "EQUIPS", "unknownstats", "fuel", "ammo", "imageDam"]);

export interface AbyssalRow {
  id: number;
  ship: Record<string, unknown>;
  estimates: { stat: string; value: number; confidence: string }[];
}

/** Evaluates kcSHIPDATA.js in an empty vm context and extracts abyssal entries (1501..4999). Pure apart from vm. */
export function parseShipData(code: string): AbyssalRow[] {
  const data = runInNewContext(`${code}\n;SHIPDATA`, {}, { timeout: 10_000 }) as Record<string, Record<string, unknown>>;
  const rows: AbyssalRow[] = [];
  for (const [key, s] of Object.entries(data)) {
    const id = Number(key);
    if (!(id > 1500 && id < 5000)) continue;
    const unknown = (s.unknownstats ?? {}) as Record<string, number>;
    const flags: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) {
      if (STAT_KEYS.has(k)) continue;
      flags[k] = typeof v === "function" ? "function" : v;
    }
    const estimates = Object.entries(HIDDEN_STATS)
      .filter(([k]) => typeof s[k] === "number")
      .map(([k, stat]) => ({ stat, value: s[k] as number, confidence: CONFIDENCE[unknown[k]!] ?? "datamined" }));
    rows.push({
      id,
      ship: {
        name: s.nameJP ?? s.name, name_en: s.name ?? null, stype: SHIP_TYPES[s.type as ShipTypeCode] ?? 0,
        hp: s.HP ?? null, fp: s.FP ?? null, tp: s.TP ?? null,
        aa: s.AA ?? null, ar: s.AR ?? null, range: s.RNG ?? null, speed: s.SPD ?? null, slots: s.SLOTS ?? null,
        equips: s.EQUIPS ?? null, flags: Object.keys(flags).length ? flags : null,
      },
      estimates,
    });
  }
  return rows;
}

export async function ingestAbyssal(): Promise<void> {
  const { text, url, revision } = await fetchGithub(FILE);
  const rows = parseShipData(text);
  const now = new Date().toISOString();
  const src = sourceRef(KEY);
  // Insert-or-update. start2 owns stype/name; kcSHIPDATA's type code is used only for ids start2 lacks.
  const shipStatements = rows.map((r) => {
    const s = r.ship;
    return `INSERT INTO ships (id, name, name_en, stype, is_abyssal, hp, fp, tp, aa, ar, range, speed, slots, equips, flags, source_id, updated_at)
VALUES (${lit(r.id)}, ${lit(s.name as string)}, ${lit(s.name_en as string)}, ${lit(s.stype as number)}, 1, ${[s.hp, s.fp, s.tp, s.aa, s.ar, s.range, s.speed, s.slots, s.equips, s.flags].map((v) => lit(v as never)).join(", ")}, ${src.sql}, ${lit(now)})
ON CONFLICT (id) DO UPDATE SET name_en = excluded.name_en, hp = excluded.hp, fp = excluded.fp, tp = excluded.tp, aa = excluded.aa, ar = excluded.ar,
range = excluded.range, speed = COALESCE(ships.speed, excluded.speed), slots = excluded.slots, equips = excluded.equips, flags = excluded.flags, updated_at = excluded.updated_at;`;
  });
  const estimates = rows.flatMap((r) => r.estimates.map((e) => ({
    ship_id: r.id, stat: e.stat, value: e.value, confidence: e.confidence, sd: null, n: null,
    source_id: src, note: null, updated_at: now,
  })));
  await execStatements("abyssal", [
    sourceUpsert({ key: KEY, name: "kancolle-replay kcSHIPDATA.js", url, licence: "MIT", revision }),
    ...shipStatements,
    `DELETE FROM estimates WHERE source_id = ${src.sql};`,
    ...upsert("estimates", estimates, ["ship_id", "stat", "source_id"]),
  ]);
  const byConf: Record<string, number> = {};
  for (const e of estimates) byConf[`${e.stat}:${e.confidence}`] = (byConf[`${e.stat}:${e.confidence}`] ?? 0) + 1;
  console.log(`abyssal @${revision.slice(0, 12)}: ${rows.length} ships, ${estimates.length} estimates`, byConf);
}

if (import.meta.main) await ingestAbyssal();
