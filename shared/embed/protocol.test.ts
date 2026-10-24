import { describe, expect, test } from "bun:test";
import {
  EMBED_VERSION,
  MAX_PRESETS_JSON,
  isAllowedParentOrigin,
  parsePluginMessage,
  parseWebMessage,
  projectCombinedFlag,
  projectConst,
  projectInfo,
  serverOrigin,
} from "./protocol";
import { airBasesFromPoi, importCombinedFromPoi, importFromPoi } from "../fleet/poiImport";
import sample from "../../web/src/sampleState.json";

const env = { src: "kcsim", v: EMBED_VERSION };

describe("projection", () => {
  test("keeps only the keys the web UI reads", () => {
    const info = {
      basic: { api_level: 120, api_nickname: "提督", api_member_id: "123" },
      fleets: [{ api_member_id: 123, api_id: 1, api_name: "第1艦隊", api_ship: [5, -1], api_mission: [0, 0, 0, 0], api_flagship: "0" }],
      ships: { 5: { api_id: 5, api_ship_id: 1, api_lv: 99, api_exp: [1, 2, 3], api_locked: 1, api_sally_area: 0 } },
      equips: { 7: { api_id: 7, api_slotitem_id: 2, api_level: 10, api_locked: 1 } },
      resources: [1, 2, 3, 4],
      quests: {},
    };
    expect(projectInfo(info)).toEqual({
      basic: { api_level: 120 },
      fleets: [{ api_id: 1, api_name: "第1艦隊", api_ship: [5, -1] }],
      ships: { 5: { api_id: 5, api_ship_id: 1, api_lv: 99 } },
      equips: { 7: { api_id: 7, api_slotitem_id: 2, api_level: 10 } },
      airbase: undefined,
    });
    expect(JSON.stringify(projectInfo(info))).not.toContain("api_member_id");
    const bases = [
      {
        api_area_id: 6, api_rid: 1, api_name: "第1基地航空隊", api_action_kind: 1, api_distance: { api_base: 7, api_bonus: 0 },
        api_plane_info: [{ api_squadron_id: 1, api_state: 1, api_slotid: 7, api_count: 18, api_max_count: 18, api_cond: 1 }],
      },
    ];
    expect(projectInfo({ ...info, airbase: bases }).airbase).toEqual([
      {
        api_area_id: 6, api_rid: 1, api_name: "第1基地航空隊", api_action_kind: 1,
        api_plane_info: [{ api_squadron_id: 1, api_state: 1, api_slotid: 7, api_count: 18, api_max_count: 18 }],
      },
    ]);
    const c = { $ships: {}, $equips: {}, $shipTypes: {}, $equipTypes: {}, $mapareas: {}, $missions: {} };
    expect(Object.keys(projectConst(c)).sort()).toEqual(["$equipTypes", "$equips", "$mapareas", "$shipTypes", "$ships"]);
  });

  test("the projection keeps everything importFromPoi / importCombinedFromPoi / airBasesFromPoi read", () => {
    const state = { info: sample.info, const: sample.const, combinedFlag: 2 };
    const projected = { info: projectInfo(sample.info), const: projectConst(sample.const), combinedFlag: projectCombinedFlag(2) };
    for (const fleet of [0, 1, 2, 3]) {
      expect(importFromPoi(projected, fleet, { now: 1, id: "x" })).toEqual(importFromPoi(state, fleet, { now: 1, id: "x" }));
    }
    expect(importFromPoi(projected, 0)?.ships.length).toBeGreaterThan(0);
    expect(importCombinedFromPoi(projected, undefined, { now: 1, id: "x" })).toEqual(importCombinedFromPoi(state, undefined, { now: 1, id: "x" }));
    expect(airBasesFromPoi(projected, 6)).toEqual(airBasesFromPoi(state, 6));
    expect(airBasesFromPoi(projected, 6)).toHaveLength(3);
  });

  test("missing slices (poi not logged in) project to undefined fields", () => {
    expect(projectInfo(undefined)).toEqual({ basic: { api_level: undefined }, fleets: undefined, ships: undefined, equips: undefined, airbase: undefined });
    expect([0, 3, 4, -1, 1.5, "1", null].map(projectCombinedFlag)).toEqual([0, 3, undefined, undefined, undefined, undefined, undefined]);
  });
});

