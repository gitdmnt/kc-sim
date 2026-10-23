// sim-core JSON contract (TypeScript view).
//
// This file is the single source of truth for the wasm API types: it is embedded
// verbatim into the wasm-pack generated `pkg/sim_core.d.ts` (via
// `typescript_custom_section`) and documented in `docs/SIM_INTERFACE.md`.
// Keep it in sync with `src/model.rs` (serde, camelCase).

/** Fleet formation. The `combined*` ones are the cruising formations (第一〜第四警戒航行序列) of a
 *  friend combined fleet and only valid there; single fleets use the first six. */
export type Formation =
  | "lineAhead"
  | "doubleLine"
  | "diamond"
  | "echelon"
  | "lineAbreast"
  | "vanguard"
  | "combinedAntiSub"
  | "combinedForward"
  | "combinedDiamond"
  | "combinedBattle";

/** Combined fleet type: 空母機動部隊 / 水上打撃部隊 / 輸送護衛部隊. */
export type CombinedType = "carrier" | "surface" | "transport";

/** Engagement form. Random unless forced via `BattleOptions.engagement`. */
export type Engagement = "sameCourse" | "headOn" | "tAdvantage" | "tDisadvantage";

/**
 * Air state from the friend fleet's point of view.
 * `none` = no aircraft took part in air combat.
 * supremacy = AS+, superiority = AS, parity = AP, denial = AD, incapability = AI.
 */
export type AirState =
  | "none"
  | "supremacy"
  | "superiority"
  | "parity"
  | "denial"
  | "incapability";

export type Rank = "SS" | "S" | "A" | "B" | "C" | "D" | "E";

export type Side = "friend" | "enemy";

/** End-of-battle damage state: healthy > 75% HP, light ≤ 75%, moderate ≤ 50%, heavy ≤ 25%. */
export type DamageState = "healthy" | "light" | "moderate" | "heavy" | "sunk";

/**
 * Battle kind of a node.
 * - `day`: day battle only (no night pursuit).
 * - `dayNight`: day battle, then night battle if any enemy ship is still afloat.
 * - `nightOnly`: night battle node (夜戦マス).
 * - `airBattle`: aerial battle node (航空戦マス): two air-combat phases, no shelling/torpedo.
 * - `airRaid`: air raid node (空襲マス): enemy air attack only; rank from friend HP loss
 *   (0% SS, <10% A, <20% B, <50% C, <80% D, else E).
 */
export type BattleKind = "day" | "dayNight" | "nightOnly" | "airBattle" | "airRaid";

/** Detection (索敵) result of the friend fleet (enemies always detect). On failure
 *  ("failure" | "failureLost" | "notFound") the friend fleet takes no part in air combat. */
export type Detection = "success" | "successLost" | "failureLost" | "failure" | "found" | "notFound";

export type Phase =
  /** Land-based air squadron waves (before the air phase). */
  | "landBase"
  | "airStrike"
  | "openingAsw"
  | "openingTorpedo"
  /** Combined friend fleet: rounds follow kcsim api_hougeki1..3 — carrier/transport: escort,
   *  main (by range), main (by position); surface: main (by range), main (by position), escort. */
  | "shelling1"
  | "shelling2"
  | "shelling3"
  | "closingTorpedo"
  | "night";

export type AttackKind = "air" | "shelling" | "asw" | "torpedo" | "night";

/**
 * Special attack (cut-in / double attack) that produced an attack event.
 * Day (artillery spotting / CVCI) and night (夜戦CI) variants share one union.
 */
export type SpecialAttack =
  | "normal"
  // day artillery spotting (弾着観測射撃)
  | "doubleAttack"
  | "cutinMainSecondary"
  | "cutinMainRadar"
  | "cutinMainAp"
  | "cutinMainMain"
  // day carrier cut-in (戦爆連合)
  | "cvciFba"
  | "cvciBba"
  | "cvciBa"
  // night (夜戦)
  | "nightDoubleAttack"
  | "nightCutinMixed"
  | "nightCutinTorpedo"
  | "nightCutinGunSecondary"
  | "nightCutinGunMain"
  | "ddciGunTorpRadar"
  | "ddciLookoutTorpRadar"
  | "ddciTorpLookoutTorp"
  | "ddciTorpLookoutDrum"
  | "ddciGunTorpRadarDouble"
  | "ddciLookoutTorpRadarDouble"
  | "ddciTorpLookoutTorpDouble"
  | "ddciTorpLookoutDrumDouble"
  // carrier night cut-ins (夜間航空攻撃): 2 night fighters + night attacker, fighter + attacker,
  // night dive bomber / fuze Suisei, fighter + 2 other night planes
  | "nightCvciFfa"
  | "nightCvciFa"
  | "nightCvciBomber"
  | "nightCvciFOther";

export type HitResult = "miss" | "hit" | "critical";

// ---------------------------------------------------------------- input ----

