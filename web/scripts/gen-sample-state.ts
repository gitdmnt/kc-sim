/**
 * src/sampleState.json を @kancolle/data の api_start2 から生成する。
 * `bun run sample` で再生成。poi の redux state (info/const) の必要部分だけを再現する。
 *
 * 注意: start2 には艦娘の回避/対潜/索敵や Lv 依存値が無いため、info.ships の
 * それらの値はサンプル用の概算 (実データではない)。
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const start2 = (await Bun.file(
  resolve(import.meta.dir, "../node_modules/@kancolle/data/api/api_start2.json")
).json()) as any;

const SHIP_NAMES = [
  "睦月", "睦月改二", "如月改二", "吹雪改二", "白雪改", "島風", "雪風改二", "時雨改二", "夕立改二",
  "神通改二", "那珂改二", "阿武隈改二", "長良改", "妙高改二", "羽黒改二", "高雄改", "愛宕改",
  "利根改二", "筑摩改二", "金剛改二丙", "比叡改二丙", "榛名改二", "霧島改二", "長門改二", "陸奥改二",
  "大和改二", "武蔵改二", "赤城改二", "加賀改二", "蒼龍改二", "飛龍改二", "翔鶴改二甲", "瑞鶴改二甲",
  "鳳翔改", "龍驤改二", "伊19改", "伊168改", "速吸改", "秋津洲改", "大淀改", "明石改", "Bismarck drei", "秋月改",
  "Iowa改", "Warspite改", "夕張改二", "五十鈴改二", "由良改二", "鬼怒改二", "古鷹改二", "加古改二",
  "扶桑改二", "山城改二", "伊勢改二", "日向改二", "瑞穂改", "神威改母", "天津風改", "初風改",
  "朝潮改二", "大潮改二", "満潮改二", "荒潮改二", "霰改二", "霞改二", "朝霜改", "清霜改",
];
const EQUIP_NAMES = [
  "12cm単装砲", "10cm連装高角砲", "12.7cm連装砲", "12.7cm連装砲B型改二", "14cm単装砲", "15.5cm三連装砲",
  "20.3cm連装砲", "20.3cm(2号)連装砲", "35.6cm連装砲", "41cm連装砲", "46cm三連装砲", "16inch三連装砲",
  "61cm三連装魚雷", "61cm四連装(酸素)魚雷", "61cm五連装(酸素)魚雷", "九六式艦戦", "零式艦戦21型",
  "零式艦戦52型", "烈風改", "烈風 一一型", "二式艦上偵察機", "12.7cm連装高角砲", "22号対水上電探", "紫電改二", "九九式艦爆", "彗星", "九七式艦攻", "天山", "流星",
  "零式水上偵察機", "零式水上観測機", "瑞雲", "試製晴嵐", "二式艦上偵察機", "彩雲", "13号対空電探",
  "21号対空電探", "32号対水上電探", "22号対水上電探改四(後期調整型)", "三式水中探信儀", "九三式水中聴音機",
  "三式爆雷投射機", "25mm三連装機銃", "25mm連装機銃", "九一式徹甲弾", "三式弾", "応急修理要員",
  "ドラム缶(輸送用)", "大発動艇", "探照灯", "照明弾", "彗星一二型(三一号光電管爆弾搭載機)",
  "零式水上偵察機11型乙", "25mm三連装機銃 集中配備", "15.2cm三連装砲", "Ro.44水上戦闘機", "強風改", "甲標的 甲型",
];

const byName = (list: any[], name: string) => list.find((x) => x.api_name === name);
// 観測ログの敵艦名表示用に、深海棲艦も数隻含める
const ABYSSAL_IDS = [1501, 1502, 1503, 1504, 1505, 1510, 1511, 1528, 1529, 1530];
const abyssals = ABYSSAL_IDS.map((id) => start2.api_mst_ship.find((x: any) => x.api_id === id)).filter(Boolean);
const ships = SHIP_NAMES.map((n) => byName(start2.api_mst_ship, n)).filter(Boolean);
const equips = EQUIP_NAMES.map((n) => byName(start2.api_mst_slotitem, n)).filter(Boolean);
const missing = [
  ...SHIP_NAMES.filter((n) => !byName(start2.api_mst_ship, n)),
  ...EQUIP_NAMES.filter((n) => !byName(start2.api_mst_slotitem, n)),
];
if (missing.length) console.warn("not found (skipped):", missing.join(", "));

const keyed = (list: any[]) => Object.fromEntries(list.map((x) => [x.api_id, x]));
const usedTypes = new Set(equips.flatMap((e) => [e.api_type[2]]));
const usedStypes = new Set([...ships, ...abyssals].map((s) => s.api_stype));

// ---- 所持艦 (info) のサンプル: 第1艦隊 6隻 + 第2艦隊 6隻 ----
const equipIdByName = (n: string) => byName(start2.api_mst_slotitem, n)?.api_id;
const loadouts: Record<string, [string, number, number][]> = {
  大和改二: [["46cm三連装砲", 10, 0], ["46cm三連装砲", 7, 0], ["三式弾", 0, 0], ["22号対水上電探改四(後期調整型)", 0, 0]],
  武蔵改二: [["46cm三連装砲", 0, 0], ["46cm三連装砲", 0, 0], ["九一式徹甲弾", 0, 0], ["22号対水上電探改四(後期調整型)", 0, 0]],
  // 空母: 艦戦は api_type[2]=6 のみ (烈風改 333 は局戦で空母に積めない)
  赤城改二: [["烈風 一一型", 10, 7], ["紫電改二", 4, 7], ["流星", 0, 7], ["彩雲", 6, 7]],
  加賀改二: [["零式艦戦52型", 7, 7], ["烈風 一一型", 0, 7], ["彗星", 0, 5], ["天山", 0, 3]],
  大淀改: [["零式水上偵察機", 4, 0], ["21号対空電探", 2, 0], ["15.5cm三連装砲", 0, 0]],
  島風: [["61cm五連装(酸素)魚雷", 10, 0], ["61cm五連装(酸素)魚雷", 0, 0]],
  時雨改二: [["12.7cm連装砲B型改二", 7, 0], ["三式水中探信儀", 0, 0], ["三式爆雷投射機", 0, 0]],
  雪風改二: [["12.7cm連装砲B型改二", 0, 0], ["三式水中探信儀", 0, 0], ["三式爆雷投射機", 0, 0]],
  夕立改二: [["12.7cm連装砲B型改二", 0, 0], ["三式水中探信儀", 0, 0], ["三式爆雷投射機", 0, 0]],
  速吸改: [["ドラム缶(輸送用)", 0, 0], ["ドラム缶(輸送用)", 0, 0], ["ドラム缶(輸送用)", 0, 0]],
  五十鈴改二: [["14cm単装砲", 0, 0], ["三式水中探信儀", 0, 0], ["三式爆雷投射機", 0, 0]],
  長門改二: [["41cm連装砲", 4, 0], ["41cm連装砲", 4, 0], ["三式弾", 0, 0], ["22号対水上電探改四(後期調整型)", 0, 0]],
  陸奥改二: [["41cm連装砲", 4, 0], ["41cm連装砲", 4, 0], ["九一式徹甲弾", 0, 0], ["22号対水上電探改四(後期調整型)", 0, 0]],
  妙高改二: [["20.3cm連装砲", 4, 0], ["20.3cm連装砲", 4, 0], ["九一式徹甲弾", 0, 0], ["22号対水上電探改四(後期調整型)", 0, 0]],
  羽黒改二: [["20.3cm連装砲", 4, 0], ["20.3cm連装砲", 4, 0], ["九一式徹甲弾", 0, 0], ["零式水上偵察機", 4, 0]],
  神通改二: [["15.5cm三連装砲", 0, 0], ["61cm四連装(酸素)魚雷", 0, 0], ["照明弾", 0, 0]],
  金剛改二丙: [["41cm連装砲", 5, 0], ["41cm連装砲", 0, 0], ["22号対水上電探改四(後期調整型)", 0, 0]],
  // ---- 艦隊ごとの上書き ("名前@艦隊番号") ----
  // 第3艦隊 (1-5 対潜): ソナー + 爆雷投射機
  "時雨改二@2": [["12.7cm連装砲B型改二", 0, 0], ["三式水中探信儀", 0, 0], ["三式爆雷投射機", 0, 0]],
  "雪風改二@2": [["12.7cm連装砲B型改二", 0, 0], ["三式水中探信儀", 0, 0], ["三式爆雷投射機", 0, 0]],
  "夕立改二@2": [["12.7cm連装砲B型改二", 0, 0], ["三式水中探信儀", 0, 0], ["三式爆雷投射機", 0, 0]],
  // 第4艦隊 (2-5 下ルート): CV + CVL + CL + DD×3。索敵 (Cn1) を稼ぐため彩雲/二式艦偵/水偵/電探を積む
  "赤城改二@3": [["烈風 一一型", 0, 7], ["零式艦戦52型", 0, 7], ["流星", 0, 7], ["彩雲", 10, 7]],
  "龍驤改二@3": [["零式艦戦52型", 0, 7], ["零式艦戦21型", 0, 7], ["天山", 0, 3], ["二式艦上偵察機", 10, 7]],
  "神通改二@3": [["零式水上偵察機", 10, 0], ["14cm単装砲", 0, 0], ["22号対水上電探", 10, 0]],
  "時雨改二@3": [["12.7cm連装砲B型改二", 0, 0], ["61cm五連装(酸素)魚雷", 0, 0], ["22号対水上電探", 10, 0]],
  "雪風改二@3": [["12.7cm連装砲B型改二", 0, 0], ["61cm五連装(酸素)魚雷", 0, 0], ["22号対水上電探", 10, 0]],
  "島風@3": [["61cm五連装(酸素)魚雷", 0, 0], ["61cm五連装(酸素)魚雷", 0, 0]],
  // 第5艦隊 (5-5 中央): 高速戦艦2 + CV + 防空駆逐 + 駆逐 + 軽巡(索敵要員)
  "金剛改二丙@4": [["41cm連装砲", 4, 0], ["41cm連装砲", 4, 0], ["32号対水上電探", 4, 0], ["零式水上観測機", 4, 0]],
  "榛名改二@4": [["41cm連装砲", 4, 0], ["41cm連装砲", 4, 0], ["32号対水上電探", 4, 0], ["零式水上偵察機", 4, 0]],
  "翔鶴改二甲@4": [["烈風 一一型", 0, 7], ["零式艦戦52型", 0, 7], ["流星", 0, 7], ["彩雲", 6, 7]],
  "秋月改@4": [["10cm連装高角砲", 0, 0], ["10cm連装高角砲", 0, 0], ["13号対空電探", 0, 0]],
  "島風@4": [["12.7cm連装砲B型改二", 0, 0], ["61cm五連装(酸素)魚雷", 0, 0]],
  "大淀改@4": [["零式水上偵察機", 4, 0], ["零式水上観測機", 4, 0], ["32号対水上電探", 4, 0], ["15.5cm三連装砲", 0, 0]],
};

/**
 * 装備可否 (start2 の api_mst_stype[].api_equip_type と api_mst_equip_ship の艦個別上書き)。
 * 艦固有のID限定 (特定の艦しか積めない装備) や補強増設は判定しない。
 */
