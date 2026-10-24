import { describe, expect, test } from "bun:test";
import type { PluginMessage } from "@shared/embed/protocol";
import { EmbedBridge } from "./bridge";

const setup = (presets: string | null = null) => {
  const sent: PluginMessage[] = [];
  let done = false;
  const versions: number[] = [];
  const views: string[] = [];
  const bridge = new EmbedBridge({
    post: (m) => sent.push(m),
    presetsJson: () => presets,
    presetsDone: () => done,
    markPresetsDone: () => {
      done = true;
    },
    onWebVersion: (v) => versions.push(v),
    onView: (v) => views.push(v),
  });
  return { bridge, sent, versions, views, isDone: () => done };
};

const ready = { src: "kcsim", v: 1, type: "ready" };
const master = { $ships: { 1: {} }, $equips: {}, $shipTypes: {}, $equipTypes: {}, $mapareas: {}, $missions: {} };
const info = (fleets: unknown[]) => ({ basic: { api_level: 120, api_nickname: "提督" }, fleets, ships: {}, equips: {}, quests: {} });

describe("EmbedBridge", () => {
  test("nothing is sent before ready; ready sends the latest state with const", () => {
    const { bridge, sent, versions } = setup();
    bridge.update({ info: info([1]), const: master });
    expect(sent).toEqual([]);
    bridge.onMessage(ready);
    expect(versions).toEqual([1]);
    expect(sent).toHaveLength(1);
    const m = sent[0];
    if (m.type !== "state") throw new Error("expected state");
    expect(m.const?.$ships).toEqual({ 1: {} });
    expect(m.info.basic).toEqual({ api_level: 120 });
    expect(JSON.stringify(m)).not.toContain("提督");
    expect(JSON.stringify(m)).not.toContain("$missions");
  });

  test("const only when it changes; info only when the parts the web UI reads change", () => {
    const { bridge, sent } = setup();
    const fleets = [1];
    const base = info(fleets);
    bridge.update({ info: base, const: master });
    bridge.onMessage(ready);
    // another info object with the same parts (e.g. resources changed): nothing to send
    bridge.update({ info: { ...base, resources: [1, 2] }, const: master });
    expect(sent).toHaveLength(1);
    bridge.update({ info: { ...base, fleets: [2] }, const: master });
    expect(sent).toHaveLength(2);
    expect("const" in sent[1]).toBe(false);
    const newMaster = { ...master };
    bridge.update({ info: { ...base, fleets: [2] }, const: newMaster });
    expect(sent).toHaveLength(3);
    expect("const" in sent[2]).toBe(true);
  });

  test("land bases and the combined flag are sent, and a change in either resends the state", () => {
    const { bridge, sent } = setup();
    const base = { ...info([1]), airbase: [{ api_area_id: 6, api_rid: 1, api_distance: { api_base: 7 }, api_plane_info: [] }] };
    bridge.update({ info: base, const: master, combinedFlag: 0 });
    bridge.onMessage(ready);
    expect(sent[0]).toMatchObject({ combinedFlag: 0, info: { airbase: [{ api_area_id: 6, api_rid: 1, api_plane_info: [] }] } });
    expect(JSON.stringify(sent[0])).not.toContain("api_distance");
    bridge.update({ info: base, const: master, combinedFlag: 1 });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ combinedFlag: 1 });
    bridge.update({ info: { ...base, airbase: [] }, const: master, combinedFlag: 1 });
    expect(sent).toHaveLength(3);
  });

  test("poi's active quests / records and the plugin's quest list are projected, and a change resends the state", () => {
    const { bridge, sent } = setup();
    const quests = {
      activeQuests: { 214: { time: 1, detail: { api_no: 214, api_state: 2, api_type: 2, api_progress_flag: 1, api_title: "あ号作戦" } } },
      records: { 214: { id: 214, sortie: { count: 12, required: 36, description: "出撃" }, count: 12, required: 36, active: true } },
    };
    const base = { ...info([1]), quests };
    const questList = { list: [{ id: 214, state: 2, type: 2, progress: 1 }, { id: 101, state: 1, type: 4, progress: 0 }] };
    bridge.update({ info: base, const: master, questList });
    bridge.onMessage(ready);
    expect(sent[0]).toMatchObject({
      quests: {
        list: questList.list,
        active: [{ id: 214, state: 2, type: 2, progress: 1 }],
        records: { 214: [{ key: "sortie", description: "出撃", count: 12, required: 36 }] },
      },
    });
    expect(JSON.stringify(sent[0])).not.toContain("あ号作戦");
    bridge.update({ info: base, const: master, questList: { list: [] } });
    expect(sent).toHaveLength(2);
    bridge.update({ info: { ...base, quests: { ...quests, records: {} } }, const: master, questList: { list: [] } });
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ quests: { list: [], records: {} } });
  });

  test("a second ready (iframe reloaded) resends everything", () => {
    const { bridge, sent } = setup();
    bridge.update({ info: info([1]), const: master });
    bridge.onMessage(ready);
    bridge.onMessage(ready);
    expect(sent).toHaveLength(2);
    expect("const" in sent[1]).toBe(true);
  });

  test("presets go after every ready until acked, then never again", () => {
    const { bridge, sent, isDone } = setup('{"format":"kcsim-presets","version":1,"presets":[]}');
    bridge.onMessage(ready);
    expect(sent.map((m) => m.type)).toEqual(["presets"]);
    bridge.onMessage(ready);
    expect(sent.map((m) => m.type)).toEqual(["presets", "presets"]);
    bridge.onMessage({ src: "kcsim", v: 1, type: "presets-ack", imported: 0, skipped: 0, persisted: true });
    expect(isDone()).toBe(true);
    bridge.onMessage(ready);
    expect(sent.map((m) => m.type)).toEqual(["presets", "presets"]);
  });

  test("an ack the web UI could only keep in memory does not finish the migration", () => {
    const { bridge, sent, isDone } = setup('{"format":"kcsim-presets","version":1,"presets":[]}');
    bridge.onMessage(ready);
    bridge.onMessage({ src: "kcsim", v: 1, type: "presets-ack", imported: 1, skipped: 0, persisted: false });
    expect(isDone()).toBe(false);
    bridge.onMessage(ready);
    expect(sent.map((m) => m.type)).toEqual(["presets", "presets"]);
  });

  test("fleet api_member_id and other unread fields are not posted", () => {
    const { bridge, sent } = setup();
    bridge.update({
      info: { basic: { api_level: 1 }, fleets: [{ api_member_id: 42, api_id: 1, api_ship: [1] }], ships: {}, equips: {} },
      const: master,
    });
    bridge.onMessage(ready);
    expect(JSON.stringify(sent)).not.toContain("api_member_id");
  });

  test("no presets to migrate: nothing sent", () => {
    const { bridge, sent } = setup(null);
    bridge.onMessage(ready);
    expect(sent).toEqual([]);
  });

  test("malformed or foreign messages are ignored", () => {
    const { bridge, sent, versions } = setup("{}");
    bridge.onMessage({ type: "ready" });
    bridge.onMessage({ src: "other", v: 1, type: "ready" });
    bridge.onMessage("ready");
    bridge.onMessage({ src: "kcsim", v: 1, type: "presets-ack", imported: "1", skipped: 0 });
    expect(sent).toEqual([]);
    expect(versions).toEqual([]);
  });

  test("a v1 web UI's hostViews / open-view (merged header) get no reply", () => {
    const { bridge, sent } = setup();
    bridge.onMessage({ ...ready, v: 1, hostViews: true });
    bridge.onMessage({ src: "kcsim", v: 1, type: "open-view", view: "log" });
    expect(sent).toEqual([]);
  });

  test("view: sent first after every ready, then only when it changes", () => {
    const { bridge, sent } = setup();
    bridge.setView("map");
    bridge.update({ info: info([1]), const: master });
    expect(sent).toEqual([]);
    bridge.onMessage(ready);
    expect(sent.map((m) => m.type)).toEqual(["view", "state"]);
    expect(sent[0]).toMatchObject({ type: "view", view: "map" });
    bridge.setView("map");
    bridge.setView("quests");
    expect(sent.slice(2)).toEqual([{ src: "kcsim", v: expect.any(Number), type: "view", view: "quests" }] as never);
    // a reloaded iframe gets the view again
    bridge.onMessage(ready);
    expect(sent.slice(3).map((m) => m.type)).toEqual(["view", "state"]);
  });

  test("view: a move the web UI made itself is reported and not echoed back", () => {
    const { bridge, sent, views } = setup();
    bridge.setView("map");
    bridge.onMessage(ready);
    bridge.onMessage({ src: "kcsim", v: 3, type: "view", view: "sortie" });
    expect(views).toEqual(["sortie"]);
    // the plugin's chrome follows (setView with the same view): nothing is posted
    bridge.setView("sortie");
    expect(sent.map((m) => m.type)).toEqual(["view"]);
    // the plugin's own views never go to the iframe
    bridge.onMessage({ src: "kcsim", v: 3, type: "view", view: "log" });
    expect(views).toEqual(["sortie"]);
  });
});
