/**
 * game.response を受けて戦闘観測レコードと出撃 (経路) レコードを組み立てる。poi / DOM には依存せず、
 * 艦隊スナップショットの取得 (getFleet) と保存先 (sink) は外から注入する。
 * マス番号 (api_no) からノード名への変換はしない (サーバが edges から引く。docs/API.md §3)。
 */
import { extractAttackEvents, extractBattleResult, extractCellData, extractEnemy, extractMapCell } from "@shared/capture/parser";
import type {
  BattleResultInfo,
  CapturedBattle,
  CapturedCell,
  CapturedFleet,
  CapturedGauge,
  CapturedMapInfo,
  CapturedSortie,
  SortieEnd,
  SortieFleetFeatures,
  StoredEvent,
} from "@shared/capture/types";

export interface ObservationSink {
  saveBattle(battle: CapturedBattle, events: StoredEvent[]): Promise<void>;
  saveResult(battleId: string, result: BattleResultInfo): Promise<void>;
  /** 出撃レコードを (途中経過も含めて) 上書き保存する。 */
  saveSortie(sortie: CapturedSortie): Promise<void>;
}

export interface CaptureDeps {
  sink: ObservationSink;
  /** 1 始まりの艦隊番号で、その時点の艦隊スナップショットを返す (poi の store から)。
   * combined=true なら随伴艦隊 (第2艦隊) も escort に入れる。 */
  getFleet: (deckId: number, combined: boolean) => CapturedFleet | null;
  /** 出撃時の艦隊の特徴 (艦種・速力・索敵)。任意。 */
  fleetFeatures?: (fleet: CapturedFleet) => SortieFleetFeatures | null;
  /** select_eventmap_rank を見ていないときの難易度 (poi の state から)。任意。 */
  getDifficulty?: (area: number, mapNo: number) => number | null;
  /** 出撃時のそのマップのゲージ状態 (poi の info.maps[area*10+mapNo] から)。任意。 */
  getGauge?: (area: number, mapNo: number) => CapturedGauge | null;
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

/** 艦隊司令部施設で離脱艦を帰投させる要求 (api_req_sortie / api_req_combined_battle の goback_port)。 */
export const isGobackPath = (path: string): boolean =>
  /^api_req_(sortie|combined_battle)\/goback_port$/.test(path);

const toNum = (v: unknown): number | null => {
  const n = typeof v === "string" && v !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** 最後のマスから出撃の終わり方を決める: ボス > 行き止まり (api_next 0) > 途中帰投。 */
export const sortieEndKind = (last: CapturedCell | undefined): SortieEnd => {
  if (!last) return "unknown";
  if (last.eventId === 5 || (last.bossCellNo !== null && last.no === last.bossCellNo)) return "boss";
  return last.next === 0 ? "end_node" : "retreat";
};

export class CaptureSession {
  private map: CapturedMapInfo | null = null;
  private sortie: CapturedSortie | null = null;
  private deckId = 1;
  private combinedFlag: number | null = null;
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
      await this.onMapNode(path, body, postBody);
    } else if (path === "api_port/port") {
      this.combinedFlag = toNum(body?.api_combined_flag) ?? this.combinedFlag;
      await this.endSortie();
    } else if (isResultPath(path)) {
      await this.onResult(body);
    } else if (isGobackPath(path)) {
      await this.onGobackPort();
    } else if (isBattlePath(path)) {
      await this.onBattle(path, body, postBody);
    }
  }

  private async endSortie() {
    const s = this.sortie;
    if (!s) return;
    this.sortie = null;
    const now = this.now();
    await this.deps.sink.saveSortie({ ...s, endKind: sortieEndKind(s.cells.at(-1)), endedAt: now, updatedAt: now });
  }

