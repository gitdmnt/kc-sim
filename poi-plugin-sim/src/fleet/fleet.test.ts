import { describe, expect, test } from "bun:test";
import {
  MemoryStorage,
  PresetStore,
  importFromPoi,
  masterFromPoi,
  parseDeckBuilder,
  resolveShipStats,
  toDeckBuilder,
} from "./index";

const poiState = () => ({
  basic: undefined,
  info: {
    basic: { api_level: 110 },
    fleets: [
      { api_name: "第一艦隊", api_ship: [11, 12, -1, -1, -1, -1] },
      { api_name: "第二艦隊", api_ship: [-1, -1, -1, -1, -1, -1] },
    ],
    ships: {
      11: {
        api_ship_id: 131,
        api_lv: 99,
        api_cond: 53,
        api_maxhp: 98,
        api_nowhp: 90,
        api_karyoku: [96, 130],
        api_raisou: [0, 0],
        api_taiku: [90, 100],
        api_soukou: [100, 120],
        api_kaihi: [45, 80],
        api_taisen: [0, 0],
        api_sakuteki: [30, 60],
        api_lucky: [32, 90],
        api_leng: 5,
        api_soku: 5,
        api_slotnum: 4,
        api_slot: [101, 102, -1, -1],
        api_onslot: [0, 0, 0, 0],
        api_slot_ex: 103,
        api_kyouka: [1, 2, 3, 4, 5, 6, 7],
      },
      12: {
        api_ship_id: 1,
        api_lv: 1,
        api_slotnum: 2,
        api_slot: [-1, -1],
        api_slot_ex: -1,
      },
    },
    equips: {
      101: { api_slotitem_id: 3, api_level: 7, api_alv: 0 },
      102: { api_slotitem_id: 6, api_level: 10, api_alv: 7 },
      103: { api_slotitem_id: 43, api_level: 0, api_alv: 0 },
    },
  },
  const: {
    $ships: {
      131: { api_id: 131, api_houg: [96, 130], api_luck: [32, 90], api_leng: 5, api_soku: 5, api_maxeq: [0, 0, 0, 0] },
      1: {
        api_id: 1, api_houg: [10, 29], api_raig: [24, 59], api_tyku: [7, 29], api_souk: [5, 19],
        api_luck: [12, 49], api_kaih: [40, 79], api_tais: [20, 49], api_saku: [6, 29], api_leng: 1, api_soku: 10,
      },
    },
    $equips: {
      3: { api_id: 3, api_houg: 20, api_houm: 3, api_houk: 0, api_saku: 1, api_leng: 4, api_type: [1, 1, 3] },
      6: { api_id: 6, api_houg: 0, api_tyku: 1, api_houk: 5, api_tais: 1, api_leng: 1 },
    },
  },
});

describe("importFromPoi", () => {
  test("builds a preset with correct field mapping", () => {
    const p = importFromPoi(poiState(), 0, { now: 1000, id: "x" })!;
    expect(p.name).toBe("第一艦隊");
    expect(p.hqLevel).toBe(110);
    expect(p.source).toBe("poi");
    expect(p.ships).toHaveLength(2);
    const s = p.ships[0];
    expect(s.masterId).toBe(131);
    expect(s.luckMod).toBe(5);
    expect(s.hpMod).toBe(6);
    expect(s.aswMod).toBe(7);
    expect(s.morale).toBe(53);
    expect(s.equips).toEqual([
      { masterId: 3, improvement: 7, proficiency: 0, slotSize: 0 },
      { masterId: 6, improvement: 10, proficiency: 7, slotSize: 0 },
      null,
      null,
    ]);
    expect(s.exSlot).toEqual({ masterId: 43, improvement: 0, proficiency: 0, slotSize: 0 });
    expect(s.observed?.evasion).toBe(45);
    expect(s.observed?.los).toBe(30);
    expect(s.observed?.range).toBe(5);
    expect(p.ships[1].exSlot).toBeNull();
  });

  test("never throws on missing data", () => {
    expect(importFromPoi(undefined, 0)).toBeNull();
    expect(importFromPoi({}, 0)).toBeNull();
    expect(importFromPoi({ info: { fleets: [] } }, 0)).toBeNull();
    expect(importFromPoi(poiState(), 1)).toBeNull(); // empty fleet
    expect(importFromPoi(poiState(), 9)).toBeNull();
    const broken = poiState();
    delete (broken.info as any).equips;
    const p = importFromPoi(broken, 0)!;
    expect(p.ships[0].equips.every((e) => e === null)).toBe(true);
    const noShips = { info: { fleets: [{ api_ship: [5] }], ships: {} } };
    expect(importFromPoi(noShips, 0)).toBeNull();
  });
});

