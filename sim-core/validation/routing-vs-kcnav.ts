// Routing validation against KCNav nodesummary edge counts (docs/VALIDATION.md §2).
//
// KCNav counts mix every fleet that matched the filter, so no single "representative" fleet can be
// compared with them. Instead the routing evaluator (simulateSortie, wasm pkg, routing only) runs a
// library of archetype fleets — compositions × speeds allowed by the filter × three LoS levels ×
// every player-select choice — and a non-negative mixture of them is fitted to the observed edge
// flows. Rules that are right can reproduce the observed per-node branch shares with some mixture;
// a node that stays off under the best mixture, an observed branch that no fleet can take, or a
// simulated move along an edge KCNav has never seen points at the rules.
//
// Reads the snapshots stored by the data-worker queue (D1 table kcnav_edge_counts, read-only, no
// KCNav request) and GET /api/v1/maps/{m} for edges and routing.
//
//   bun validation/routing-vs-kcnav.ts            # query D1 + API, save snapshot, rewrite docs/VALIDATION.md
//   bun validation/routing-vs-kcnav.ts --offline  # reuse validation/kcnav-snapshot.json
//
// Needs `wasm-pack build --target web` (pkg/) and, unless --offline, the local data-worker on :8787.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { query } from "../../data-worker/scripts/lib/d1.ts";
import { initSync, simulateSortie } from "../pkg/sim_core.js";
import type { EquipmentInput, RoutingDocument, ShipInput, SortieInput, SortieNode, SortieSummary } from "../pkg/sim_core.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const SNAPSHOT = new URL("./kcnav-snapshot.json", import.meta.url).pathname;
const DOC = `${ROOT}docs/VALIDATION.md`;
const API = process.env.DATA_API ?? "http://127.0.0.1:8787/api/v1";
/** Sorties per library fleet (routing only, no battles). */
const COUNT = 2000;
/** Nodes with fewer observed departures are not judged. */
const MIN_OBS = 100;
/** An observed branch counts as "taken by players" from this share and run count. */
const MIN_BRANCH = { share: 0.01, runs: 30 };

initSync({ module: readFileSync(new URL("../pkg/sim_core_bg.wasm", import.meta.url)) });

// ---------------------------------------------------------------- fleets ----

type Code = "DE" | "DD" | "CL" | "CLT" | "CT" | "CA" | "CAV" | "CVL" | "FBB" | "BB" | "BBV" | "CV" | "CVB" | "SS" | "AV" | "AO";
const STYPE: Record<Code, number> = { DE: 1, DD: 2, CL: 3, CLT: 4, CA: 5, CAV: 6, CVL: 7, FBB: 8, BB: 9, BBV: 10, CV: 11, SS: 13, AV: 16, CVB: 18, CT: 21, AO: 22 };
/** Rough Lv99 naked LoS per type. */
const NAKED_LOS: Record<Code, number> = { DE: 30, DD: 45, CL: 50, CLT: 45, CT: 50, CA: 50, CAV: 60, CVL: 60, FBB: 60, BB: 60, BBV: 60, CV: 70, CVB: 70, SS: 25, AV: 60, AO: 30 };
const SPEEDS = { slow: 5, fast: 10, fastPlus: 15, fastest: 20 } as const;
type Speed = keyof typeof SPEEDS;
type LosLevel = "none" | "mid" | "high";

/** LoS equipment per type and level (none: no LoS equipment). */
function losGear(code: Code, level: LosLevel): EquipmentInput[] {
  if (level === "none") return [];
  const n = level === "mid" ? 1 : 2;
  if (code === "CV" || code === "CVB" || code === "CVL") return Array.from({ length: n }, () => ({ id: 61, types: [0, 0, 9, 9, 0], stats: { los: 7 }, planes: 18 }));
  if (code === "CA" || code === "CAV" || code === "BBV" || code === "AV" || code === "FBB" || code === "BB") {
    return Array.from({ length: n }, () => ({ id: 25, types: [0, 0, 10, 10, 0], stats: { los: level === "mid" ? 5 : 8 }, planes: 2 }));
  }
  if (code === "DD" || code === "CL" || code === "CT" || code === "CLT" || code === "DE") return level === "high" ? [{ id: 28, types: [0, 0, 12, 11, 0], stats: { los: 8 } }] : [];
  return [];
}