const equipShipOverride = new Map<number, Set<number>>(
  (Array.isArray(start2.api_mst_equip_ship) ? start2.api_mst_equip_ship : Object.values(start2.api_mst_equip_ship)).map((e: any) => [e.api_ship_id, new Set<number>(e.api_equip_type)])
);
const canEquip = (ship: any, equip: any): boolean => {
  const t2: number = equip.api_type[2];
  const override = equipShipOverride.get(ship.api_id);
  if (override) return override.has(t2);
  const stype = start2.api_mst_stype.find((x: any) => x.api_id === ship.api_stype);
  return stype?.api_equip_type?.[String(t2)] === 1;
};
const fleetShipNames = [
  ["大和改二", "武蔵改二", "赤城改二", "加賀改二", "大淀改", "島風"],
  ["時雨改二", "雪風改二", "速吸改", "金剛改二丙", "睦月改二", "夕立改二"],
  // 対潜編成 (1-5 向け): 軽巡 + 駆逐3 (ソナー + 爆雷投射機)
  ["五十鈴改二", "時雨改二", "雪風改二", "夕立改二"],
  // 2-5 下ルート (定番): CV + CVL + CL + DD×3
  ["赤城改二", "龍驤改二", "神通改二", "時雨改二", "雪風改二", "島風"],
  // 5-5 中央 (定番寄り): 高速戦艦2 + CV + 防空駆逐 + 駆逐 + 軽巡
  ["金剛改二丙", "榛名改二", "翔鶴改二甲", "秋月改", "島風", "大淀改"],
];

