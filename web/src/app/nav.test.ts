import { describe, expect, test } from "bun:test";
import { WEB_VIEWS, isWebView } from "@shared/embed/protocol";
import { MemoryStorage } from "../fleet/storage";
import { FEATURES, navFeatures, readStoredView } from "./nav";

const WEB = navFeatures(isWebView);

describe("nav model", () => {
  test("the plugin shows everything; the web UI alone only its own views (no 資源, 観測ログ, 送信設定)", () => {
    expect(FEATURES.map((f) => [f.id, f.views.map((v) => v.id)])).toEqual([
      ["sim", ["sortie", "map", "enemy", "log", "upload", "sim-settings"]],
      ["quests", ["quests"]],
      ["resources", ["resources-chart", "resources-event", "resources-day"]],
      ["settings", ["settings"]],
    ]);
    expect(WEB.map((f) => [f.id, f.views.map((v) => v.id)])).toEqual([
      ["sim", ["sortie", "map", "enemy", "sim-settings"]],
      ["quests", ["quests"]],
      ["settings", ["settings"]],
    ]);
    // every web view is reachable in both
    const all = FEATURES.flatMap((f) => f.views.map((v) => v.id));
    expect(WEB_VIEWS.every((v) => all.includes(v))).toBe(true);
  });

  test("stored view; the old web UI's tab (kcsim:tab) is moved once, renamed tabs mapped", () => {
    const s = new MemoryStorage();
    expect(readStoredView(WEB, s)).toBe("sortie");
    s.setItem("kcsim:tab", "estimate");
    expect(readStoredView(WEB, s)).toBe("enemy");
    expect(s.getItem("kcsim:tab")).toBeNull();
    expect(s.getItem("kcsim:view")).toBe("enemy");
    for (const old of ["sortie", "map", "quests", "settings"]) {
      const t = new MemoryStorage();
      t.setItem("kcsim:tab", old);
      expect(readStoredView(WEB, t)).toBe(old as never);
    }
    // a view this side cannot show falls back to the first one
    s.setItem("kcsim:view", "resources-day");
    expect(readStoredView(WEB, s)).toBe("sortie");
    expect(readStoredView(FEATURES, s)).toBe("resources-day");
  });
});