/** Compositions in the library (flagship first). Broad on purpose: the fit picks the population. */
const COMPS: string[] = [
  "DD", "DE DE DE", "DE DE DE DE", "CVL DE DE DE", "CT DE DE DE", "CL DE DE DE", "CL DD DD DD", "DD DD DD DD",
  "CL DD DD DD DD", "CL DD DD DD DD DD", "AO DE DE DE", "CVL CL DD DD", "CL DD DD CA CA CAV", "CL DD DD DD CA CA",
  "CL DD DD DD DD CAV", "CL CAV DD DD DD DD", "CAV CAV DD DD CL DD", "BBV BBV CA CA CL DD", "BBV BBV CL DD DD DD",
  "CLT CLT CL DD DD DD", "CLT CLT CLT CL DD DD", "AV AV CL DD DD DD", "CVL CVL CL DD DD DD", "CV CV CL DD DD DD",
  "CV CV CA CA DD DD", "BB BB CA CA DD DD", "BB BB CL DD DD DD", "BB BB CAV CAV DD DD", "BB BB CV CV DD DD",
  "FBB FBB CV CV DD DD", "BB BB CV DD DD AO", "BB CV CV DD DD AO", "BB BB CV CL DD DD", "BB CV CV CL DD DD",
  "BB BB CVL CL DD DD", "BB BB CV CV CA CA", "BB BB CV CV CAV CL", "BB BB BB CV CV CV", "CV CV CV BB CA DD",
  "BB BB CLT CLT CA CA", "SS SS SS SS", "SS SS SS SS SS SS", "AS SS SS SS SS SS",
].map((c) => c.replace("AS", "AV"));

/** Speeds a composition can plausibly sail at. */
function speedsFor(codes: Code[]): Speed[] {
  const out: Speed[] = [];
  if (codes.some((c) => ["DE", "BB", "BBV", "CVL", "AV", "AO", "SS", "CV"].includes(c))) out.push("slow");
  out.push("fast");
  if (!codes.some((c) => ["DE", "AO", "AV", "SS", "CT"].includes(c))) out.push("fastPlus", "fastest");
  return out;
}

interface LibFleet {
  label: string;
  ships: ShipInput[];
  selects: Record<string, string>;
}

function fleetShips(codes: Code[], speed: Speed, los: LosLevel): ShipInput[] {
  return codes.map((code) => ({
    shipType: STYPE[code], level: 99, maxHp: 50, speed: SPEEDS[speed],
    stats: { firepower: 50, torpedo: 50, antiAir: 50, armor: 50, evasion: 60, asw: 50, los: NAKED_LOS[code], luck: 20 },
    slots: losGear(code, los),
  }));
}

/** KCNav speed filter (fleet speed = slowest ship) as a predicate. */
function speedFilter(filter: string): (s: number) => boolean {
  const p = new URLSearchParams(filter);
  const lo = Number(p.get("minSpeed") ?? 0);
  const hi = Number(p.get("maxSpeed") ?? 99);
  return (s) => s >= lo && s <= hi;
}

/** Player-select nodes of a routing document (node → options), walking nested rules. */
function selectNodes(doc: RoutingDocument): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  /** Walks a node or rule object (`{ rules: [...] }`), recording `select` options. */
  const walk = (node: string, holder: unknown) => {
    if (!holder || typeof holder !== "object" || !("rules" in holder) || !Array.isArray(holder.rules)) return;
    for (const r of holder.rules) {
      if (r && typeof r === "object" && "select" in r && Array.isArray(r.select)) {
        out[node] = [...new Set([...(out[node] ?? []), ...r.select.filter((x: unknown): x is string => typeof x === "string")])];
      }
      walk(node, r);
    }
  };
  for (const [node, def] of Object.entries(doc.nodes)) walk(node, def);
  return out;
}

