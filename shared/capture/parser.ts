/**
 * 戦闘パケット (game.response の body) から攻撃イベントを取り出す。
 * 対応: api_opening_taisen / api_opening_atack / api_hougeki1-3 / api_raigeki / api_hougeki (夜戦) /
 *       api_n_hougeki1-2 (夜→昼) / api_kouku, api_kouku2, api_injection_kouku (stage3) / api_air_base_attack
 * 未対応 (生データは保存される): 支援艦隊, 基地航空隊の対潜, 連合艦隊の艦隊間インデックス補正の細部。
 * 海域マス (api_req_map/start・next の api_no・api_cell_data) も取り出す (extractMapCell / extractCellData)。
 */
import type {
  AttackEvent, AttackPhase, CapturedCell, CapturedCellData, CapturedCellResult, CapturedEnemy, CapturedEnemyShip,
  CapturedGauge, HitKind, Side,
} from "./types";

type RawEvent = Omit<AttackEvent, "seq">;

const hitOf = (cl: unknown): HitKind => (cl === 2 ? "crit" : cl === 1 ? "hit" : "miss");

/** 雷撃戦が何巡目の砲撃の後に来るか (ここに無い戦闘は砲撃3の後)。 */
const TORPEDO_AFTER: Record<string, number> = {
  "api_req_combined_battle/battle": 1,
  "api_req_combined_battle/ec_battle": 1,
  "api_req_combined_battle/each_battle": 2,
};

/** 昼戦・夜戦で .1 が付くかばう表現を分離する。 */
export const splitDamage = (raw: unknown): { damage: number; protected: boolean } => {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  const damage = Math.floor(n + 1e-9);
  return { damage, protected: n - damage > 1e-6 };
};

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

const parseHougeki = (h: any, phase: AttackPhase): RawEvent[] => {
  if (!h || typeof h !== "object") return [];
  const events: RawEvent[] = [];
  const atList = asArray(h.api_at_list);
  const eflag = asArray(h.api_at_eflag);
  const types = asArray(h.api_at_type ?? h.api_sp_list);
  const dfList = asArray(h.api_df_list);
  const siList = asArray(h.api_si_list);
  const clList = asArray(h.api_cl_list);
  const dmgList = asArray(h.api_damage);

  atList.forEach((at, i) => {
    // 古い形式は先頭に -1 が入る
    if (typeof at !== "number" || at < 0) return;
    const attackerSide: Side = eflag[i] === 1 ? "enemy" : "friend";
    const defenderSide: Side = attackerSide === "friend" ? "enemy" : "friend";
    const defenders = asArray(dfList[i]);
    const cls = asArray(clList[i]);
    const dmgs = asArray(dmgList[i]);
    const items = asArray(siList[i]).filter(
      (x): x is number => typeof x === "number" && x > 0
    );
    defenders.forEach((df, j) => {
      if (typeof df !== "number" || df < 0) return;
      const { damage, protected: prot } = splitDamage(dmgs[j]);
      const event: RawEvent = {
        phase,
        attackerSide,
        attackerIdx: at,
        defenderSide,
        defenderIdx: df,
        attackType: num(types[i]),
        hit: hitOf(cls[j]),
        damage,
        protected: prot,
      };
      if (items.length > 0) event.displayItems = items;
      events.push(event);
    });
  });
  return events;
};

