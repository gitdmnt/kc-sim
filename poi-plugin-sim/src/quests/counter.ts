/**
 * 単発任務などの進捗カウンタ。poi の任務トラッカー (quest_goal.cson) はほぼ定期任務しか数えないので、手入力の
 * 任務データ (shared/quest/overrides.json、private notes QUEST_OVERRIDES) で条件が機械的に判定できる任務を、
 * game.response から自分で数える。startCapture (capture/plugin.ts) が応答ごとに `handle` を呼ぶ。
 *
 * - 数えるのは遂行中 (poi の info.quests.activeQuests で api_state 2) で、poi の records に無い任務だけ
 * - 出撃: map/start で艦隊 (出撃した艦隊、連合なら主力) とゲージ番号を覚え、map/next でマスを更新、battleresult で判定
 * - 演習: practice/battle で艦隊を覚え、battle_result で判定。遠征: mission/result (艦隊は応答時点の poi の state)
 * - 廃棄・解体・近代化改修の対象は応答前の state (直前の応答で覚えた参照) から引く (poi は応答前に state を更新する)
 * - 報酬受け取り (clearitemget) で消し、「全て」の任務一覧に無くなった任務も消す
 */
import { applyQuestEvent, currentCount, questGoals } from "@shared/quest/progress";
import type { CountedEquip, CountedShip, QuestEvent, QuestGoal } from "@shared/quest/progress";
import type { PoiQuestGoal } from "@shared/embed/protocol";
import type { QuestRequirement } from "@shared/quest/types";
import overrides from "@shared/quest/overrides.json";
import type { QuestCounts, QuestProgressStore } from "./store";

/** 任務 id -> 数えられるサブ目標 (手入力の条件から) */
export const buildQuestGoals = (entries: readonly { id: number; requirements?: unknown }[]): Map<number, QuestGoal[]> => {
  const out = new Map<number, QuestGoal[]>();
  for (const e of entries) {
    const goals = questGoals((e.requirements as QuestRequirement | undefined) ?? null);
    if (goals.length > 0) out.set(e.id, goals);
  }
  return out;
};

let bundled: Map<number, QuestGoal[]> | undefined;
/** 同梱の任務データのサブ目標 (初回に作る) */
export const bundledQuestGoals = (): Map<number, QuestGoal[]> => (bundled ??= buildQuestGoals(overrides));

const ROOT = /^\/?kcsapi\//;

const at = (v: unknown, ...keys: (string | number)[]): unknown =>
  keys.reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string | number, unknown>)[k] : undefined), v);

const toNum = (v: unknown): number | null => {
  const n = typeof v === "string" && v !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

const idList = (v: unknown): number[] =>
  String(v ?? "").split(",").map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0);

/** 艦 1 隻 (poi の info.ships の値) をマスターで解決する */
const countedShip = (state: unknown, ship: unknown): CountedShip | null => {
  const id = toNum(at(ship, "api_ship_id"));
  if (id === null) return null;
  const m = at(state, "const", "$ships", id);
  return { id, stype: toNum(at(m, "api_stype")) ?? 0, ctype: toNum(at(m, "api_ctype")) ?? 0, lv: toNum(at(ship, "api_lv")) ?? 1 };
};

/** 艦隊 (1 始まり) の艦を並び順に */
const fleetOf = (state: unknown, deck: number): CountedShip[] => {
  const ids = at(state, "info", "fleets", deck - 1, "api_ship");
  return (Array.isArray(ids) ? ids : []).flatMap((i) => (toNum(i) ?? -1) > 0 ? (countedShip(state, at(state, "info", "ships", i as number)) ?? []) : []);
};

/**
 * 表示用: 遂行中 (達成済みを含む) の任務のうち数えられるものの、サブ目標と今の数。poi が数えている任務も含める
 * (どちらを出すかは projectQuests が決める: poi の records が優先)。
 */
export const countedGoals = (
  infoQuests: unknown, counts: QuestCounts, now: number, goals: Map<number, QuestGoal[]> = bundledQuestGoals(),
): Record<number, PoiQuestGoal[]> => {
  const out: Record<number, PoiQuestGoal[]> = {};
  const active = at(infoQuests, "activeQuests");
  for (const a of active && typeof active === "object" ? Object.values(active) : []) {
    const id = toNum(at(a, "detail", "api_no"));
    const list = id === null ? undefined : goals.get(id);
    if (id === null || !list) continue;
    out[id] = list.map((g) => ({ key: g.key, description: g.description, count: currentCount(g, counts[id]?.[g.key], now), required: g.required, source: "kcsim" }));
  }
  return out;
};

