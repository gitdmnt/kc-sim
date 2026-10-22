import { describe, expect, test } from "bun:test";
import { MemoryStorage } from "@web/fleet/storage";
import { DEFAULT_SERVER_URL, getUploadSettings, migrateLegacySettings, updatePluginSettings } from "./settings";

const NEW_PROD = "https://kc-sim.lumpoler.workers.dev";
const OLD_PROD = "https://kc-sim-data.lumpoler.workers.dev";

const run = (entries: Record<string, unknown>) => {
  const s = new MemoryStorage();
  for (const [k, v] of Object.entries(entries)) s.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
  migrateLegacySettings(s);
  return { s, settings: JSON.parse(s.getItem("kcsim:plugin")!), auth: JSON.parse(s.getItem("kcsim:auth") ?? "null") };
};

describe("migrateLegacySettings", () => {
  test("fresh install: auto upload on, production server", () => {
    expect(run({}).settings).toEqual({ serverUrl: DEFAULT_SERVER_URL, autoUpload: true });
  });

  test("upgrade from the old default (127.0.0.1, no kcsim:settings): auto upload off", () => {
    expect(run({ "kcsim:preset:p1": "{}" }).settings).toEqual({ serverUrl: DEFAULT_SERVER_URL, autoUpload: false });
  });

  test("upgrade with a local or other apiBase: auto upload off, even if it was on", () => {
    expect(run({ "kcsim:settings": { apiBase: "http://127.0.0.1:8787", autoUpload: true } }).settings.autoUpload).toBe(false);
    expect(run({ "kcsim:settings": { apiBase: "https://example.com", autoUpload: true } }).settings.autoUpload).toBe(false);
    expect(run({ "kcsim:settings": { apiBase: "", autoUpload: true } }).settings.autoUpload).toBe(false);
  });

  test("upgrade from the old production host: keeps auto upload and moves the credentials to the new origin", () => {
    const creds = { apiBase: OLD_PROD, clientId: "c-1", token: "t", banned: false };
    const { settings, auth } = run({ "kcsim:settings": { apiBase: `${OLD_PROD}/` }, "kcsim:auth": creds });
    expect(settings).toEqual({ serverUrl: DEFAULT_SERVER_URL, autoUpload: true });
    expect(auth).toEqual({ ...creds, apiBase: NEW_PROD });
    expect(run({ "kcsim:settings": { apiBase: OLD_PROD, autoUpload: false } }).settings.autoUpload).toBe(false);
  });

  test("upgrade already pointed at the new production host keeps auto upload; other credentials are untouched", () => {
    const creds = { apiBase: "http://127.0.0.1:8787", clientId: "c-2", token: "t", banned: false };
    const { settings, auth } = run({ "kcsim:settings": { apiBase: NEW_PROD, autoUpload: true }, "kcsim:auth": creds });
    expect(settings.autoUpload).toBe(true);
    expect(auth).toEqual(creds);
  });

  test("drops the old UI's keys, keeps presets, credentials and upload state; runs once", () => {
    const { s } = run({
      "kcsim:settings": { apiBase: OLD_PROD },
      "kcsim:cache:/api/v1/maps": "{}",
      "kcsim:tab": "log",
      "kcsim:map": "1-5",
      "kcsim:selectedPreset": "p1",
      "kcsim:preset:p1": "{}",
      "kcsim:auth": "{}",
      "kcsim:autoUploadStatus": "{}",
      other: "x",
    });
    for (const k of ["kcsim:settings", "kcsim:cache:/api/v1/maps", "kcsim:tab", "kcsim:map", "kcsim:selectedPreset"]) {
      expect(s.getItem(k)).toBeNull();
    }
    for (const k of ["kcsim:preset:p1", "kcsim:auth", "kcsim:autoUploadStatus", "other"]) expect(s.getItem(k)).not.toBeNull();
    s.setItem("kcsim:plugin", JSON.stringify({ serverUrl: "http://localhost:5173/", autoUpload: true }));
    s.setItem("kcsim:tab", "x");
    migrateLegacySettings(s);
    expect(s.getItem("kcsim:tab")).toBe("x");
    expect(JSON.parse(s.getItem("kcsim:plugin")!).serverUrl).toBe("http://localhost:5173/");
  });
});

test("upload target is the server URL's origin, or nothing for a URL that is not allowed", () => {
  updatePluginSettings({ serverUrl: `${NEW_PROD}/app/` });
  expect(getUploadSettings().apiBase).toBe(NEW_PROD);
  updatePluginSettings({ serverUrl: "http://example.com/" });
  expect(getUploadSettings().apiBase).toBe("");
});
