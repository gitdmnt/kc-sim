import { describe, expect, test } from "bun:test";
import type { MasterData } from "@shared/fleet/types";
import { computeFitBonus, fitEquipOf, fitShipOf, fitToEquipmentStats, shipBaseId, shipNationality } from "@shared/sim/fit";
import type { FitEntry } from "@shared/sim/fit";

// Real data: api_start2 (Tibowl/api_start2) rows for the remodel families of the test ships and the test equipment, and
// every ElectronicObserverEN/Data FitBonuses.json entry that touches that equipment (id = index in the file).
const master: MasterData = {
  ships: {
    16: { api_id: 16, api_name: "潮", api_stype: 2, api_ctype: 1, api_sort_id: 14201, api_aftershipid: "233" },
    59: { api_id: 59, api_name: "古鷹", api_stype: 5, api_ctype: 7, api_sort_id: 8011, api_aftershipid: "262" },
    61: { api_id: 61, api_name: "青葉", api_stype: 5, api_ctype: 13, api_sort_id: 8031, api_aftershipid: "264" },
    70: { api_id: 70, api_name: "最上", api_stype: 5, api_ctype: 9, api_sort_id: 9011, api_aftershipid: "73" },
    73: { api_id: 73, api_name: "最上改", api_stype: 6, api_ctype: 9, api_sort_id: 9012, api_aftershipid: "501" },
    79: { api_id: 79, api_name: "榛名", api_stype: 8, api_ctype: 6, api_sort_id: 1031, api_aftershipid: "211" },
    99: { api_id: 99, api_name: "球磨", api_stype: 3, api_ctype: 4, api_sort_id: 10031, api_aftershipid: "215" },
    115: { api_id: 115, api_name: "夕張", api_stype: 3, api_ctype: 34, api_sort_id: 10171, api_aftershipid: "293" },
    133: { api_id: 133, api_name: "夕雲", api_stype: 2, api_ctype: 38, api_sort_id: 16201, api_aftershipid: "302" },
    151: { api_id: 151, api_name: "榛名改二", api_stype: 8, api_ctype: 6, api_sort_id: 1036, api_aftershipid: "593" },
    211: { api_id: 211, api_name: "榛名改", api_stype: 8, api_ctype: 6, api_sort_id: 1032, api_aftershipid: "151" },
    215: { api_id: 215, api_name: "球磨改", api_stype: 3, api_ctype: 4, api_sort_id: 10032, api_aftershipid: "652" },
    233: { api_id: 233, api_name: "潮改", api_stype: 2, api_ctype: 1, api_sort_id: 14202, api_aftershipid: "407" },
    262: { api_id: 262, api_name: "古鷹改", api_stype: 5, api_ctype: 7, api_sort_id: 8012, api_aftershipid: "416" },
    264: { api_id: 264, api_name: "青葉改", api_stype: 5, api_ctype: 13, api_sort_id: 8032, api_aftershipid: "0" },
    293: { api_id: 293, api_name: "夕張改", api_stype: 3, api_ctype: 34, api_sort_id: 10172, api_aftershipid: "622" },
    302: { api_id: 302, api_name: "夕雲改", api_stype: 2, api_ctype: 38, api_sort_id: 16202, api_aftershipid: "542" },
    349: { api_id: 349, api_name: "風雲改", api_stype: 2, api_ctype: 38, api_sort_id: 16222, api_aftershipid: "564" },
    407: { api_id: 407, api_name: "潮改二", api_stype: 2, api_ctype: 1, api_sort_id: 14206, api_aftershipid: "0" },
    416: { api_id: 416, api_name: "古鷹改二", api_stype: 5, api_ctype: 7, api_sort_id: 8016, api_aftershipid: "0" },
    453: { api_id: 453, api_name: "風雲", api_stype: 2, api_ctype: 38, api_sort_id: 16221, api_aftershipid: "349" },
    501: { api_id: 501, api_name: "最上改二", api_stype: 6, api_ctype: 9, api_sort_id: 9016, api_aftershipid: "506" },
    506: { api_id: 506, api_name: "最上改二特", api_stype: 6, api_ctype: 9, api_sort_id: 9017, api_aftershipid: "501" },
    514: { api_id: 514, api_name: "Sheffield", api_stype: 3, api_ctype: 108, api_sort_id: 33431, api_aftershipid: "705" },
    542: { api_id: 542, api_name: "夕雲改二", api_stype: 2, api_ctype: 38, api_sort_id: 16206, api_aftershipid: "0" },
    562: { api_id: 562, api_name: "Johnston", api_stype: 2, api_ctype: 91, api_sort_id: 32551, api_aftershipid: "689" },
    564: { api_id: 564, api_name: "風雲改二", api_stype: 2, api_ctype: 38, api_sort_id: 16226, api_aftershipid: "0" },
    572: { api_id: 572, api_name: "Rodney", api_stype: 9, api_ctype: 88, api_sort_id: 33061, api_aftershipid: "577" },
    577: { api_id: 577, api_name: "Rodney改", api_stype: 9, api_ctype: 88, api_sort_id: 33062, api_aftershipid: "0" },
    593: { api_id: 593, api_name: "榛名改二乙", api_stype: 8, api_ctype: 6, api_sort_id: 1037, api_aftershipid: "954" },
    622: { api_id: 622, api_name: "夕張改二", api_stype: 3, api_ctype: 34, api_sort_id: 10176, api_aftershipid: "623" },
    623: { api_id: 623, api_name: "夕張改二特", api_stype: 3, api_ctype: 34, api_sort_id: 10177, api_aftershipid: "624" },
    624: { api_id: 624, api_name: "夕張改二丁", api_stype: 3, api_ctype: 34, api_sort_id: 10178, api_aftershipid: "622" },
    652: { api_id: 652, api_name: "球磨改二", api_stype: 3, api_ctype: 4, api_sort_id: 10036, api_aftershipid: "657" },
    657: { api_id: 657, api_name: "球磨改二丁", api_stype: 3, api_ctype: 4, api_sort_id: 10037, api_aftershipid: "652" },
    689: { api_id: 689, api_name: "Johnston改", api_stype: 2, api_ctype: 91, api_sort_id: 32552, api_aftershipid: "0" },
    705: { api_id: 705, api_name: "Sheffield改", api_stype: 3, api_ctype: 108, api_sort_id: 33432, api_aftershipid: "0" },
    954: { api_id: 954, api_name: "榛名改二丙", api_stype: 8, api_ctype: 6, api_sort_id: 1038, api_aftershipid: "593" },
  },
  equips: {
    267: { api_id: 267, api_name: "12.7cm連装砲D型改二", api_type: [1,1,1,1,0], api_saku: 0, api_tyku: 4, api_houm: 2 },
    366: { api_id: 366, api_name: "12.7cm連装砲D型改三", api_type: [1,1,1,1,0], api_saku: 0, api_tyku: 4, api_houm: 2 },
    29: { api_id: 29, api_name: "33号対水上電探", api_type: [5,8,12,11,0], api_saku: 7, api_tyku: 0, api_houm: 5 },
    517: { api_id: 517, api_name: "逆探(E27)+22号対水上電探改四(後期調整型)", api_type: [5,8,12,11,0], api_saku: 8, api_tyku: 0, api_houm: 9 },
    503: { api_id: 503, api_name: "35.6cm連装砲改四", api_type: [1,1,3,3,0], api_saku: 0, api_tyku: 5, api_houm: 4 },
    307: { api_id: 307, api_name: "GFCS Mk.37", api_type: [5,8,12,11,0], api_saku: 6, api_tyku: 7, api_houm: 9 },
    510: { api_id: 510, api_name: "Walrus", api_type: [5,7,10,50,49], api_saku: 4, api_tyku: 0, api_houm: 1 },
    329: { api_id: 329, api_name: "35.6cm連装砲改二", api_type: [1,1,3,3,0], api_saku: 0, api_tyku: 5, api_houm: 5 },
    308: { api_id: 308, api_name: "5inch単装砲 Mk.30改+GFCS Mk.37", api_type: [1,1,1,16,0], api_saku: 3, api_tyku: 11, api_houm: 6 },
    50: { api_id: 50, api_name: "20.3cm(3号)連装砲", api_type: [1,1,2,2,0], api_saku: 0, api_tyku: 4, api_houm: 1 },
    90: { api_id: 90, api_name: "20.3cm(2号)連装砲", api_type: [1,1,2,2,0], api_saku: 0, api_tyku: 3, api_houm: 1 },
    310: { api_id: 310, api_name: "14cm連装砲改", api_type: [1,1,2,2,0], api_saku: 0, api_tyku: 0, api_houm: 3 },
    410: { api_id: 410, api_name: "21号対空電探改二", api_type: [5,8,13,11,0], api_saku: 7, api_tyku: 7, api_houm: 4 },
    30: { api_id: 30, api_name: "21号対空電探", api_type: [5,8,13,11,0], api_saku: 4, api_tyku: 4, api_houm: 2 },
    380: { api_id: 380, api_name: "12.7cm連装高角砲改二", api_type: [1,1,1,16,0], api_saku: 0, api_tyku: 6, api_houm: 1 },
    131: { api_id: 131, api_name: "25mm三連装機銃 集中配備", api_type: [4,6,21,15,0], api_saku: 0, api_tyku: 9, api_houm: 0 },
  },
};
const ENTRIES: FitEntry[] = [
  { id: 1, ids: null, types: [10], bonuses: [{shipX: [662,663,668],num: 1,bonus: {houg: 2,kaih: 1,tais: 3}},{shipX: [501,502,506,507],num: 1,bonus: {houg: 2}}] }, // types 10
  { id: 3, ids: null, types: [12,13], bonuses: [{shipX: [569,648,951,961],num: 1,bonusAR: {houg: 1,tyku: 2,kaih: 3}},{shipX: [955,956,960,981],num: 1,bonusAR: {tyku: 2,kaih: 1}}] }, // types 12,13
  { id: 15, ids: [30,410], types: null, bonuses: [{shipX: [73,501,502,506,507],num: 1,bonus: {tyku: 3,kaih: 2,saku: 2}},{shipClass: [54],num: 1,bonus: {tyku: 3,kaih: 2,saku: 2}}] }, // 21号対空電探 / 21号対空電探改二
  { id: 16, ids: [410], types: null, bonuses: [{shipX: [73,501,502,506,507],num: 1,bonus: {houg: 1,tyku: 2,souk: 1,kaih: 2}},{shipClass: [54],num: 1,bonus: {houg: 1,tyku: 2,souk: 1,kaih: 2}},{shipX: [968],num: 1,bonus: {houg: 1,tyku: 1,kaih: 1}}] }, // 21号対空電探改二
  { id: 18, ids: [39,40,49,131], types: null, bonuses: [{shipX: [662,663],bonus: {tyku: 2,kaih: 1}},{shipX: [668],bonus: {tyku: 3,kaih: 2}},{shipClass: [56],bonus: {houg: 1,tyku: 2,kaih: 2}},{shipClass: [56],num: 1,bonusAR: {tyku: 2,kaih: 2}},{shipX: [979],bonus: {tyku: 2,kaih: 3}}] }, // 25mm連装機銃 / 25mm三連装機銃 / 25mm単装機銃 / 25mm三連装機銃 集中配備
  { id: 22, ids: [131], types: null, bonuses: [{shipX: [979],level: 10,bonus: {tyku: 2}}] }, // 25mm三連装機銃 集中配備
  { id: 26, ids: [50], types: null, bonuses: [{shipClass: [7,13],bonus: {houg: 1}},{shipClass: [7,13],num: 1,bonusSR: {houg: 1,raig: 1,kaih: 1}},{shipClass: [7,13],requires: [90],num: 1,bonusSR: {houg: -1,raig: -1,kaih: -1}},{shipClass: [8,9,29,31],bonus: {houg: 2,kaih: 1}},{shipClass: [8,9,29,31],num: 1,bonusSR: {houg: 3,raig: 2,kaih: 2}},{shipClass: [9,31],requires: [50],num: 2,bonus: {houg: 1}},{shipX: [501,502,506,507],bonus: {houg: 1}},{shipX: [501,506],num: 1,bonusSR: {houg: 1,kaih: 1}},{shipX: [501,502,506,507],requires: [30,410],num: 1,bonus: {houg: 1,tyku: 3,kaih: 2}},{shipX: [501,502,506,507],requires: [410],num: 1,bonus: {houg: 2}}] }, // 20.3cm(3号)連装砲
  { id: 40, ids: [90], types: null, bonuses: [{shipX: [142],bonus: {houg: 2,kaih: 1}},{shipX: [295,416,417],bonus: {houg: 1}},{shipX: [264],bonus: {houg: 1,tyku: 1}},{shipClass: [7,8,9,13,29,31],bonus: {houg: 1}},{shipS: [61],num: 1,bonusAR: {tyku: 5,kaih: 2}},{shipClass: [7,13],num: 1,bonusSR: {houg: 3,raig: 2,kaih: 2}},{shipX: [501,502,506,507],bonus: {houg: 1}}] }, // 20.3cm(2号)連装砲
  { id: 79, ids: [267], types: null, bonuses: [{shipClass: [22,38],bonus: {houg: 2,kaih: 1}},{shipClass: [30],bonus: {houg: 1,kaih: 1}},{shipX: [566,567,568,656,670,915,951],num: 1,bonus: {houg: 1}},{shipX: [542,543,563,564,569,578,981],bonus: {houg: 1}},{shipX: [229,542,543,563,564,569,578,648,649,955,956,960,981],num: 1,bonusSR: {houg: 1,raig: 3,kaih: 2}},{shipClass: [38],num: 1,bonusSR: {houg: 2,raig: 3,kaih: 1}},{shipX: [955,956],num: 1,bonusSR: {raig: -1}},{shipX: [960],num: 1,bonusSR: {raig: -2}},{shipX: [648,649,955,956,960,961],bonus: {houg: 2}},{shipX: [648],num: 1,bonusSR: {houg: 2,raig: 3,kaih: 1}}] }, // 12.7cm連装砲D型改二
  { id: 80, ids: [366], types: null, bonuses: [{shipClass: [22,38],bonus: {houg: 2,kaih: 1}},{shipClass: [30],bonus: {houg: 1,kaih: 1}},{shipX: [566,567,568,656,670,915,951],num: 1,bonus: {houg: 1,tyku: 2}},{shipX: [566,567,568,656,670,915,951],num: 2,bonus: {houg: 1,tyku: 2}},{shipX: [542,543,563,564,569,578,981],bonus: {houg: 1}},{shipX: [648,649,955,956,960,961],bonus: {houg: 2}},{shipX: [229,542,543,563,564,569,578,648,649,955,956,960,961,981],num: 1,bonus: {houg: 1,tyku: 3,houm: 1}},{shipX: [229,542,543,563,564,569,578,648,649,955,956,960,961,981],num: 1,bonusSR: {houg: 2,raig: 4,kaih: 2,houm: 2}},{shipX: [960],num: 1,bonusSR: {houg: 1,raig: -1}},{shipX: [229,542,543,563,564,569,578,648,649,955,956,960,961,981],num: 1,bonusAR: {houg: 1,tyku: 5,kaih: 3,houm: 1}},{shipX: [229,542,543,563,564,569,578,648,649,955,956,960,961,981],num: 2,bonus: {houg: 2,tyku: 2}},{shipX: [955],num: 2,bonus: {houg: 1}},{shipX: [229,542,543,563,564,569,578,648,649,955,956,960,961,981],level: 5,bonus: {houm: 1}},{shipX: [229,542,543,563,564,569,578,648,649,955,956,960,961,981],level: 8,bonus: {houg: 1}},{shipX: [229,542,543,563,564,569,578,648,649,955,956,960,961,981],level: 10,bonus: {houm: 1}},{shipX: [569,648],num: 1,bonus: {houg: 1,tyku: 2}}] }, // 12.7cm連装砲D型改三
  { id: 81, ids: [267,366], types: null, bonuses: [{shipX: [648,961],requires: [129,412],num: 1,bonus: {houg: 2,tyku: 2,kaih: 3}},{shipX: [648,961],requires: [74],num: 1,bonus: {houg: 3,kaih: -3}}] }, // 12.7cm連装砲D型改二 / 12.7cm連装砲D型改三
  { id: 106, ids: [307], types: null, bonuses: [{shipNationality: [4],bonus: {houg: 1,tyku: 1,kaih: 1}}] }, // GFCS Mk.37
  { id: 107, ids: [308], types: null, bonuses: [{shipNationality: [4],bonus: {houg: 1,tyku: 1,kaih: 1}},{shipType: [2],bonus: {houg: 1}},{shipType: [1],bonus: {tyku: 1,kaih: 1}},{shipX: [651,656],bonus: {houg: 1,tyku: 1,kaih: 1}}] }, // 5inch単装砲 Mk.30改+GFCS Mk.37
  { id: 108, ids: [310,518], types: null, bonuses: [{shipClass: [34],bonus: {houg: 2,tyku: 1,kaih: 1}},{shipClass: [34],level: 10,bonus: {houg: 2}},{shipClass: [56],bonus: {houg: 2,kaih: 1}},{shipClass: [56],level: 10,bonus: {houg: 2,kaih: 2}},{shipClass: [90],bonus: {houg: 3,raig: 2,tyku: 1,kaih: 1}},{shipClass: [90],level: 10,bonus: {houg: 1,raig: 1}},{shipX: [622,623,624],bonus: {houg: 2,kaih: 1,tais: 1}},{shipX: [622,623,624],num: 1,bonusSR: {houg: 3,raig: 2,kaih: 2}},{shipX: [622,623,624],level: 7,bonus: {houg: 1,raig: 1}}] }, // 14cm連装砲改 / 14cm連装砲改二
  { id: 124, ids: [329], types: null, bonuses: [{shipS: [78,79,85,86],bonus: {houg: 1,kaih: 1}},{shipX: [209,210,211,212],bonus: {houg: 1}},{shipX: [149,150,151,152],bonus: {houg: 2,tyku: 1}},{shipX: [591,592,954],bonus: {houg: 3,raig: 2,tyku: 1}},{shipX: [593],bonus: {houg: 2,raig: 1,tyku: 3}},{shipX: [694],bonus: {houg: 4,raig: 1,tyku: 1}},{shipS: [26,27,77,87],bonus: {houg: 1}}] }, // 35.6cm連装砲改二
  { id: 159, ids: [380], types: null, bonuses: [{shipType: [16,21],bonus: {houg: 1,tyku: 2}},{shipClass: [101],bonus: {houg: 1,tyku: 2}},{shipClass: [101],num: 1,bonus: {houg: 2,tyku: 2}},{shipS: [22,23,56,113],bonus: {houg: 2}},{shipS: [24,25],bonus: {houg: 3,tyku: 2}},{shipS: [22,23,56,113,115],bonus: {tais: 1}},{shipS: [51,52,115],bonus: {houg: 1}},{shipX: [488],bonus: {tyku: 4}},{shipX: [141,160,220,487],bonus: {tyku: 3}},{shipX: [22,23,56,113,219,224,289],bonus: {tyku: 2}},{shipX: [651,656],bonus: {houg: 3,tyku: 3}},{shipX: [407,665],bonus: {houg: 2,tyku: 2}},{shipX: [407,665],num: 1,bonus: {houg: 1,tyku: 1,kaih: 2}},{shipX: [141,160,487,488],bonus: {tais: 1}},{shipX: [477,478,624],bonus: {tais: 2}},{shipX: [477,478,622,624],bonus: {tyku: 2}},{shipX: [652,657],bonus: {houg: 3}},{shipX: [146,547],num: 1,bonus: {houg: 2}},{shipX: [146,547,652,657],num: 1,bonus: {tyku: 2}},{shipType: [3,4,16,21],num: 1,bonusSR: {houg: 2,kaih: 1}},{shipClass: [101],num: 1,bonusSR: {houg: 4,kaih: 3}},{shipX: [118,119,141,160,487,488,651,656],num: 1,bonusSR: {houg: 1,kaih: 2}},{shipX: [146,547,652,657],num: 1,bonusSR: {houg: 1,kaih: 3}},{shipX: [407,665],num: 1,bonusSR: {houg: 2,kaih: 1}},{shipX: [407,665],requiresType: [21],requiresNumType: 1,num: 1,bonus: {houg: 1,tyku: 2,kaih: 1}}] }, // 12.7cm連装高角砲改二
  { id: 249, ids: [503], types: null, bonuses: [{shipX: [593],bonus: {houg: 4,tyku: 4,houm: 2}},{shipX: [954],bonus: {houg: 4,tyku: 3,houm: 2}},{shipX: [151],bonus: {houg: 2,tyku: 2,houm: 1}},{shipX: [591,592],bonus: {houg: 3,tyku: 1,houm: 1}},{shipX: [149],bonus: {houg: 2,tyku: 1}},{shipX: [150,152],bonus: {houg: 2}},{shipX: [694],bonus: {houg: 4,tyku: 1,houm: 1}},{shipX: [593,694,954],level: 1,bonus: {houg: 1}},{shipX: [593,954],level: 2,bonus: {tyku: 1}},{shipX: [593,954],level: 4,bonus: {houm: 1}},{shipX: [593,694,954],level: 6,bonus: {houg: 1}},{shipX: [593,694,954],level: 8,bonus: {tyku: 1}},{shipX: [593,694,954],level: 10,bonus: {houm: 1}},{shipX: [151,591,592,694],level: 2,bonus: {houg: 1}},{shipX: [151,591,592],level: 4,bonus: {tyku: 1}},{shipX: [151,591,592],level: 6,bonus: {houm: 1}},{shipX: [151,591,592],level: 8,bonus: {houg: 1}},{shipX: [151,591,592],level: 10,bonus: {houm: 1}},{shipX: [149,150,152,694],level: 4,bonus: {houm: 1}},{shipX: [149,150,152],level: 7,bonus: {houg: 1}},{shipX: [149,150,152],level: 10,bonus: {tyku: 1}},{shipX: [954],num: 1,bonusSR: {houg: 3,kaih: 2,houm: 3}},{shipX: [151,591,592,593,694],num: 1,bonusSR: {houg: 2,kaih: 1,houm: 2}},{shipX: [591,592,593,694,954],requires: [174],num: 1,bonus: {raig: 4}},{shipX: [591,592,593,694,954],requires: [174],requiresLevel: 6,num: 1,bonus: {raig: 1}},{shipX: [591,592,593,694,954],requires: [174],requiresLevel: 8,num: 1,bonus: {houm: 1}},{shipX: [591,592,593,694,954],requires: [174],requiresLevel: 10,num: 1,bonus: {houg: 1}},{shipX: [591,592,593,694,954],num: 1,bonusAccR: {houg: 2,kaih: 2,houm: 2}},{shipX: [591],num: 1,bonusAccR: {houg: 1}},{shipX: [954],num: 1,bonusAccR: {houg: 2}}] }, // 35.6cm連装砲改四
  { id: 254, ids: [510], types: null, bonuses: [{shipNationality: [5],bonus: {houg: 2,kaih: 2,tais: 3,saku: 2}},{shipClass: [88],bonus: {saku: 3,houm: 2}},{shipClass: [88],num: 1,bonus: {houg: 4,kaih: 2}}] }, // Walrus
  { id: 256, ids: [517], types: null, bonuses: [{shipClass: [1,5,10,12,18,22,23,28,30,38,54,66,101,74,77,85,104,117],num: 1,bonus: {kaih: 1,saku: 1,houm: 1}},{shipClass: [38],num: 1,bonus: {houg: 1,houm: 1}},{shipX: [960],num: 1,bonus: {houg: 2,kaih: 3,saku: 2,houm: 1}},{shipX: [147,235,407,419,464,470,578,656,955,961,975],num: 1,bonus: {houg: 1,kaih: 2,saku: 1,houm: 1}},{shipX: [981],num: 1,bonus: {houg: 1,kaih: 1,houm: 1}},{requires: [267,366],requiresLevel: 3,num: 1,bonus: {houg: 1,houm: 1}},{shipClass: [38],requires: [267,366],requiresLevel: 3,num: 1,bonus: {houg: 1,houm: 1}},{requires: [450],requiresLevel: 4,num: 1,bonus: {houg: 1,tyku: 4,kaih: 3,houm: 1}},{level: 7,num: 1,bonus: {houm: 1}},{level: 8,num: 1,bonus: {kaih: 1}},{level: 9,num: 1,bonus: {houg: 1}},{level: 10,num: 1,bonus: {houm: 1}}] }, // 逆探(E27)+22号対水上電探改四(後期調整型)
];

