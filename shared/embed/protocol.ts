// postMessage protocol between the poi plugin (parent, file://) and the web UI it embeds in an iframe.
//
//   web → plugin   ready        { v }                             once the web UI listens
//   plugin → web   state        { info, const?, combinedFlag? }   after every ready (const included), then on change
//   plugin → web   presets      { json }                          the plugin's old presets, once per origin until acked
//   web → plugin   presets-ack  { imported, skipped, persisted }  persisted = saved to storage that survives a reload
//
// Every message is `{ src: "kcsim", v, type, ...fields }`. `v` is the sender's protocol version: adding an optional
// field, or a message type the peer may ignore, keeps it; any other change bumps it, and the web UI (deployed at once)
// keeps accepting the previous version for at least one plugin release. Unknown types are ignored. The plugin always
// draws the one header (シミュレーション / 観測ログ / 送信設定); the embedded web UI draws none (v2 dropped v1's
// `hostViews` / `host` / `open-view`, which merged the plugin's views into the web UI's header; a v1 plugin ignores
// their absence and keeps its own tab bar). The poi state never leaves the user's machine: the
// plugin projects it to the keys below (what shared/fleet/poiImport.ts, the catalog and the map tab read; keep the
// lists in step with them) and posts it only to the iframe's origin.

export const EMBED_SOURCE = "kcsim";
export const EMBED_VERSION = 2;
/** Oldest plugin protocol the web UI still accepts. */
export const EMBED_MIN_VERSION = 1;
/** Upper bound for the presets JSON (the plugin's localStorage holds a few MB at most). */
export const MAX_PRESETS_JSON = 8 * 1024 * 1024;

/** The poi redux slices the web UI reads (`info` = 母港, `const` = master data, `state.sortie.combinedFlag`). */
export interface PoiState {
  info: unknown;
  const: unknown;
  /** poi's `state.sortie.combinedFlag` (api_combined_flag: 0 none, 1 機動, 2 水上, 3 輸送) */
  combinedFlag?: unknown;
}

/**
 * What the web UI reads from `state.info` (shared/fleet/poiImport.ts): HQ level, fleets (id, name, ship ids), land
 * bases (area, number, name, action, squadrons), and per ship / equipment instance only the fields below. Fleet
 * `api_member_id` (the admiral's id), base distances, missions, resources, quests, the admiral's name, … are dropped.
 */
export interface PoiInfo {
  basic: { api_level?: unknown };
  fleets: unknown;
  ships: unknown;
  equips: unknown;
  airbase: unknown;
}

const FLEET_KEYS = ["api_id", "api_name", "api_ship"];
const SHIP_KEYS = [
  "api_id", "api_ship_id", "api_lv", "api_slot", "api_onslot", "api_slotnum", "api_slot_ex", "api_kyouka", "api_maxhp",
  "api_nowhp", "api_karyoku", "api_raisou", "api_taiku", "api_soukou", "api_kaihi", "api_taisen", "api_sakuteki",
  "api_lucky", "api_leng", "api_soku", "api_cond", "api_sp_effect_items",
];
const EQUIP_KEYS = ["api_id", "api_slotitem_id", "api_level", "api_alv"];
const AIRBASE_KEYS = ["api_area_id", "api_rid", "api_name", "api_action_kind"];
const SQUADRON_KEYS = ["api_squadron_id", "api_state", "api_slotid", "api_count", "api_max_count"];

/** What the web UI reads from `state.const`: catalog (ships, equips, type names) and map area names. */
export interface PoiConst {
  $ships: unknown;
  $equips: unknown;
  $shipTypes: unknown;
  $equipTypes: unknown;
  $mapareas: unknown;
}

export type WebMessage =
  | { src: typeof EMBED_SOURCE; v: number; type: "ready" }
  | { src: typeof EMBED_SOURCE; v: number; type: "presets-ack"; imported: number; skipped: number; persisted: boolean };

