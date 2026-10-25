// Observed map graph (poi-observed) for GET /api/v1/maps/{map} `observed` and the bundle export.
import { cellLetters } from "./aggregate";

type Row = Record<string, unknown>;

export const OBSERVED_LAYOUT_COLS = "map_id, layout, version, boss_cell, sorties, encounters, first_seen, last_seen, current";
export const OBSERVED_CELL_COLS = "map_id, layout, cell_no, color_no, event_id, event_kind, visits, is_boss, lbas_distance";
export const OBSERVED_EDGE_SQL = "SELECT map_id, layout, from_cell, to_cell, SUM(count) AS count FROM poi_edge_counts";
export const OBSERVED_EDGE_GROUP = "GROUP BY map_id, layout, from_cell, to_cell";
export const MISMATCH_COLS = "map_id, layout, kind, from_cell, to_cell, count, observed, stored, checked_at";

/**
 * The current layout of one map (poi_layouts.current, chosen when its comp sets are materialised: see
 * aggregate.ts currentLayout; the newest before that): cells, transitions (summed over difficulty) and mismatches
 * against the stored graph, with letters resolved from `edges` (null when unresolvable). Null when nothing is observed.
 */
export function observedGraphJson(rows: { layouts: Row[]; cells: Row[]; edgeCounts: Row[]; mismatches: Row[]; edges: Row[] }) {
  const current = rows.layouts.find((l) => l.current === 1) ?? [...rows.layouts].sort((a, b) => (b.version as number) - (a.version as number))[0];
  if (!current) return null;
  const mine = (r: Row) => r.layout === current.layout;
  const edges = rows.edges as { edge_id: number; from_letter: string; to_letter: string }[];
  const letters = cellLetters(edges);
  const byId = new Map(edges.map((e) => [e.edge_id, e]));
  return {
    layout: {
      version: current.version, cellCount: current.layout ? String(current.layout).split(",").length : null,
      sorties: current.sorties, encounters: current.encounters, firstSeen: current.first_seen, lastSeen: current.last_seen,
      bossCell: current.boss_cell, bossLetter: letters.get(current.boss_cell as number) ?? null,
    },
    layoutVersions: rows.layouts.length,
    cells: rows.cells.filter(mine).sort((a, b) => (a.cell_no as number) - (b.cell_no as number)).map((c) => ({
      no: c.cell_no, letter: letters.get(c.cell_no as number) ?? null, colorNo: c.color_no, eventId: c.event_id,
      eventKind: c.event_kind, visits: c.visits, isBoss: !!c.is_boss, lbasDistance: c.lbas_distance ?? null,
    })),
    edges: rows.edgeCounts.filter(mine).sort((a, b) => (a.to_cell as number) - (b.to_cell as number) || (a.from_cell as number) - (b.from_cell as number))
      .map((e) => {
        const into = byId.get(e.to_cell as number);
        // A cell without an incoming stored edge is a start point: take the stored edge's Start node.
        const fromLetter = letters.get(e.from_cell as number) ?? (into?.from_letter.startsWith("Start") ? into.from_letter : null);
        return { from: e.from_cell, to: e.to_cell, fromLetter, toLetter: into?.to_letter ?? null, count: e.count };
      }),
    mismatches: rows.mismatches.filter(mine).map((m) => ({
      kind: m.kind, from: m.from_cell === -1 ? null : m.from_cell, to: m.to_cell, count: m.count, observed: m.observed,
      stored: m.stored, checkedAt: m.checked_at,
    })),
  };
}

/** Node letter -> LBAS distance from the observed cells (the nearest cell when a letter has several). */
export function lbasDistanceByLetter(observed: { cells: { letter: string | null; lbasDistance: unknown }[] } | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of observed?.cells ?? []) {
    if (c.letter === null || c.lbasDistance === null) continue;
    out.set(c.letter, Math.min(out.get(c.letter) ?? Infinity, c.lbasDistance as number));
  }
  return out;
}
