/**
 * イベント特効 (`GET /api/v1/maps/{map}/bonuses`) を sim-core の入力に変換する。
 * 単一戦闘は `BattleInput.bonuses` / `escortBonuses` / `lbasBonuses` / `friendFleetBonuses` / `debuffs`、
 * 出撃はマスごとの `SortieNode.bonuses` / `escortBonuses` / `lbasBonuses` / `friendFleetBonuses` / `debuffs`。
 * 友軍艦隊もそのマスの特効を受ける (bonus.js `applyAutoBonusShip(ship, isFF)`)。
 *
 * 畳み方は kancolle-replay `simulator-ui/bonus.js` (MIT) に合わせる。
 * - マスごとに、該当する項目 (`nodes` が null か含む、`nodesExclude` に含まれない) の dmg/acc/eva をキーごとに掛ける。
 *   `all` は特定のマスを指定しない項目だけの積、`nodes[マス]` はそのマスの全項目の積で、`all` を置き換える。
 * - `perEquip` は該当装備の数だけ掛ける。`isPlane` の項目は艦載機グループ (搭載機が残る間だけ効く) になる。
 * - `shipType` は api_stype、`shipClass` は api_ctype、`shipBase` は改装系列の初期艦 (`shipBaseId`)、`shipId` はマスター ID。
 *   装備種別 `requireEquipType` は kcsim の種別で、高角砲アイコンの小口径主砲は 101、副砲は 104 として扱う [inference]。
 */
import type { ArmorDebuff, BaseBonusSet, DamageMods, PlaneBonusGroup, ShipBonusSet } from "../../sim-core/pkg/sim_core";
import type { MasterData, Preset, PresetAirBase, PresetEquip, PresetShip } from "../fleet/types";
import { shipBaseId } from "./fit";

/** `/maps/{map}/bonuses` の 1 項目 (kancolle-replay のキーをそのまま持つ)。 */
export interface EventBonusEntry {
  nodes: string[] | null;
  nodesExclude: string[] | null;
  [key: string]: unknown;
}

/** `GET /api/v1/maps/{map}/bonuses` の応答 (docs/API.md)。 */
export interface EventBonusResponse {
  map: string;
  date: string | null;
  note: string | null;
  /** "kancolle-replay" または "manual" (server/data/event-bonuses.json) */
  source: string;
  revision: string | null;
  bonuses: EventBonusEntry[];
  lbasBonuses: EventBonusEntry[];
  debuffs: EventBonusEntry[];
}

/** 1 隻 / 1 基地の特効: `nodes[マス]` があればそれ、無ければ `all`。 */
export interface NodeBonus<T> {
  all?: T;
  nodes?: Record<string, T>;
}

/** kancolle-replay の accEvaType。data=データの値、none=1、dmg=dmg と同じ値、half=1+(dmg−1)/2。 */
export type AccEvaMode = "data" | "none" | "dmg" | "half";

export interface BuildBonusOptions {
  /** 推測値 (`unconfirmed: 1`) の項目も使う。既定 false。 */
  unconfirmed?: boolean;
  /** 命中・回避の扱い。既定 "data"。 */
  accEva?: AccEvaMode;
  /** エンジンに渡す基地航空隊 (その順)。渡すと `lbasBonuses` を作る。 */
  lbas?: PresetAirBase[];
}

export interface BonusBuild {
  /** 主力 (通常艦隊) の各艦。`preset.ships` の順、null = 特効なし。 */
  bonuses: (NodeBonus<ShipBonusSet> | null)[];
  /** 随伴艦隊の各艦 (`preset.escort` があるときだけ)。 */
  escortBonuses?: (NodeBonus<ShipBonusSet> | null)[];
  /** `opts.lbas` の各基地 (渡したときだけ)。 */
  lbasBonuses?: (NodeBonus<BaseBonusSet> | null)[];
  /** 友軍艦隊の各艦 (`preset.friendFleet` があるときだけ)。 */
  friendFleetBonuses?: (NodeBonus<ShipBonusSet> | null)[];
  /** 評価できなかった項目など。 */
  warnings: string[];
}

type Mods = { dmg: number; acc: number; eva: number };
const KEYS = ["dmg", "acc", "eva"] as const;

