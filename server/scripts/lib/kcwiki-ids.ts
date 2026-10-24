// kcwiki-quest-data requirements -> override requirements with master ids (docs/QUEST_OVERRIDES.md "From kcwiki").
// kcwiki names ships by master name (a name also accepts the later remodels, as the 任務 tab reads it) or by
// ship-type word, and equipment by name. The counter needs master data, so every name is resolved here; anything
// that has no unambiguous reading is reported as a problem for hand-checking instead of being guessed.

export interface KcwikiMaster {
  ships: { api_id: number; api_name: string; api_stype: number; api_ctype?: number; api_aftershipid?: string }[];
  equips: { api_id: number; api_name: string }[];
  missions: { api_id: number; api_disp_no?: string; api_name: string }[];
  /** api_mst_slotitem_equiptype: category names (小口径主砲 ...) */
  equipTypes: { api_id: number; api_name: string }[];
  /** api_mst_useitem: consumables (開発資材 ...) that kcwiki sometimes lists among scrapped equipment */
  useitems: { api_id: number; api_name: string }[];
}

/** Category words kcwiki uses that are not api_mst_slotitem_equiptype names verbatim. */
const EQUIP_TYPE_WORDS: Record<string, number[]> = { 電探: [12, 13], 対空機銃: [21] };

/** Ship-type words of kcwiki (both its short and long spellings) -> api_stype. */
const TYPE_WORDS: Record<string, number[]> = {
  駆逐: [2], 駆逐艦: [2], 軽巡: [3], 軽巡洋艦: [3], 雷巡: [4], 重雷装巡洋艦: [4], 重巡: [5], 重巡洋艦: [5], 航巡: [6],
  航空巡洋艦: [6], 軽母: [7], 軽空母: [7], 戦艦: [8, 9], 高速戦艦: [8], 低速戦艦: [9], 航戦: [10], 航空戦艦: [10],
  正規空母: [11], 装母: [18], 装甲空母: [18], 潜水艦: [13, 14], 潜水空母: [14], 水母: [16], 水上機母艦: [16],
  揚陸艦: [17], 工作艦: [19], 潜水母艦: [20], 練巡: [21], 練習巡洋艦: [21], 補給艦: [22], 海防艦: [1],
};
/** "any ship" words: kcwiki's free slots (自由枠), optional, so they constrain nothing */
const ANY = ["艦", "他の艦"];

const key = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
type Obj = Record<string, unknown>;