const equipInst: Record<number, any> = {};
const shipInst: Record<number, any> = {};
const fleets: any[] = [];
let nextEquip = 5000;
let nextShip = 100;
for (const [fi, names] of fleetShipNames.entries()) {
  const ids: number[] = [];
  for (const name of names) {
    const m = byName(start2.api_mst_ship, name);
    if (!m) continue;
    const slotIds: number[] = [];
    const onslot: number[] = [];
    const lo = loadouts[`${name}@${fi}`] ?? loadouts[name] ?? [];
    if (lo.length > m.api_slot_num) throw new Error(`${name}: 装備 ${lo.length} 個 > スロット ${m.api_slot_num}`);
    lo.forEach(([eName, lv, alv], i) => {
      const mid = equipIdByName(eName);
      if (!mid) throw new Error(`${name}: 装備 "${eName}" が start2 に無い`);
      const em = start2.api_mst_slotitem.find((x: any) => x.api_id === mid);
      if (!canEquip(m, em)) throw new Error(`${name}(stype ${m.api_stype}) は ${eName}(type ${em.api_type[2]}) を装備できない`);
      const iid = nextEquip++;
      equipInst[iid] = { api_id: iid, api_slotitem_id: mid, api_level: lv, api_alv: alv, api_locked: 0 };
      slotIds.push(iid);
      onslot.push(m.api_maxeq?.[i] ?? 0);
    });
    while (slotIds.length < m.api_slot_num) {
      slotIds.push(-1);
      onslot.push(m.api_maxeq?.[slotIds.length - 1] ?? 0);
    }
    const lv = 99;
    // 装備のマスター値を合計 (表示値は装備込み)。素の回避・対潜・索敵は start2 に無いので概算
    const eq = { houg: 0, raig: 0, tyku: 0, souk: 0, houk: 0, tais: 0, saku: 0 };
    for (const sid of slotIds) {
      const mid = equipInst[sid]?.api_slotitem_id;
      const em = start2.api_mst_slotitem.find((x: any) => x.api_id === mid);
      if (!em) continue;
      for (const k of Object.keys(eq) as (keyof typeof eq)[]) eq[k] += em[`api_${k}`] ?? 0;
    }
    // Lv99 の艦を想定。火力・雷装・対空・装甲は master の最大値 (近代化満了, api_xxx[1]) を使う。
    // 回避・対潜・索敵は start2 に無いので、艦種ごとの Lv99 の概算値 (装備なし) を使う。実データではない。
    const NAKED_LV99: Record<number, { eva: number; asw: number; los: number }> = {
      1: { eva: 60, asw: 60, los: 30 }, 2: { eva: 85, asw: 70, los: 22 }, 3: { eva: 60, asw: 70, los: 32 },
      4: { eva: 70, asw: 0, los: 40 }, 5: { eva: 40, asw: 0, los: 40 }, 6: { eva: 40, asw: 0, los: 55 },
      7: { eva: 50, asw: 40, los: 40 }, 8: { eva: 40, asw: 0, los: 25 }, 9: { eva: 35, asw: 0, los: 25 },
      10: { eva: 38, asw: 0, los: 45 }, 11: { eva: 40, asw: 0, los: 40 }, 12: { eva: 35, asw: 0, los: 25 },
      18: { eva: 40, asw: 0, los: 40 }, 21: { eva: 50, asw: 60, los: 45 }, 20: { eva: 30, asw: 30, los: 20 },
    };
    const nk = NAKED_LV99[m.api_stype] ?? { eva: 40, asw: 0, los: 30 };
    const iid = nextShip++;
    shipInst[iid] = {
      api_id: iid, api_ship_id: m.api_id, api_lv: lv, api_cond: 49 + (iid % 5),
      api_maxhp: m.api_taik[1], api_nowhp: m.api_taik[1],
      api_karyoku: [m.api_houg[1] + eq.houg, m.api_houg[1]], api_raisou: [m.api_raig[1] + eq.raig, m.api_raig[1]],
      api_taiku: [m.api_tyku[1] + eq.tyku, m.api_tyku[1]], api_soukou: [m.api_souk[1] + eq.souk, m.api_souk[1]],
      api_kaihi: [nk.eva + eq.houk, nk.eva + 20], api_taisen: [nk.asw + eq.tais, nk.asw + 30],
      api_sakuteki: [nk.los + eq.saku, nk.los + 20], api_lucky: [Math.min(m.api_luck[1], m.api_luck[0] + 10), m.api_luck[1]],
      api_leng: m.api_leng, api_soku: m.api_soku, api_slotnum: m.api_slot_num,
      api_slot: slotIds.slice(0, m.api_slot_num), api_onslot: onslot.slice(0, m.api_slot_num),
      api_slot_ex: -1, api_kyouka: [0, 0, 0, 0, 3, 2, 0],
    };
    ids.push(iid);
  }
  while (ids.length < 6) ids.push(-1);
  fleets.push({ api_id: fi + 1, api_name: `第${fi + 1}艦隊`, api_ship: ids });
}
for (let i = fleets.length; i < 4; i++) {
  fleets.push({ api_id: i + 1, api_name: `第${i + 1}艦隊`, api_ship: [-1, -1, -1, -1, -1, -1] });
}

const state = {
  info: { basic: { api_level: 120, api_nickname: "sample" }, fleets, ships: shipInst, equips: equipInst },
  const: {
    $ships: keyed([...ships, ...abyssals]),
    $equips: keyed(equips),
    $shipTypes: keyed(start2.api_mst_stype.filter((s: any) => usedStypes.has(s.api_id))),
    $equipTypes: keyed(start2.api_mst_slotitem_equiptype.filter((t: any) => usedTypes.has(t.api_id))),
    $mapareas: keyed(start2.api_mst_maparea.slice(0, 7)),
    $maps: keyed(start2.api_mst_mapinfo.filter((m: any) => m.api_maparea_id <= 3)),
  },
};

const out = resolve(import.meta.dir, "../src/sampleState.json");
writeFileSync(out, JSON.stringify(state, null, 1) + "\n");
console.log(`wrote ${out}: ${ships.length} ships (+${abyssals.length} abyssal), ${equips.length} equips, ${Object.keys(shipInst).length} owned ships`);