const nums = (v: unknown): number[] | null => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (x: number) => Math.round(1e10 * x) / 1e10;

/** マス `letter` (undefined = 特定のマスでない) に効く項目か (bonus.js の nodes / nodesExclude)。 */
const appliesAt = (e: EventBonusEntry, letter: string | undefined) =>
  !(e.nodes && (letter === undefined || !e.nodes.includes(letter))) && !(e.nodesExclude && letter !== undefined && e.nodesExclude.includes(letter));

/** 項目に出てくるマスの文字 (マスごとの値を出すマス)。 */
const lettersOf = (entries: EventBonusEntry[]) => {
  const out = new Set<string>();
  for (const e of entries) for (const l of [...(e.nodes ?? []), ...(e.nodesExclude ?? [])]) out.add(l);
  return [...out].sort();
};

/** kcsim の装備種別 (kcEQDATA `type`): 高角砲アイコンの小口径主砲 101、副砲 104、他は api_type[2]。 */
const kcEquipType = (types: number[] | undefined): number => {
  const t2 = types?.[2] ?? 0;
  if (types?.[3] === 16 && t2 === 1) return 101;
  if (types?.[3] === 16 && t2 === 4) return 104;
  return t2;
};

interface Eq {
  /** エンジンのスロット番号 (0–4、補強増設 5) / 基地の中隊番号 */
  slot: number;
  id: number;
  type: number;
  level: number;
  /** 搭載数 (requireSlot) */
  capacity: number;
}

const toEq = (e: PresetEquip, slot: number, master: MasterData, capacity: number): Eq => ({
  slot, id: e.masterId, type: kcEquipType(master.equips[e.masterId]?.api_type), level: e.improvement ?? 0, capacity,
});

const shipEquips = (ship: PresetShip, master: MasterData): Eq[] => {
  const maxeq = master.ships[ship.masterId]?.api_maxeq;
  const out = ship.equips.flatMap((e, i) => (e ? [toEq(e, i, master, e.slotSize ?? maxeq?.[i] ?? 0)] : []));
  if (ship.exSlot) out.push(toEq(ship.exSlot, 5, master, 0));
  return out;
};

/** エンジンの中隊の並び (`buildSquadrons` と同じく、空きと master に無い装備を詰める)。 */
const baseEquips = (base: PresetAirBase, master: MasterData): Eq[] =>
  base.squadrons.filter((e): e is PresetEquip => !!e && !!master.equips[e.masterId]).map((e, i) => toEq(e, i, master, e.slotSize ?? 18));

/** 比率の扱い (accEvaType) を通した dmg/acc/eva。 */
const withMode = (dmg: number, acc: number, eva: number, mode: AccEvaMode): Mods => {
  switch (mode) {
    case "none":
      return { dmg, acc: 1, eva: 1 };
    case "dmg":
      return { dmg, acc: dmg, eva: dmg };
    case "half":
      return { dmg, acc: 1 + (dmg - 1) / 2, eva: 1 + (dmg - 1) / 2 };
    default:
      return { dmg, acc, eva };
  }
};

const toMods = (m: Mods, eva = true): DamageMods => {
  const out: DamageMods = {};
  if (m.dmg !== 1) out.dmg = round(m.dmg);
  if (m.acc !== 1) out.acc = round(m.acc);
  if (eva && m.eva !== 1) out.eva = round(m.eva);
  return out;
};

/**
 * 艦載機グループ (bonus.js `_applyAutoBonusPresetPlaneEnd`)。グループは項目ごと、`perEquip` なら装備ごと。
 * 条件は requireEquipId / requireEquipIdNum / requireEquipIdNumX / requireEquipIdNot / requireEquipType。
 */
