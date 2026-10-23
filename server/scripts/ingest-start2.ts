// api_start2 (Tibowl/api_start2) -> ship_types, ships, equip_types, equipments, maps.
import { execStatements } from "./lib/d1";
import { fetchGithub } from "./lib/fetch";
import { sourceRef, sourceUpsert, upsert } from "./lib/sql";
import { SHIP_TYPES } from "../src/routing/schema";
import { shipBaseId } from "../../shared/sim/fit";
import type { ShipMaster } from "../../shared/fleet/types";

const FILE = { owner: "Tibowl", repo: "api_start2", ref: "master", path: "start2.json" };
const KEY = "tibowl-start2";

interface MstShip {
  api_id: number; api_name: string; api_yomi?: string; api_stype: number; api_ctype?: number;
  api_soku: number; api_slot_num: number; api_leng?: number; api_maxeq?: number[];
  api_taik?: number[]; api_houg?: number[]; api_raig?: number[]; api_tyku?: number[];
  api_souk?: number[]; api_luck?: number[]; api_fuel_max?: number; api_bull_max?: number;
  api_sort_id?: number; api_aftershipid?: string;
}
interface MstSlotitem {
  api_id: number; api_name: string; api_type: number[]; api_houg: number; api_raig: number;
  api_tyku: number; api_souk: number; api_baku: number; api_tais: number; api_saku: number;
  api_houm: number; api_houk: number; api_luck: number; api_leng: number;
  api_distance?: number; api_cost?: number;
}
interface MstMapinfo {
  api_id: number; api_maparea_id: number; api_no: number; api_name: string; api_opetext: string;
  api_max_maphp: number | null; api_required_defeat_count: number | null;
}

export async function ingestStart2(): Promise<void> {
  const { text, url, revision } = await fetchGithub(FILE);
  const json = JSON.parse(text);
  const d = json.api_data ?? json;
  const now = new Date().toISOString();
  const src = sourceRef(KEY);
  const codeById: Record<number, string> = Object.fromEntries(Object.entries(SHIP_TYPES).map(([c, id]) => [id, c]));

  const stypes = (d.api_mst_stype as { api_id: number; api_name: string }[]).map((s) => ({
    id: s.api_id, code: codeById[s.api_id] ?? null, name: s.api_name,
  }));

  // Remodel lineage for fit bonuses (shipS = first form of the line, shipNationality from api_sort_id).
  const lineage: Record<number, ShipMaster> = {};
  for (const s of d.api_mst_ship as MstShip[]) {
    if (s.api_id <= 1500) lineage[s.api_id] = { api_id: s.api_id, api_aftershipid: s.api_aftershipid, api_sort_id: s.api_sort_id };
  }
  const lineageMaster = { ships: lineage };

  const ships = (d.api_mst_ship as MstShip[]).map((s) => {
    const abyssal = s.api_id > 1500;
    const after = Number(s.api_aftershipid ?? 0);
    return {
      id: s.api_id, name: s.api_name, yomi: s.api_yomi ?? null, stype: s.api_stype, ctype: s.api_ctype ?? null,
      speed: s.api_soku, range: s.api_leng ?? null, slot_num: s.api_slot_num, is_abyssal: abyssal,
      hp: s.api_taik?.[0] ?? null, fp: s.api_houg?.[0] ?? null, tp: s.api_raig?.[0] ?? null,
      aa: s.api_tyku?.[0] ?? null, ar: s.api_souk?.[0] ?? null, luck: s.api_luck?.[0] ?? null,
      max_stats: abyssal || !s.api_taik ? null : {
        hp: s.api_taik[1], fp: s.api_houg?.[1], tp: s.api_raig?.[1], aa: s.api_tyku?.[1], ar: s.api_souk?.[1], luck: s.api_luck?.[1],
      },
      slots: s.api_maxeq ?? null, fuel_max: s.api_fuel_max ?? null, ammo_max: s.api_bull_max ?? null,
      after_ship_id: !abyssal && after > 0 ? after : null, sort_id: abyssal ? null : (s.api_sort_id ?? null),
      base_id: abyssal ? null : (shipBaseId(s.api_id, lineageMaster) ?? null),
      source_id: src, updated_at: now,
    };
  });
  // Abyssal visible stats come from ingest-abyssal; do not clobber them with start2's nulls.
  const playerShips = ships.filter((s) => !s.is_abyssal);
  const abyssalShips = ships.filter((s) => s.is_abyssal).map((s) => ({
    id: s.id, name: s.name, yomi: s.yomi, stype: s.stype, ctype: s.ctype, speed: s.speed,
    slot_num: s.slot_num, is_abyssal: true, source_id: src, updated_at: now,
  }));

  const equipTypes = (d.api_mst_slotitem_equiptype as { api_id: number; api_name: string }[]).map((t) => ({
    id: t.api_id, name: t.api_name,
  }));
  const equips = (d.api_mst_slotitem as MstSlotitem[]).map((e) => ({
    id: e.api_id, name: e.api_name, type: e.api_type, type_id: e.api_type[2]!, icon: e.api_type[3] ?? null,
    fp: e.api_houg, tp: e.api_raig, aa: e.api_tyku, ar: e.api_souk, bomb: e.api_baku, asw: e.api_tais,
    los: e.api_saku, acc: e.api_houm, ev: e.api_houk, luck: e.api_luck, range: e.api_leng,
    radius: e.api_distance ?? null, cost: e.api_cost ?? null, is_abyssal: e.api_id > 1500,
    source_id: src, updated_at: now,
  }));
  const maps = (d.api_mst_mapinfo as MstMapinfo[]).map((m) => ({
    id: m.api_id, world: m.api_maparea_id, no: m.api_no, name: m.api_name, opetext: m.api_opetext,
    is_event: m.api_maparea_id > 7, max_hp: m.api_max_maphp, required_defeat_count: m.api_required_defeat_count,
    source_id: src, updated_at: now,
  }));

  await execStatements("start2", [
    sourceUpsert({ key: KEY, name: "api_start2 (Tibowl/api_start2)", url, licence: "game data; repo has no licence", revision }),
    ...upsert("ship_types", stypes, ["id"]),
    ...upsert("ships", playerShips, ["id"]),
    ...upsert("ships", abyssalShips, ["id"]),
    ...upsert("equip_types", equipTypes, ["id"]),
    ...upsert("equipments", equips, ["id"]),
    ...upsert("maps", maps, ["id"]),
  ]);
  console.log(`start2 @${revision.slice(0, 12)}: ${stypes.length} stypes, ${playerShips.length} ships, ${abyssalShips.length} abyssal, ${equips.length} equipments, ${maps.length} maps`);
}

if (import.meta.main) await ingestStart2();