  private async onMapNode(path: "api_req_map/start" | "api_req_map/next", body: any, postBody: any) {
    const isStart = path === "api_req_map/start";
    const area = toNum(body?.api_maparea_id) ?? this.map?.area;
    const mapNo = toNum(body?.api_mapinfo_no) ?? this.map?.mapNo;
    const cell = extractMapCell(body);
    if (area == null || mapNo == null || cell === null) return;
    const key = `${area}-${mapNo}`;
    const now = this.now();
    if (isStart) {
      await this.endSortie(); // 母港を経ずに次の出撃 (取り逃し) なら前の出撃を閉じる
      this.step = 0;
      this.deckId = toNum(postBody?.api_deck_id) ?? 1;
      const cellData = extractCellData(body);
      const combined = this.deckId === 1 && (this.combinedFlag ?? 0) > 0;
      const fleet = this.deps.getFleet(this.deckId, combined);
      this.sortie = {
        id: `s-${now.toString(36)}-${++this.counter}`,
        startedAt: now,
        updatedAt: now,
        endedAt: null,
        endKind: null,
        map: key,
        area,
        mapNo,
        difficulty: this.difficultyByMap.get(key) ?? this.deps.getDifficulty?.(area, mapNo) ?? null,
        deckId: this.deckId,
        fleetSize: fleet?.ships.length ?? null,
        escortSize: fleet?.escort?.length ?? 0,
        gauge: this.deps.getGauge?.(area, mapNo) ?? null,
        combined: this.combinedFlag,
        cellData,
        cells: [],
        fleet,
        features: fleet && this.deps.fleetFeatures ? this.deps.fleetFeatures(fleet) : null,
        pending: 1,
      };
    }
    this.step += 1;
    this.visitId = `${now.toString(36)}-${++this.counter}`;
    const sortie = this.sortie?.map === key ? this.sortie : null;
    if (sortie) {
      sortie.cells.push({ ...cell, battles: [] });
      (sortie.packets ??= []).push({ path, body });
      sortie.updatedAt = now;
      await this.deps.sink.saveSortie(sortie);
    }
    this.map = {
      map: key,
      area,
      mapNo,
      cellId: cell.no,
      node: String(cell.no),
      difficulty: sortie?.difficulty ?? this.difficultyByMap.get(key) ?? this.deps.getDifficulty?.(area, mapNo) ?? null,
      eventId: cell.eventId,
      eventKind: cell.eventKind,
      step: this.step,
      ...(sortie ? { sortieId: sortie.id } : {}),
      ...(sortie?.cellData ? { layout: sortie.cellData.map((c) => c.no) } : {}),
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
    const cell = this.currentCell();
    if (cell && cell.battles.length < 8) {
      cell.battles.push(id);
      this.sortie!.updatedAt = capturedAt;
      await this.deps.sink.saveSortie(this.sortie!);
    }
  }

  /** 今の出撃の最後に到達したマス (この出撃の中のマスにいるときだけ)。 */
  private currentCell(): CapturedCell | undefined {
    return this.sortie && this.map?.sortieId === this.sortie.id ? this.sortie.cells.at(-1) : undefined;
  }

  private async onResult(body: any) {
    if (!body) return;
    if (this.lastBattleId) {
      const result: BattleResultInfo = {
        rank: typeof body.api_win_rank === "string" ? body.api_win_rank : null,
        mvp: toNum(body.api_mvp),
        dropShipId: toNum(body.api_get_ship?.api_ship_id),
        raw: body,
      };
      await this.deps.sink.saveResult(this.lastBattleId, result);
    }
    const cell = this.currentCell();
    const parsed = extractBattleResult(body);
    if (!cell || !parsed) return;
    const { escape, ...result } = parsed;
    // idx は出撃時の並び (本隊 → 随伴) の 1 始まりの位置。KC3 も撤退後に詰めずに同じ位置で引いている
    const fleet = this.sortie!.fleet;
    const flat = fleet ? [...fleet.ships, ...(fleet.escort ?? [])] : [];
    const shipIds = (idx: number[]) => idx.flatMap((i) => (flat[i - 1] ? [flat[i - 1]!.masterId] : []));
    cell.result = {
      ...result,
      ...(escape
        ? { escape: { idx: escape.idx, towIdx: escape.towIdx, shipIds: shipIds(escape.idx), towShipIds: shipIds(escape.towIdx), type: escape.type, retreated: false } }
        : {}),
    };
    this.sortie!.updatedAt = this.now();
    await this.deps.sink.saveSortie(this.sortie!);
  }

  /** goback_port: 直前のマスで離脱可能だった艦が、そのマスの後で実際に撤退した。 */
  private async onGobackPort() {
    const escape = this.currentCell()?.result?.escape;
    if (!escape || escape.retreated) return;
    escape.retreated = true;
    this.sortie!.updatedAt = this.now();
    await this.deps.sink.saveSortie(this.sortie!);
  }
}