const planeGroups = (bonuses: EventBonusEntry[], eqs: Eq[], mode: AccEvaMode, isLbas: boolean): PlaneBonusGroup[] => {
  const out: PlaneBonusGroup[] = [];
  for (const b of bonuses) {
    const ids = nums(b.requireEquipId);
    const types = nums(b.requireEquipType);
    const not = nums(b.requireEquipIdNot);
    const idCount = ids ? eqs.filter((e) => ids.includes(e.id)).length : 0;
    const hit = eqs.filter((e) => {
      if (ids && !ids.includes(e.id)) return false;
      if (ids && num(b.requireEquipIdNum) !== null && idCount < num(b.requireEquipIdNum)!) return false;
      if (ids && num(b.requireEquipIdNumX) !== null && idCount !== num(b.requireEquipIdNumX)) return false;
      if (not && not.includes(e.id)) return false;
      if (types && !types.includes(e.type)) return false;
      return true;
    });
    if (hit.length === 0) continue;
    const m = withMode(num(b.dmg) ?? 1, num(b.acc) ?? 1, num(b.eva) ?? 1, mode);
    const group = (slots: number[]): PlaneBonusGroup => {
      const g: PlaneBonusGroup = { slots, ...toMods(m, !isLbas) };
      if (b.notAirOnly && !isLbas) g.notAirOnly = true;
      return g;
    };
    if (b.perEquip) for (const e of hit) out.push(group([e.slot]));
    else out.push(group(hit.map((e) => e.slot)));
  }
  return out;
};

/** 1 隻の、マス `letter` での特効 (bonus.js `_applyAutoBonusPreset`)。null = 特効なし。 */
const shipSetAt = (
  res: EventBonusResponse, ship: PresetShip, master: MasterData, letter: string | undefined, opts: BuildBonusOptions, missingBase: { n: number },
): ShipBonusSet | null => {
  const m = master.ships[ship.masterId];
  const eqs = shipEquips(ship, master);
  const mode = opts.accEva ?? "data";
  const total: Partial<Mods> = {};
  const planes: EventBonusEntry[] = [];
  for (const b of res.bonuses) {
    if (!appliesAt(b, letter)) continue;
    if (b.unconfirmed && !opts.unconfirmed) continue;
    const st = nums(b.shipType), sc = nums(b.shipClass), sb = nums(b.shipBase), sid = nums(b.shipId);
    if (st && !st.includes(m?.api_stype ?? -1)) continue;
    if (sc && !sc.includes(m?.api_ctype ?? -1)) continue;
    if (sb) {
      const base = shipBaseId(ship.masterId, master);
      if (base === undefined) {
        missingBase.n++;
        continue;
      }
      if (!sb.includes(base)) continue;
    }
    if (sid && !sid.includes(ship.masterId)) continue;
    if (b.isPlane) {
      planes.push(b);
      continue;
    }
    let count = 0;
    const ids = nums(b.requireEquipId);
    if (ids) {
      count = eqs.filter((e) => ids.includes(e.id) && (!b.requireSlot || e.capacity > 0) && e.level >= (num(b.requireEquipLevel) ?? 0)).length;
      if (count < (num(b.requireEquipIdNum) ?? 1)) continue;
    }
    const types = nums(b.requireEquipType);
    if (types) {
      count = eqs.filter((e) => types.includes(e.type) && (!b.requireSlot || e.capacity > 0)).length;
      if (count < (num(b.requireEquipTypeNum) ?? 1)) continue;
    }
    if (!b.perEquip) count = 1;
    for (const k of KEYS) {
      const v = num(b[k]);
      if (v === null) continue;
      total[k] = (total[k] ?? 1) * v ** count;
    }
  }
  const set: ShipBonusSet = toMods(withMode(total.dmg ?? 1, total.acc ?? 1, total.eva ?? 1, mode));
  const groups = planeGroups(planes, eqs, mode, false);
  if (groups.length > 0) set.planes = groups;
  return Object.keys(set).length > 0 ? set : null;
};

const fold = <T>(at: (letter: string | undefined) => T | null, letters: string[]): NodeBonus<T> | null => {
  const all = at(undefined);
  const nodes: Record<string, T> = {};
  const none = JSON.stringify(all ?? {});
  for (const l of letters) {
    const v = at(l);
    // `nodes[l]` は `all` を置き換えるので、`all` と違うマスだけ書く (特効が無くなるマスは空のセット)。
    if (JSON.stringify(v ?? {}) !== none) nodes[l] = v ?? ({} as T);
  }
  const out: NodeBonus<T> = {};
  if (all) out.all = all;
  if (Object.keys(nodes).length > 0) out.nodes = nodes;
  return Object.keys(out).length > 0 ? out : null;
};

