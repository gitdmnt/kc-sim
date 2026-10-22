import { expect, test } from "bun:test";
import { MemoryStorage } from "@web/fleet/storage";

test("first run keeps a legacy autoUpload opt-out, drops the legacy apiBase and obsolete keys", async () => {
  const s = new MemoryStorage();
  s.setItem("kcsim:settings", JSON.stringify({ apiBase: "https://kc-sim-data.lumpoler.workers.dev", autoUpload: false }));
  s.setItem("kcsim:cache:/api/v1/maps", "{}");
  s.setItem("kcsim:tab", "log");
  s.setItem("kcsim:selectedPreset", "p1");
  s.setItem("kcsim:preset:p1", "{}");
  s.setItem("kcsim:auth", "{}");
  Object.assign(globalThis, { localStorage: s });
  try {
    // Dynamic on purpose: settings.ts reads (and migrates) localStorage when it is first loaded.
    const { DEFAULT_SERVER_URL, getPluginSettings, getUploadSettings, updatePluginSettings } = await import("./settings");
    expect(getPluginSettings()).toEqual({ serverUrl: DEFAULT_SERVER_URL, autoUpload: false });
    expect(getUploadSettings()).toEqual({ autoUpload: false, apiBase: "https://kc-sim.lumpoler.workers.dev" });
    expect(s.getItem("kcsim:settings")).toBeNull();
    expect(s.getItem("kcsim:cache:/api/v1/maps")).toBeNull();
    expect(s.getItem("kcsim:tab")).toBeNull();
    expect(s.getItem("kcsim:selectedPreset")).toBeNull();
    // presets (migrated to the web UI by postMessage) and upload credentials stay
    expect(s.getItem("kcsim:preset:p1")).toBe("{}");
    expect(s.getItem("kcsim:auth")).toBe("{}");

    // a server URL that is not allowed uploads nowhere
    updatePluginSettings({ serverUrl: "http://example.com/" });
    expect(getUploadSettings().apiBase).toBe("");
    expect(JSON.parse(s.getItem("kcsim:plugin")!)).toEqual({ serverUrl: "http://example.com/", autoUpload: false });
  } finally {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});
