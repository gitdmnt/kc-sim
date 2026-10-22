/**
 * game.response を受けて戦闘観測レコードを組み立てる。poi / DOM には依存せず、
 * 艦隊スナップショットの取得 (getFleet) と保存先 (sink) は外から注入する。
 */
import { extractAttackEvents, extractEnemy } from "./parser";
import type {
  BattleResultInfo,
  CapturedBattle,
  CapturedFleet,
  CapturedMapInfo,
  StoredEvent,
} from "./types";

export interface ObservationSink {
  saveBattle(battle: CapturedBattle, events: StoredEvent[]): Promise<void>;
  saveResult(battleId: string, result: BattleResultInfo): Promise<void>;
}

export interface CaptureDeps {
  sink: ObservationSink;
  /** 1 始まりの艦隊番号で、その時点の艦隊スナップショットを返す (poi の store から)。
   * combined=true なら随伴艦隊 (第2艦隊) も escort に入れる。 */
  getFleet: (deckId: number, combined: boolean) => CapturedFleet | null;
  /** (area, map, cellId) → ノード名 (A, B…)。ゲーム API には無いので任意。 */
  resolveNode?: (area: number, mapNo: number, cellId: number) => string | undefined;
  now?: () => number;
  onError?: (error: unknown) => void;
}

const ROOT = /^\/?kcsapi\//;
const NOT_BATTLE = /\/(battleresult|goback_port|ld_shooting_result)$/;

export const isBattlePath = (path: string): boolean =>
  (/^api_req_(sortie|combined_battle)\//.test(path) ||
    /^api_req_battle_midnight\//.test(path)) &&
  !NOT_BATTLE.test(path);

/** 味方が連合艦隊の戦闘か (api_req_combined_battle のうち敵連合単独の ec_* を除く)。 */
const isFriendCombined = (path: string): boolean =>
  path.startsWith("api_req_combined_battle/") && !/\/ec_/.test(path);

export const isResultPath = (path: string): boolean =>
  /^api_req_(sortie|combined_battle)\/battleresult$/.test(path);

const toNum = (v: unknown): number | null => {
  const n = typeof v === "string" && v !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export class CaptureSession {
  private map: CapturedMapInfo | null = null;
  private deckId = 1;
  private visitId = "";
  private step = 0;
  private counter = 0;
  /** 直前の戦闘 (battleresult を紐付ける先) */
  private lastBattleId: string | null = null;
  private difficultyByMap = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private deps: CaptureDeps) {}

  /** poi の game.response の detail をそのまま渡す。例外は投げない。 */
  handle(rawPath: string, body: any, postBody?: any): Promise<void> {
    const path = rawPath.replace(ROOT, "");
    this.queue = this.queue
      .then(() => this.dispatch(path, body, postBody))
      .catch((e) => (this.deps.onError ?? console.error)(e));
    return this.queue;
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  private async dispatch(path: string, body: any, postBody: any) {
    if (path === "api_req_map/select_eventmap_rank") {
      const rank = toNum(postBody?.api_rank);
      const area = toNum(postBody?.api_maparea_id);
      const mapNo = toNum(postBody?.api_map_no);
      if (rank !== null && area !== null && mapNo !== null) {
        this.difficultyByMap.set(`${area}-${mapNo}`, rank);
      }
    } else if (path === "api_req_map/start" || path === "api_req_map/next") {
      this.onMapNode(path === "api_req_map/start", body, postBody);
    } else if (isResultPath(path)) {
      await this.onResult(body);
    } else if (isBattlePath(path)) {
      await this.onBattle(path, body, postBody);
    }
  }

  private onMapNode(isStart: boolean, body: any, postBody: any) {
    const area = toNum(body?.api_maparea_id) ?? this.map?.area;
    const mapNo = toNum(body?.api_mapinfo_no) ?? this.map?.mapNo;
    const cellId = toNum(body?.api_no);
    if (area == null || mapNo == null || cellId === null) return;
    if (isStart) {
      this.step = 0;
      this.deckId = toNum(postBody?.api_deck_id) ?? 1;
    }
    this.step += 1;
    const key = `${area}-${mapNo}`;
    this.visitId = `${this.now().toString(36)}-${++this.counter}`;
    this.map = {
      map: key,
      area,
      mapNo,
      cellId,
      node: this.deps.resolveNode?.(area, mapNo, cellId) ?? String(cellId),
      difficulty: this.difficultyByMap.get(key) ?? null,
      eventId: toNum(body?.api_event_id),
      eventKind: toNum(body?.api_event_kind),
      step: this.step,
    };
  }

  private async onBattle(path: string, body: any, postBody: any) {
    if (!body || typeof body !== "object") return;
    const capturedAt = this.now();
    const id = `${capturedAt.toString(36)}-${++this.counter}`;
    const deckId = toNum(body.api_deck_id) ?? this.deckId;
    const enemy = extractEnemy(body);
    const battle: CapturedBattle = {
      id,
      capturedAt,
      path,
      visitId: this.visitId || id,
      map: this.map,
      fleet: this.deps.getFleet(deckId, isFriendCombined(path)),
      enemy,
      enemyMasterIds: [
        ...new Set([...enemy.ships, ...enemy.escort].map((s) => s.masterId)),
      ],
      pending: 1,
      raw: body,
      postBody,
    };
    const events: StoredEvent[] = extractAttackEvents(body, path).map((e) => ({
      ...e,
      battleId: id,
      map: this.map?.map ?? null,
      node: this.map?.node ?? null,
    }));
    this.lastBattleId = id;
    await this.deps.sink.saveBattle(battle, events);
  }

  private async onResult(body: any) {
    if (!this.lastBattleId || !body) return;
    const result: BattleResultInfo = {
      rank: typeof body.api_win_rank === "string" ? body.api_win_rank : null,
      mvp: toNum(body.api_mvp),
      dropShipId: toNum(body.api_get_ship?.api_ship_id),
      raw: body,
    };
    await this.deps.sink.saveResult(this.lastBattleId, result);
  }
}