/** api_opening_atack / api_raigeki。旧形式 (frai/fcl/fydam) と新形式 (*_list_items) の両対応。 */
const parseTorpedo = (t: any, phase: AttackPhase): RawEvent[] => {
  if (!t || typeof t !== "object") return [];
  const events: RawEvent[] = [];

  const side = (
    attackerSide: Side,
    rai: unknown[],
    cl: unknown[],
    ydam: unknown[],
    items: { rai?: unknown[]; cl?: unknown[]; ydam?: unknown[] }
  ) => {
    const defenderSide: Side = attackerSide === "friend" ? "enemy" : "friend";
    const count = Math.max(rai.length, items.rai?.length ?? 0);
    for (let i = 0; i < count; i++) {
      const itemTargets = items.rai?.[i];
      if (Array.isArray(itemTargets)) {
        const cls = asArray(items.cl?.[i]);
        const dmgs = asArray(items.ydam?.[i]);
        itemTargets.forEach((target, j) => {
          if (typeof target !== "number" || target < 0) return;
          const { damage, protected: prot } = splitDamage(dmgs[j]);
          events.push({
            phase, attackerSide, attackerIdx: i, defenderSide, defenderIdx: target,
            attackType: null, hit: hitOf(cls[j]), damage, protected: prot,
          });
        });
      } else if (typeof rai[i] === "number" && (rai[i] as number) >= 0) {
        const { damage, protected: prot } = splitDamage(ydam[i]);
        events.push({
          phase, attackerSide, attackerIdx: i, defenderSide, defenderIdx: rai[i] as number,
          attackType: null, hit: hitOf(cl[i]), damage, protected: prot,
        });
      }
    }
  };

  side("friend", asArray(t.api_frai), asArray(t.api_fcl), asArray(t.api_fydam), {
    rai: t.api_frai_list_items, cl: t.api_fcl_list_items, ydam: t.api_fydam_list_items,
  });
  side("enemy", asArray(t.api_erai), asArray(t.api_ecl), asArray(t.api_eydam), {
    rai: t.api_erai_list_items, cl: t.api_ecl_list_items, ydam: t.api_eydam_list_items,
  });
  return events;
};

/**
 * 航空戦 stage3。攻撃艦は特定できないため attackerIdx = -1。
 * stage3 は命中した対象だけにフラグが立つので miss は出力されない。
 */
const parseStage3 = (stage3: any, offset: number): RawEvent[] => {
  if (!stage3 || typeof stage3 !== "object") return [];
  const events: RawEvent[] = [];
  const side = (
    defenderSide: Side,
    rai: unknown[], bak: unknown[], cl: unknown[], dam: unknown[]
  ) => {
    const attackerSide: Side = defenderSide === "friend" ? "enemy" : "friend";
    const count = Math.max(rai.length, bak.length, dam.length);
    for (let i = 0; i < count; i++) {
      const torp = rai[i] === 1;
      const bomb = bak[i] === 1;
      if (!torp && !bomb) continue;
      const { damage, protected: prot } = splitDamage(dam[i]);
      events.push({
        phase: "air", attackerSide, attackerIdx: -1,
        defenderSide, defenderIdx: i + offset,
        attackType: null, hit: cl[i] === 1 ? "crit" : "hit",
        damage, protected: prot,
        airKind: torp && bomb ? "both" : torp ? "torpedo" : "bomb",
      });
    }
  };
  side("friend", asArray(stage3.api_frai_flag), asArray(stage3.api_fbak_flag),
    asArray(stage3.api_fcl_flag), asArray(stage3.api_fdam));
  side("enemy", asArray(stage3.api_erai_flag), asArray(stage3.api_ebak_flag),
    asArray(stage3.api_ecl_flag), asArray(stage3.api_edam));
  return events;
};

const parseKouku = (k: any): RawEvent[] => {
  if (!k || typeof k !== "object") return [];
  return [
    ...parseStage3(k.api_stage3, 0),
    ...parseStage3(k.api_stage3_combined, 6),
  ];
};

