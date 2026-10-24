/**
 * poi への登録。`startCapture()` は index.es の pluginDidLoad から呼ぶ。
 *
 * [INFERENCE] windowMode プラグインでも pluginDidLoad はメインウィンドウ側で実行され、
 * プラグインウィンドウを開かなくても動く (poi の plugin-manager がロード時に呼ぶ)。
 * プラグインウィンドウ側 (別 BrowserWindow) では呼ばない。二重登録は window 上のフラグで防ぐ。
 */
import { extractGauge } from "@shared/capture/parser";
import { summarizeFleet } from "@shared/fleet/calc";
import { importFromPoi, masterFromPoi } from "@shared/fleet/poiImport";
import { startAutoUpload } from "./autoUpload";
import type { AutoUploader, AutoUploadOptions } from "./autoUpload";
import { ObservationDb } from "./db";
import { CaptureSession } from "./session";
import type { CapturedFleet, ShipSupply, SortieFleetFeatures } from "@shared/capture/types";
import { ResourceRecorder, getResourceDb, notifyResourceRecorded, recordFromPoi } from "../resources";
import type { ResourceStore } from "../resources";
import { QuestCounter, getQuestProgressDb, notifyQuestProgress } from "../quests";
import type { QuestProgressStore } from "../quests";

const GLOBAL_KEY = "__kcsimCapture";

export interface StartCaptureOptions {
  /** poi の redux state を返す関数。既定は window.getStore()。 */
  getState?: () => any;
  db?: ObservationDb;
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
  /** 自動送信の差し替え (テスト用)。false なら自動送信しない。 */
  autoUpload?: false | Partial<Omit<AutoUploadOptions, "db">>;
  /** 資源の推移の保存先 (テスト用)。false なら記録しない。既定は getResourceDb()。 */
  resources?: false | ResourceStore;
  /** 任務の進捗カウンタの保存先 (テスト用)。false なら数えない。既定は getQuestProgressDb()。 */
  quests?: false | QuestProgressStore;
}

interface Running {
  stop: () => void;
  db: ObservationDb;
}

/** オブジェクト・配列のプロパティを辿る (poi の state は未検証の JSON)。 */
const at = (v: unknown, ...keys: (string | number)[]): unknown =>
  keys.reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string | number, unknown>)[k] : undefined), v);

/** 燃料・弾薬。importFromPoi と同じ条件で艦を拾うので ships と並びが揃う。 */
const supplyOf = (state: unknown, deckId: number): (ShipSupply | null)[] => {
  const ids = at(state, "info", "fleets", deckId - 1, "api_ship");
  const out: (ShipSupply | null)[] = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== "number" || id <= 0) continue;
    const s = at(state, "info", "ships", id);
    const masterId = at(s, "api_ship_id");
    if (typeof masterId !== "number") continue;
    const m = at(state, "const", "$ships", masterId);
    const [fuel, fuelMax, ammo, ammoMax] = [at(s, "api_fuel"), at(m, "api_fuel_max"), at(s, "api_bull"), at(m, "api_bull_max")];
    out.push(
      typeof fuel === "number" && typeof fuelMax === "number" && typeof ammo === "number" && typeof ammoMax === "number"
        ? { fuel, fuelMax, ammo, ammoMax }
        : null
    );
  }
  return out;
};

export const fleetSnapshot = (
  state: any,
  deckId: number,
  combined: boolean
): CapturedFleet | null => {
  const main = importFromPoi(state, deckId - 1);
  if (!main) return null;
  const snapshot: CapturedFleet = { deckId, ships: main.ships };
  const supply = supplyOf(state, deckId);
  if (supply.length === main.ships.length) snapshot.supply = supply;
  if (combined) {
    const escort = importFromPoi(state, 1);
    if (escort) snapshot.escort = escort.ships;
  }
  return snapshot;
};

const defaultGetState = () => {
  const w = window as any;
  return typeof w.getStore === "function" ? w.getStore() : undefined;
};

/** 出撃時の艦隊の特徴: 艦種 (master の api_stype)、速力・索敵 (summarizeFleet)、司令部 Lv。 */
export const fleetFeatures = (state: unknown, fleet: CapturedFleet): SortieFleetFeatures => {
  const master = masterFromPoi(state);
  const hq = at(state, "info", "basic", "api_level");
  const hqLevel = typeof hq === "number" ? hq : null;
  const summary = summarizeFleet([...fleet.ships, ...(fleet.escort ?? [])], master, hqLevel ?? 120, !!fleet.escort?.length);
  const stypes = (ships: CapturedFleet["ships"]) => ships.map((s) => master.ships[s.masterId]?.api_stype ?? 0);
  return {
    stypes: stypes(fleet.ships),
    ...(fleet.escort ? { escortStypes: stypes(fleet.escort) } : {}),
    speed: summary.speed,
    los: summary.los,
    hqLevel,
  };
};

