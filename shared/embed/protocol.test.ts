import { describe, expect, test } from "bun:test";
import {
  EMBED_VERSION,
  MAX_PRESETS_JSON,
  isAllowedParentOrigin,
  parsePluginMessage,
  parseWebMessage,
  projectConst,
  projectInfo,
  serverOrigin,
} from "./protocol";
import { importFromPoi } from "../fleet/poiImport";
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
    });
    expect(JSON.stringify(projectInfo(info))).not.toContain("api_member_id");
    const c = { $ships: {}, $equips: {}, $shipTypes: {}, $equipTypes: {}, $mapareas: {}, $missions: {} };
    expect(Object.keys(projectConst(c)).sort()).toEqual(["$equipTypes", "$equips", "$mapareas", "$shipTypes", "$ships"]);
  });

  test("the projection keeps everything importFromPoi reads", () => {
    const state = { info: sample.info, const: sample.const };
    const projected = { info: projectInfo(sample.info), const: projectConst(sample.const) };
    for (const fleet of [0, 1, 2, 3]) {
      expect(importFromPoi(projected, fleet, { now: 1, id: "x" })).toEqual(importFromPoi(state, fleet, { now: 1, id: "x" }));
    }
    expect(importFromPoi(projected, 0)?.ships.length).toBeGreaterThan(0);
  });

  test("missing slices (poi not logged in) project to undefined fields", () => {
    expect(projectInfo(undefined)).toEqual({ basic: { api_level: undefined }, fleets: undefined, ships: undefined, equips: undefined });
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
});

describe("parseWebMessage", () => {
  test("ready and presets-ack", () => {
    expect(parseWebMessage({ src: "kcsim", v: 2, type: "ready" })).toEqual({ src: "kcsim", v: 2, type: "ready" });
    expect(parseWebMessage({ ...env, type: "presets-ack", imported: 2, skipped: 0, persisted: true })?.type).toBe("presets-ack");
    expect(parseWebMessage({ ...env, type: "presets-ack", imported: 2, skipped: 0, persisted: false })).toMatchObject({ persisted: false });
    expect(parseWebMessage({ ...env, type: "presets-ack", imported: 2, skipped: 0 })).toBeNull();
    expect(parseWebMessage({ ...env, type: "presets-ack", imported: -1, skipped: 0, persisted: true })).toBeNull();
    expect(parseWebMessage({ ...env, type: "state", info: {} })).toBeNull();
  });
});

describe("serverOrigin", () => {
  test("https anywhere, http only on this machine", () => {
    expect(serverOrigin("https://kc-sim.lumpoler.workers.dev/")).toBe("https://kc-sim.lumpoler.workers.dev");
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