/** Every combination of select choices (cartesian product; maps have at most a few select nodes). */
function selectCombos(doc: RoutingDocument): Record<string, string>[] {
  let combos: Record<string, string>[] = [{}];
  for (const [node, opts] of Object.entries(selectNodes(doc))) combos = combos.flatMap((c) => opts.map((o) => ({ ...c, [node]: o })));
  return combos;
}

function library(doc: RoutingDocument, filter: string): LibFleet[] {
  const ok = speedFilter(filter);
  const out: LibFleet[] = [];
  for (const comp of COMPS) {
    const codes = comp.split(" ") as Code[];
    for (const speed of speedsFor(codes).filter((s) => ok(SPEEDS[s]))) {
      for (const los of ["none", "mid", "high"] as const) {
        for (const selects of selectCombos(doc)) {
          const sel = Object.entries(selects).map(([n, o]) => `${n}→${o}`).join(" ");
          out.push({ label: `${comp} · ${speed} · LoS ${los}${sel ? ` · ${sel}` : ""}`, ships: fleetShips(codes, speed, los), selects });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- data I/O ----

interface MapData { edges: { id: number; from: string; to: string }[]; nodes: { letter: string; type: string | null; isBoss: boolean }[]; routing: RoutingDocument }
interface Snapshot { retrievedAt: string; maps: Record<string, MapData>; counts: { map: string; query: string; edgeId: number; runs: number; retrievedAt: string }[] }

const MAPS = ["1-5", "2-5", "5-5"];

async function loadSnapshot(): Promise<Snapshot> {
  if (Bun.argv.includes("--offline")) {
    if (!existsSync(SNAPSHOT)) throw new Error(`no snapshot at ${SNAPSHOT}`);
    return JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  }
  const maps: Record<string, MapData> = {};
  for (const m of MAPS) {
    const r = await fetch(`${API}/maps/${m}`);
    if (!r.ok) throw new Error(`GET /maps/${m}: ${r.status}`);
    maps[m] = (await r.json()) as MapData;
  }
  // D1 is read through the data-worker's wrangler wrapper (read-only query).
  const ids = MAPS.map((m) => m.replace("-", "")).join(", ");
  const rows = await query<{ map_id: number; query: string; edge_id: number; runs: number; retrieved_at: string }>(
    `SELECT map_id, query, edge_id, runs, retrieved_at FROM kcnav_edge_counts WHERE map_id IN (${ids})`,
  );
  const counts = rows.map((r) => ({ map: `${Math.floor(r.map_id / 10)}-${r.map_id % 10}`, query: r.query, edgeId: r.edge_id, runs: r.runs, retrievedAt: r.retrieved_at }));
  const snap = { retrievedAt: new Date().toISOString(), maps, counts };
  writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 1));
  return snap;
}

// ------------------------------------------------------------ observations ----

interface Observed {
  query: string;
  retrievedAt: string;
  sorties: number;
  /** edge index (into MapData.edges) → runs */
  runs: Float64Array;
}

/** Filter key without the date range, e.g. "maxSpeed=5". */
const filterKey = (q: string) => [...new URLSearchParams(q)].filter(([k]) => k !== "start" && k !== "end").map(([k, v]) => `${k}=${v}`).sort().join("&");

function observedCases(snap: Snapshot): { map: string; filter: string; obs: Observed }[] {
  const out: { map: string; filter: string; obs: Observed }[] = [];
  for (const map of MAPS) {
    const m = snap.maps[map]!;
    const idx = new Map(m.edges.map((e, i) => [e.id, i]));
    const byQuery = new Map<string, Snapshot["counts"]>();
    for (const r of snap.counts.filter((r) => r.map === map)) byQuery.set(r.query, [...(byQuery.get(r.query) ?? []), r]);
    for (const [q, rows] of [...byQuery].sort((a, b) => filterKey(a[0]).localeCompare(filterKey(b[0])))) {
      const runs = new Float64Array(m.edges.length);
      for (const r of rows) {
        const i = idx.get(r.edgeId);
        if (i !== undefined) runs[i] = runs[i]! + r.runs;
      }
      out.push({ map, filter: filterKey(q), obs: { query: q, retrievedAt: rows[0]!.retrievedAt, sorties: rows.find((r) => r.edgeId === 0)?.runs ?? 0, runs } });
    }
  }
  return out;
}

/**
 * Observed flows per sortie with retreats removed: the simulation runs without battles, so every
 * sortie that reaches a node leaves it. Each node's outflow is scaled by (corrected arrivals /
 * observed departures). One pass propagates the correction one edge further from Start, so passes
 * repeat until the flows stop changing (longest path; loops carry only a few runs).
 */
function retreatFreeFlows(m: MapData, o: Observed): Float64Array {
  const out = new Float64Array(m.edges.length);
  const depObs = new Map<string, number>();
  m.edges.forEach((e, i) => depObs.set(e.from, (depObs.get(e.from) ?? 0) + o.runs[i]!));
  for (let pass = 0, changed = true; pass < 100 && changed; pass++) {
    changed = false;
    const arrivals = new Map<string, number>();
    m.edges.forEach((e, i) => arrivals.set(e.to, (arrivals.get(e.to) ?? 0) + out[i]!));
    m.edges.forEach((e, i) => {
      const prev = out[i]!;
      const dep = depObs.get(e.from) ?? 0;
      const arr = e.from.startsWith("Start") ? o.sorties : (arrivals.get(e.from) ?? 0);
      out[i] = dep > 0 ? (o.runs[i]! * Math.max(arr, dep)) / dep : 0;
      if (Math.abs(out[i]! - prev) > 1e-6 * o.sorties) changed = true;
    });
  }
  return out.map((x) => x / o.sorties);
}

// ------------------------------------------------------------ simulation ----

interface SimFleet { label: string; flows: Float64Array; offEdges: Map<string, number> }

function simulate(m: MapData, fleets: LibFleet[]): SimFleet[] {
  const nodes: Record<string, SortieNode> = {};
  for (const n of m.nodes) nodes[n.letter] = { kind: n.type as SortieNode["kind"], boss: n.isBoss };
  const idx = new Map(m.edges.map((e, i) => [`${e.from}>${e.to}`, i]));
  return fleets.map((f, k) => {
    const input: SortieInput = { friend: { ships: f.ships }, hqLevel: 120, map: { routing: m.routing, nodes }, config: { selects: f.selects }, topPaths: 100000 };
    const s: SortieSummary = simulateSortie(input, COUNT, 7000 + k);
    const flows = new Float64Array(m.edges.length);
    const offEdges = new Map<string, number>();
    for (const p of s.paths) {
      for (let j = 0; j + 1 < p.path.length; j++) {
        const key = `${p.path[j]}>${p.path[j + 1]}`;
        const i = idx.get(key);
        if (i === undefined) offEdges.set(key, (offEdges.get(key) ?? 0) + p.rate);
        else flows[i] = flows[i]! + p.rate;
      }
    }
    return { label: f.label, flows, offEdges };
  });
}

// ------------------------------------------------------------------- fit ----

/** Solve the symmetric positive (semi-)definite system M x = r by Cholesky (tiny ridge for ties). */
function solveSpd(M: number[][], r: number[]): number[] {
  const n = r.length;
  const L = M.map((row) => row.map(() => 0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = M[i]![j]! + (i === j ? 1e-12 : 0);
      for (let k = 0; k < j; k++) s -= L[i]![k]! * L[j]![k]!;
      L[i]![j] = i === j ? Math.sqrt(Math.max(s, 1e-18)) : s / L[j]![j]!;
    }
  }
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = r[i]!;
    for (let k = 0; k < i; k++) s -= L[i]![k]! * y[k]!;
    y[i] = s / L[i]![i]!;
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let k = i + 1; k < n; k++) s -= L[k]![i]! * x[k]!;
    x[i] = s / L[i]![i]!;
  }
  return x;
}

/** Lawson–Hanson non-negative least squares: argmin ‖A x − b‖, x ≥ 0 (A given column-wise). */
function nnls(cols: Float64Array[], b: Float64Array): Float64Array {
  const n = cols.length;
  const dot = (u: Float64Array, v: Float64Array) => u.reduce((s, x, i) => s + x * v[i]!, 0);
  const x = new Float64Array(n);
  const passive = new Set<number>();
  const resid = () => {
    const r = b.slice();
    for (const j of passive) for (let i = 0; i < r.length; i++) r[i] = r[i]! - x[j]! * cols[j]![i]!;
    return r;
  };
  for (let outer = 0; outer < 3 * n; outer++) {
    const r = resid();
    let best = -1;
    let bestG = 1e-10;
    for (let j = 0; j < n; j++) {
      if (passive.has(j)) continue;
      const g = dot(cols[j]!, r);
      if (g > bestG) [best, bestG] = [j, g];
    }
    if (best < 0) break;
    passive.add(best);
    for (;;) {
      const P = [...passive];
      const s = solveSpd(
        P.map((i) => P.map((j) => dot(cols[i]!, cols[j]!))),
        P.map((i) => dot(cols[i]!, b)),
      );
      if (s.every((v) => v > 0)) {
        P.forEach((j, k) => (x[j] = s[k]!));
        break;
      }
      let alpha = 1;
      P.forEach((j, k) => {
        if (s[k]! <= 0) alpha = Math.min(alpha, x[j]! / (x[j]! - s[k]!));
      });
      P.forEach((j, k) => {
        x[j] = x[j]! + alpha * (s[k]! - x[j]!);
        if (x[j]! <= 1e-12) {
          x[j] = 0;
          passive.delete(j);
        }
      });
    }
  }
  return x;
}

/**
 * Mixture weights w ≥ 0, Σw = 1, minimising Σ_e (Σ_f w_f s_fe − o_e)² / (o_e + ε): NNLS on the
 * weighted system plus a heavily weighted Σw = 1 row.
 */
function fitMixture(sim: SimFleet[], o: Float64Array): Float64Array {
  const E = o.length;
  const sw = o.map((x) => Math.sqrt(1 / (x + 0.002)));
  const SUM = 30;
  const cols = sim.map((f) => {
    const c = new Float64Array(E + 1);
    for (let e = 0; e < E; e++) c[e] = sw[e]! * f.flows[e]!;
    c[E] = SUM;
    return c;
  });
  const b = new Float64Array(E + 1);
  for (let e = 0; e < E; e++) b[e] = sw[e]! * o[e]!;
  b[E] = SUM;
  const w = nnls(cols, b);
  const total = w.reduce((s, x) => s + x, 0);
  return w.map((x) => x / total);
}

// ------------------------------------------------------------- comparison ----

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

interface NodeRow { node: string; n: number; cells: string; maxDiff: number; verdict: string }

function compare(m: MapData, o: Observed, sim: SimFleet[], w: Float64Array): { rows: NodeRow[]; flags: string[] } {
  const fitted = new Float64Array(m.edges.length);
  sim.forEach((f, k) => f.flows.forEach((x, e) => (fitted[e] = fitted[e]! + w[k]! * x)));
  const byNode = new Map<string, number[]>();
  m.edges.forEach((e, i) => byNode.set(e.from, [...(byNode.get(e.from) ?? []), i]));
  const rows: NodeRow[] = [];
  const flags: string[] = [];
  for (const [node, edges] of [...byNode].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true }))) {
    const oTot = edges.reduce((s, i) => s + o.runs[i]!, 0);
    const fTot = edges.reduce((s, i) => s + fitted[i]!, 0);
    if (edges.length < 2 || oTot < MIN_OBS) continue;
    let maxDiff = 0;
    const cells: string[] = [];
    for (const i of edges) {
      const os = o.runs[i]! / oTot;
      const fs = fTot > 0 ? fitted[i]! / fTot : 0;
      if (os < 0.0005 && fs < 0.0005) continue;
      maxDiff = Math.max(maxDiff, Math.abs(os - fs));
      cells.push(`${m.edges[i]!.to} ${pct(os)} / ${pct(fs)}`);
      const taken = os >= MIN_BRANCH.share && o.runs[i]! >= MIN_BRANCH.runs;
      if (taken && sim.every((f) => f.flows[i]! === 0)) {
        flags.push(`${node}→${m.edges[i]!.to}: taken by ${pct(os)} of players (${o.runs[i]} runs) but no library fleet takes it`);
      }
    }
    const verdict = fTot === 0 ? "not reached" : maxDiff <= 0.05 ? "ok" : maxDiff <= 0.15 ? "≈" : "OFF";
    if (verdict === "OFF") flags.push(`${node}: best mixture still off by ${pct(maxDiff)}`);
    rows.push({ node, n: Math.round(oTot), cells: cells.join("; "), maxDiff, verdict });
  }
  const off = new Map<string, number>();
  sim.forEach((f, k) => f.offEdges.forEach((r, key) => off.set(key, Math.max(off.get(key) ?? 0, r))));
  for (const [key, r] of off) flags.push(`${key.replace(">", "→")}: simulated (up to ${pct(r)} of a fleet's sorties) but not an edge of the KCNav map`);
  return { rows, flags };
}