/** `[equipment id, improvement]` を艦に載せたときの装備ボーナス */
const fit = (shipId: number, equips: [number, number?][], entries = ENTRIES) =>
  computeFitBonus(
    fitShipOf(shipId, master),
    equips.map(([masterId, improvement = 0]) => fitEquipOf({ masterId, improvement }, master)),
    entries
  );

describe("computeFitBonus with real FitBonuses.json entries", () => {
  // ElectronicObserverCoreTests/FitBonus/{Gun,Radar,Seaplane}FitBonusTest.cs expectations
  test.each([
    ["夕張改二特 + 14cm連装砲改★7 (level stages add up)", 623, [[310, 7]], { houg: 5, raig: 1, tyku: 1, tais: 1, kaih: 2 }],
    ["榛名改二乙 + 35.6cm連装砲改四", 593, [[503]], { houg: 4, tyku: 4, houm: 2 }],
    ["… + GFCS Mk.37 (surface and accuracy radar)", 593, [[503], [307]], { houg: 8, tyku: 4, houm: 6, kaih: 3 }],
    ["… + 33号対水上電探 (surface radar only)", 593, [[503], [29]], { houg: 6, tyku: 4, houm: 4, kaih: 1 }],
    ["風雲改二 + E27+22号改四", 564, [[517]], { houg: 1, houm: 2, kaih: 1, saku: 1 }],
    ["… + D型改二", 564, [[517], [267]], { houg: 7, raig: 6, houm: 2, kaih: 5, saku: 1 }],
    ["… + D型改二★3 (requires with requiresLevel)", 564, [[517], [267, 3]], { houg: 9, raig: 6, houm: 4, kaih: 5, saku: 1 }],
    ["… + D型改二★3 + D型改三★4", 564, [[517], [267, 3], [366, 4]], { houg: 15, raig: 10, tyku: 3, houm: 7, kaih: 8, saku: 1 }],
    ["Sheffield改 + Walrus (British)", 705, [[510]], { houg: 2, tais: 3, saku: 2, kaih: 2 }],
    ["Rodney改 + Walrus (Nelson class)", 577, [[510]], { houg: 6, tais: 3, houm: 2, saku: 5, kaih: 4 }],
    ["球磨改 + Walrus (none)", 215, [[510]], {}],
  ] as [string, number, [number, number?][], object][])("%s", (_, ship, equips, expected) => {
    expect(fit(ship, equips)).toEqual({ bonus: expected, unresolved: 0 });
  });

  test("夕雲改二 + 12.7cm連装砲D型改二 matches the wiki (per gun +3/+1, surface radar synergy once +3/+6/+3)", () => {
    // wikiwiki.jp/kancolle/12.7cm連装砲D型改二 装備ボーナス
    expect(fit(542, [[267]]).bonus).toEqual({ houg: 3, kaih: 1 });
    expect(fit(542, [[267], [267]]).bonus).toEqual({ houg: 6, kaih: 2 });
    expect(fit(542, [[267], [29]]).bonus).toEqual({ houg: 6, raig: 6, kaih: 4 });
    expect(fit(542, [[267], [267], [29]]).bonus).toEqual({ houg: 9, raig: 6, kaih: 5 });
  });

  test("最上改二 + 20.3cm(3号) with 21号対空電探改二 gets both radar synergies (wiki)", () => {
    // wikiwiki.jp/kancolle/20.3cm(3号)連装砲: 単体 +3/回避+1、水上電探 +4/雷+2/回避+3、21号対空電探改二 +3/対空+3/回避+2
    expect(fit(501, [[50]]).bonus).toEqual({ houg: 3, kaih: 1 });
    const radarOnly = fit(501, [[410]]).bonus;
    const both = fit(501, [[50], [410]]).bonus;
    const delta = Object.entries(both)
      .map(([k, v]) => [k, v! - (radarOnly[k as keyof typeof radarOnly] ?? 0)] as const)
      .filter(([, v]) => v !== 0);
    expect(Object.fromEntries(delta)).toEqual({ houg: 3 + 4 + 3, raig: 2, tyku: 3, kaih: 1 + 3 + 2 });
  });

  test("shipS matches every form of a remodel line", () => {
    // 35.6cm連装砲改二: shipS [78, 79, 85, 86] (金剛型) for every form, shipX 151 only for 榛名改二
    expect(fit(79, [[329]]).bonus).toEqual({ houg: 1, kaih: 1 });
    expect(fit(151, [[329]]).bonus).toEqual({ houg: 3, tyku: 1, kaih: 1 });
    // 20.3cm(2号): shipS [61] (青葉) bonusAR 対空+5 回避+2, with an air radar only
    expect(fit(61, [[90], [30]]).bonus).toEqual({ houg: 1, tyku: 5, kaih: 2 });
    expect(fit(264, [[90]]).bonus).toEqual({ houg: 2, tyku: 1 });
    expect(fit(264, [[90], [30]]).bonus).toEqual({ houg: 2, tyku: 6, kaih: 2 });
  });

  test("shipNationality from api_sort_id (US guns and radars)", () => {
    expect(fit(562, [[307]]).bonus).toEqual({ houg: 1, tyku: 1, kaih: 1 });
    expect(fit(542, [[307]]).bonus).toEqual({});
    // 5inch単装砲 Mk.30改+GFCS Mk.37: American + destroyer
    expect(fit(562, [[308]]).bonus).toEqual({ houg: 2, tyku: 1, kaih: 1 });
  });

  test("requires counts the item itself; num makes a bonus apply once", () => {
    // 20.3cm(3号) on 最上型: +2/+1 per gun, shipX 最上改二 +1 per gun, requires [50] num 2: +1 once
    expect(fit(501, [[50], [50]]).bonus).toEqual({ houg: 7, kaih: 2 });
    // 古鷹型: 2号砲 + 3号砲 + 水上電探 cancels the 3号 radar synergy (requires [90] bonusSR −1), wiki: only the 2号 synergy
    expect(fit(416, [[50], [29]]).bonus).toEqual({ houg: 2, raig: 1, kaih: 1 });
    expect(fit(416, [[90], [29]]).bonus).toEqual({ houg: 5, raig: 2, kaih: 2 });
    expect(fit(416, [[50], [90], [29]]).bonus).toEqual({ houg: 6, raig: 2, kaih: 2 });
  });

  test("requiresType / requiresNumType", () => {
    // 12.7cm連装高角砲改二 on 潮改二: + an AA gun (type 21) → +1/対空+2/回避+1 once
    expect(fit(407, [[380]]).bonus).toEqual({ houg: 3, tyku: 3, kaih: 2 });
    expect(fit(407, [[380], [131]]).bonus).toEqual({ houg: 4, tyku: 5, kaih: 3 });
    expect(fit(407, [[380], [131], [131]]).bonus).toEqual({ houg: 4, tyku: 5, kaih: 3 });
  });
});

