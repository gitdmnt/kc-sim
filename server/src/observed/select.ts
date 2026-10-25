// Source preference for enemy comp sets (private notes API §2 enemy-comps): poi-observed when the node has
// enough own encounters, else KCNav. Shared by the read API and the bundle export.
import { OBSERVED_SOURCE } from "./aggregate";

export const DEFAULT_MIN_OBSERVED = 30;
export const SOURCE_PREFS = ["auto", "all", "kcnav", OBSERVED_SOURCE] as const;
export type SourcePref = (typeof SOURCE_PREFS)[number];

interface CompLike { count: number; weight: number; lastSeen?: unknown }
interface SetLike<C extends CompLike> {
  difficulty: unknown; periodEnd: string | null; totalCount: unknown; source: unknown; comps: C[];
}

export interface Selection {
  difficulty: number;
  /** Source of the returned sets for this difficulty (`auto`: the source the policy picked). */
  source: string | null;
  /** Encounters in the current-layout poi-observed set (0 if none). */
  observedCount: number;
  minObserved: number;
}

/**
 * - `since` drops KCNav sets that ended before it and poi-observed comps last seen before it
 *   (weights and totalCount are renormalised).
 * - Per difficulty, `auto` returns the current-layout poi-observed set when its count ≥ minObserved, else the
 *   other sources' sets, else the poi-observed set; `kcnav` / `poi-observed` force one side; `all` returns
 *   every set (selection still reports what `auto` would pick).
 */
export function selectCompSets<C extends CompLike, S extends SetLike<C>>(
  sets: S[], opts: { minObserved: number; prefer: SourcePref; since?: string | null },
): { sets: S[]; selection: Selection[] } {
  const since = opts.since ?? null;
  const filtered = since === null ? sets : sets.flatMap((s): S[] => {
    if (s.source !== OBSERVED_SOURCE) return s.periodEnd && s.periodEnd < since ? [] : [s];
    const comps = s.comps.filter((c) => typeof c.lastSeen !== "string" || c.lastSeen >= since);
    const total = comps.reduce((n, c) => n + c.count, 0);
    return total ? [{ ...s, totalCount: total, comps: comps.map((c) => ({ ...c, weight: c.count / total })) }] : [];
  });
  const out: S[] = [];
  const selection: Selection[] = [];
  const diffs = [...new Set(filtered.map((s) => s.difficulty as number))].sort((a, b) => a - b);
  for (const d of diffs) {
    const mine = filtered.filter((s) => s.difficulty === d);
    const observed = mine.find((s) => s.source === OBSERVED_SOURCE && !s.periodEnd);
    const others = mine.filter((s) => s.source !== OBSERVED_SOURCE);
    const n = (observed?.totalCount as number | undefined) ?? 0;
    const auto = observed && n >= opts.minObserved ? [observed] : others.length ? others : observed ? [observed] : [];
    const chosen = opts.prefer === "all" ? mine
      : opts.prefer === "kcnav" ? others
      : opts.prefer === OBSERVED_SOURCE ? (observed ? [observed] : [])
      : auto;
    const picked = opts.prefer === "all" ? auto : chosen;
    selection.push({ difficulty: d, source: (picked[0]?.source as string | undefined) ?? null, observedCount: n, minObserved: opts.minObserved });
    out.push(...chosen);
  }
  return { sets: out, selection };
}