// ------------------------------------------------------------------- main ----

const snap = await loadSnapshot();
const out: string[] = [];
const allFlags: string[] = [];
out.push(
  `Generated by \`bun validation/routing-vs-kcnav.ts\` on ${new Date().toISOString().slice(0, 10)} from ${snap.counts.length} stored edge counts. ` +
    `Library: ${COMPS.length} compositions × speeds allowed by the filter × LoS none/mid/high × every player-select choice, ${COUNT} routing-only sorties each.`,
);
out.push(
  "Cells are `destination observed% / fitted%` (fitted = best non-negative mixture of library fleets, fitted to retreat-corrected edge flows per sortie). " +
    "Verdict: ok ≤ 5 pt, ≈ ≤ 15 pt, OFF otherwise; nodes with < 100 observed departures or one exit are omitted.\n",
);
const cases = observedCases(snap);
for (const { map, filter, obs } of cases.filter((c) => c.obs.sorties > 0)) {
  const m = snap.maps[map]!;
  const lib = library(m.routing, filter);
  const sim = simulate(m, lib);
  const target = retreatFreeFlows(m, obs);
  const w = fitMixture(sim, target);
  const { rows, flags } = compare(m, obs, sim, w);
  allFlags.push(...flags.map((f) => `${map} [${filter || "all"}] ${f}`));
  const top = [...w].map((x, k) => [x, k] as const).filter(([x]) => x >= 0.01).sort((a, b) => b[0] - a[0]).slice(0, 8);
  out.push(`### ${map} — filter \`${filter || "(none)"}\``);
  out.push(`KCNav: ${obs.sorties} sorties, \`${obs.query}\`, retrieved ${obs.retrievedAt}. Library: ${lib.length} fleets.`);
  out.push(`Fitted population (top, ≥ 1%): ${top.map(([x, k]) => `${sim[k]!.label} ${pct(x)}`).join("; ") || "—"}.\n`);
  out.push("| node | observed n | branches (observed / fitted) | max \\|Δ\\| | verdict |", "|---|---|---|---|---|");
  for (const r of rows) out.push(`| ${r.node} | ${r.n} | ${r.cells} | ${pct(r.maxDiff)} | ${r.verdict} |`);
  out.push("");
}
const empty = cases.filter((c) => c.obs.sorties === 0).map((c) => `${c.map} \`${c.obs.query}\``);
if (empty.length) out.push(`No usable snapshot (fetch failed or 0 sorties): ${empty.join(", ")}.\n`);
out.push("#### Flagged\n");
out.push(allFlags.length ? allFlags.map((f) => `- ${f}`).join("\n") : "- none");

const begin = "<!-- routing-validation:begin -->";
const end = "<!-- routing-validation:end -->";
const doc = readFileSync(DOC, "utf8");
const i = doc.indexOf(begin);
const j = doc.indexOf(end);
if (i < 0 || j < 0) throw new Error(`markers missing in ${DOC}`);
writeFileSync(DOC, `${doc.slice(0, i + begin.length)}\n${out.join("\n")}\n${doc.slice(j)}`);
console.log(out.join("\n"));