export const extractAttackEvents = (body: any, path = ""): AttackEvent[] => {
  if (!body || typeof body !== "object") return [];
  const isNight = path.includes("midnight") || path.includes("sp_midnight");
  const raw: RawEvent[] = [];

  // 時系列順: 航空 → 先制対潜 → 開幕雷撃 → 砲撃 → 閉幕雷撃 → 夜戦
  raw.push(...parseKouku(body.api_injection_kouku));
  asArray(body.api_air_base_attack).forEach((wave) => raw.push(...parseKouku(wave)));
  raw.push(...parseKouku(body.api_kouku));
  raw.push(...parseKouku(body.api_kouku2));
  raw.push(...parseHougeki(body.api_opening_taisen, "opening_asw"));
  raw.push(...parseTorpedo(body.api_opening_atack, "opening_torpedo"));
  // 雷撃戦の位置 (kcsim simCombined / sim6vs12 / sim12vs12): 空母機動・輸送護衛部隊 対 通常 (combined_battle/battle)
  // と 通常 対 敵連合 (ec_battle) は砲撃1の後、空母機動・輸送護衛部隊 対 敵連合 (each_battle) は砲撃2の後、ほかは最後。
  // 砲撃のあと最後に置くと、KCNav の each_battle / ec_battle では雷撃の始まる前に撃沈済みの艦を狙う雷撃が 580 件出る (この順なら 0 件)。
  const torpedoAfter = Object.entries(TORPEDO_AFTER).find(([api]) => path.endsWith(api))?.[1] ?? 3;
  const closingTorpedo = parseTorpedo(body.api_raigeki, "closing_torpedo");
  raw.push(...parseHougeki(body.api_hougeki1, "shelling1"));
  if (torpedoAfter === 1) raw.push(...closingTorpedo);
  raw.push(...parseHougeki(body.api_hougeki2, "shelling2"));
  if (torpedoAfter === 2) raw.push(...closingTorpedo);
  raw.push(...parseHougeki(body.api_hougeki3, "shelling3"));
  if (torpedoAfter === 3) raw.push(...closingTorpedo);
  // 夜戦 (api_hougeki) と夜→昼 (api_n_hougeki1/2)。昼戦で api_hougeki 単独キーが来る場合は砲撃1扱い。
  raw.push(...parseHougeki(body.api_n_hougeki1, "night"));
  raw.push(...parseHougeki(body.api_n_hougeki2, "night"));
  raw.push(...parseHougeki(body.api_hougeki, isNight ? "night" : "shelling1"));

  return raw.map((e, seq) => ({ seq, ...e }));
};

const enemyShips = (
  ke: unknown, lv: unknown, maxhps: unknown, nowhps: unknown, slots: unknown, params: unknown
): CapturedEnemyShip[] => {
  const ships: CapturedEnemyShip[] = [];
  asArray(ke).forEach((id, idx) => {
    if (typeof id !== "number" || id <= 0) return;
    const pick = (arr: unknown) => num(asArray(arr)[idx]);
    const arrAt = (arr: unknown): number[] | null => {
      const v = asArray(arr)[idx];
      return Array.isArray(v) ? (v as number[]) : null;
    };
    ships.push({
      idx, masterId: id, level: pick(lv), maxHp: pick(maxhps), nowHp: pick(nowhps),
      slots: arrAt(slots), params: arrAt(params),
    });
  });
  return ships;
};

/** 戦闘パケットから敵情報と陣形・交戦形態を取り出す。欠けている項目は null/空。 */
export const extractEnemy = (body: any): CapturedEnemy => {
  const b = body ?? {};
  const formation: unknown[] = asArray(b.api_formation);
  return {
    ships: enemyShips(b.api_ship_ke, b.api_ship_lv, b.api_e_maxhps, b.api_e_nowhps, b.api_eSlot, b.api_eParam),
    escort: enemyShips(
      b.api_ship_ke_combined, b.api_ship_lv_combined, b.api_e_maxhps_combined,
      b.api_e_nowhps_combined, b.api_eSlot_combined, b.api_eParam_combined
    ),
    friendFormation: num(formation[0]),
    enemyFormation: num(formation[1]),
    engagement: num(formation[2]),
  };
};

// ---- 海域マス (api_req_map/start・next) ----

/** ゲーム応答の 1 オブジェクト。未検証の JSON なので各値は num() などで確かめて使う。 */
type Packet = Record<string, unknown>;
const packet = (v: unknown): Packet | null => (v !== null && typeof v === "object" ? (v as Packet) : null);