/** 開始する。既に動いていれば何もせず既存の db を返す。 */
export const startCapture = (opts: StartCaptureOptions = {}): ObservationDb => {
  const g = globalThis as any;
  if (g[GLOBAL_KEY]) return (g[GLOBAL_KEY] as Running).db;

  const db = opts.db ?? new ObservationDb();
  const getState = opts.getState ?? defaultGetState;
  const session = new CaptureSession({
    sink: db,
    getFleet: (deckId, combined) => {
      try {
        return fleetSnapshot(getState(), deckId, combined);
      } catch (e) {
        console.error("[kcsim] fleet snapshot failed", e);
        return null;
      }
    },
    fleetFeatures: (fleet) => {
      try {
        return fleetFeatures(getState(), fleet);
      } catch (e) {
        console.error("[kcsim] fleet features failed", e);
        return null;
      }
    },
    // イベント海域で select_eventmap_rank を見ていない (前回起動時に選択済み) ときの難易度
    getDifficulty: (area, mapNo) => {
      const rank = at(getState(), "info", "maps", area * 10 + mapNo, "api_eventmap", "api_selected_rank");
      return typeof rank === "number" && rank > 0 ? rank : null;
    },
    getGauge: (area, mapNo) => {
      try {
        return extractGauge(at(getState(), "info", "maps", area * 10 + mapNo));
      } catch (e) {
        console.error("[kcsim] gauge failed", e);
        return null;
      }
    },
  });

  let autoUploader: AutoUploader | undefined;
  if (opts.autoUpload !== false) {
    try {
      autoUploader = startAutoUpload({ ...opts.autoUpload, db });
    } catch (e) {
      console.error("[kcsim] failed to start auto upload", e);
    }
  }

  const resourceStore = opts.resources === false ? undefined : (opts.resources ?? getResourceDb());
  const resources = resourceStore
    ? new ResourceRecorder({
        store: resourceStore,
        onRecord: notifyResourceRecorded,
        onError: (e) => console.error("[kcsim] resource history failed", e),
      })
    : undefined;

  const questStore = opts.quests === false ? undefined : (opts.quests ?? getQuestProgressDb());
  const questCounter = questStore
    ? new QuestCounter({
        store: questStore,
        getState,
        onChange: notifyQuestProgress,
        onError: (e) => console.error("[kcsim] quest progress failed", e),
      })
    : undefined;

  const target = opts.target ?? window;
  const listener = (e: Event) => {
    const d = (e as CustomEvent).detail;
    if (d && typeof d.path === "string") {
      void session.handle(d.path, d.body, d.postBody);
      autoUploader?.onResponse(d.path);
      // 例外は QuestCounter の onError が記録する
      void questCounter?.handle(d.path, d.body, d.postBody);
      // poi は game.response の前に redux を更新しているので、ここで読む state はこの応答の反映後
      // (失敗は ResourceRecorder の onError が記録する)
      if (resources) {
        try {
          void recordFromPoi(resources, getState(), d).catch(() => {});
        } catch (e) {
          console.error("[kcsim] resource history failed", e);
        }
      }
    }
  };
  target.addEventListener("game.response", listener);

  const running: Running = {
    db,
    stop: () => {
      autoUploader?.stop();
      target.removeEventListener("game.response", listener);
      void db.close();
      void resourceStore?.close?.();
      void questStore?.close?.();
      delete g[GLOBAL_KEY];
    },
  };
  g[GLOBAL_KEY] = running;
  return db;
};

export const stopCapture = (): void => {
  (globalThis as any)[GLOBAL_KEY]?.stop();
};

/** 起動中の db (UI から listBattles 等を呼ぶ用)。未起動なら undefined。 */
export const getCaptureDb = (): ObservationDb | undefined =>
  (globalThis as any)[GLOBAL_KEY]?.db;

let shared: ObservationDb | undefined;
/** UI 用。キャプチャ起動中ならその db、そうでなければ同じ DB を開く共有インスタンス。 */
export const getObservationDb = (): ObservationDb =>
  getCaptureDb() ?? (shared ??= new ObservationDb());
