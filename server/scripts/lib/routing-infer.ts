// Routing rule inference from observed sorties (private notes ROUTING_INFERENCE). Offline only: runs in
// scripts / CI, never in the Worker (Free plan, 10 ms CPU per request).
//
// Per branching node, the samples are (fleet features + visited nodes) → next node. A CHAID-style
// tree is grown on them: every candidate split is "feature ≥ threshold" over features that map 1:1
// onto ROUTING_DSL leaves, scored by the G statistic (2×K table) minus a complexity penalty, and kept
// only when it is significant after a Bonferroni correction over every candidate tested. The tree is
// then written as an ordered DSL rule list (nested `rules` for subtrees, `los` actions for pure LoS
// bands, `random` + `uncertain` for mixed leaves) and checked with validateRoutingDoc.
import { mapLos33 } from "../../../shared/fleet/calc";
import { SHIP_GROUPS, SHIP_TYPES, SPEEDS, type Predicate, type Rule, type RoutingDoc, type ShipTypeCode } from "../../src/routing/schema";
import { validateRoutingDoc, type Edge } from "../../src/routing/validate";
import * as z from "zod";

// ---------------------------------------------------------------- inputs ----

/** One equipment item as routing sees it (ROUTING_DSL §5). */
export interface RouteEquip { id: number; cat: number; los: number; level: number }
/** One ship as routing sees it: api_stype, master id, api_soku, naked LoS (api_sakuteki[0] − Σ equipment LoS). */
export interface RouteShip { stype: number; id: number; speed: number; nakedLos: number; equips: RouteEquip[] }
export type FleetType = "single" | "ctf" | "stf" | "tcf";

/** One observed sortie. */
export interface SortieSample {
  main: RouteShip[];
  escort?: RouteShip[];
  fleetType?: FleetType;
  hq: number;
  /** 0 normal maps, 1 丁 … 4 甲. */
  difficulty?: number;
  /** Current gauge number (api_gauge_num) at the sortie start; the DSL `gauge` metric. */
  gauge?: number;
  /** Node letters from the start node (Start, Start1, …) to the last node reached. */
  path: string[];
  /** Nodes where the game offered a player choice (api_select_route): node → offered letters. */
  selects?: Record<string, string[]>;
}

export interface InferOptions {
  /** Ship families (every remodel id of one ship) usable as `countIds` features. */
  families?: number[][];
  /** A family becomes a feature once this many sorties contain it. Default 20. */
  minFamilySupport?: number;
  /** Minimum samples on each side of a split. Default 3. */
  minLeaf?: number;
  /** Maximum tree depth per node. Default 5. */
  maxDepth?: number;
  /** Family-wise significance level of a split (Bonferroni over all candidates). Default 0.01. */
  alpha?: number;
  /** Leaves with fewer samples are marked `uncertain`. Default 30. */
  minConfident?: number;
  /** G-statistic units charged per unit of feature complexity (simplicity bias). Default 2. */
  complexityPenalty?: number;
  /** `sources[0].note` of the emitted document. */
  sourceNote?: string;
}

export interface NodeReport {
  node: string;
  kind: "learned" | "single-exit" | "unobserved" | "end";
  samples: number;
  outcomes: Record<string, number>;
  leaves: number;
  uncertainLeaves: number;
  /** Resubstitution accuracy of the majority outcome per leaf. */
  trainAccuracy: number;
}

export interface InferResult { doc: RoutingDoc; report: NodeReport[]; dropped: number; errors: string[] }

// ------------------------------------------------------------- LoS (§5) ----

/** LoS formula 33 floored to 2 decimals (the shared implementation); `full` is 6 (single) or 12 (combined, both fleets). */
export function los33(ships: RouteShip[], cn: number, hq: number, full = 6): number {
  return mapLos33(
    ships.map((s) => ({ bareLos: s.nakedLos, equips: s.equips.map((e) => ({ type2: e.cat, los: e.los, improvement: e.level })) })),
    hq, cn, full,
  );
}

// -------------------------------------------------------------- features ----

const EQUIP_MATCH: Record<"RADAR" | "SURFACE_RADAR" | "DRUM" | "LANDING_CRAFT" | "SONAR", (e: RouteEquip) => boolean> = {
  RADAR: (e) => e.cat === 12 || e.cat === 13 || e.cat === 93,
  SURFACE_RADAR: (e) => (e.cat === 12 || e.cat === 13 || e.cat === 93) && e.los >= 5,
  DRUM: (e) => e.id === 75,
  LANDING_CRAFT: (e) => e.cat === 24 || e.cat === 46,
  SONAR: (e) => e.cat === 14 || e.cat === 40,
};
const SPEED_NAME = Object.fromEntries(Object.entries(SPEEDS).map(([k, v]) => [v, k])) as Record<number, keyof typeof SPEEDS>;

type FleetSel = "main" | "escort" | "all";
interface Feature {
  key: string;
  /** Simplicity bias: 1 for plain metrics, more for unions / id lists. */
  complexity: number;
  bool: boolean;
  /** Values are classes (speed): a split's threshold is the upper observed value, not a midpoint. */
  discrete?: boolean;
  /** Value on one sortie (visited features are filled per sample). */
  value: (s: SortieSample) => number;
  /** DSL leaf for value ≥ t (`neg`: value < t). */
  leaf: (t: number, neg: boolean) => Predicate;
}

