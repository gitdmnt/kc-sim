import { routingDoc, type Predicate, type Rule, type RoutingDoc } from "./schema";

export interface Edge { from: string; to: string }

const START = "@start";
/**
 * Structural (zod) + semantic validation of a routing document.
 * `edges` (when given) enables adjacency checks: every destination must be an outgoing edge of
 * the node, and every node with outgoing edges must have rules.
 */
export function validateRoutingDoc(input: unknown, edges?: Edge[]): { doc?: RoutingDoc; errors: string[] } {
  const parsed = routingDoc.safeParse(input);
  if (!parsed.success) {
    return { errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  const doc = parsed.data;
  const errors: string[] = [];
  const out = new Map<string, Set<string>>();
  for (const e of edges ?? []) {
    if (!out.has(e.from)) out.set(e.from, new Set());
    out.get(e.from)!.add(e.to);
  }
  const known = new Set<string>([...out.keys(), ...(edges ?? []).map((e) => e.to)]);
  // Doc-level `start` rules choose among the map's start points (virtual source node START).
  const startNodes = [...known].filter((n) => /^Start\d*$/.test(n));
  out.set(START, new Set(startNodes));

  const checkPred = (p: Predicate, where: string) => {
    if ("all" in p) return p.all.forEach((q) => checkPred(q, where));
    if ("any" in p) return p.any.forEach((q) => checkPred(q, where));
    if ("not" in p) return checkPred(p.not, where);
    if (p.m === "visited" && edges && !known.has(p.node)) errors.push(`${where}: visited node ${p.node} not on map`);
  };

  const checkRules = (rules: Rule[], node: string, path: string) => {
    const dests: string[] = [];
    rules.forEach((r, i) => {
      const where = `${path}[${i}]`;
      if (r.when) checkPred(r.when, where);
      if ("to" in r) dests.push(r.to);
      else if ("random" in r) {
        const sum = r.random.reduce((s, e) => s + e.p, 0);
        if (Math.abs(sum - 1) > 1e-6) errors.push(`${where}: random weights sum to ${sum}, expected 1`);
        dests.push(...r.random.map((e) => e.to));
      } else if ("los" in r) {
        const mins = r.los.thresholds.map((t) => t.min);
        if (mins.some((m, k) => k > 0 && m >= mins[k - 1]!)) errors.push(`${where}: los thresholds must be strictly descending`);
        dests.push(...r.los.thresholds.map((t) => t.to), r.los.below);
      } else if ("select" in r) {
        dests.push(...r.select);
        const def = doc.defaults?.select?.[node];
        if (def !== undefined && !r.select.includes(def)) errors.push(`${where}: defaults.select.${node}=${def} not among options`);
      } else {
        checkRules(r.rules, node, `${where}.rules`);
      }
    });
    if (rules.at(-1)?.when !== undefined) errors.push(`${path}: last rule must be unconditional (no "when")`);
    if (edges) {
      const allowed = out.get(node) ?? new Set();
      for (const d of dests) if (!allowed.has(d)) errors.push(`${path}: ${node}->${d} is not an edge`);
    }
  };

  for (const [node, def] of Object.entries(doc.nodes)) {
    if ("rules" in def) checkRules(def.rules, node, `nodes.${node}.rules`);
    else if (edges && (out.get(node)?.size ?? 0) > 0) errors.push(`nodes.${node}: marked end but has outgoing edges`);
    if (edges && !known.has(node)) errors.push(`nodes.${node}: not on map`);
  }
  if (doc.start) checkRules(doc.start.rules, START, "start.rules");
  if (edges) {
    for (const [from] of out) if (from !== START && !(from in doc.nodes)) errors.push(`nodes.${from}: has outgoing edges but no rules`);
    if (startNodes.length > 1 && !doc.start) errors.push(`start: map has ${startNodes.length} start points (${startNodes.join(", ")}); a "start" rule list is required`);
  }
  for (const [node, choice] of Object.entries(doc.defaults?.select ?? {})) {
    if (!(node in doc.nodes)) errors.push(`defaults.select.${node}: unknown node`);
    else if (edges && !out.get(node)?.has(choice)) errors.push(`defaults.select.${node}: ${node}->${choice} is not an edge`);
  }
  return errors.length ? { doc, errors } : { doc, errors: [] };
}

/** Number of rules (nested included) and how many are marked `uncertain`. */
export function countRules(doc: RoutingDoc): { total: number; uncertain: number } {
  const walk = (rules: Rule[]): [number, number] =>
    rules.reduce<[number, number]>(([t, u], r) => {
      const [st, su] = "rules" in r ? walk(r.rules) : [0, 0];
      return [t + 1 + st, u + (r.uncertain ? 1 : 0) + su];
    }, [0, 0]);
  let total = 0;
  let uncertain = 0;
  for (const n of [...Object.values(doc.nodes), ...(doc.start ? [doc.start] : [])]) {
    if (!("rules" in n)) continue;
    const [t, u] = walk(n.rules);
    total += t;
    uncertain += u;
  }
  return { total, uncertain };
}
