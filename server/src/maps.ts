// Map / node naming shared by the worker, ingest scripts and the KCNav parser.

/** "1-5" -> 15, "62-1" -> 621 (api_mst_mapinfo.api_id). Also accepts a numeric id string. */
export function parseMapKey(key: string): { id: number; world: number; no: number } | null {
  const m = /^(\d+)-(\d+)$/.exec(key);
  if (m) {
    const world = Number(m[1]);
    const no = Number(m[2]);
    return { id: world * 10 + no, world, no };
  }
  if (/^\d+$/.test(key)) {
    const id = Number(key);
    return { id, world: Math.floor(id / 10), no: id % 10 };
  }
  return null;
}

export const mapName = (id: number) => `${Math.floor(id / 10)}-${id % 10}`;

/**
 * Canonical node letter (private notes ROUTING_DSL §1): KC3 "Start" / "Start 2" and KCNav numeric start
 * spots "1", "2" become "Start" (single start) or "Start1", "Start2" (several starts).
 */
export function normalizeLetter(label: string, multipleStarts: boolean): string {
  const kc3 = /^Start ?(\d*)$/.exec(label);
  if (kc3) return kc3[1] ? `Start${kc3[1]}` : "Start";
  if (/^\d+$/.test(label)) return multipleStarts ? `Start${label}` : "Start";
  return label;
}

/**
 * Node type from game api_event_id / api_event_kind (KCNav route[3]; kcwiki node_types `id`/`kind`).
 * Combinations checked against kcwiki db/node_types-57..62.json; event ids 7 and 8 are unverified.
 * Kind 7 = 夜昼戦 (払暁戦, KC3Kai src/library/objects/Node.js `knownNodeExtraClasses` "nc_night_to_day"
 * and kc3-translations terms `BattleKindNightToDay`; not in the kcwiki files).
 */
export function nodeTypeFromEvent(eventId: number | null | undefined, eventKind?: number | null): string | null {
  switch (eventId) {
    case 0: return eventKind === 0 ? "landing" : "start";
    case 2: return "resource";
    case 3: return "maelstrom";
    case 4: return eventKind === 2 ? "night_battle" : eventKind === 4 ? "air_battle" : eventKind === 6 ? "air_raid" : eventKind === 7 ? "night_to_day" : "battle";
    case 5: return "boss";
    case 6: return eventKind === 2 ? "select" : "empty";
    case 7: return eventKind === 0 ? "air_recon" : "air_battle";
    case 8: return "escort_success";
    case 9: return "landing";
    case 10: return "anchorage_repair";
    default: return null;
  }
}