/** 1 基地の、マス `letter` での特効 (bonus.js `applyAutoLBAS`; `unconfirmed` は見ない)。null = 特効なし。 */
const baseSetAt = (res: EventBonusResponse, eqs: Eq[], letter: string | undefined, mode: AccEvaMode): BaseBonusSet | null => {
  if (eqs.length === 0) return null;
  const dmg = eqs.map(() => 1);
  const acc = eqs.map(() => 1);
  const planes: EventBonusEntry[] = [];
  for (const item of res.lbasBonuses) {
    if (!appliesAt(item, letter)) continue;
    if (item.isPlane) {
      planes.push(item);
      continue;
    }
    let match: Eq[] = [];
    const ids = nums(item.requireEquipId);
    if (ids) {
      match = eqs.filter((e) => ids.includes(e.id) && (!item.requireSlot || e.capacity > 0));
      if (match.length === 0) continue;
    }
    const types = nums(item.requireEquipType);
    if (types) {
      match = eqs.filter((e) => types.includes(e.type) && (!item.requireSlot || e.capacity > 0));
      if (match.length === 0) continue;
    }
    const times = item.basewide && item.perEquip ? match.length : 1;
    const apply = item.basewide ? eqs : match;
    const d = num(item.dmg), a = num(item.acc);
    for (const e of apply) {
      if (d !== null) dmg[e.slot] = dmg[e.slot]! * d ** times;
      if (a !== null && mode === "data") acc[e.slot] = acc[e.slot]! * a ** times;
    }
  }
  const squadrons = eqs.map((e) => {
    const out = toMods(withMode(dmg[e.slot]!, acc[e.slot]!, 1, mode), false);
    return Object.keys(out).length > 0 ? out : null;
  });
  const set: BaseBonusSet = {};
  if (squadrons.some((s) => s)) set.squadrons = squadrons;
  const groups = planeGroups(planes, eqs, mode, true);
  if (groups.length > 0) set.planes = groups;
  return Object.keys(set).length > 0 ? set : null;
};

/**
 * 編成と特効データから、艦・基地ごとの特効 (`all` とマスごとの値) を作る。
 * `shipBase` の項目は、master に api_aftershipid が無いと評価できない (適用せず warnings に数える)。
 */
export const buildBonuses = (preset: Preset, res: EventBonusResponse, master: MasterData, opts: BuildBonusOptions = {}): BonusBuild => {
  const warnings: string[] = [];
  const missingBase = { n: 0 };
  const letters = lettersOf(res.bonuses);
  const ships = (list: PresetShip[]) => list.map((ship) => fold((l) => shipSetAt(res, ship, master, l, opts, missingBase), letters));
  const out: BonusBuild = { bonuses: ships(preset.ships), warnings };
  if (preset.escort?.length) out.escortBonuses = ships(preset.escort);
  if (preset.friendFleet?.length) out.friendFleetBonuses = ships(preset.friendFleet);
  if (opts.lbas) {
    const lbLetters = lettersOf(res.lbasBonuses);
    out.lbasBonuses = opts.lbas.map((base) => {
      const eqs = baseEquips(base, master);
      return fold((l) => baseSetAt(res, eqs, l, opts.accEva ?? "data"), lbLetters);
    });
  }
  if (missingBase.n > 0) warnings.push("改装系列の初期艦 (shipBase) で決まる特効を評価できず未適用 (master に api_aftershipid がありません)");
  return out;
};

/** マス `letter` で効く値 (`nodes[letter]` が `all` を置き換える)。空のセットや無しは null。 */
export const bonusAt = <T extends object>(b: NodeBonus<T> | null | undefined, letter: string): T | null => {
  const v = b ? (b.nodes?.[letter] ?? b.all ?? null) : null;
  return v && Object.keys(v).length > 0 ? v : null;
};

/** マス `letter` の装甲デバフ (`SortieNode.debuffs` / `BattleInput.debuffs`)。 */
export const debuffsAt = (res: EventBonusResponse, letter: string): ArmorDebuff[] =>
  res.debuffs.filter((d) => appliesAt(d, letter) && num(d.amount) !== null).map((d) => {
    const out: ArmorDebuff = { amount: num(d.amount)! };
    const ids = nums(d.shipId);
    if (ids) out.shipId = ids;
    return out;
  });