/** Equipment stats as in master data (api_houg, api_raig, ...). All default 0. */
export interface EquipmentStats {
  firepower?: number; // api_houg
  torpedo?: number; // api_raig
  antiAir?: number; // api_tyku
  armor?: number; // api_souk
  evasion?: number; // api_houk
  asw?: number; // api_tais
  los?: number; // api_saku
  accuracy?: number; // api_houm
  bombing?: number; // api_baku (dive bombing)
  luck?: number; // api_luck
  range?: number; // api_leng (0..5)
}

export interface EquipmentInput {
  /** Master id (api_slotitem_id / api_id). Used for a handful of id-specific rules. */
  id: number;
  /** api_type, 5 entries. [2] = category (e.g. 1 small gun, 6 fighter), [3] = icon (16 = HA gun). */
  types: number[];
  stats?: EquipmentStats;
  /** Improvement level ★ 0..10 (api_level). Default 0. */
  improvement?: number;
  /** Aircraft proficiency rank 0..7 (api_alv). Default 0. */
  proficiency?: number;
  /** Current plane count in this slot (api_onslot). Default 0. Ignored for non-aircraft. */
  planes?: number;
}

/** Naked ship stats: WITHOUT equipment stats and WITHOUT equipment fit bonuses.
 *  Friend ships: poi `api_xxx[0]` minus equipment master stats (minus `equipBonus`).
 *  Enemy ships: base stats (api_eParam / master data), equipment is added by the engine. */
export interface ShipStats {
  firepower: number;
  torpedo: number;
  antiAir: number;
  armor: number;
  /** Default 0. */
  evasion?: number;
  /** Default 0. Naked ASW (also decides whether DD/CL-type ships can attack subs). */
  asw?: number;
  /** Default 0. Supply it for friend ships: detection uses it, and a fleet with near-zero LoS
   *  regularly fails detection (no air combat for the friend fleet). */
  los?: number;
  /** Default 0. Equipment luck (rare) is added on top. */
  luck?: number;
}

export interface ShipInput {
  /** Master id (api_ship_id / enemy api_mst_id). Informational. */
  id?: number;
  name?: string;
  /** api_stype: 1 DE, 2 DD, 3 CL, 4 CLT, 5 CA, 6 CAV, 7 CVL, 8 FBB, 9 BB, 10 BBV, 11 CV,
   *  12 BB, 13 SS, 14 SSV, 15 AP, 16 AV, 17 LHA, 18 CVB, 19 AR, 20 AS, 21 CT, 22 AO. */
  shipType: number;
  /** api_ctype (ship class). Optional; enables class-specific rules (Akizuki-class AACI 1–3,
   *  class-specific main-gun fit). */
  shipClass?: number;
  /** Default 1. Enemies: api_ship_lv (submarines need level ≥ 10 for opening torpedoes; base
   *  Ka/Yo/So-class (1530, 1531, 1570) and 潜水棲姫 (1644–1646) never fire them). */
  level?: number;
  maxHp: number;
  /** HP at the start of this battle. Default `maxHp`. 0 = already sunk (ignored by combat). */
  hp?: number;
  stats: ShipStats;
  /** Sum of visible equipment fit bonuses (装備ボーナス) not included in `stats`. Default none. */
  equipBonus?: EquipmentStats;
  /** Hidden flat accuracy bonus added to every accuracy formula's flat term (shelling / torpedo /
   *  night / ASW). Default 0. Not kcsim's abyssal `TACC` (that is torpedo-only: `torpedoAccuracy`);
   *  kcsim models no generic hidden accuracy for abyssal ships. */
  hiddenAccuracy?: number;
  /** Hidden torpedo accuracy (kcsim `TACC`, the data API's abyssal `acc` estimate): added to the
   *  flat term of opening / closing torpedo accuracy only. Default 0. */
  torpedoAccuracy?: number;
  /** Ship's own range api_leng (1 short .. 4 very long). Default by ship type
   *  (BB-class 3, CA/CL-class 2, others 1). Effective range = max(ship, equipment). */
  range?: number;
  /** api_soku. Informational (routing); unused by the battle engine. */
  speed?: number;
  /** Default 49. */
  morale?: number;
  /** Current fuel / ammo and their maxima (api_fuel, api_fuel_max, api_bull, api_bull_max).
   *  Max defaults to 100, current defaults to max. Enemies are always treated as full. */
  fuel?: number;
  fuelMax?: number;
  ammo?: number;
  ammoMax?: number;
  /** Equipment in slot order (max 5). `null` = empty slot. Plane counts live in each entry. */
  slots: (EquipmentInput | null)[];
  /** Reinforcement expansion slot (補強増設). */
  exSlot?: EquipmentInput | null;
  /** Installation (陸上型): cannot be torpedoed; submarines target only installations. Default false. */
  isInstallation?: boolean;
  /** Ship always performs opening ASW. Default: true for friend ships whose `id` is one of the 26
   *  always-OASW ships (Isuzu K2 141, Tatsuta K2 478, Jervis/Janus Kai, Fletcher class, Taiyou class,
   *  … — kcsim data), else false. Set explicitly to override. */
  alwaysOpeningAsw?: boolean;
  /** Carrier that attacks at night with a plain FP+TP night attack (Graf Zeppelin-type, abyssal
   *  princess carriers). Carriers with night aviation personnel (equipped ids 258/259 or built in)
   *  and night planes make night air attacks / night CVCI without this flag. Default false. */
  nightAttacker?: boolean;
}

