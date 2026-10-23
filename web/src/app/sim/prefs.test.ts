import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_PREFS, loadPrefs } from "./prefs";

const store = (value: unknown) => {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => (value === undefined ? null : JSON.stringify(value)) };
};

afterEach(() => delete (globalThis as { localStorage?: unknown }).localStorage);

describe("loadPrefs", () => {
  test("default run count is 10,000", () => {
    store(undefined);
    expect(loadPrefs().count).toBe(10_000);
    expect(DEFAULT_PREFS.count).toBe(10_000);
  });
  test("an unversioned stored count equal to the old default moves to the new default", () => {
    store({ map: "2-3", count: 100_000 });
    expect(loadPrefs()).toMatchObject({ map: "2-3", count: 10_000 });
  });
  test("other unversioned counts and versioned choices are kept", () => {
    store({ count: 50_000 });
    expect(loadPrefs().count).toBe(50_000);
    store({ version: 2, count: 100_000 });
    expect(loadPrefs().count).toBe(100_000);
  });
});
