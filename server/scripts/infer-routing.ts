// Routing from our own poi sortie observations (private notes ROUTING_INFERENCE), run daily by GitHub Actions
// (.github/workflows/jobs.yml) against production D1 (D1_REMOTE=1; locally the wrangler D1 file). Sends no KCNav
// request. Per map, on the sorties of its newest layout:
//   - maps without hand-authored rules: infer a routing document (≥ --min-sorties usable sorties), validate it
//     against the map's edges and, with --write, store it in routing_inferred (served by the API);
//   - maps with hand-authored rules: check the observations against them (moves the rules cannot produce, branch
//     shares that differ for fleets the rules treat alike) and, with --write, store the report in routing_checks.
//     The rules themselves are never changed.
// Prints a markdown report (also to $GITHUB_STEP_SUMMARY) and with --out writes the documents as files.
//
// Usage: bun scripts/infer-routing.ts [--maps 1-5,62-1] [--min-sorties 100] [--write] [--out .tmp/inferred]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ROUTING_HEAD_COLS, ROUTING_RULE_COLS, routingDocJson } from "../src/assemble";
import { bumpDataVersion } from "../src/cache";
import { mapName, parseMapKey } from "../src/maps";
import { routingDoc } from "../src/routing/schema";
import { countRules, type Edge } from "../src/routing/validate";
import { openD1 } from "./lib/d1-database";
import {
  checkHandRules, inferRouting, observedSortie, observedSortieRow, parseStart2Ships, shipFamilies, type SortieSample,
} from "./lib/routing-infer";
import { appendSummary } from "./lib/summary";
import * as z from "zod";

const ROOT = new URL("../", import.meta.url).pathname;
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { maps: { type: "string" }, "min-sorties": { type: "string", default: "100" }, write: { type: "boolean" }, out: { type: "string" } },
});
const minSorties = Number(values["min-sorties"]);
const wanted = values.maps?.split(",").map((m) => parseMapKey(m.trim())?.id).filter((x): x is number => x !== undefined);
const db = openD1();
const now = new Date().toISOString();
/** Observation rows per page: fleet + sortie JSON are a few KB each. */
const PAGE = 200;
const USABLE = "kind = 'sortie' AND quarantine IS NULL AND sortie IS NOT NULL AND fleet IS NOT NULL AND difficulty IS NOT NULL";

const maps = (await db.prepare(`SELECT map_id, COUNT(*) AS n FROM observations WHERE ${USABLE} GROUP BY map_id ORDER BY map_id`)
  .all<{ map_id: number; n: number }>()).results.filter((m) => !wanted || wanted.includes(m.map_id));

// Ship families for countIds features: the npm api_start2 snapshot when installed (stale for new ships).
const start2 = `${ROOT}../web/node_modules/@kancolle/data/api/api_start2.json`;
const families = existsSync(start2) ? shipFamilies(parseStart2Ships(await Bun.file(start2).json())) : [];
const equipType = z.array(z.number());

interface Line { map: string; layout: string; sorties: number; skipped: string; result: string }
const lines: Line[] = [];
const details: string[] = [];
let wrote = false;