const ships = (s: SortieSample, f: FleetSel = "all") => (f === "main" ? s.main : f === "escort" ? s.escort ?? [] : [...s.main, ...(s.escort ?? [])]);
const num = (base: Record<string, unknown>) => (t: number, neg: boolean) => ({ ...base, ...(neg ? { lt: t } : { gte: t }) }) as Predicate;
const boolLeaf = (base: Record<string, unknown>, negForm: "eq" | "not") => (_t: number, neg: boolean): Predicate =>
  !neg ? (base as Predicate) : negForm === "eq" ? ({ ...base, eq: false } as Predicate) : { not: base as Predicate };

interface Atom { codes: string[]; mask: number; complexity: number }

/** Count atoms: base types present in the data, groups that differ from a base type, and disjoint unions of two. */
function atoms(present: Set<number>): Atom[] {
  const out = new Map<number, Atom>();
  const add = (codes: string[], mask: number, complexity: number) => {
    if (mask && !out.has(mask)) out.set(mask, { codes, mask, complexity });
  };
  const presentMask = (types: readonly ShipTypeCode[]) => types.reduce((m, c) => (present.has(SHIP_TYPES[c]) ? m | (1 << SHIP_TYPES[c]) : m), 0);
  for (const [code, id] of Object.entries(SHIP_TYPES)) if (present.has(id)) add([code], 1 << id, 1);
  for (const [g, types] of Object.entries(SHIP_GROUPS)) add([g], presentMask(types), 1);
  const singles = [...out.values()];
  for (let i = 0; i < singles.length; i++) {
    for (let j = i + 1; j < singles.length; j++) {
      const a = singles[i]!;
      const b = singles[j]!;
      if (a.mask & b.mask) continue;
      add([...a.codes, ...b.codes], a.mask | b.mask, 2);
    }
  }
  return [...out.values()];
}

const inMask = (mask: number, s: RouteShip) => s.stype < 31 && (mask & (1 << s.stype)) !== 0;

function catalog(sorties: SortieSample[], opts: Required<Pick<InferOptions, "minFamilySupport">> & InferOptions): Feature[] {
  const present = new Set(sorties.flatMap((s) => ships(s).map((x) => x.stype)));
  const combined = sorties.some((s) => (s.escort?.length ?? 0) > 0);
  const out: Feature[] = [];
  out.push({ key: "ships", complexity: 1, bool: false, value: (s) => ships(s).length, leaf: num({ m: "ships" }) });
  const fleets: FleetSel[] = combined ? ["all", "main", "escort"] : ["all"];
  if (combined) {
    for (const f of ["main", "escort"] as const) out.push({ key: `ships.${f}`, complexity: 1.5, bool: false, value: (s) => ships(s, f).length, leaf: num({ m: "ships", fleet: f }) });
  }
  for (const a of atoms(present)) {
    for (const f of a.complexity === 1 ? fleets : ["all" as const]) {
      const fleet = f === "all" ? {} : { fleet: f };
      const extra = f === "all" ? 0 : 0.5;
      out.push({
        key: `count.${a.codes.join("+")}${f === "all" ? "" : `.${f}`}`, complexity: a.complexity + extra, bool: false,
        value: (s) => ships(s, f).filter((x) => inMask(a.mask, x)).length, leaf: num({ m: "count", types: a.codes, ...fleet }),
      });
    }
    if (a.complexity === 1) {
      out.push({
        key: `onlyTypes.${a.codes.join("+")}`, complexity: 1.5, bool: true,
        value: (s) => (ships(s).every((x) => inMask(a.mask, x)) ? 1 : 0), leaf: boolLeaf({ m: "onlyTypes", types: a.codes }, "eq"),
      });
      out.push({
        key: `flagship.${a.codes.join("+")}`, complexity: 1, bool: true,
        value: (s) => (s.main[0] && inMask(a.mask, s.main[0]) ? 1 : 0), leaf: boolLeaf({ m: "flagship", in: a.codes }, "not"),
      });
    }
  }
  const bbMask = (["FBB", "BB", "XBB"] as const).reduce((m, c) => m | (1 << SHIP_TYPES[c]), 0);
  out.push({
    key: "count.BATTLESHIP.slow", complexity: 2, bool: false,
    value: (s) => ships(s).filter((x) => inMask(bbMask, x) && x.speed <= SPEEDS.slow).length,
    leaf: num({ m: "count", types: ["BATTLESHIP"], maxSpeed: "slow" }),
  });
  out.push({
    key: "speed", complexity: 1, bool: false, discrete: true,
    value: (s) => Math.min(20, ...ships(s).map((x) => x.speed)),
    leaf: (t, neg) => ({ m: "speed", ...(neg ? { lt: SPEED_NAME[t] ?? t } : { gte: SPEED_NAME[t] ?? t }) }) as Predicate,
  });
  for (const cn of [1, 2, 3, 4] as const) {
    out.push({
      key: `los.cn${cn}`, complexity: 1, bool: false,
      value: (s) => los33(ships(s), cn, s.hq, (s.escort?.length ?? 0) > 0 ? 12 : 6), leaf: num({ m: "los", cn }),
    });
  }
  for (const [g, match] of Object.entries(EQUIP_MATCH)) {
    out.push({
      key: `equipShips.${g}`, complexity: 1, bool: false,
      value: (s) => ships(s).filter((x) => x.equips.some(match)).length, leaf: num({ m: "equipShips", equip: { group: g } }),
    });
    if (g === "DRUM" || g === "LANDING_CRAFT") {
      out.push({
        key: `equipCount.${g}`, complexity: 1.5, bool: false,
        value: (s) => ships(s).reduce((n, x) => n + x.equips.filter(match).length, 0), leaf: num({ m: "equipCount", equip: { group: g } }),
      });
    }
  }
  for (const t of ["single", "ctf", "stf", "tcf"] as const) {
    out.push({ key: `fleetType.${t}`, complexity: 1, bool: true, value: (s) => ((s.fleetType ?? "single") === t ? 1 : 0), leaf: boolLeaf({ m: "fleetType", in: [t] }, "not") });
  }
  out.push({ key: "difficulty", complexity: 1, bool: false, value: (s) => s.difficulty ?? 0, leaf: num({ m: "difficulty" }) });
  out.push({ key: "gauge", complexity: 1, bool: false, value: (s) => s.gauge ?? 1, leaf: num({ m: "gauge" }) });
  for (const fam of opts.families ?? []) {
    const ids = new Set(fam);
    const support = sorties.reduce((n, s) => n + (ships(s).some((x) => ids.has(x.id)) ? 1 : 0), 0);
    if (support < opts.minFamilySupport) continue;
    const sorted = [...ids].sort((a, b) => a - b);
    out.push({
      key: `countIds.${sorted.join(",")}`, complexity: 1.5, bool: false,
      value: (s) => ships(s).filter((x) => ids.has(x.id)).length, leaf: num({ m: "countIds", ids: sorted }),
    });
  }
  return out;
}