describe("computeFitBonus semantics", () => {
  const ship = { masterId: 1, stype: 2, ctype: 7, baseId: 1, nationality: 1 };
  const gun = (improvement = 0) => ({ masterId: 9, type2: 1, improvement });
  const entry = (bonuses: FitEntry["bonuses"]): FitEntry[] => [{ id: 0, ids: [9], types: null, bonuses }];

  test("without num/requires the bonus is per matching item; level filters the items", () => {
    const e = entry([{ bonus: { houg: 1 } }, { level: 4, bonus: { houm: 1 } }]);
    expect(computeFitBonus(ship, [gun(), gun(4)], e).bonus).toEqual({ houg: 2, houm: 1 });
    expect(computeFitBonus(ship, [gun(), gun()], entry([{ num: 2, bonus: { houg: 1 } }])).bonus).toEqual({ houg: 1 });
    expect(computeFitBonus(ship, [gun()], entry([{ num: 2, bonus: { houg: 1 } }])).bonus).toEqual({});
  });

  test("requires needs requiresNum items at requiresLevel; requires with level needs a qualifying item", () => {
    const other = (improvement = 0) => ({ masterId: 174, type2: 5, improvement });
    const e = entry([{ requires: [174], requiresNum: 2, requiresLevel: 3, bonus: { raig: 1 } }]);
    expect(computeFitBonus(ship, [gun(), other(3)], e).bonus).toEqual({});
    expect(computeFitBonus(ship, [gun(), other(3), other(2)], e).bonus).toEqual({});
    expect(computeFitBonus(ship, [gun(), gun(), other(3), other(5)], e).bonus).toEqual({ raig: 1 });
    // 北方迷彩 style: requires + level 7 — EO would apply it without the level, the game needs ★7
    const camo = entry([{ requires: [174], level: 7, bonus: { kaih: 4 } }]);
    expect(computeFitBonus(ship, [gun(6), other()], camo).bonus).toEqual({});
    expect(computeFitBonus(ship, [gun(7), other()], camo).bonus).toEqual({ kaih: 4 });
  });

  test("radar bonuses apply once per definition, from the radar's master stats", () => {
    const radar = (saku: number, tyku: number, houm: number) => ({ masterId: 28, type2: 12, improvement: 0, saku, tyku, houm });
    const e = entry([{ bonusSR: { houg: 1 }, bonusAR: { tyku: 2 }, bonusAccR: { houm: 3 } }]);
    expect(computeFitBonus(ship, [gun(), gun()], e).bonus).toEqual({});
    expect(computeFitBonus(ship, [gun(), gun(), radar(5, 1, 7)], e).bonus).toEqual({ houg: 1 });
    expect(computeFitBonus(ship, [gun(), radar(4, 2, 8)], e).bonus).toEqual({ tyku: 2, houm: 3 });
    // a non-radar with the same stats does not count
    expect(computeFitBonus(ship, [gun(), { ...radar(9, 9, 9), type2: 11 }], e).bonus).toEqual({});
  });

  test("unknown keys and missing ship info are counted as unresolved, not applied", () => {
    const e = entry([{ shipS: [1], bonus: { houg: 1 } }, { shipNationality: [1], bonus: { kaih: 1 } }]);
    expect(computeFitBonus(ship, [gun()], e)).toEqual({ bonus: { houg: 1, kaih: 1 }, unresolved: 0 });
    expect(computeFitBonus({ masterId: 1, stype: 2 }, [gun()], e)).toEqual({ bonus: {}, unresolved: 2 });
    // a ship that fails a known condition is not unresolved
    expect(computeFitBonus({ masterId: 1, stype: 2 }, [gun()], entry([{ shipX: [2], shipS: [1], bonus: { houg: 1 } }])).unresolved).toBe(0);
    const unknown = [{ id: 0, ids: [9], types: null, bonuses: [{ shipHull: [1], bonus: { houg: 1 } }] }] as unknown as FitEntry[];
    expect(computeFitBonus(ship, [gun()], unknown)).toEqual({ bonus: {}, unresolved: 1 });
  });
});