/** api_req_map/start・next の応答から到達マスを取り出す。api_no が無ければ null。 */
export const extractMapCell = (body: unknown): Omit<CapturedCell, "battles"> | null => {
  const b = packet(body);
  const no = num(b?.api_no);
  if (!b || no === null) return null;
  const select = packet(b.api_select_route)?.api_select_cells;
  return {
    no,
    from: num(b.api_from_no),
    colorNo: num(b.api_color_no),
    eventId: num(b.api_event_id),
    eventKind: num(b.api_event_kind),
    bossCellNo: num(b.api_bosscell_no),
    next: num(b.api_next),
    selectCells: Array.isArray(select) ? select.filter((x: unknown): x is number => typeof x === "number") : null,
  };
};

/** api_req_map/start の api_cell_data (全マスの番号・色・通過済み)。無ければ null。 */
export const extractCellData = (body: unknown): CapturedCellData[] | null => {
  const list = packet(body)?.api_cell_data;
  if (!Array.isArray(list)) return null;
  return list.flatMap((item: unknown) => {
    const c = packet(item);
    const no = num(c?.api_no);
    return !c || no === null ? [] : [{ no, colorNo: num(c.api_color_no), passed: num(c.api_passed), distance: num(c.api_distance) }];
  });
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const numList = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);

/**
 * api_get_member/mapinfo の api_map_info の 1 要素 (poi の info.maps[api_id]) からゲージ状態を取り出す。
 * ゲージ番号・種別・HP・ランクはイベント海域の api_eventmap に入っている (無ければ要素直下を見る)。
 * 何も読めなければ null。
 */
export const extractGauge = (entry: unknown): CapturedGauge | null => {
  const m = packet(entry);
  if (!m) return null;
  const ev = packet(m.api_eventmap);
  const pick = (key: string) => num(ev?.[key]) ?? num(m[key]);
  const gauge: CapturedGauge = {
    gaugeNum: pick("api_gauge_num"),
    gaugeType: pick("api_gauge_type"),
    nowHp: num(ev?.api_now_maphp),
    maxHp: num(ev?.api_max_maphp),
    state: num(ev?.api_state),
    rank: num(ev?.api_selected_rank),
    cleared: num(m.api_cleared),
    defeatCount: num(m.api_defeat_count),
  };
  return Object.values(gauge).every((v) => v === null) ? null : gauge;
};

/** battleresult の api_escape (艦隊司令部施設)。`idx` は 1 始まりの位置のまま (艦への解決は呼び出し側)。 */
export interface RawEscape { idx: number[]; towIdx: number[]; type: number | null }

/**
 * battleresult の応答から勝敗・ドロップ・離脱を取り出す。`escape` は api_escape があるときだけ。
 * api_win_rank が無ければ null (戦闘結果ではない)。
 */
export const extractBattleResult = (body: unknown): (Omit<CapturedCellResult, "escape"> & { escape?: RawEscape }) | null => {
  const b = packet(body);
  const rank = str(b?.api_win_rank);
  if (!b || !rank) return null;
  const ship = packet(b.api_get_ship);
  const shipId = num(ship?.api_ship_id);
  const item = packet(b.api_get_useitem);
  const itemId = num(item?.api_useitem_id);
  const eventItems = (Array.isArray(b.api_get_eventitem) ? b.api_get_eventitem : []).flatMap((v: unknown) => {
    const e = packet(v);
    const [type, id, value] = [num(e?.api_type), num(e?.api_id), num(e?.api_value)];
    return type === null || id === null || value === null ? [] : [{ type, id, value }];
  });
  const esc = packet(b.api_escape);
  const idx = numList(esc?.api_escape_idx);
  const towIdx = numList(esc?.api_tow_idx);
  const name = str(ship?.api_ship_name);
  const itemName = str(item?.api_useitem_name);
  return {
    rank,
    drop: shipId === null ? null : { shipId, ...(name ? { name } : {}) },
    ...(itemId === null ? {} : { useItem: { id: itemId, ...(itemName ? { name: itemName } : {}) } }),
    ...(eventItems.length ? { eventItems } : {}),
    escapeFlag: num(b.api_escape_flag) ?? 0,
    ...(idx.length || towIdx.length ? { escape: { idx, towIdx, type: num(b.api_escape_type) } } : {}),
  };
};