// ------------------------------------------------------------ statistics ----

/** ln Γ(x) (Lanczos). */
function lnGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const k of c) ser += k / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Upper regularised incomplete gamma Q(a, x) (series / continued fraction, Numerical Recipes). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const gln = lnGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let del = sum;
    for (let n = 1; n < 500; n++) {
      del *= x / (a + n);
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** P(χ²_df ≥ x). */
const chi2sf = (x: number, df: number) => gammaQ(df / 2, x / 2);

/** G statistic of a 2×K table (rows: yes / no). */
function gStat(yes: Int32Array, no: Int32Array, nYes: number, nNo: number): number {
  const n = nYes + nNo;
  let g = 0;
  for (let k = 0; k < yes.length; k++) {
    const col = yes[k]! + no[k]!;
    if (!col) continue;
    if (yes[k]) g += yes[k]! * Math.log((yes[k]! * n) / (nYes * col));
    if (no[k]) g += no[k]! * Math.log((no[k]! * n) / (nNo * col));
  }
  return 2 * g;
}

// ------------------------------------------------------------------ tree ----

interface Sample { s: number; visited: Set<string>; out: number }
type Tree =
  | { leaf: true; counts: Int32Array; n: number }
  | { leaf: false; f: number; t: number; lo: number; hi: number; yes: Tree; no: Tree; n: number };

interface Ctx {
  features: Feature[];
  /** fleet feature values [sortie][feature] */
  values: Float64Array[];
  /** visited features: node letters after the fleet features */
  visitedNodes: string[];
  outcomes: string[];
  minLeaf: number;
  maxDepth: number;
  alpha: number;
  penalty: number;
}

const featureValue = (c: Ctx, x: Sample, f: number) =>
  f < c.features.length ? c.values[x.s]![f]! : x.visited.has(c.visitedNodes[f - c.features.length]!) ? 1 : 0;

function countsOf(c: Ctx, xs: Sample[]): Int32Array {
  const k = new Int32Array(c.outcomes.length);
  for (const x of xs) k[x.out]!++;
  return k;
}

/** Threshold for "value ≥ t" between the observed values lo < hi: integer midpoint for counts, 2-decimal midpoint for LoS. */
function threshold(lo: number, hi: number): number {
  if (Number.isInteger(lo) && Number.isInteger(hi)) return Math.max(lo + 1, Math.ceil((lo + hi) / 2));
  const mid = Math.round(((lo + hi) / 2) * 100) / 100;
  return mid > lo ? mid : hi;
}

function grow(c: Ctx, xs: Sample[], depth: number): Tree {
  const counts = countsOf(c, xs);
  const n = xs.length;
  const kinds = counts.reduce((m, v) => m + (v > 0 ? 1 : 0), 0);
  if (kinds <= 1 || depth >= c.maxDepth || n < 2 * c.minLeaf) return { leaf: true, counts, n };
  let best: { f: number; lo: number; hi: number; g: number; score: number } | null = null;
  let tested = 0;
  const K = c.outcomes.length;
  for (let f = 0; f < c.features.length + c.visitedNodes.length; f++) {
    const byValue = new Map<number, Int32Array>();
    for (const x of xs) {
      const v = featureValue(c, x, f);
      let row = byValue.get(v);
      if (!row) byValue.set(v, (row = new Int32Array(K)));
      row[x.out]!++;
    }
    if (byValue.size < 2) continue;
    const vals = [...byValue.keys()].sort((a, b) => a - b);
    // Sweep from the top: `yes` = value ≥ boundary.
    const yes = new Int32Array(K);
    let nYes = 0;
    for (let i = vals.length - 1; i > 0; i--) {
      const row = byValue.get(vals[i]!)!;
      for (let k = 0; k < K; k++) { yes[k]! += row[k]!; nYes += row[k]!; }
      const nNo = n - nYes;
      if (nYes < c.minLeaf || nNo < c.minLeaf) continue;
      tested++;
      const no = counts.map((v, k) => v - yes[k]!);
      const g = gStat(yes, no, nYes, nNo);
      const score = g - c.penalty * (f < c.features.length ? c.features[f]!.complexity : 1);
      if (!best || score > best.score + 1e-9) best = { f, lo: vals[i - 1]!, hi: vals[i]!, g, score };
    }
  }
  if (!best || chi2sf(best.g, kinds - 1) * tested > c.alpha) return { leaf: true, counts, n };
  const t = c.features[best.f]?.discrete ? best.hi : threshold(best.lo, best.hi);
  const yesXs = xs.filter((x) => featureValue(c, x, best.f) >= t);
  const noXs = xs.filter((x) => featureValue(c, x, best.f) < t);
  return { leaf: false, f: best.f, t, lo: best.lo, hi: best.hi, n, yes: grow(c, yesXs, depth + 1), no: grow(c, noXs, depth + 1) };
}

function leaves(t: Tree): Extract<Tree, { leaf: true }>[] {
  return t.leaf ? [t] : [...leaves(t.yes), ...leaves(t.no)];
}

// ------------------------------------------------------------ tree → DSL ----

const SELECT = "?select";

interface EmitCtx extends Ctx { minConfident: number; selectOptions: string[] }

function leafRule(c: EmitCtx, l: Extract<Tree, { leaf: true }>): Rule {
  const entries = [...l.counts].map((v, k) => [c.outcomes[k]!, v] as const).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const obs = entries.map(([o, v]) => `${o}:${v}`).join(" ");
  const note = `inferred: n=${l.n} (${obs})`;
  const small = l.n < c.minConfident;
  const sel = entries.find(([o]) => o === SELECT);
  if (sel && sel[1] * 2 >= l.n) {
    return { select: c.selectOptions, note, ...(entries.length > 1 || small ? { uncertain: true } : {}) };
  }
  const real = entries.filter(([o]) => o !== SELECT);
  if (real.length === 1) return { to: real[0]![0], note, ...(small || sel ? { uncertain: true } : {}) };
  const total = real.reduce((s, [, v]) => s + v, 0);
  // 3-decimal weights, each ≥ 0.001; the most frequent outcome (first) absorbs the rounding.
  const ps = real.map(([, v]) => Math.max(0.001, Math.round((v / total) * 1000) / 1000));
  ps[0] = Math.round((1 - ps.slice(1).reduce((s, p) => s + p, 0)) * 1000) / 1000;
  return { random: real.map(([o], i) => ({ to: o, p: ps[i]! })), note, uncertain: true };
}

function featureLeaf(c: Ctx, f: number, t: number, neg: boolean): Predicate {
  if (f < c.features.length) return c.features[f]!.leaf(t, neg);
  const node = c.visitedNodes[f - c.features.length]!;
  return neg ? { m: "visited", node, eq: false } : { m: "visited", node };
}

const splitNote = (c: Ctx, t: Extract<Tree, { leaf: false }>) =>
  c.features[t.f]?.bool || t.f >= c.features.length ? "" : ` boundary in (${t.lo}, ${t.hi}]`;

const pureTo = (c: EmitCtx, t: Tree): string | null => {
  if (!t.leaf) return null;
  const r = leafRule(c, t);
  return "to" in r && !r.uncertain ? r.to : null;
};

/** `los` action for a chain of LoS splits on one Cn whose `yes` sides are pure leaves, ending in a pure leaf. */
function losAction(c: EmitCtx, t: Extract<Tree, { leaf: false }>): Rule | null {
  const key = c.features[t.f]?.key;
  if (!key?.startsWith("los.cn")) return null;
  const thresholds: { min: number; to: string }[] = [];
  const notes: string[] = [];
  let cur: Tree = t;
  while (!cur.leaf && c.features[cur.f]?.key === key) {
    const to = pureTo(c, cur.yes);
    if (!to || (thresholds.length && cur.t >= thresholds.at(-1)!.min)) return null;
    thresholds.push({ min: cur.t, to });
    notes.push(`${to}: n=${cur.yes.n},${splitNote(c, cur)}`);
    cur = cur.no;
  }
  const below = pureTo(c, cur);
  if (!below) return null;
  const cn = Number(key.slice("los.cn".length)) as 1 | 2 | 3 | 4;
  return { los: { cn, thresholds, below, interpolate: false }, note: `inferred: ${notes.join("; ")} below ${below}: n=${cur.n}` };
}

function toRules(c: EmitCtx, t: Tree): Rule[] {
  if (t.leaf) return [leafRule(c, t)];
  const los = losAction(c, t);
  if (los) return [los];
  const note = splitNote(c, t);
  const withWhen = (when: Predicate, sub: Tree): Rule => {
    const rules = toRules(c, sub);
    if (rules.length === 1 && !rules[0]!.when) {
      const r = rules[0]!;
      return { when, ...r, ...(note ? { note: `${r.note ?? "inferred"};${note}` } : {}) } as Rule;
    }
    return { when, rules, ...(note ? { note: `inferred:${note}` } : {}) };
  };
  // The leaf side (if any) becomes the conditional rule; the other side continues the ordered list.
  if (t.yes.leaf || !t.no.leaf) return [withWhen(featureLeaf(c, t.f, t.t, false), t.yes), ...toRules(c, t.no)];
  return [withWhen(featureLeaf(c, t.f, t.t, true), t.no), ...toRules(c, t.yes)];
}

/** Merges consecutive conditional rules with the same fixed destination into one `any` rule. */
function mergeSameTo(rules: Rule[]): Rule[] {
  const out: Rule[] = [];
  for (const r of rules) {
    const prev = out.at(-1);
    if (prev && prev.when && r.when && "to" in prev && "to" in r && prev.to === r.to && !!prev.uncertain === !!r.uncertain) {
      const left = "any" in prev.when ? prev.when.any : [prev.when];
      out[out.length - 1] = { when: { any: [...left, r.when] }, to: r.to, note: [prev.note, r.note].filter(Boolean).join(" | "), ...(r.uncertain ? { uncertain: true } : {}) };
    } else {
      out.push("rules" in r ? { ...r, rules: mergeSameTo(r.rules) } : r);
    }
  }
  return out;
}

// ------------------------------------------------------------------ main ----

const START = "@start";
const isStart = (l: string) => /^Start\d*$/.test(l);

/** Infers a routing document for `map` from observed sorties, validated against `edges`. */
export function inferRouting(map: string, edges: Edge[], sorties: SortieSample[], options: InferOptions = {}): InferResult {
  const opts = {
    minFamilySupport: 20, minLeaf: 3, maxDepth: 5, alpha: 0.01, minConfident: 30, complexityPenalty: 2, ...options,
  };
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const letters = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
  const starts = letters.filter(isStart);
  const edgeSet = new Set(edges.map((e) => `${e.from}>${e.to}`));
  const valid = sorties.filter((s) =>
    s.path.length > 0 && isStart(s.path[0]!) && starts.includes(s.path[0]!) && s.path.every((l, i) => i === 0 || edgeSet.has(`${s.path[i - 1]}>${l}`)));
  const features = catalog(valid, opts);
  const values = valid.map((s) => Float64Array.from(features, (f) => f.value(s)));

  // Samples per decision point.
  const samples = new Map<string, { s: number; visited: Set<string>; out: string }[]>();
  const push = (node: string, x: { s: number; visited: Set<string>; out: string }) => {
    let arr = samples.get(node);
    if (!arr) samples.set(node, (arr = []));
    arr.push(x);
  };
  valid.forEach((s, i) => {
    if (starts.length > 1) push(START, { s: i, visited: new Set(), out: s.path[0]! });
    const visited = new Set<string>();
    for (let j = 0; j + 1 < s.path.length; j++) {
      const node = s.path[j]!;
      visited.add(node);
      push(node, { s: i, visited: new Set(visited), out: s.selects?.[node] ? SELECT : s.path[j + 1]! });
    }
  });

  const report: NodeReport[] = [];
  const doc: RoutingDoc = {
    map,
    sources: [{ id: "inferred", note: opts.sourceNote ?? `inferred from ${valid.length} observed sorties (scripts/lib/routing-infer.ts)` }],
    nodes: {},
  };
  const selectDefaults: Record<string, string> = {};

  const learn = (node: string, exits: string[]): Rule[] => {
    const xs = samples.get(node) ?? [];
    if (exits.length === 1) {
      report.push({ node, kind: "single-exit", samples: xs.length, outcomes: {}, leaves: 1, uncertainLeaves: 0, trainAccuracy: 1 });
      return [{ to: exits[0]! }];
    }
    if (!xs.length) {
      report.push({ node, kind: "unobserved", samples: 0, outcomes: {}, leaves: 1, uncertainLeaves: 1, trainAccuracy: 0 });
      const p = Math.round(1000 / exits.length) / 1000;
      return [{
        random: exits.map((to, i) => ({ to, p: i === exits.length - 1 ? Math.round((1 - p * (exits.length - 1)) * 1000) / 1000 : p })),
        uncertain: true, note: "inferred: no observations; uniform placeholder over the map's exits",
      }];
    }
    const outcomes = [...new Set(xs.map((x) => x.out))].sort();
    const selectOptions = [...new Set(xs.flatMap((x) => (x.out === SELECT ? valid[x.s]!.selects![node]! : [])))];
    if (selectOptions.length) {
      const chosen = new Map<string, number>();
      for (const x of xs) {
        if (x.out !== SELECT) continue;
        const p = valid[x.s]!.path;
        const next = p[p.indexOf(node) + 1]!;
        chosen.set(next, (chosen.get(next) ?? 0) + 1);
      }
      selectDefaults[node] = [...chosen].sort((a, b) => b[1] - a[1])[0]![0];
    }
    const visitedNodes = [...new Set(xs.flatMap((x) => [...x.visited]))].filter((l) => l !== node && !isStart(l)).sort();
    const c: EmitCtx = {
      features, values, visitedNodes, outcomes, minLeaf: opts.minLeaf, maxDepth: opts.maxDepth, alpha: opts.alpha,
      penalty: opts.complexityPenalty, minConfident: opts.minConfident, selectOptions: selectOptions.length >= 2 ? selectOptions : exits,
    };
    const tree = grow(c, xs.map((x) => ({ s: x.s, visited: x.visited, out: outcomes.indexOf(x.out) })), 0);
    const ls = leaves(tree);
    const counts: Record<string, number> = {};
    for (const x of xs) counts[x.out] = (counts[x.out] ?? 0) + 1;
    const correct = ls.reduce((s, l) => s + Math.max(...l.counts), 0);
    const rules = mergeSameTo(toRules(c, tree));
    report.push({
      node, kind: "learned", samples: xs.length, outcomes: counts, leaves: ls.length,
      uncertainLeaves: ls.filter((l) => l.n < opts.minConfident || l.counts.filter((v) => v > 0).length > 1).length,
      trainAccuracy: correct / xs.length,
    });
    return rules;
  };

  if (starts.length > 1) doc.start = { rules: learn(START, starts) };
  for (const l of letters.sort()) {
    const exits = out.get(l) ?? [];
    if (!exits.length) {
      doc.nodes[l] = { end: true };
      report.push({ node: l, kind: "end", samples: 0, outcomes: {}, leaves: 0, uncertainLeaves: 0, trainAccuracy: 1 });
    } else {
      doc.nodes[l] = { rules: learn(l, exits) };
    }
  }
  if (Object.keys(selectDefaults).length) doc.defaults = { select: selectDefaults };
  const { errors } = validateRoutingDoc(doc, edges);
  return { doc, report, dropped: sorties.length - valid.length, errors };
}

// ------------------------------------------------------------- evaluator ----

/** Map-state inputs of `nextDistribution` (ROUTING_DSL §5); defaults as in the sim-core evaluator. */
export interface EvalConfig { selects?: Record<string, string>; flags?: Record<string, boolean>; phase?: number; gauge?: number }

function typeMask(codes: string[]): number {
  let m = 0;
  for (const c of codes) {
    const group = (SHIP_GROUPS as Record<string, readonly ShipTypeCode[]>)[c];
    for (const t of group ?? [c as ShipTypeCode]) m |= 1 << SHIP_TYPES[t];
  }
  return m;
}

function equipMatch(sel: { group?: string; types?: number[]; minLos?: number; ids?: number[] }): (e: RouteEquip) => boolean {
  if (sel.group) return EQUIP_MATCH[sel.group as keyof typeof EQUIP_MATCH];
  if (sel.ids) return (e) => sel.ids!.includes(e.id);
  return (e) => sel.types!.includes(e.cat) && e.los >= (sel.minLos ?? -Infinity);
}

/**
 * Next-node distribution at `node` ("@start" = the doc's start rules) for one sortie, following the
 * DSL semantics of sim-core's evaluator (routing.rs). Used to score inferred rules per node without
 * Monte Carlo; whole-sortie checks still go through the wasm evaluator.
 */
export function nextDistribution(doc: RoutingDoc, node: string, s: SortieSample, visited: Set<string>, cfg: EvalConfig = {}): Record<string, number> {
  const all = ships(s);
  const full = (s.escort?.length ?? 0) > 0 ? 12 : 6;
  const speedVal = (v: unknown) => (typeof v === "string" ? SPEEDS[v as keyof typeof SPEEDS] : (v as number));
  const cmp = (leaf: Record<string, unknown>, v: number, conv: (x: unknown) => number = (x) => x as number) =>
    (leaf.eq === undefined || v === conv(leaf.eq)) && (leaf.ne === undefined || v !== conv(leaf.ne)) &&
    (leaf.gt === undefined || v > conv(leaf.gt)) && (leaf.gte === undefined || v >= conv(leaf.gte)) &&
    (leaf.lt === undefined || v < conv(leaf.lt)) && (leaf.lte === undefined || v <= conv(leaf.lte)) &&
    (leaf.in === undefined || (leaf.in as number[]).includes(v));
  const bool = (leaf: { eq?: boolean }, v: boolean) => (leaf.eq === undefined ? v : v === leaf.eq);
  const test = (p: Predicate): boolean => {
    if ("all" in p) return p.all.every(test);
    if ("any" in p) return p.any.some(test);
    if ("not" in p) return !test(p.not);
    const fl = "fleet" in p && p.fleet ? ships(s, p.fleet) : all;
    switch (p.m) {
      case "ships": return cmp(p, fl.length);
      case "count": {
        const mask = typeMask(p.types);
        const max = p.maxSpeed ? SPEEDS[p.maxSpeed] : Infinity;
        return cmp(p, fl.filter((x) => inMask(mask, x) && x.speed <= max).length);
      }
      case "countIds": return cmp(p, fl.filter((x) => p.ids.includes(x.id)).length);
      case "equipShips": { const m = equipMatch(p.equip); return cmp(p, fl.filter((x) => x.equips.some(m)).length); }
      case "equipCount": { const m = equipMatch(p.equip); return cmp(p, fl.reduce((n, x) => n + x.equips.filter(m).length, 0)); }
      case "speed": return cmp(p, Math.min(20, ...all.map((x) => x.speed)), speedVal);
      case "los": return cmp(p, los33(all, p.cn, s.hq, full));
      case "fleetType": return p.in.includes(s.fleetType ?? "single");
      case "flagship": { const f = ships(s, p.fleet ?? "main")[0]; return !!f && inMask(typeMask(p.in), f); }
      case "difficulty": return cmp(p, s.difficulty ?? 0);
      case "phase": return cmp(p, cfg.phase ?? doc.defaults?.phase ?? 1);
      case "gauge": return cmp(p, cfg.gauge ?? s.gauge ?? doc.defaults?.gauge ?? 1);
      case "onlyTypes": { const mask = typeMask(p.types); return bool(p, fl.every((x) => inMask(mask, x))); }
      case "hq": return cmp(p, s.hq);
      case "visited": return bool(p, visited.has(p.node));
      case "flag": return bool(p, cfg.flags?.[p.name] ?? doc.defaults?.flags?.includes(p.name) ?? false);
    }
  };
  const evalRules = (rules: Rule[]): Record<string, number> => {
    for (const r of rules) {
      if (r.when && !test(r.when)) continue;
      if ("to" in r) return { [r.to]: 1 };
      if ("random" in r) {
        const d: Record<string, number> = {};
        for (const e of r.random) d[e.to] = (d[e.to] ?? 0) + e.p;
        return d;
      }
      if ("select" in r) {
        const pick = cfg.selects?.[node] ?? doc.defaults?.select?.[node];
        return { [pick && r.select.includes(pick) ? pick : r.select[0]!]: 1 };
      }
      if ("los" in r) {
        const v = los33(all, r.los.cn, s.hq, full);
        const t = r.los.thresholds;
        if (v >= t[0]!.min) return { [t[0]!.to]: 1 };
        for (let i = 0; i + 1 < t.length; i++) {
          if (v < t[i + 1]!.min) continue;
          if (r.los.interpolate === false) return { [t[i + 1]!.to]: 1 };
          const p = (v - t[i + 1]!.min) / (t[i]!.min - t[i + 1]!.min);
          const d: Record<string, number> = {};
          d[t[i]!.to] = p;
          d[t[i + 1]!.to] = (d[t[i + 1]!.to] ?? 0) + 1 - p;
          return d;
        }
        return { [r.los.below]: 1 };
      }
      return evalRules(r.rules);
    }
    throw new Error(`rules of ${node} fell through`);
  };
  const def = node === START ? doc.start : doc.nodes[node];
  if (!def || !("rules" in def)) return {};
  return evalRules(def.rules);
}

// ------------------------------------------------------- hand-rule check ----

export interface HandRuleCheck {
  /** Branching decisions checked (player selects and single-exit nodes excluded). */
  decisions: number;
  /** Observed moves the rules give probability 0 for that fleet. `example`: ship types of one such fleet. */
  impossible: { node: string; to: string; count: number; example: string }[];
  /** Fleets the rules treat alike at a node (same next-node distribution) whose observed shares differ. */
  divergent: { node: string; expected: Record<string, number>; observed: Record<string, number>; n: number; tv: number; p: number }[];
}

const STYPE_CODE = Object.fromEntries(Object.entries(SHIP_TYPES).map(([k, v]) => [v, k])) as Record<number, string>;

/**
 * Compares observed sorties with a routing document. Divergence is judged per (node, expected distribution):
 * groups with ≥ `minSamples` decisions whose observed shares differ by ≥ `minTv` (total variation) and fail a
 * G goodness-of-fit test at `alpha` after a Bonferroni correction over the groups tested.
 */
export function checkHandRules(
  doc: RoutingDoc, edges: Edge[], sorties: SortieSample[], { minSamples = 30, minTv = 0.15, alpha = 0.01 } = {},
): HandRuleCheck {
  const exits = new Map<string, number>();
  for (const e of edges) exits.set(e.from, (exits.get(e.from) ?? 0) + 1);
  const impossible = new Map<string, HandRuleCheck["impossible"][number]>();
  const groups = new Map<string, { node: string; expected: Record<string, number>; observed: Record<string, number>; n: number }>();
  let decisions = 0;
  const judge = (s: SortieSample, node: string, visited: Set<string>, to: string) => {
    decisions++;
    const expected = nextDistribution(doc, node, s, visited);
    if (!expected[to]) {
      const key = `${node}>${to}`;
      const hit = impossible.get(key);
      if (hit) hit.count++;
      else impossible.set(key, { node, to, count: 1, example: [...s.main, ...(s.escort ?? [])].map((x) => STYPE_CODE[x.stype] ?? x.stype).join(" ") });
      return;
    }
    const sorted = Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b)));
    const key = `${node}|${JSON.stringify(sorted)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { node, expected: sorted, observed: {}, n: 0 }));
    g.observed[to] = (g.observed[to] ?? 0) + 1;
    g.n++;
  };
  for (const s of sorties) {
    if (doc.start) judge(s, START, new Set(), s.path[0]!);
    const visited = new Set<string>();
    for (let j = 0; j + 1 < s.path.length; j++) {
      const node = s.path[j]!;
      visited.add(node);
      if (!s.selects?.[node] && (exits.get(node) ?? 0) > 1) judge(s, node, new Set(visited), s.path[j + 1]!);
    }
  }
  const tested = [...groups.values()].filter((g) => g.n >= minSamples && Object.keys(g.expected).length > 0);
  const divergent = tested.flatMap((g) => {
    const keys = new Set([...Object.keys(g.expected), ...Object.keys(g.observed)]);
    let tv = 0;
    let stat = 0;
    for (const k of keys) {
      const o = g.observed[k] ?? 0;
      const e = (g.expected[k] ?? 0) * g.n;
      tv += Math.abs(o / g.n - (g.expected[k] ?? 0));
      if (o > 0) stat += o * Math.log(o / e);
    }
    tv /= 2;
    const df = Object.keys(g.expected).length - 1;
    const p = df > 0 ? chi2sf(2 * stat, df) : 1;
    return tv >= minTv && p * tested.length < alpha ? [{ ...g, tv: Math.round(tv * 1000) / 1000, p }] : [];
  });
  return { decisions, impossible: [...impossible.values()].sort((a, b) => b.count - a.count), divergent: divergent.sort((a, b) => b.tv - a.tv) };
}

// ------------------------------------------------------ poi observations ----

const start2Ships = z.object({
  api_mst_ship: z.array(z.object({ api_id: z.number(), api_stype: z.number(), api_aftershipid: z.union([z.string(), z.number()]).optional() }).loose()),
}).loose();
/** `api_mst_ship` (id, stype, remodel target) of an api_start2 JSON (e.g. the npm @kancolle/data snapshot). */
export const parseStart2Ships = (json: unknown) => start2Ships.parse(json).api_mst_ship;

/** Remodel families (api_aftershipid chains, every id of one ship) of player ships (id < 1500). */
export function shipFamilies(ships: { api_id: number; api_aftershipid?: string | number }[]): number[][] {
  const player = ships.filter((s) => s.api_id < 1500);
  const parent = new Map(player.map((s) => [s.api_id, s.api_id]));
  const find = (x: number): number => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (const s of player) {
    const after = Number(s.api_aftershipid ?? 0);
    if (after > 0 && parent.has(after)) parent.set(find(after), find(s.api_id));
  }
  const groups = new Map<number, number[]>();
  for (const s of player) {
    const root = find(s.api_id);
    groups.set(root, [...(groups.get(root) ?? []), s.api_id]);
  }
  return [...groups.values()].map((g) => g.sort((a, b) => a - b));
}

const equipJson = z.object({ masterId: z.number(), improvement: z.number().default(0) }).loose();
const shipJson = z.object({
  masterId: z.number(),
  equips: z.array(equipJson.nullable()),
  exSlot: equipJson.nullish(),
  observed: z.object({ los: z.number().optional(), speed: z.number().optional() }).loose().optional(),
}).loose();
type ShipJson = z.infer<typeof shipJson>;
/** The columns of a stored sortie observation (observations.kind = 'sortie') that inference reads; JSON columns parsed. */
export const observedSortieRow = z.object({
  difficulty: z.number().nullable(),
  fleet: z.object({ ships: z.array(shipJson), escort: z.array(shipJson).optional() }).loose().nullable(),
  sortie: z.object({
    combined: z.number().nullish(),
    /** server-derived (ingest/validate.ts sortieFleetType); older records lack it */
    fleetType: z.enum(["single", "ctf", "stf", "tcf", "striking"]).nullish(),
    gauge: z.object({ gaugeNum: z.number().nullable() }).loose().nullish(),
    cells: z.array(z.object({
      no: z.number(),
      selectCells: z.array(z.number()).nullish(),
      result: z.object({ escape: z.object({ retreated: z.boolean() }).loose().nullish() }).loose().nullish(),
    }).loose()),
    features: z.object({ hqLevel: z.number().nullish() }).loose().nullish(),
  }).loose().nullable(),
});
export type ObservedSortieRow = z.infer<typeof observedSortieRow>;
export interface MasterLookup {
  ship: (id: number) => { stype: number; speed: number | null } | undefined;
  equip: (id: number) => { cat: number; los: number } | undefined;
}

/** Combined-fleet type by the stored `fleetType`, else by api_combined_flag (older records). */
const FLEET_TYPES: Record<string, FleetType> = { ctf: "ctf", stf: "stf", tcf: "tcf" };
const COMBINED_FLAG: Record<number, FleetType> = { 1: "ctf", 2: "stf", 3: "tcf" };

/**
 * Converts a stored sortie observation into a sample. Cells become letters through the map's edges
 * (edge id = destination cell number): path = [from of the first cell's edge, to of every cell's edge].
 * The path ends at a cell after which ships retreated (FCF, `result.escape.retreated`): later decisions were
 * made by a smaller fleet than the snapshot. A striking force (遊撃部隊) counts as `single`, as in the sim-core
 * evaluator, which has no `striking` fleet type yet. Returns the reason when the observation cannot be used.
 */
export function observedSortie(row: ObservedSortieRow, edgesById: Map<number, Edge>, master: MasterLookup): SortieSample | { reason: string } {
  if (!row.fleet?.ships.length || !row.sortie?.cells.length) return { reason: "no fleet or cells" };
  const route = (ships: ShipJson[]): RouteShip[] | string => {
    const out: RouteShip[] = [];
    for (const s of ships) {
      const m = master.ship(s.masterId);
      if (!m) return `unknown ship ${s.masterId}`;
      const equips: RouteEquip[] = [];
      for (const e of [...s.equips, s.exSlot ?? null]) {
        if (!e) continue;
        const em = master.equip(e.masterId);
        if (!em) return `unknown equipment ${e.masterId}`;
        equips.push({ id: e.masterId, cat: em.cat, los: em.los, level: e.improvement });
      }
      const speed = s.observed?.speed ?? m.speed;
      if (s.observed?.los === undefined || speed == null) return "fleet snapshot without observed LoS / speed";
      out.push({ stype: m.stype, id: s.masterId, speed, nakedLos: s.observed.los - equips.reduce((n, e) => n + e.los, 0), equips });
    }
    return out;
  };
  const main = route(row.fleet.ships);
  if (typeof main === "string") return { reason: main };
  const escort = row.fleet.escort?.length ? route(row.fleet.escort) : undefined;
  if (typeof escort === "string") return { reason: escort };
  const cells = row.sortie.cells;
  const first = edgesById.get(cells[0]!.no);
  if (!first) return { reason: `cell ${cells[0]!.no} is not an edge of the map` };
  const path = [first.from];
  const selects: Record<string, string[]> = {};
  for (const c of cells) {
    const e = edgesById.get(c.no);
    if (!e) return { reason: `cell ${c.no} is not an edge of the map` };
    path.push(e.to);
    if (c.selectCells?.length) selects[e.to] = c.selectCells.map((n) => edgesById.get(n)?.to ?? String(n));
    if (c.result?.escape?.retreated) break;
  }
  const fleetType = FLEET_TYPES[row.sortie.fleetType ?? ""] ?? COMBINED_FLAG[row.sortie.combined ?? 0] ?? "single";
  return {
    main, ...(escort ? { escort, fleetType } : {}),
    hq: row.sortie.features?.hqLevel ?? 120, difficulty: row.difficulty ?? 0,
    ...(row.sortie.gauge?.gaugeNum ? { gauge: row.sortie.gauge.gaugeNum } : {}), path, selects,
  };
}