export type PluginMessage =
  | { src: typeof EMBED_SOURCE; v: number; type: "state"; info: PoiInfo; const?: PoiConst; combinedFlag?: number }
  | { src: typeof EMBED_SOURCE; v: number; type: "presets"; json: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

const at = (v: unknown, key: string): unknown => (isObject(v) ? v[key] : undefined);

/** The listed own keys of an object (others dropped); non-objects become undefined. */
const pick = (v: unknown, keys: readonly string[]): Record<string, unknown> | undefined => {
  if (!isObject(v)) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (Object.hasOwn(v, k)) out[k] = v[k];
  return out;
};

/** Applies `pick` to every entry of an array (poi's fleets) or an id-keyed object (ships, equips). */
const pickEach = (v: unknown, keys: readonly string[]): unknown => {
  if (Array.isArray(v)) return v.map((e) => pick(e, keys) ?? null);
  if (!isObject(v)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [id, e] of Object.entries(v)) out[id] = pick(e, keys) ?? null;
  return out;
};

/** Projects poi's `info` to the keys the web UI reads (see PoiInfo). Also applied on receipt. */
export const projectInfo = (info: unknown): PoiInfo => {
  const bases = at(info, "airbase");
  return {
    basic: { api_level: at(at(info, "basic"), "api_level") },
    fleets: pickEach(at(info, "fleets"), FLEET_KEYS),
    ships: pickEach(at(info, "ships"), SHIP_KEYS),
    equips: pickEach(at(info, "equips"), EQUIP_KEYS),
    airbase: Array.isArray(bases)
      ? bases.map((b) => {
          const base = pick(b, AIRBASE_KEYS);
          return base ? { ...base, api_plane_info: pickEach(at(b, "api_plane_info"), SQUADRON_KEYS) } : null;
        })
      : undefined,
  };
};

/** poi's combined flag (0..3), else undefined. */
export const projectCombinedFlag = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3 ? v : undefined;

export const projectConst = (c: unknown): PoiConst => ({
  $ships: at(c, "$ships"),
  $equips: at(c, "$equips"),
  $shipTypes: at(c, "$shipTypes"),
  $equipTypes: at(c, "$equipTypes"),
  $mapareas: at(c, "$mapareas"),
});

/** `src` and an integer `v` ≥ 1, else null. */
export const readEnvelope = (data: unknown): (Record<string, unknown> & { v: number; type: string }) | null => {
  if (!isObject(data) || data.src !== EMBED_SOURCE) return null;
  const { v, type } = data;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || typeof type !== "string") return null;
  return data as Record<string, unknown> & { v: number; type: string };
};

/** A message from the web UI, or null (foreign, malformed or unknown type). */
export const parseWebMessage = (data: unknown): WebMessage | null => {
  const m = readEnvelope(data);
  if (!m) return null;
  if (m.type === "ready") return { src: EMBED_SOURCE, v: m.v, type: "ready" };
  if (m.type === "presets-ack" && isCount(m.imported) && isCount(m.skipped) && typeof m.persisted === "boolean") {
    return { src: EMBED_SOURCE, v: m.v, type: "presets-ack", imported: m.imported, skipped: m.skipped, persisted: m.persisted };
  }
  return null;
};

/** A message from the plugin in a version this web UI accepts, or null. */
export const parsePluginMessage = (data: unknown): PluginMessage | null => {
  const m = readEnvelope(data);
  if (!m || m.v < EMBED_MIN_VERSION || m.v > EMBED_VERSION) return null;
  if (m.type === "state") {
    if (!isObject(m.info) || (m.const !== undefined && !isObject(m.const))) return null;
    // Keep only the projected keys even if the sender added more.
    const msg: PluginMessage = { src: EMBED_SOURCE, v: m.v, type: "state", info: projectInfo(m.info) };
    if (m.const !== undefined) msg.const = projectConst(m.const);
    const combinedFlag = projectCombinedFlag(m.combinedFlag);
    if (combinedFlag !== undefined) msg.combinedFlag = combinedFlag;
    return msg;
  }
  if (m.type === "presets" && typeof m.json === "string" && m.json.length <= MAX_PRESETS_JSON) {
    return { src: EMBED_SOURCE, v: m.v, type: "presets", json: m.json };
  }
  return null;
};

// An array, not an object: hostnames like "constructor" must not hit Object.prototype.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Origin of the server URL the plugin embeds and uploads to, or null when it is not allowed: https anywhere,
 * http only on this machine (local `wrangler dev` / vite). Anything else (file:, javascript:, plain http) is refused.
 */
export const serverOrigin = (url: string): string | null => {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOSTS.includes(u.hostname))) return u.origin;
  return null;
};

/**
 * Whether the web UI accepts messages from a parent with this origin. poi's plugin window is a file:// page, which
 * Chromium reports as "file://". `dev` also allows local http pages (the plugin's dev harness).
 *
 * "null" is accepted only until a real poi window confirms which string it reports: "null" is also the origin of any
 * sandboxed iframe or data: document, so drop it once "file://" is confirmed. (The effect stays inside the framing
 * site's partitioned storage, so it is not a hole today, but it is wider than needed.)
 */
export const isAllowedParentOrigin = (origin: string, dev: boolean): boolean => {
  if (origin === "file://" || origin === "null") return true;
  if (!dev) return false;
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && LOCAL_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
};