describe("DeckBuilder", () => {
  const deck = {
    version: 4,
    hqlv: 120,
    f1: {
      s1: {
        id: "131", lv: 99, luck: 40, hp: 100, asw: 0,
        items: { i1: { id: 3, rf: 7, mas: 7 }, i2: { id: 6, rf: 0 }, ix: { id: 43 } },
      },
      s2: { id: 1, lv: 20, luck: -1, items: {} },
    },
    f2: { s1: { id: "2", lv: 1, items: {} } },
  };

  test("parse", () => {
    const master = masterFromPoi(poiState());
    const p = parseDeckBuilder(deck, { now: 5, genId: () => "d1", master });
    expect(p.source).toBe("deckbuilder");
    expect(p.hqLevel).toBe(120);
    expect(p.ships.map((s) => s.masterId)).toEqual([131, 1]);
    expect(p.ships[0].level).toBe(99);
    expect(p.ships[0].luckMod).toBe(8); // 40 - 32
    expect(p.ships[0].observed).toEqual({ luck: 40, maxHp: 100 });
    expect(p.ships[0].equips[0]).toEqual({ masterId: 3, improvement: 7, proficiency: 7, slotSize: 0 });
    expect(p.ships[0].equips[1]?.proficiency).toBe(0);
    expect(p.ships[0].exSlot?.masterId).toBe(43);
    expect(p.ships[1].observed).toBeUndefined();
    expect(parseDeckBuilder(JSON.stringify(deck), { fleet: 2 }).ships[0].masterId).toBe(2);
    expect(() => parseDeckBuilder(deck, { fleet: 3 })).toThrow();
  });

  test("export / round trip", () => {
    const p = parseDeckBuilder(deck, { now: 5, genId: () => "d1" });
    const out = toDeckBuilder(p);
    expect(out.version).toBe(4);
    expect(out.hqlv).toBe(120);
    const f1 = out.f1 as any;
    expect(f1.s1).toEqual({
      id: "131", lv: 99, luck: 40, hp: 100,
      items: { i1: { id: 3, rf: 7, mas: 7 }, i2: { id: 6, rf: 0 }, ix: { id: 43, rf: 0 } },
    });
    expect(f1.s2.luck).toBe(-1);
    const again = parseDeckBuilder(out as any, { now: 5, genId: () => "d2" });
    expect(again.ships[0].equips[0]).toMatchObject({ masterId: 3, improvement: 7, proficiency: 7 });
  });
});

describe("PresetStore", () => {
  const mk = () => {
    let t = 100;
    const storage = new MemoryStorage();
    let n = 0;
    return {
      storage,
      store: new PresetStore({ storage, now: () => ++t, genId: () => `id${++n}` }),
    };
  };

  test("save/list/get/remove with kcsim: prefix", () => {
    const { store, storage } = mk();
    storage.setItem("other", "x");
    const base = importFromPoi(poiState(), 0)!;
    const a = store.save({ ...base, id: undefined, name: "A" });
    const b = store.save({ ...base, id: undefined, name: "B" });
    expect(a.id).toBe("id1");
    expect(storage.getItem("kcsim:preset:id1")).not.toBeNull();
    expect(store.list().map((p) => p.name)).toEqual(["B", "A"]);
    store.save({ ...a, name: "A2" });
    expect(store.list()[0].name).toBe("A2");
    expect(store.get(b.id)?.ships).toHaveLength(2);
    store.remove(a.id);
    expect(store.get(a.id)).toBeNull();
    storage.setItem("kcsim:preset:bad", "{not json");
    expect(store.list()).toHaveLength(1);
  });

  test("JSON export/import", () => {
    const { store } = mk();
    const saved = store.save({ ...importFromPoi(poiState(), 0)!, id: "p" });
    const json = store.exportJSON();
    const other = mk().store;
    const [imp] = other.importJSON(json);
    expect(imp.id).toBe("p");
    expect(imp.ships[0].equips[1]?.improvement).toBe(10);
    expect(imp.source).toBe("import");
    // collision gets a fresh id
    const [dup] = other.importJSON(json);
    expect(dup.id).not.toBe("p");
    expect(other.list()).toHaveLength(2);
    expect(() => other.importJSON('{"ships": 3}')).toThrow();
    expect(saved.id).toBe("p");
  });

  test("DeckBuilder via store", () => {
    const { store } = mk();
    const p = store.importDeckBuilder({ version: 4, f1: { s1: { id: 1, lv: 5, items: {} } } });
    expect(store.exportDeckBuilder(p.id)).toContain('"id":"1"');
    expect(() => store.exportDeckBuilder("nope")).toThrow();
  });
});

describe("resolveShipStats", () => {
  const master = masterFromPoi(poiState());

  test("observed wins", () => {
    const p = importFromPoi(poiState(), 0)!;
    const st = resolveShipStats(p.ships[0], master);
    expect(st.evasion).toEqual({ value: 45, source: "observed" });
    expect(st.maxHp).toEqual({ value: 98, source: "observed" });
  });

  test("manual ship: interpolates where [min,max] exists, else unknown", () => {
    const st = resolveShipStats(
      {
        masterId: 1, level: 50, luckMod: 3, hpMod: 0, aswMod: 2, morale: 49,
        equips: [{ masterId: 6, improvement: 0, proficiency: 0 }, null],
      },
      master
    );
    expect(st.evasion).toEqual({ value: Math.floor(40 + (39 * 50) / 99) + 5, source: "computed" });
    expect(st.asw.value).toBe(Math.floor(20 + (29 * 50) / 99) + 1 + 2);
    expect(st.los.value).toBe(Math.floor(6 + (23 * 50) / 99));
    expect(st.luck.value).toBe(15);
    expect(st.firepower.value).toBe(10);
    expect(st.maxHp).toEqual({ value: null, source: "unknown" });
    expect(st.range.value).toBe(1);
  });

  test("unknown master", () => {
    const st = resolveShipStats(
      { masterId: 9999, level: 1, luckMod: 0, hpMod: 0, aswMod: 0, morale: 49, equips: [] },
      master
    );
    expect(st.asw.source).toBe("unknown");
    expect(resolveShipStats(importFromPoi(poiState(), 0)!.ships[1]).firepower.value).toBe(0);
  });
});
