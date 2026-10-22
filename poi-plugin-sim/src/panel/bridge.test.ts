import { describe, expect, test } from "bun:test";
import type { PluginMessage } from "@shared/embed/protocol";
import { EmbedBridge } from "./bridge";

const setup = (presets: string | null = null) => {
  const sent: PluginMessage[] = [];
  let done = false;
  const versions: number[] = [];
  const bridge = new EmbedBridge({
    post: (m) => sent.push(m),
    presetsJson: () => presets,
    presetsDone: () => done,
    markPresetsDone: () => {
      done = true;
    },
    onWebVersion: (v) => versions.push(v),
  });
  return { bridge, sent, versions, isDone: () => done };
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
    bridge.update({ info: { ...base, quests: { x: 1 } }, const: master });
    expect(sent).toHaveLength(1);
    bridge.update({ info: { ...base, fleets: [2] }, const: master });
    expect(sent).toHaveLength(2);
    expect("const" in sent[1]).toBe(false);
    const newMaster = { ...master };
    bridge.update({ info: { ...base, fleets: [2] }, const: newMaster });
    expect(sent).toHaveLength(3);
    expect("const" in sent[2]).toBe(true);
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
});