describe("parsePluginMessage", () => {
  test("state with and without const; extra keys dropped", () => {
    const m = parsePluginMessage({
      ...env,
      type: "state",
      info: { fleets: [{ api_member_id: 9, api_ship: [1] }], basic: { api_nickname: "x" } },
      const: { $ships: {} },
    });
    expect(m?.type).toBe("state");
    if (m?.type !== "state") throw new Error();
    expect(m.info.basic).toEqual({ api_level: undefined });
    expect(m.info.fleets).toEqual([{ api_ship: [1] }]);
    expect(m.const?.$ships).toEqual({});
    const n = parsePluginMessage({ ...env, type: "state", info: {} });
    expect(n && "const" in n).toBe(false);
    expect(n && "combinedFlag" in n).toBe(false);
    expect(parsePluginMessage({ ...env, type: "state", info: {}, combinedFlag: 1 })).toMatchObject({ combinedFlag: 1 });
    expect(parsePluginMessage({ ...env, type: "state", info: {}, combinedFlag: 9 })).not.toHaveProperty("combinedFlag");
  });

  test("quests are re-validated on receipt: malformed entries and goals dropped, extra keys stripped", () => {
    const m = parsePluginMessage({
      ...env, type: "state", info: {},
      quests: {
        list: [{ id: 101, state: 1, type: 4, progress: 0, title: "x" }, { id: "x", state: 1 }, null],
        active: "nope",
        records: { 214: [{ key: "sortie", count: 3, required: 36, description: "出撃", extra: 1 }, { key: "bad", count: "3" }], abc: [], 5: "x" },
        secret: 1,
      },
    });
    expect(m && m.type === "state" && m.quests).toEqual({
      list: [{ id: 101, state: 1, type: 4, progress: 0 }],
      active: [],
      records: { 214: [{ key: "sortie", description: "出撃", count: 3, required: 36 }] },
    });
    const none = parsePluginMessage({ ...env, type: "state", info: {}, quests: 1 });
    expect(none && "quests" in none).toBe(false);
    expect(parsePluginMessage({ ...env, type: "state", info: {}, quests: {} })).toMatchObject({ quests: { list: null, active: [], records: {} } });
  });

  test("rejects foreign, malformed and unsupported messages", () => {
    expect(parsePluginMessage(null)).toBeNull();
    expect(parsePluginMessage("kcsim")).toBeNull();
    expect(parsePluginMessage({ ...env, src: "other", type: "state", info: {} })).toBeNull();
    expect(parsePluginMessage({ src: "kcsim", type: "state", info: {} })).toBeNull();
    expect(parsePluginMessage({ src: "kcsim", v: 1.5, type: "state", info: {} })).toBeNull();
    expect(parsePluginMessage({ src: "kcsim", v: EMBED_VERSION + 1, type: "state", info: {} })).toBeNull();
    expect(parsePluginMessage({ ...env, type: "state", info: [] })).toBeNull();
    expect(parsePluginMessage({ ...env, type: "state", info: {}, const: null })).toBeNull();
    expect(parsePluginMessage({ ...env, type: "unknown" })).toBeNull();
    expect(parsePluginMessage({ ...env, type: "presets", json: 1 })).toBeNull();
    expect(parsePluginMessage({ ...env, type: "presets", json: "x".repeat(MAX_PRESETS_JSON + 1) })).toBeNull();
    expect(parsePluginMessage({ ...env, type: "presets", json: "[]" })).toEqual({ ...env, type: "presets", json: "[]" } as never);
  });

  test("a v1 plugin's state is still accepted; its host message (merged header) is ignored", () => {
    expect(parsePluginMessage({ src: "kcsim", v: 1, type: "state", info: {} })?.type).toBe("state");
    expect(parsePluginMessage({ src: "kcsim", v: 1, type: "host", views: [], insetLeft: 80 })).toBeNull();
  });

  test("view: only the web UI's own views, nothing else attached", () => {
    expect(parsePluginMessage({ ...env, type: "view", view: "map", extra: 1 })).toEqual({ ...env, type: "view", view: "map" } as never);
    expect(parsePluginMessage({ ...env, type: "view", view: "sim-settings" })?.type).toBe("view");
    // the plugin's own views never reach the iframe; unknown or prototype names are refused
    for (const view of ["log", "upload", "resources-chart", "estimate", "constructor", 1, undefined]) {
      expect(parsePluginMessage({ ...env, type: "view", view })).toBeNull();
    }
    expect(parsePluginMessage({ src: "kcsim", v: EMBED_VERSION + 1, type: "view", view: "map" })).toBeNull();
  });
});