for (const { map_id: mapId } of maps) {
  const map = mapName(mapId);
  const layoutRow = await db.prepare("SELECT layout FROM poi_layouts WHERE map_id = ?1 ORDER BY version DESC LIMIT 1").bind(mapId).first<{ layout: string }>();
  const layout = layoutRow?.layout ?? "";
  const rows: { id: number; difficulty: number | null; fleet: string; sortie: string }[] = [];
  for (let after = 0; ;) {
    const page = (await db.prepare(
      `SELECT id, difficulty, fleet, sortie FROM observations WHERE map_id = ?1 AND ${USABLE} AND COALESCE(layout, '') = ?2 AND id > ?3 ORDER BY id LIMIT ${PAGE}`,
    ).bind(mapId, layout, after).all<{ id: number; difficulty: number | null; fleet: string; sortie: string }>()).results;
    rows.push(...page);
    if (page.length < PAGE) break;
    after = page.at(-1)!.id;
  }
  const parsed = rows.map((r) => observedSortieRow.parse({ difficulty: r.difficulty, fleet: JSON.parse(r.fleet), sortie: JSON.parse(r.sortie) }));
  const shipIds = new Set<number>();
  const equipIds = new Set<number>();
  for (const row of parsed) {
    for (const s of [...(row.fleet?.ships ?? []), ...(row.fleet?.escort ?? [])]) {
      shipIds.add(s.masterId);
      for (const e of [...s.equips, s.exSlot ?? null]) if (e) equipIds.add(e.masterId);
    }
  }
  const [shipRows, equipRows, edgeRows, head, ruleRows] = await Promise.all([
    db.prepare("SELECT id, stype, speed FROM ships WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify([...shipIds]))
      .all<{ id: number; stype: number; speed: number | null }>(),
    db.prepare("SELECT id, type, los FROM equipments WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify([...equipIds]))
      .all<{ id: number; type: string; los: number | null }>(),
    db.prepare("SELECT edge_id, from_letter, to_letter FROM edges WHERE map_id = ?1").bind(mapId).all<{ edge_id: number; from_letter: string; to_letter: string }>(),
    db.prepare(`SELECT ${ROUTING_HEAD_COLS} FROM routing_maps WHERE map_id = ?1`).bind(mapId).first<Record<string, unknown>>(),
    db.prepare(`SELECT ${ROUTING_RULE_COLS} FROM routing_rules WHERE map_id = ?1`).bind(mapId).all<Record<string, unknown>>(),
  ]);
  const line: Line = { map, layout: layout || "(unknown)", sorties: 0, skipped: "", result: "" };
  lines.push(line);
  if (!edgeRows.results.length) {
    line.result = "no edges in D1: enqueue the KCNav `map` job (`bun run kcnav enqueue --maps … --kinds map`)";
    continue;
  }
  const ships = new Map(shipRows.results.map((s) => [s.id, s]));
  const equips = new Map(equipRows.results.map((e) => [e.id, { cat: equipType.parse(JSON.parse(e.type))[2] ?? 0, los: e.los ?? 0 }]));
  const master = { ship: (id: number) => ships.get(id), equip: (id: number) => equips.get(id) };
  const edges: Edge[] = edgeRows.results.map((e) => ({ from: e.from_letter, to: e.to_letter }));
  const byId = new Map(edgeRows.results.map((e) => [e.edge_id, { from: e.from_letter, to: e.to_letter }]));
  const samples: SortieSample[] = [];
  const reasons = new Map<string, number>();
  for (const row of parsed) {
    const s = observedSortie(row, byId, master);
    if ("reason" in s) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
    else samples.push(s);
  }
  line.sorties = samples.length;
  line.skipped = [...reasons].map(([r, n]) => `${n}× ${r}`).join("; ");

  if (head) {
    // Hand-authored rules: report only. A stale inferred document for the map is removed.
    const hand = routingDoc.parse(routingDocJson(head, ruleRows.results));
    const check = checkHandRules(hand, edges, samples);
    const findings = check.impossible.length + check.divergent.length;
    line.result = `hand rules: ${check.decisions} decisions, ${check.impossible.length} impossible moves, ${check.divergent.length} divergent branches`;
    if (findings) {
      details.push(`#### ${map}: observations vs hand-authored rules`, "");
      for (const m of check.impossible) details.push(`- impossible: ${m.node}→${m.to} ×${m.count} (e.g. \`${m.example}\`)`);
      for (const d of check.divergent) {
        details.push(`- divergent at ${d.node} (n=${d.n}, TV ${d.tv}, p=${d.p.toExponential(1)}): expected ${JSON.stringify(d.expected)}, observed ${JSON.stringify(d.observed)}`);
      }
      details.push("");
    }
    if (values.write) {
      wrote = true;
      await db.batch([
        db.prepare(`INSERT INTO routing_checks (map_id, layout, sorties, findings, report, generated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT (map_id) DO UPDATE SET layout = excluded.layout, sorties = excluded.sorties, findings = excluded.findings,
            report = excluded.report, generated_at = excluded.generated_at`)
          .bind(mapId, layout, samples.length, findings, JSON.stringify({ decisions: check.decisions, impossible: check.impossible, divergent: check.divergent }), now),
        db.prepare("DELETE FROM routing_inferred WHERE map_id = ?1").bind(mapId),
      ]);
    }
    continue;
  }

  if (samples.length < minSorties) {
    line.result = `not inferred: ${samples.length} usable sorties (< ${minSorties})`;
    continue;
  }
  const res = inferRouting(map, edges, samples, {
    families, sourceNote: `inferred from ${samples.length} poi sortie observations of layout ${layout || "(unknown)"} on ${now.slice(0, 10)} (scripts/infer-routing.ts)`,
  });
  if (res.errors.length) {
    line.result = `inference produced an invalid document: ${res.errors.slice(0, 3).join("; ")}`;
    continue;
  }
  const counts = countRules(res.doc);
  const learned = res.report.filter((r) => r.kind === "learned");
  const unobserved = res.report.filter((r) => r.kind === "unobserved").map((r) => r.node);
  line.result = `inferred: ${counts.total} rules (${counts.uncertain} uncertain), ${learned.length} branching nodes learned` +
    (unobserved.length ? `, never observed: ${unobserved.join(" ")}` : "");
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    writeFileSync(`${values.out}/${map}.json`, `${JSON.stringify(res.doc, null, 1)}\n`);
  }
  if (values.write) {
    await db.prepare(`INSERT INTO routing_inferred (map_id, layout, sorties, rule_count, uncertain_count, doc, report, source_id, generated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, (SELECT id FROM sources WHERE key = 'poi-inferred'), ?8)
      ON CONFLICT (map_id) DO UPDATE SET layout = excluded.layout, sorties = excluded.sorties, rule_count = excluded.rule_count,
        uncertain_count = excluded.uncertain_count, doc = excluded.doc, report = excluded.report, source_id = excluded.source_id,
        generated_at = excluded.generated_at`)
      .bind(mapId, layout, samples.length, counts.total, counts.uncertain, JSON.stringify(res.doc), JSON.stringify(res.report), now).run();
    wrote = true;
  }
}
// The API serves inferred documents: new ones must not be hidden by cached GETs.
if (wrote) await bumpDataVersion(db).run();

const target = process.env.D1_REMOTE === "1" ? "production D1" : "local D1";
appendSummary([
  `### Routing from observations (${target}${values.write ? "" : ", dry run"})`,
  "",
  maps.length ? "| map | layout | usable sorties | result | skipped |" : "No usable sortie observations.",
  ...(maps.length ? ["|---|---|---|---|---|"] : []),
  ...lines.map((l) => `| ${l.map} | ${l.layout.length > 24 ? `${l.layout.slice(0, 24)}…` : l.layout} | ${l.sorties} | ${l.result} | ${l.skipped} |`),
  "",
  ...details,
].join("\n"));
