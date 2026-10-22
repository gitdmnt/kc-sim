// Compares a routing document with observed KCNav edge counts (nodesummary). Fleet-independent checks
// only: rule coverage of observed branches, never-observed rule branches, and the distribution of
// nodes whose rules do not depend on the fleet.
import type { Rule, RoutingDoc } from "./schema";

export interface EdgeRuns { from: string; to: string; runs: number }

export interface NodeComparison {
  node: string;
  total: number;
  observed: Record<string, number>;
  /** Destinations any rule can produce. */
  ruleTargets: string[];
  /** Observed (runs > 0) but no rule can produce it: a missing rule. */
  uncovered: string[];
  /** A rule target with zero runs although the node has ≥ minSample runs. */
  unobserved: string[];
  /** Fleet-independent nodes only: expected vs observed share per destination. */
  distribution?: { expected: Record<string, number>; observedShare: Record<string, number>; maxAbsDiff: number; ok: boolean };
}

function targets(rules: Rule[], out: Set<string>): void {
  for (const r of rules) {
    if ("to" in r) out.add(r.to);
    else if ("random" in r) r.random.forEach((e) => out.add(e.to));
    else if ("los" in r) { r.los.thresholds.forEach((t) => out.add(t.to)); out.add(r.los.below); }
    else if ("select" in r) r.select.forEach((t) => out.add(t));
    else targets(r.rules, out);
  }
}

/** Distribution when the first rule that can fire is unconditional fixed/random, else null. */
function fleetIndependent(rules: Rule[]): Record<string, number> | null {
  const r = rules[0];
  if (!r || r.when !== undefined) return null;
  if ("to" in r) return { [r.to]: 1 };
  if ("random" in r) {
    const d: Record<string, number> = {};
    for (const e of r.random) d[e.to] = (d[e.to] ?? 0) + e.p;
    return d;
  }
  return null;
}

export function compareRouting(
  doc: RoutingDoc,
  edges: EdgeRuns[],
  opts: { minSample?: number; tolerance?: number } = {},
): NodeComparison[] {
  const minSample = opts.minSample ?? 200;
  const tolerance = opts.tolerance ?? 0.05;
  const byFrom = new Map<string, Record<string, number>>();
  for (const e of edges) {
    const o = byFrom.get(e.from) ?? {};
    o[e.to] = (o[e.to] ?? 0) + e.runs;
    byFrom.set(e.from, o);
  }
  const out: NodeComparison[] = [];
  for (const [node, observed] of byFrom) {
    const def = doc.nodes[node];
    const total = Object.values(observed).reduce((s, n) => s + n, 0);
    const ruleTargets = new Set<string>();
    if (def && "rules" in def) targets(def.rules, ruleTargets);
    const seen = Object.keys(observed).filter((t) => observed[t]! > 0);
    const cmp: NodeComparison = {
      node, total, observed, ruleTargets: [...ruleTargets].sort(),
      uncovered: seen.filter((t) => !ruleTargets.has(t)).sort(),
      unobserved: total >= minSample ? [...ruleTargets].filter((t) => !(observed[t]! > 0)).sort() : [],
    };
    const expected = def && "rules" in def ? fleetIndependent(def.rules) : null;
    if (expected && total >= minSample) {
      const keys = new Set([...Object.keys(expected), ...Object.keys(observed)]);
      const observedShare: Record<string, number> = {};
      let maxAbsDiff = 0;
      for (const k of keys) {
        observedShare[k] = (observed[k] ?? 0) / total;
        maxAbsDiff = Math.max(maxAbsDiff, Math.abs((expected[k] ?? 0) - observedShare[k]!));
      }
      cmp.distribution = { expected, observedShare, maxAbsDiff, ok: maxAbsDiff <= tolerance };
    }
    out.push(cmp);
  }
  return out.sort((a, b) => a.node.localeCompare(b.node));
}
