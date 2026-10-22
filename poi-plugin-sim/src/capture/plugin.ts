/**
 * poi への登録。`startCapture()` は index.es の pluginDidLoad から呼ぶ。
 *
 * [INFERENCE] windowMode プラグインでも pluginDidLoad はメインウィンドウ側で実行され、
 * プラグインウィンドウを開かなくても動く (poi の plugin-manager がロード時に呼ぶ)。
 * プラグインウィンドウ側 (別 BrowserWindow) では呼ばない。二重登録は window 上のフラグで防ぐ。
 */
import { importFromPoi } from "../fleet/poiImport";
import { startAutoUpload } from "./autoUpload";
import type { AutoUploader, AutoUploadOptions } from "./autoUpload";
import { ObservationDb } from "./db";
import { CaptureSession } from "./session";
import type { CaptureDeps } from "./session";
import type { CapturedFleet, ShipSupply } from "./types";

const GLOBAL_KEY = "__kcsimCapture";

export interface StartCaptureOptions {
  /** poi の redux state を返す関数。既定は window.getStore()。 */
  getState?: () => any;
  db?: ObservationDb;
  resolveNode?: CaptureDeps["resolveNode"];
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
  /** 自動送信の差し替え (テスト用)。false なら自動送信しない。 */
  autoUpload?: false | Partial<Omit<AutoUploadOptions, "db">>;
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
    resolveNode: opts.resolveNode,
  });

  let autoUploader: AutoUploader | undefined;
  if (opts.autoUpload !== false) {
    try {
      autoUploader = startAutoUpload({ ...opts.autoUpload, db });
    } catch (e) {
      console.error("[kcsim] failed to start auto upload", e);
    }
  }

  const target = opts.target ?? window;
  const listener = (e: Event) => {
    const d = (e as CustomEvent).detail;
    if (d && typeof d.path === "string") {
      void session.handle(d.path, d.body, d.postBody);
      autoUploader?.onResponse(d.path);
    }
  };
  target.addEventListener("game.response", listener);

  const running: Running = {
    db,
    stop: () => {
      autoUploader?.stop();
      target.removeEventListener("game.response", listener);
      void db.close();
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