export function kcwikiConverter(m: KcwikiMaster) {
  const shipsByName = new Map<string, number[]>();
  for (const s of m.ships) shipsByName.set(key(s.api_name), [...(shipsByName.get(key(s.api_name)) ?? []), s.api_id]);
  const byId = new Map(m.ships.map((s) => [s.api_id, s]));
  const equipsByName = new Map<string, number[]>();
  for (const e of m.equips) equipsByName.set(key(e.api_name), [...(equipsByName.get(key(e.api_name)) ?? []), e.api_id]);

  /** The named form and its later remodels (remodel loops stop at a repeat). */
  const later = (id: number): number[] => {
    const out: number[] = [];
    for (let x = id; x > 0 && !out.includes(x); x = Number(byId.get(x)?.api_aftershipid ?? 0)) out.push(x);
    return out;
  };

  return (req: Obj): { requirements: Obj; problems: string[] } => {
    const problems: string[] = [];

    const ships = (names: string[]): { shipIds?: number[]; stypes?: number[] } => {
      const shipIds = new Set<number>();
      const stypes = new Set<number>();
      for (const n of names) {
        if (TYPE_WORDS[n]) TYPE_WORDS[n].forEach((t) => stypes.add(t));
        else if (n === "空母") problems.push("ship word 空母 (正規/装甲 only, or 軽空母 too?)");
        else if (shipsByName.get(key(n))?.length === 1) later(shipsByName.get(key(n))![0]!).forEach((i) => shipIds.add(i));
        else problems.push(`ship name ${n}: ${shipsByName.has(key(n)) ? "several master ships" : "not in the master data"}`);
      }
      return { ...(shipIds.size && { shipIds: [...shipIds].sort((a, b) => a - b) }), ...(stypes.size && { stypes: [...stypes] }) };
    };

    const classes = (names: string[]): number[] => {
      const out = new Set<number>();
      for (const n of names) {
        const ids = shipsByName.get(key(n.replace(/型$/, "")));
        const c = ids?.length ? byId.get(ids[0]!)?.api_ctype : undefined;
        if (c === undefined) problems.push(`ship class ${n} not found`);
        else out.add(c);
      }
      return [...out];
    };

    /** Groups and the fleet fields of one leaf; "any ship" groups (free slots) are dropped. */
    const fleet = (r: Obj): Obj => {
      const out: Obj = {};
      const groups: Obj[] = [];
      for (const g of (r.groups as Obj[] | undefined) ?? []) {
        const names = list(g.ship as string | string[] | undefined);
        const amount = Array.isArray(g.amount) ? (g.amount.length === 1 ? g.amount[0] : g.amount) : g.amount;
        const min = typeof g.select === "number" ? g.select : Array.isArray(amount) ? (amount[0] as number) : ((amount as number | undefined) ?? 1);
        if (names.length > 0 && names.every((n) => ANY.includes(n))) {
          if (g.flagship || g.lv || g.place) problems.push("an any-ship group with flagship / lv / place");
          continue;
        }
        if (names.some((n) => ANY.includes(n))) problems.push("a group mixes 艦 with names");
        const match: Obj = { ...ships(names.filter((n) => !ANY.includes(n))) };
        const cls = list(g.shipclass as string | string[] | undefined);
        if (cls.length) match.ctypes = classes(cls);
        const base: Obj = {
          ...(names.length && { ship: g.ship }), ...(cls.length && { shipclass: g.shipclass }), ...match,
          ...(g.lv ? { lv: g.lv } : {}), ...(g.place ? { place: g.place } : {}), ...(g.note ? { note: g.note } : {}),
        };
        const count = { ...(amount !== undefined && { amount }), ...(g.select !== undefined && { select: g.select }) };
        // kcwiki's "flagship X, X ×4": the flagship is one of the four
        if (g.flagship && min > 1) groups.push({ ...base, flagship: true }, { ...base, ...count });
        else groups.push({ ...base, ...(g.flagship ? { flagship: true } : {}), ...count });
      }
      if (groups.length) out.groups = groups;
      if (r.disallowed === "他の艦") out.onlyGroups = true;
      else if (r.disallowed !== undefined) problems.push(`disallowed ${String(r.disallowed)}`);
      if (r.fleetid !== undefined) out.fleetid = r.fleetid;
      return out;
    };

    /** Items as override items: an equipment name -> equipIds, a category word -> equipTypes, a consumable -> アイテム */
    const items = (v: unknown, counted: boolean): Obj[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      return (v as Obj[]).map((i) => {
        const name = String(i.name);
        if (i.category !== undefined && i.category !== "装備") return { ...i };
        const ids = equipsByName.get(key(name));
        if (ids?.length) return { ...i, equipIds: ids };
        const types = EQUIP_TYPE_WORDS[name] ?? m.equipTypes.filter((t) => key(t.api_name) === key(name)).map((t) => t.api_id);
        if (types.length) return { ...i, equipTypes: types };
        if (m.useitems.some((u) => key(u.api_name) === key(name))) return { ...i, category: "アイテム" };
        if (counted) problems.push(`equipment ${name} not in the master data`);
        return { ...i };
      });
    };

    /** scraps / consumptions; consumables kcwiki lists among the scraps (開発資材 ...) move to consumptions */
    const scrapsAndUse = (r: Obj): Obj => {
      const scraps = items(r.scraps, true) ?? [];
      const use = [...(items(r.consumptions, false) ?? []), ...scraps.filter((i) => i.category === "アイテム")];
      const kept = scraps.filter((i) => i.category !== "アイテム");
      return { ...(kept.length && { scraps: kept }), ...(use.length && { consumptions: use }) };
    };

    const walk = (r: Obj): Obj => {
      const c = r.category as string;
      const pick = (...keys: string[]) => Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));
      switch (c) {
        case "and":
        case "or":
        case "then":
          return { category: c, list: ((r.list as Obj[]) ?? []).map(walk) };
        case "sortie": {
          const maps = list(r.map as string | string[] | undefined);
          const out: Obj = { category: c, times: r.times ?? 1, ...pick("boss", "result") };
          const range = maps.length === 1 ? /^(\d+)-(\d+)\s*~\s*\1-(\d+)$/.exec(maps[0]!) : null;
          if (range) {
            out.map = Array.from({ length: Number(range[3]) - Number(range[2]) + 1 }, (_, i) => `${range[1]}-${Number(range[2]) + i}`);
            out.total = true;
          } else out.map = maps.length === 1 ? maps[0] : maps;
          if (maps.length === 0) problems.push("sortie without a map (counted on departure)");
          for (const mm of maps) if (!range && !/^\d+-\d+$/.test(mm)) problems.push(`map ${mm}`);
          if (!r.boss) problems.push(`sortie without boss (${String(r.result ?? "no result")})`);
          if (r.result === "クリア") problems.push("result クリア");
          return { ...out, ...fleet(r) };
        }
        case "excercise":
          return { category: c, ...pick("times", "victory", "daily"), ...fleet(r) };
        case "expedition": {
          // an id list in kcwiki means each of them (e.g. Dy1: 警備任務・海上護衛任務・… 各1回)
          const objects = ((r.objects as Obj[]) ?? []).flatMap((o) => {
            const hits = list(o.id as number | string | (number | string)[] | undefined).map((x) => {
              const hit = typeof x === "number" ? m.missions.find((y) => y.api_id === x) : m.missions.find((y) => y.api_disp_no === x || String(y.api_id) === x);
              if (!hit) problems.push(`expedition ${x}`);
              return hit;
            });
            return hits.length ? hits.map((h) => ({ id: h?.api_id ?? 0, ...(h?.api_name && { name: h.api_name }), times: o.times })) : [{ times: o.times }];
          });
          return { category: c, objects, ...pick("resources"), ...fleet(r) };
        }
        case "simple":
          return { category: c, ...pick("subcategory", "times", "batch") };
        case "scrapequipment":
          return { category: c, list: items(r.list, true) };
        case "equipexchange":
          return {
            category: c, ...pick("resources"),
            ...(r.equipments ? { equipments: items(r.equipments, false) } : {}),
            ...scrapsAndUse(r),
          };
        case "modelconversion": {
          const slots = ((r.slots as Obj[] | undefined) ?? []).map((s) => {
            const ids = equipsByName.get(key(String(s.equipment)));
            if (!ids) problems.push(`equipment ${String(s.equipment)} not in the master data`);
            return { ...s, ...(ids && { equipIds: ids }) };
          });
          const sec = list(r.secretary as string | string[] | undefined).filter((n) => !ANY.includes(n));
          const notes = [r.fullyskilled && "熟練度max", r.maxmodified && "改修max", r.use_skilled_crew && "熟練搭乗員1消費"].filter(Boolean);
          return {
            category: c, ...pick("equipment", "resources"), ...(slots.length && { slots }),
            ...(sec.length && { secretary: r.secretary, secretaryIds: ships(sec).shipIds }),
            ...scrapsAndUse(r),
            ...(notes.length && { note: notes.join("・") }),
          };
        }
        case "fleet":
          return { category: c, ...fleet(r) };
        default:
          problems.push(`category ${c}`);
          return { ...r };
      }
    };

    return { requirements: walk(req), problems };
  };
}
