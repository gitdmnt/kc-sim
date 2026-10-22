/** 実パケットの形式に合わせて手で組んだ戦闘パケット (配列長は艦数に合わせて短縮)。 */

/** api_req_sortie/battle: 味方3隻 vs 敵3隻。航空戦・先制対潜・開幕雷撃・砲撃1・2・閉幕雷撃つき。 */
export const dayBattle = {
  api_deck_id: 1,
  api_formation: [1, 2, 1],
  api_f_nowhps: [30, 31, 32],
  api_f_maxhps: [30, 31, 32],
  api_ship_ke: [1501, 1502, 1503, -1, -1, -1],
  api_ship_lv: [1, 1, 1, -1, -1, -1],
  api_e_nowhps: [12, 14, 16, -1, -1, -1],
  api_e_maxhps: [12, 14, 16, -1, -1, -1],
  api_eSlot: [[501, -1], [502, -1], [503, 504], [-1], [-1], [-1]],
  api_eParam: [[5, 0, 5, 5], [6, 10, 6, 6], [7, 0, 7, 7], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
  api_kouku: {
    api_stage3: {
      api_frai_flag: [0, 0, 0],
      api_erai_flag: [1, 0, 0],
      api_fbak_flag: [0, 1, 0],
      api_ebak_flag: [1, 1, 0],
      api_fcl_flag: [0, 1, 0],
      api_ecl_flag: [0, 1, 0],
      api_fdam: [0, 10.1, 0],
      api_edam: [3, 7, 0],
    },
  },
  api_opening_taisen: {
    api_at_eflag: [0],
    api_at_list: [2],
    api_at_type: [0],
    api_df_list: [[0]],
    api_si_list: [[1]],
    api_cl_list: [[1]],
    api_damage: [[4]],
  },
  api_opening_atack: {
    api_frai: [2, -1, -1],
    api_fcl: [2, 0, 0],
    api_fdam: [0, 0, 0],
    api_fydam: [55, 0, 0],
    api_erai: [-1, 0, -1],
    api_ecl: [0, 1, 0],
    api_edam: [9, 0, 0],
    api_eydam: [0, 9.1, 0],
  },
  api_hougeki1: {
    api_at_eflag: [0, 1, 0],
    api_at_list: [0, 1, 1],
    api_at_type: [0, 0, 2],
    api_df_list: [[0], [2], [1, 1]],
    api_si_list: [[1, 2], [-1], [3, 4]],
    api_cl_list: [[2], [1], [1, 0]],
    api_damage: [[35], [12.1], [20, 0]],
  },
  api_hougeki2: {
    api_at_eflag: [1],
    api_at_list: [0],
    api_at_type: [0],
    api_df_list: [[1]],
    api_si_list: [[-1]],
    api_cl_list: [[0]],
    api_damage: [[0]],
  },
  api_raigeki: {
    api_frai: [-1, 1, -1],
    api_fcl: [0, 1, 0],
    api_fdam: [0, 0, 0],
    api_fydam: [0, 18, 0],
    api_erai: [-1, -1, -1],
    api_ecl: [0, 0, 0],
    api_edam: [0, 18, 0],
    api_eydam: [0, 0, 0],
  },
};

/** api_req_battle_midnight/battle: 夜戦 (連続攻撃・かばう・古い -1 先頭なし形式)。 */
export const midnightBattle = {
  api_deck_id: 1,
  api_formation: [1, 1, 1],
  api_ship_ke: [1501, 1502],
  api_ship_lv: [1, 1],
  api_e_nowhps: [5, 6],
  api_e_maxhps: [12, 14],
  api_eSlot: [[501], [502]],
  api_eParam: [[5, 0, 5, 5], [6, 10, 6, 6]],
  api_hougeki: {
    api_at_eflag: [0, 1, 0],
    api_at_list: [0, 2, 1],
    api_n_mother_list: [0, 0, 0],
    api_df_list: [[1], [0], [0, 0]],
    api_si_list: [[1, 2, 3], [-1], [4, 5, 6]],
    api_sp_list: [0, 0, 1],
    api_cl_list: [[2], [0], [1, 1]],
    api_damage: [[40], [0], [15, 16.1]],
  },
};

/** 旧形式: 各配列の先頭に -1 が入る。 */
export const legacyHougeki = {
  api_at_list: [-1, 0],
  api_at_type: [-1, 0],
  api_df_list: [-1, [1]],
  api_si_list: [-1, [1]],
  api_cl_list: [-1, [1]],
  api_damage: [-1, [8]],
  api_at_eflag: [-1, 0],
};

/** 新形式の雷撃 (複数雷撃対応: *_list_items)。 */
export const listItemsTorpedo = {
  api_frai_list_items: [[3, 4], null, null],
  api_fcl_list_items: [[1, 2], null, null],
  api_fdam: [0, 0, 0],
  api_fydam_list_items: [[10, 20.1], null, null],
  api_erai_list_items: [null, [0], null],
  api_ecl_list_items: [null, [0], null],
  api_edam: [0, 0, 0],
  api_eydam_list_items: [null, [0], null],
};

/** 味方連合艦隊 (空母機動部隊) の敵側連合: 随伴の航空 stage3_combined を含む。 */
export const combinedKouku = {
  api_deck_id: 1,
  api_formation: [14, 1, 2],
  api_ship_ke: [1501],
  api_ship_lv: [1],
  api_e_nowhps: [10],
  api_e_maxhps: [10],
  api_ship_ke_combined: [1510, 1511],
  api_ship_lv_combined: [5, 6],
  api_e_nowhps_combined: [20, 21],
  api_e_maxhps_combined: [20, 21],
  api_kouku: {
    api_stage3: { api_ebak_flag: [0], api_ecl_flag: [0], api_edam: [0], api_fbak_flag: [0], api_fcl_flag: [0], api_fdam: [0] },
    api_stage3_combined: {
      api_fbak_flag: [0, 0, 1],
      api_fcl_flag: [0, 0, 0],
      api_fdam: [0, 0, 7],
    },
  },
};

export const mapStart = {
  api_maparea_id: 1,
  api_mapinfo_no: 2,
  api_no: 1,
  api_event_id: 4,
  api_event_kind: 1,
};
export const mapNext = { ...mapStart, api_no: 5, api_event_id: 4, api_event_kind: 1 };
export const battleResult = {
  api_win_rank: "S",
  api_mvp: 2,
  api_get_ship: { api_ship_id: 77, api_ship_name: "x" },
};

// ---- 海域 (api_req_map/start・next) ----
// 1-5 の実パケット形式に合わせて組んだもの。マス番号は KC3 edges と同じ (edge_id = 行き先の api_no):
// 0 Start, 1 A, 2 B, 3 C, 4 D, 5 E, 6 F, 7 G, 8 H, 9 I, 10/11/12 J (ボス、経路ごとに別番号)。
// api_cell_data の api_id は海域ごとの通し ID でキャプチャでは使わない。api_distance は基地航空隊の
// ある海域でだけ付く (ここでは一部にだけ付けて欠落も確かめる)。

const CELL_COLORS_15 = [0, 4, 90, 4, 4, 4, 4, 90, 4, 4, 5, 5, 5];

/** api_req_map/start (1-5、A マスへ)。api_from_no は付かない。 */
export const mapStart15 = {
  api_cell_data: CELL_COLORS_15.map((color, no) => ({
    api_id: 1500 + no,
    api_no: no,
    api_color_no: color,
    api_passed: no <= 4 ? 1 : 0,
    ...(no === 6 ? { api_distance: 3 } : {}),
  })),
  api_rashin_flg: 1,
  api_rashin_id: 2,
  api_maparea_id: 1,
  api_mapinfo_no: 5,
  api_no: 1,
  api_color_no: 4,
  api_event_id: 4,
  api_event_kind: 1,
  api_next: 1,
  api_bosscell_no: 12,
  api_bosscomp: 0,
  api_airsearch: { api_plane_type: 0, api_result: 0 },
  api_e_deck_info: [{ api_kind: 1, api_ship_ids: [1501, 1502, 1503] }],
  api_limit_state: 0,
};

const next15 = (no: number, from: number, extra: Record<string, unknown>) => ({
  api_rashin_flg: 1,
  api_rashin_id: 1,
  api_maparea_id: 1,
  api_mapinfo_no: 5,
  api_no: no,
  api_from_no: from,
  api_comment_kind: 0,
  api_production_kind: 0,
  api_bosscell_no: 12,
  api_bosscomp: 0,
  api_airsearch: { api_plane_type: 0, api_result: 0 },
  api_limit_state: 0,
  ...extra,
});

/** api_req_map/next: A → D (戦闘、分岐 2)。 */
export const mapNext15D = next15(4, 1, { api_color_no: 4, api_event_id: 4, api_event_kind: 1, api_next: 2 });
/** D → F (戦闘)。 */
export const mapNext15F = next15(6, 4, { api_color_no: 4, api_event_id: 4, api_event_kind: 1, api_next: 2 });
/** F → G (気のせい: event 6 / kind 0)。 */
export const mapNext15G = next15(7, 6, { api_color_no: 90, api_event_id: 6, api_event_kind: 0, api_next: 1 });
/** G → J (ボス、cell 12、終端)。 */
export const mapNext15J = next15(12, 7, { api_color_no: 5, api_event_id: 5, api_event_kind: 1, api_next: 0 });
/** F → I (戦闘、終端マス)。 */
export const mapNext15I = next15(9, 6, { api_color_no: 4, api_event_id: 4, api_event_kind: 1, api_next: 0 });

/** 能動分岐 (event 6 / kind 2) の api_req_map/next。選択肢は api_select_route。 */
export const mapNextSelect = {
  api_rashin_flg: 0,
  api_rashin_id: 0,
  api_maparea_id: 7,
  api_mapinfo_no: 3,
  api_no: 3,
  api_from_no: 2,
  api_color_no: 6,
  api_event_id: 6,
  api_event_kind: 2,
  api_next: 2,
  api_bosscell_no: 18,
  api_bosscomp: 0,
  api_comment_kind: 0,
  api_production_kind: 0,
  api_select_route: { api_select_cells: [5, 6] },
  api_airsearch: { api_plane_type: 0, api_result: 0 },
  api_limit_state: 0,
};

/** 1-5 の戦闘 (敵 3 隻、単縦陣)。ship ids を変えて別編成を作れる。 */
export const battle15 = (shipKe: number[], formation = 1) => ({
  ...dayBattle,
  api_formation: [1, formation, 1],
  api_ship_ke: [...shipKe, ...Array(6 - shipKe.length).fill(-1)],
});