interface Sortie {
  map: string;
  deck: number;
  fleet: CountedShip[];
  gauge: number | null;
  cell: number;
  boss: boolean;
}

export interface QuestCounterDeps {
  store: QuestProgressStore;
  getState: () => unknown;
  /** 任務 id -> サブ目標。既定は同梱の任務データ */
  goals?: Map<number, QuestGoal[]>;
  /** 進捗を保存したあと (提督 ID) */
  onChange?: (admiral: string) => void;
  onError?: (e: unknown) => void;
  now?: () => number;
}

export class QuestCounter {
  private goals: Map<number, QuestGoal[]>;
  private admiral: string | null = null;
  private counts: QuestCounts | null = null;
  private sortie: Sortie | null = null;
  private exercise: { deck: number; fleet: CountedShip[] } | null = null;
  /** 直前の応答の時点の poi の state (廃棄・解体・改修で消える前の艦・装備を引く) */
  private prev: unknown = undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private deps: QuestCounterDeps) {
    this.goals = deps.goals ?? bundledQuestGoals();
  }

  /** poi の game.response の detail をそのまま渡す。例外は投げない。 */
  handle(rawPath: string, body: unknown, postBody?: unknown): Promise<void> {
    const path = rawPath.replace(ROOT, "");
    const state = this.deps.getState();
    const prev = this.prev;
    this.prev = state;
    this.queue = this.queue
      .then(() => this.dispatch(path, body, postBody, state, prev))
      .catch((e) => (this.deps.onError ?? console.error)(e));
    return this.queue;
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  private async dispatch(path: string, body: unknown, post: unknown, state: unknown, prev: unknown) {
    const event = this.toEvent(path, body, post, state, prev);
    if (path === "api_req_quest/clearitemget") {
      const id = String(toNum(at(post, "api_quest_id")));
      await this.update(state, (c) => id in c && delete c[id]);
    } else if (path === "api_get_member/questlist" && (toNum(at(post, "api_tab_id")) ?? 0) === 0) {
      const raw = at(body, "api_list");
      if (!Array.isArray(raw)) return;
      const listed = new Set(raw.map((q) => String(at(q, "api_no"))));
      await this.update(state, (c) => {
        let changed = false;
        for (const id of Object.keys(c)) if (!listed.has(id)) changed = delete c[id];
        return changed;
      });
    } else if (event) {
      const active = this.countedQuests(state);
      if (active.length === 0) return;
      const now = this.now();
      await this.update(state, (c) => {
        let changed = false;
        for (const id of active) {
          const counts = (c[id] ??= {});
          if (applyQuestEvent(this.goals.get(id)!, counts, event, now)) changed = true;
          else if (Object.keys(counts).length === 0) delete c[id];
        }
        return changed;
      });
    }
  }

  /** 遂行中で、条件を数えられ、poi が数えていない任務 */
  private countedQuests(state: unknown): number[] {
    const active = at(state, "info", "quests", "activeQuests");
    const records = at(state, "info", "quests", "records");
    const out: number[] = [];
    for (const a of active && typeof active === "object" ? Object.values(active) : []) {
      const id = toNum(at(a, "detail", "api_no"));
      if (id === null || toNum(at(a, "detail", "api_state")) !== 2 || !this.goals.has(id)) continue;
      if (at(records, id) !== undefined) continue;
      out.push(id);
    }
    return out;
  }

  /** 提督の進捗を読み込んで `fn` で変え、変わったら保存する */
  private async update(state: unknown, fn: (counts: QuestCounts) => boolean | void) {
    const id = at(state, "info", "basic", "api_member_id");
    if ((typeof id !== "number" && typeof id !== "string") || String(id) === "") return;
    const admiral = String(id);
    if (this.admiral !== admiral || !this.counts) {
      this.counts = await this.deps.store.load(admiral);
      this.admiral = admiral;
    }
    if (fn(this.counts) === false) return;
    await this.deps.store.save(admiral, this.counts);
    this.deps.onChange?.(admiral);
  }

  /** API 応答 1 件をカウンタの出来事にする (出撃・演習の途中は文脈を覚えるだけ) */
  private toEvent(path: string, body: unknown, post: unknown, state: unknown, prev: unknown): QuestEvent | null {
    switch (path) {
      case "api_req_map/start": {
        const area = toNum(at(body, "api_maparea_id"));
        const no = toNum(at(body, "api_mapinfo_no"));
        const deck = toNum(at(post, "api_deck_id")) ?? 1;
        if (area === null || no === null) return (this.sortie = null);
        // 連合艦隊は deck 1 (主力) で出撃するので、主力で判定する
        this.sortie = {
          map: `${area}-${no}`, deck, fleet: fleetOf(state, deck), gauge: toNum(at(state, "info", "maps", area * 10 + no, "api_gauge_num")),
          cell: -1, boss: false,
        };
        this.onCell(body);
        return null;
      }
      case "api_req_map/next":
        this.onCell(body);
        return null;
      case "api_req_sortie/battleresult":
      case "api_req_combined_battle/battleresult": {
        const s = this.sortie;
        const rank = at(body, "api_win_rank");
        if (!s || typeof rank !== "string") return null;
        return { kind: "battle", map: s.map, cell: s.cell, boss: s.boss, rank, gauge: s.gauge, deck: s.deck, fleet: s.fleet };
      }
      case "api_port/port":
        this.sortie = null;
        return null;
      case "api_req_practice/battle": {
        const deck = toNum(at(post, "api_deck_id")) ?? 1;
        this.exercise = { deck, fleet: fleetOf(state, deck) };
        return null;
      }
      case "api_req_practice/battle_result": {
        const ex = this.exercise;
        const rank = at(body, "api_win_rank");
        this.exercise = null;
        return ex && typeof rank === "string" ? { kind: "exercise", rank, deck: ex.deck, fleet: ex.fleet } : null;
      }
      case "api_req_mission/result": {
        const deck = toNum(at(post, "api_deck_id")) ?? 0;
        const name = at(body, "api_quest_name");
        let mission = toNum(at(state, "info", "fleets", deck - 1, "api_mission", 1)) ?? 0;
        if (mission <= 0) {
          const missions = at(state, "const", "$missions");
          const m = Object.values(missions && typeof missions === "object" ? missions : {}).find((x) => at(x, "api_name") === name);
          mission = toNum(at(m, "api_id")) ?? 0;
        }
        if (mission <= 0) return null;
        return { kind: "expedition", mission, success: (toNum(at(body, "api_clear_result")) ?? 0) >= 1, deck, fleet: fleetOf(state, deck) };
      }
      case "api_req_kousyou/createitem": {
        const items = at(body, "api_get_items");
        return { kind: "develop", attempts: Array.isArray(items) ? items.length : 1 };
      }
      case "api_req_kousyou/createship":
        return { kind: "build" };
      case "api_req_kousyou/destroyitem2":
        return {
          kind: "scrapEquip",
          equips: idList(at(post, "api_slotitem_ids")).flatMap((i): CountedEquip[] => {
            const id = toNum(at(prev, "info", "equips", i, "api_slotitem_id"));
            return id === null ? [] : [{ id, type: toNum(at(prev, "const", "$equips", id, "api_type", 2)) ?? 0 }];
          }),
        };
      case "api_req_kousyou/destroyship":
        return { kind: "scrapShip", ships: idList(at(post, "api_ship_id")).flatMap((i) => countedShip(prev, at(prev, "info", "ships", i)) ?? []) };
      case "api_req_kousyou/remodel_slot":
        return { kind: "improve", success: toNum(at(body, "api_remodel_flag")) === 1 };
      case "api_req_kaisou/powerup":
        return {
          kind: "modernize",
          success: toNum(at(body, "api_powerup_flag")) === 1,
          target: countedShip(prev, at(prev, "info", "ships", toNum(at(post, "api_id")) ?? 0)),
          materials: idList(at(post, "api_id_items")).flatMap((i) => countedShip(prev, at(prev, "info", "ships", i)) ?? []),
        };
      case "api_req_kaisou/remodeling": {
        // 改装後の艦は続く ship3 で届くので、改装前の艦の api_aftershipid から引く
        const before = countedShip(prev, at(prev, "info", "ships", toNum(at(post, "api_id")) ?? 0));
        const after = before ? toNum(at(state, "const", "$ships", before.id, "api_aftershipid")) : null;
        const ship = after ? countedShip(state, { api_ship_id: after, api_lv: before!.lv }) : null;
        return { kind: "remodel", ship };
      }
      case "api_req_hokyu/charge":
        return { kind: "resupply" };
      case "api_req_nyukyo/start":
        return { kind: "repair" };
      default:
        return null;
    }
  }

  private onCell(body: unknown) {
    if (!this.sortie) return;
    const no = toNum(at(body, "api_no"));
    const bossCell = toNum(at(body, "api_bosscell_no"));
    this.sortie.cell = no ?? -1;
    this.sortie.boss = toNum(at(body, "api_event_id")) === 5 || (no !== null && no === bossCell);
  }
}