export interface FleetInput {
  /** 1..7 ships in order (index 0 = flagship). Combined fleet: the main fleet (主力). */
  ships: ShipInput[];
  /** Default "lineAhead"; combined friend fleet: one of the `combined*` formations, default
   *  "combinedBattle". */
  formation?: Formation;
  /** Friend combined fleet only: escort fleet (随伴), 1..6 ships. Requires `combined`. An enemy
   *  escort is a validation error (enemy combined fleets are not supported). */
  escort?: ShipInput[];
  /** Friend combined fleet type. Requires `escort`. */
  combined?: CombinedType;
}

export interface BattleOptions {
  /** Default "day". */
  kind?: BattleKind;
  /** Force the engagement form. Default: random (45% same, 15% T+, 30% head-on, 10% T-;
   *  T- becomes head-on if either fleet carries a Saiun). */
  engagement?: Engagement;
  /** runBattle only: record every attack in `result.events`. Default false. */
  log?: boolean;
}

/** One land-base wave: one base's squadrons (1..4). Each squadron is an EquipmentInput whose
 *  `planes` is the squadron size (default 18; recon categories 9/10/41/49/94: 4; large land-based
 *  bombers (category 53): 9). Proficiency/improvement apply. */
export interface LandBaseWave {
  squadrons: EquipmentInput[];
}

export interface BattleInput {
  friend: FleetInput;
  enemy: FleetInput;
  options?: BattleOptions;
  /** Land-base waves in order (max 6), resolved before the friend's air phase (not in night-only
   *  battles). Each wave starts from its own squadron sizes. */
  lbas?: LandBaseWave[];
}

// --------------------------------------------------------------- output ----

export interface ShipResult {
  maxHp: number;
  hpStart: number;
  hpEnd: number;
  sunk: boolean;
  damageState: DamageState;
  /** Damage dealt by this ship (overkill included, as in the game's MVP rule). */
  damageDealt: number;
  /** Master id of the damage control item consumed in this battle, if any. */
  dameconUsed?: number;
}

export interface AttackEvent {
  phase: Phase;
  kind: AttackKind;
  special: SpecialAttack;
  attackerSide: Side;
  /** Index in the attacker's fleet. Friend combined fleets: main ships first, then the escort.
   *  `landBase` events: index of the wave in the battle's wave list. */
  attacker: number;
  /** Index in the defender's fleet (the other side). */
  defender: number;
  /** True if the original target was the flagship and another ship covered it (かばう). */
  covered: boolean;
  /** Air attacks: slot index of the attacking aircraft (`landBase`: squadron index). */
  slot?: number;
  hit: HitResult;
  /** HP removed from the defender (after sinking protection; may exceed remaining HP). */
  damage: number;
  defenderHpBefore: number;
  defenderHpAfter: number;
  /** Model probability that this roll hits (normal or critical). */
  pHit: number;
  /** Model probability that this roll is a critical hit (subset of pHit). */
  pCrit: number;
}

export interface BattleResult {
  rank: Rank;
  /** Friend index of the (main-fleet) MVP (most damage dealt; flagship on ties at 0). */
  mvp: number;
  /** Friend combined fleet: index (into `friend`) of the escort fleet's MVP. */
  mvpEscort?: number;
  engagement: Engagement;
  airState: AirState;
  detection: Detection;
  /** True if the night phase was fought. */
  nightBattle: boolean;
  /** Damage gauges (戦果ゲージ) in integer percent: damage dealt to the enemy / taken by the friend. */
  enemyGauge: number;
  friendGauge: number;
  /** Per friend ship: main ships, then escort ships. */
  friend: ShipResult[];
  enemy: ShipResult[];
  /** Present when `options.log` is true. */
  events?: AttackEvent[];
}

/** Fleets after the battle: same shape as the input (a combined friend fleet keeps `escort` /
 *  `combined`), with hp, fuel, ammo, morale, plane counts, proficiency (reset to 0 for wiped
 *  slots) and consumed damage-control items updated. Feed `state.friend` into the next node's
 *  `BattleInput.friend`. */
export interface BattleState {
  friend: FleetInput;
  enemy: FleetInput;
}

export interface RunBattleOutput {
  result: BattleResult;
  state: BattleState;
}

export interface ShipSummary {
  maxHp: number;
  hpMean: number;
  /** Counts of end HP: index = HP (0..maxHp, 0 = sunk). Length maxHp + 1. */
  hpHistogram: number[];
  /** Rates in [0,1]; the five damage-state rates sum to 1. */
  sunkRate: number;
  heavyRate: number;
  moderateRate: number;
  lightRate: number;
  healthyRate: number;
  damageDealtMean: number;
  /** Friend ships only (0 for enemies). A combined fleet has two MVPs per battle (rates sum to 2). */
  mvpRate: number;
}