describe("ship info from master", () => {
  test("shipBaseId follows api_aftershipid back to the first form, through 改二 cycles", () => {
    expect(shipBaseId(954, master)).toBe(79); // 榛名改二丙 ↔ 改二乙
    expect(shipBaseId(624, master)).toBe(115); // 夕張改二丁
    expect(shipBaseId(542, master)).toBe(133);
    expect(shipBaseId(133, master)).toBe(133);
    // 宗谷: every form is a remodel target → lowest api_sort_id
    const soya = { ships: {
      645: { api_id: 645, api_sort_id: 7613, api_aftershipid: "650" },
      650: { api_id: 650, api_sort_id: 7615, api_aftershipid: "699" },
      699: { api_id: 699, api_sort_id: 7611, api_aftershipid: "645" },
    } };
    expect(shipBaseId(650, soya)).toBe(699);
    // the data API master has no api_aftershipid: unknown
    expect(shipBaseId(1, { ships: { 1: { api_id: 1 } } })).toBeUndefined();
  });

  test("shipNationality uses EO's api_sort_id ranges", () => {
    expect(shipNationality(1037, 593)).toBe(1);
    expect(shipNationality(30511, 174)).toBe(2);
    expect(shipNationality(32551, 562)).toBe(4);
    expect(shipNationality(33432, 705)).toBe(5);
    expect(shipNationality(36411, 574)).toBe(10);
    expect(shipNationality(38411, 613)).toBe(12);
    expect(shipNationality(undefined, 1)).toBeUndefined();
    expect(shipNationality(undefined, 1501)).toBe(0);
  });
});

test("conversion to EquipmentStats (range is applied to ShipInput.range by the adapter)", () => {
  expect(fitToEquipmentStats({ houg: 2, kaih: 1, tais: 3, houm: 2, leng: 1 })).toEqual({ firepower: 2, evasion: 1, asw: 3, accuracy: 2 });
});
