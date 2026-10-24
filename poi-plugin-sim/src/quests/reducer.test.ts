import { describe, expect, test } from "bun:test";
import { PLUGIN_PACKAGE, questListOf, reducer } from "./reducer";

const quest = (api_no: number, api_state: number, api_type = 4, api_progress_flag = 0) => ({ api_no, api_state, api_type, api_progress_flag, api_title: "t" });
const questlist = (tab: number, list: unknown[]) => ({
  type: "@@Response/kcsapi/api_get_member/questlist",
  postBody: { api_verno: "1", api_tab_id: String(tab) },
  body: { api_count: list.length, api_list: list },
});

describe("quest list reducer", () => {
  test("the 全て tab replaces the list; other tabs only update known entries and add new ones", () => {
    let s = reducer(undefined, { type: "@@INIT" });
    expect(s.list).toBeNull();
    // a partial tab before any full list: ignored
    s = reducer(s, questlist(9, [quest(214, 2)]));
    expect(s.list).toBeNull();
    s = reducer(s, questlist(0, [quest(101, 1), -1, quest(214, 1, 2)]));
    expect(s.list).toEqual([{ id: 101, state: 1, type: 4, progress: 0 }, { id: 214, state: 1, type: 2, progress: 0 }]);
    s = reducer(s, questlist(9, [quest(214, 2, 2, 1), quest(301, 2, 1)]));
    expect(s.list).toEqual([
      { id: 101, state: 1, type: 4, progress: 0 },
      { id: 214, state: 2, type: 2, progress: 1 },
      { id: 301, state: 2, type: 1, progress: 0 },
    ]);
  });

  test("a taken reward removes the quest; a new login forgets the list", () => {
    let s = reducer(undefined, questlist(0, [quest(101, 3), quest(102, 1)]));
    s = reducer(s, { type: "@@Response/kcsapi/api_req_quest/clearitemget", postBody: { api_quest_id: "101" }, body: {} });
    expect(s.list?.map((e) => e.id)).toEqual([102]);
    const same = reducer(s, { type: "@@Response/kcsapi/api_req_quest/clearitemget", postBody: { api_quest_id: "999" } });
    expect(same).toBe(s);
    expect(reducer(s, { type: "@@Response/kcsapi/api_get_member/require_info", body: {} }).list).toBeNull();
  });

  test("questListOf reads poi's state.ext[package]._", () => {
    const own = { list: [] };
    expect(questListOf({ ext: { [PLUGIN_PACKAGE]: { _: own } } })).toBe(own);
    expect(questListOf({})).toBeUndefined();
    expect(questListOf(undefined)).toBeUndefined();
  });
});