export interface SimulationSummary {
  count: number;
  /** Rates in [0,1]. */
  rankRates: Record<Rank, number>;
  airStateRates: Record<AirState, number>;
  nightBattleRate: number;
  enemyFlagshipSunkRate: number;
  /** Battles that ended with at least one friend ship heavily damaged (not sunk). */
  friendHeavyAnyRate: number;
  friendSunkAnyRate: number;
  /** Main ships, then escort ships. */
  friend: ShipSummary[];
  enemy: ShipSummary[];
}

// -------------------------------------------------------- forward model ----

export type QueryKind = "shelling" | "torpedo" | "night" | "asw" | "openingAsw" | "air";

/** Night-battle context seen from the attacker. */
export interface NightContext {
  /** Attacker's fleet fired a star shell. */
  ownStarshell?: boolean;
  /** Defender's fleet fired a star shell. */
  enemyStarshell?: boolean;
  /** Attacker's fleet has a lit searchlight. */
  ownSearchlight?: boolean;
  /** Defender's fleet has a lit searchlight. */
  enemySearchlight?: boolean;
  /** Accuracy stat of the attacker fleet's night-recon contact plane; absent = no contact. */
  nightContactAccuracy?: number;
}

export interface AttackQuery {
  kind: QueryKind;
  attacker: ShipInput;
  defender: ShipInput;
  /** Default "friend". Decides player-only rules (e.g. AA, protection) and side constants. */
  attackerSide?: Side;
  /** Default "lineAhead". */
  attackerFormation?: Formation;
  defenderFormation?: Formation;
  /** Vanguard rules depend on the ship index (0-based) and fleet size. Defaults 0 / 6. */
  attackerIndex?: number;
  attackerFleetSize?: number;
  defenderIndex?: number;
  defenderFleetSize?: number;
  /** Damage only. Default "sameCourse". */
  engagement?: Engagement;
  /** Accuracy / power modifiers of a special attack. Default "normal". */
  special?: SpecialAttack;
  /** kind="night" only. */
  night?: NightContext;
  /** kind="air": slot index of the attacking plane. Default: first bomber slot. */
  slot?: number;
  /** kind="air": contact (触接) multiplier 1 / 1.12 / 1.17 / 1.2. Default 1. */
  contactModifier?: number;
}

export interface HitProbability {
  /** Probability of hitting (normal or critical). */
  pHit: number;
  /** Probability of a critical hit (subset of pHit). */
  pCrit: number;
  /** Attacker hit term in percent (before subtracting evasion). */
  accuracy: number;
  /** Defender evasion term in percent. */
  evasion: number;
}

/**
 * `hitProbabilityGrid` input: `query` evaluated over the cartesian grid evasion × luck ×
 * hiddenAccuracy of one ship (estimator helper). Each axis replaces the target's naked
 * `stats.evasion` / `stats.luck` / `hiddenAccuracy`; an absent or empty axis keeps the query's value.
 * Result: `Uint8Array` of `[hit %, crit %]` pairs (`pHit = hit / 100`, `pCrit = crit / 100`, the
 * integer percents the game rolls against), index `2·((iEv·nLuck + iLuck)·nAcc + iAcc)`.
 */
export interface HitGridQuery {
  query: AttackQuery;
  target: "attacker" | "defender";
  evasion?: number[];
  luck?: number[];
  hiddenAccuracy?: number[];
}

export interface DamagePoint {
  damage: number;
  p: number;
}

export interface DamageDistribution {
  /** Mean of the distributions below (convenience). */
  meanHit: number;
  meanCritical: number;
  /** Damage distribution of one normal hit / one critical hit, before sinking protection.
   *  Probabilities sum to 1. Scratch damage is based on the defender's current `hp`. */
  hit: DamagePoint[];
  critical: DamagePoint[];
}

// --------------------------------------------------------------- sortie ----

/**
 * ROUTING_DSL document (docs/ROUTING_DSL.md) exactly as served by
 * `GET /api/v1/maps/{map}/routing`. Validated by the engine (unknown keys / metrics → Error).
 */