describe("parseWebMessage", () => {
  test("ready and presets-ack", () => {
    expect(parseWebMessage({ src: "kcsim", v: 2, type: "ready" })).toEqual({ src: "kcsim", v: 2, type: "ready" });
    expect(parseWebMessage({ ...env, type: "presets-ack", imported: 2, skipped: 0, persisted: true })?.type).toBe("presets-ack");
    expect(parseWebMessage({ ...env, type: "presets-ack", imported: 2, skipped: 0, persisted: false })).toMatchObject({ persisted: false });
    expect(parseWebMessage({ ...env, type: "presets-ack", imported: 2, skipped: 0 })).toBeNull();
    expect(parseWebMessage({ ...env, type: "presets-ack", imported: -1, skipped: 0, persisted: true })).toBeNull();
    expect(parseWebMessage({ ...env, type: "state", info: {} })).toBeNull();
    expect(parseWebMessage({ ...env, type: "ready", hostViews: true })).toEqual({ ...env, type: "ready" } as never);
    expect(parseWebMessage({ ...env, type: "open-view", view: "log" })).toBeNull();
  });

  test("view: the web UI reports a move of its own", () => {
    expect(parseWebMessage({ ...env, type: "view", view: "sortie" })).toEqual({ ...env, type: "view", view: "sortie" } as never);
    expect(parseWebMessage({ ...env, type: "view", view: "log" })).toBeNull();
    expect(parseWebMessage({ ...env, type: "view" })).toBeNull();
  });
});

describe("serverOrigin", () => {
  test("https anywhere, http only on this machine", () => {
    expect(serverOrigin("https://kc-sim.udama.net/")).toBe("https://kc-sim.udama.net");
    expect(serverOrigin(" https://example.com/app/ ")).toBe("https://example.com");
    expect(serverOrigin("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(serverOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(serverOrigin("http://[::1]:8787/")).toBe("http://[::1]:8787");
    expect(serverOrigin("http://example.com/")).toBeNull();
    expect(serverOrigin("http://constructor/")).toBeNull();
    expect(serverOrigin("file:///etc/passwd")).toBeNull();
    expect(serverOrigin("javascript:alert(1)")).toBeNull();
    expect(serverOrigin("https://user:pw@example.com/")).toBeNull();
    expect(serverOrigin("")).toBeNull();
  });
});

describe("isAllowedParentOrigin", () => {
  test("poi's file:// window; local http only in dev", () => {
    expect(isAllowedParentOrigin("file://", false)).toBe(true);
    expect(isAllowedParentOrigin("null", false)).toBe(true);
    expect(isAllowedParentOrigin("http://localhost:5174", false)).toBe(false);
    expect(isAllowedParentOrigin("http://localhost:5174", true)).toBe(true);
    expect(isAllowedParentOrigin("https://evil.example", true)).toBe(false);
  });
});