export interface RoutingDocument {
  map: string;
  defaults?: { select?: Record<string, string>; flags?: string[]; phase?: number; gauge?: number };
  /** Multi-start maps (5-6, 6-4, 6-5): rules evaluated like a node's, before the first move, whose
   *  destinations are the `Start*` nodes. */
  start?: { rules: unknown[]; note?: string };
  nodes: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Node kind. API `nodes[].type` values are accepted verbatim as aliases
 * (`night_battle`, `air_battle`, `air_raid`, `escort_success`, `air_recon`, `anchorage_repair`;
 * `whirlpool` = `maelstrom`). Any other string is treated as `empty` and reported in `warnings`.
 */
export type NodeKind =
  | "start"
  | "battle"
  | "boss"
  | "nightBattle"
  | "airBattle"
  | "airRaid"
  | "empty"
  | "select"
  | "resource"
  | "maelstrom"
  | "landing"
  | "escortSuccess"
  | "airRecon"
  | "anchorageRepair";

export interface EnemyComp {
  /** Relative weight (API `weight`); normalised over the node's comps. */
  weight: number;
  /** Enemy fleet in BattleInput `enemy` shape; `fleet.formation` is the enemy formation. */
  fleet: FleetInput;
}

export interface SortieNode {
  /** Missing/null: `battle` if `comps` are given, else `empty` (both reported in `warnings`). */
  kind?: NodeKind | null;
  /** Boss node (API `isBoss`); `kind: "boss"` implies it. A boss may be a night/air node. */
  boss?: boolean;
  /** Enemy comps of battle-type nodes. A battle-type node without comps is treated as empty. */
  comps?: EnemyComp[];
  /** `resource` / `landing` nodes: expected gain per visit (not applied to the ships). */
  resource?: ResourceAmounts;
  /** `maelstrom` nodes: loss definition. Without `rate` the node causes no loss (warned). */
  maelstrom?: Maelstrom;
  /** Fuel / ammo the node's battle consumes, as fractions of each ship's capacity (floored, at
   *  least 1 fuel; ammo +50 % rounded up after night pursuit). Default by node: 20 % / 20 %; night
   *  battle 10 % / 10 %; air raid 6 % / 4 %; submarines only 8 % / 0 % (a submarine boss 20 % / 20 %);
   *  PT imps only 4 % / 8 %. Set it for other node types, e.g. radar ambush `{ fuel: 0.04, ammo: 0 }`,
   *  anti-sub air raid `{ fuel: 0.12, ammo: 0.06 }`, 6-4 / 6-5 air raids `{ fuel: 0.04, ammo: 0.08 }`. */
  supply?: { fuel: number; ammo: number };
  /** Battle kind of the node, replacing the one from `kind` and the night policy (a battle-type
   *  node with comps still decides whether there is a battle). */
  battleKind?: BattleKind;
}

export interface ResourceAmounts {
  fuel?: number;
  ammo?: number;
  steel?: number;
  bauxite?: number;
}

/** Per-ship loss `min(max, floor(have × rate × (1 − radar reduction)))`; the radar reduction by the
 *  number of afloat ships carrying a small/large radar (`types[2]` 12/13) is
 *  0 / 25 / 40 / 50 / 55 / 58 / 60 % for 0…6+ ships. */
export interface Maelstrom {
  resource: "fuel" | "ammo";
  rate?: number;
  /** Per-ship cap. */
  max?: number;
  /** Strong maelstrom: with probability `highChance` (default 0) `rateHigh` is used instead. */
  rateHigh?: number;
  highChance?: number;
  /** Default true. */
  radarReducible?: boolean;
}

export interface SortieMap {
  routing: RoutingDocument;
  /** Node letter → node. Letters reached by routing but missing here are treated as empty. */
  nodes: Record<string, SortieNode>;
}

export interface SortieConfig {
  /** Force the start node (e.g. "Start2"). Default: picked per sortie by `routing.start` rules when
   *  the document has them, else "Start". An explicit value overrides the start rules. */
  start?: string;
  /** Player choices at `select` rules (node → letter). Must be one of the options. */
  selects?: Record<string, string>;
  /** Map-state flags; a flag not listed falls back to `routing.defaults.flags`, else false. */
  flags?: Record<string, boolean>;
  /** 0 normal maps, 1 丁 … 4 甲. Default 0. */
  difficulty?: number;
  /** Default `routing.defaults.phase`, else 1. */
  phase?: number;
  /** Current gauge number. Default `routing.defaults.gauge`, else 1. */
  gauge?: number;
  /** Node letter to evaluate instead of the boss: the sortie ends right after this node, and every
   *  boss output (`SortieSummary.boss.*`) and the gauge (kill / HP logic, default final comps) use
   *  this node's battle. Unknown letter → Error. Default: the map's boss node. Night policy
   *  `bossOnly` still refers to the real boss. */
  target?: string;
}

/** Night pursuit at day-battle nodes. `ifNotSRank` / `ifNotARank`: pursue only when the day result
 *  is worse than S / A. Night battles only happen while an enemy ship is afloat. */
export type NightPolicy = "never" | "bossOnly" | "always" | "ifNotSRank" | "ifNotARank";

export interface RetreatPolicy {
  /** Retreat when a ship is heavily damaged (大破撤退). Default true. A heavily damaged (main)
   *  flagship always ends the sortie; a combined fleet's escort flagship is ignored (it cannot
   *  sink). */
  onHeavy?: boolean;
  /** A heavily damaged non-flagship that still carries a damage-control item does not force a
   *  retreat. Default true. */
  allowDamecon?: boolean;
  /** Retreat when a ship is moderately damaged (中破撤退). Default false. */
  onModerate?: boolean;
  /** Evacuate (護衛退避) the one ship that would force a retreat, with the main flagship's
   *  command facility: 艦隊司令部施設 (id 107, combined fleets: the ship leaves with the first
   *  escort destroyer above 75 % HP), 遊撃部隊 艦隊司令部施設 (272, striking forces) or 精鋭水雷戦隊
   *  司令部 (413, torpedo squadrons): the ship leaves alone and loses 20 % of its max HP. Evacuated
   *  ships leave with empty fuel (and ammo with 413) and morale 49, and take no further part in
   *  battles, routing, TP or node effects. Two or more such ships still end the sortie. Default true. */
  useFcf?: boolean;
}

/** Choice after a node: `retreat` always returns there; `push` advances even with damaged ships
 *  (a heavily damaged main flagship still ends the sortie). */
export type Advance = "retreat" | "push";

export interface SortiePolicy {
  /** Per-node friend formation. Default: `lineAbreast` if every comp of the node is submarines
   *  only, else `lineAhead`; combined fleets `combinedAntiSub` / `combinedBattle`. A combined
   *  fleet needs `combined*` formations, a single fleet the others. */
  formations?: Record<string, Formation>;
  /** Default "bossOnly". */
  night?: NightPolicy;
  retreat?: RetreatPolicy;
  /** Node letter → advance choice (unknown letter → Error). Other nodes follow `retreat`. */
  advance?: Record<string, Advance>;
  /** Underway replenishment (洋上補給, `types[2]` 44) before the boss / target battle: the items on
   *  ships still in the fleet (max 3 used) refill every ship by 25 / 36 / 47 % (combined fleets
   *  15 / 27.5 / 40 %) of its capacity. Default true. */
  underway?: boolean;
  /** Combat rations (`types[2]` 43) are eaten before the boss / target battle: ration +10 morale and
   *  +2 to the neighbours, canned saury (id 150) +12 / +9 [unverified]. Default true. */
  rations?: boolean;
}

export interface GaugeInput {
  /** `kill`: a kill = the boss flagship sunk (any rank). `hp`: boss flagship damage depletes the gauge.
   *  `tp`: transport gauge; each sortie gains the fleet's TP at the boss (S/SS full, A × 0.7
   *  floored, else 0). Ignored when `phases` is given. */
  kind: "kill" | "hp" | "tp";
  /** Kills, HP or TP remaining. Ignored when `phases` is given. */
  remaining: number;
  /** HP gauge: boss comps of the final form (last dance). Default: the boss node's comps. */
  finalComps?: EnemyComp[];
  /** HP gauge: the final form appears when remaining ≤ this. Default: the largest flagship maxHp of
   *  the final comps. In the final form the flagship starts with min(maxHp, remaining) HP and the
   *  gauge breaks only when it sinks. */
  finalThreshold?: number;
  /** Monte-Carlo gauge runs. Default 200 (hp), 2000 (kill). */
  runs?: number;
  /** Sorties cap per run. Default 500. */
  maxSorties?: number;
  /** Carry morale from sortie to sortie (full sortie simulation per run, also for `kill`; default
   *  `runs` becomes 200). Absent: every sortie starts from the input morale. */
  morale?: GaugeMorale;
  /** `tp`: tank-force table of the event (KC3Kai `tpMultipliers.tankforce`): ship type and equipment
   *  TP × 0.75 / 0.8 plus the tank equipment's own TP. Default: no tank force. */
  tank?: TankType;
  /** `tp`: TP of a full-rank sortie, replacing the table lookup (the A-rank scaling still applies). */
  tpPerSortie?: number;
  /** Several gauges of one map, cleared one after another within each run (full sortie simulation;
   *  default `runs` 200). Sorties are counted over the whole run and `maxSorties` caps the run. When
   *  present it replaces `kind` / `remaining` / `finalComps` / `finalThreshold` / `tank` / `tpPerSortie`. */
  phases?: GaugePhase[];
}

export type TankType = "type1" | "type2" | "typeUnk";

export interface GaugePhase {
  kind: "kill" | "hp" | "tp";
  remaining: number;
  /** Boss comps of this gauge. Default: the boss node's comps. */
  comps?: EnemyComp[];
  finalComps?: EnemyComp[];
  finalThreshold?: number;
  /** Routing `phase` during this gauge. Default: the map's starting phase (`config.phase`, else
   *  `routing.defaults.phase`, else 1) + the gauge's index. */
  phase?: number;
  /** Routing `gauge` number during this gauge. Default: the starting gauge (`config.gauge`, else
   *  `routing.defaults.gauge`, else 1) + the gauge's index. */
  gauge?: number;
  tank?: TankType;
  tpPerSortie?: number;
}

/** Wait between two sorties: at least `waitMinutes`, and until every ship reaches `untilMorale`
 *  (capped at 49). Natural recovery is +3 per 3 minutes up to 49 (none at ≥ 49). Sunk ships are
 *  replaced by ships with the input morale. */
export interface GaugeMorale {
  waitMinutes?: number;
  untilMorale?: number;
}

/** A sortie land base: squadrons (as in `LandBaseWave`) and the node letters of its two waves
 *  (same letter twice = both waves at that node; empty = not sortied, e.g. 防空/待機). Squadron
 *  sizes reset every sortie; losses carry from node to node (two waves at one node both start
 *  from the sizes before that battle, kcsim). */
export interface LandBase {
  squadrons: EquipmentInput[];
  targets: string[];
}

export interface SortieInput {
  /** Friend fleet in its current state (as `RunBattleOutput.state.friend`), single or combined.
   *  `formation` is ignored (see `policy.formations`). Routing uses `shipType`, `id`, `speed`
   *  (api_soku after boosts; missing → 10 with a warning), naked LoS (`stats.los +
   *  equipBonus.los`), equipment `id`, `types[2]`, `stats.los`, `improvement`. */
  friend: FleetInput;
  /** Admiral (HQ) level for the LoS formula and the `hq` predicate. */
  hqLevel: number;
  map: SortieMap;
  config?: SortieConfig;
  policy?: SortiePolicy;
  gauge?: GaugeInput;
  /** Run the `count` sorties back to back (連続出撃): morale carries from one sortie to the next,
   *  recovering during the wait in between (same rules as `GaugeInput.morale`). The web worker
   *  splits runs into chunks, each starting from the input morale. Absent: independent sorties. */
  consecutive?: GaugeMorale;
  /** Guard against routing loops: maximum nodes per sortie (Start excluded). Default 20. */
  maxNodes?: number;
  /** Number of most frequent paths to report. Default 20. */
  topPaths?: number;
  /** Land bases (max 3; max 4 squadrons, max 2 targets each). At a node, waves run in base
   *  order, then each base's targets in order. Unknown target letters are warned about. */
  lbas?: LandBase[];
  /** The single friend fleet is a striking force (遊撃部隊): routing fleet type `striking`, and the
   *  272 command facility works. A 7-ship fleet always is one. A combined fleet cannot be. */
  striking?: boolean;
  repair?: RepairPolicy;
  /** Costs the engine does not model (support expeditions, ...): added to every sortie in
   *  `resourcesPerSortie` and `gauge.resources`. Not interpreted otherwise. */
  extraPerSortie?: ResourceAmounts;
}

export interface RepairPolicy {
  /** Ships whose docking time exceeds this many seconds take an instant repair item (bucket): no
   *  docking time for them, one bucket each; docking fuel and steel are still paid. Only affects the
   *  resource totals.
   *  Default: never. */
  bucketAboveSec?: number;
}

export interface PathRate {
  /** Node letters from the start node to the last node reached. */
  path: string[];
  rate: number;
}

export interface NodeSummary {
  /** Fraction of sorties that reached the node. */
  reachRate: number;
  /** Fraction of sorties that fought a battle there. */
  battleRate: number;
  /** Rank distribution of the battles fought there (conditional; zeros if none). */
  rankRates: Record<Rank, number>;
  /** Fraction of sorties that retreated (or were forced home) after this node, by reason. */
  retreatRate: number;
  retreatHeavyRate: number;
  retreatModerateRate: number;
  /** Fraction of the node's battles that went to night. */
  nightRate: number;
  /** Fraction of sorties that evacuated a ship (command facility) after this node. */
  fcfRate: number;
}

export interface SortieShipSummary {
  sunkRate: number;
  /** Damage state at the end of the sortie (sunk excluded). */
  heavyRate: number;
  moderateRate: number;
  /** Mean HP lost during the sortie and mean HP missing at the end (repair need). */
  damageTakenMean: number;
  hpMissingMean: number;
  fuelUsedMean: number;
  ammoUsedMean: number;
  /** Mean bauxite to refill lost aircraft per sortie (5 per plane, not reduced by marriage). */
  bauxiteMean: number;
  /** Mean number of aircraft slots wiped out (proficiency lost) per sortie. */
  proficiencyLostMean: number;
  /** Docking need at the end of the sortie (sunk ships: 0). */
  repair: RepairSummary;
  damecon: { usedRate: number };
  /** Fraction of sorties in which the ship was evacuated (retreating or escorting). */
  evacuatedRate: number;
}

export interface Dist {
  mean: number;
  p50: number;
  p90: number;
}

/** Docking cost per sortie: fuel / steel = floor(0.032 / 0.06 × fuelMax × HP lost); time in seconds =
 *  (Lv ≤ 11: 10·Lv, else 5·Lv + 10·floor(√(Lv−11)) + 50) × ship-type factor × HP lost + 30. */
export interface RepairSummary {
  fuel: Dist;
  steel: Dist;
  timeSec: Dist;
}

/** Fleet docking need: fuel / steel summed over ships; `timeSec` = slowest ship (parallel docks),
 *  `timeSecTotal` = sum (single dock). */
export interface FleetRepairSummary extends RepairSummary {
  timeSecTotal: Dist;
}

/** Net resources (costs minus gains from resource nodes; extras included). Per sortie: fuel / ammo =
 *  resupply (+ underway refill) + docking fuel + land bases, steel = docking steel + anchorage
 *  repair, bauxite = plane refill (ships and land bases), `timeSec` = slowest ship. Per gauge
 *  clear: the sum over the run's sorties (docking time summed, one dock). */
export interface ResourcesSummary {
  fuel: Dist;
  ammo: Dist;
  steel: Dist;
  bauxite: Dist;
  /** Instant repair items (`repair.bucketAboveSec`). */
  buckets: Dist;
  timeSec: Dist;
}

/** Present only when a node of the map has an effect configured. */
export interface NodeEffectsSummary {
  gainedMean: Required<ResourceAmounts>;
  /** Included in `fuelUsedMean` / `ammoUsedMean`. */
  maelstromFuelMean: number;
  maelstromAmmoMean: number;
  /** Anchorage repair: HP restored and repair materials used per sortie. */
  anchorageHpMean: number;
  anchorageMaterialsMean: number;
  /** Steel of the anchorage repairs (3 per HP restored, kancolle-replay). */
  anchorageSteelMean: number;
}

export interface GaugeSummary {
  kind: "kill" | "hp" | "tp";
  remaining: number;
  /** Mean sorties to clear over the runs that cleared; null if no run cleared. */
  expectedSorties: number | null;
  p50Sorties: number | null;
  p90Sorties: number | null;
  /** With `GaugeInput.morale`: minutes spent waiting between sorties per cleared run. */
  expectedWaitMinutes?: number;
  p50WaitMinutes?: number;
  p90WaitMinutes?: number;
  /** Resources spent per cleared run; absent when no run cleared. `kill` gauges are not simulated
   *  sortie by sortie: mean sortie cost × the sorties drawn. */
  resources?: ResourcesSummary;
  /** With `phases`: sorties spent in each gauge, over the cleared runs. */
  phases?: { kind: "kill" | "hp" | "tp"; expectedSorties: number | null; p90Sorties: number | null }[];
  /** Runs that hit `maxSorties` without clearing. */
  cappedRate: number;
  runs: number;
}

export interface SortieSummary {
  count: number;
  /** Most frequent full paths (descending), plus the rate of all other paths. */
  paths: PathRate[];
  otherPathsRate: number;
  nodes: Record<string, NodeSummary>;
  /** The boss node, or `config.target` when set. */
  boss: {
    reachRate: number;
    /** Rank distribution conditional on a boss battle. */
    rankRates: Record<Rank, number>;
    /** Per sortie: boss flagship sunk (kill-gauge progress; same as `flagshipSunkRate`). */
    killRate: number;
    /** Per sortie: boss flagship sunk (HP-gauge final kill). */
    flagshipSunkRate: number;
    /** Mean damage dealt to the boss flagship per sortie (0 when the boss is not reached). */
    flagshipDamageMean: number;
  };
  /** Fraction of sorties ending in a retreat (damage policy or `policy.advance`). */
  retreatRate: number;
  /** Fraction of sorties with at least one command-facility evacuation. */
  fcfRate: number;
  /** Underway replenishment items / combat rations used per sortie. */
  underwayUsedMean: number;
  rationsUsedMean: number;
  /** Land-base cost per sortie (inside `resourcesPerSortie`): sortie fuel / ammo of every base
   *  with a target (land attackers ⌈1.5n⌉ / ⌊0.7n⌋, large bombers ⌈2n⌉ / ⌈2n⌉, others ⌈n⌉ /
   *  ⌈0.6n⌉ for n planes), plus 3 fuel and 5 bauxite per plane lost. Present with land bases. */
  lbasCostMean?: Required<ResourceAmounts>;
  /** With `consecutive`: mean wait between two sorties (minutes). */
  waitMinutesMean?: number;
  /** Fraction of sorties in which at least one friend ship sank. */
  sunkRate: number;
  battlesMean: number;
  nodesMean: number;
  fuelUsedMean: number;
  ammoUsedMean: number;
  /** Fuel / ammo are resupply costs: ships of Lv ≥ 100 pay floor(0.85 × amount) (amount > 1). */
  bauxiteMean: number;
  repair: FleetRepairSummary;
  resourcesPerSortie: ResourcesSummary;
  effects?: NodeEffectsSummary;
  /** Main ships, then escort ships. */
  friend: SortieShipSummary[];
  gauge?: GaugeSummary;
  /** Deduplicated input/data problems met during the simulation (unknown node kinds, …). */
  warnings: string[];
}

// ------------------------------------------------------------ functions ----
// (declared by wasm-bindgen in pkg/sim_core.d.ts; repeated here for readers)
// export function simulateBattle(input: BattleInput, count: number, seed: number): SimulationSummary;
// export function runBattle(input: BattleInput, seed: number): RunBattleOutput;
// export function hitProbability(query: AttackQuery): HitProbability;
// export function damageDistribution(query: AttackQuery): DamageDistribution;
// export function hitProbabilityGrid(grid: HitGridQuery): Uint8Array;
// export function simulateSortie(input: SortieInput, count: number, seed: number): SortieSummary;
