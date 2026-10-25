/** private notes API §2 の応答型 (camelCase)。 */

export type NodeType =
  | "start" | "battle" | "boss" | "night_battle" | "air_battle" | "air_raid" | "night_to_day"
  | "empty" | "select" | "resource" | "maelstrom" | "landing" | "escort_success"
  | "air_recon" | "anchorage_repair" | null;

export interface MapSummary {
  id: number;
  key: string;
  world: number;
  no: number;
  name: string;
  isEvent: boolean;
  nodeCount: number;
  edgeCount: number;
  compSetCount: number;
  /** provenance: hand-authored rules, or inferred from poi sortie observations (older APIs / bundle indexes omit it) */
  routing: { ruleCount: number; uncertainCount: number; provenance?: RoutingProvenance } | null;
  /** 静的バンドルの索引から作った概算 (名前・ルール数が不明) */
  approx?: boolean;
}

export interface MapNode {
  letter: string;
  x: number | null;
  y: number | null;
  colorNo: number | null;
  eventId: number | null;
  eventKind: number | null;
  type: NodeType;
  isBoss: boolean;
  /** 基地航空隊の距離 (捕捉した api_cell_data の api_distance)。null / 省略は不明 (古い API・バンドル) */
  lbasDistance?: number | null;
}

export interface MapEdge {
  id: number;
  from: string;
  to: string;
}

export type RoutingProvenance = "hand" | "inferred";

/** Where `MapDetail.routing` comes from (private notes API §2). generatedAt / sortieCount only for inferred documents. */
export interface RoutingMeta {
  provenance: RoutingProvenance;
  generatedAt: string | null;
  sortieCount: number | null;
}

export interface MapDetail {
  map: {
    id: number;
    key: string;
    world: number;
    no: number;
    name: string;
    opetext?: string | null;
    isEvent: boolean;
    maxHp: number | null;
    requiredDefeatCount: number | null;
  };
  nodes: MapNode[];
  edges: MapEdge[];
  routing: RoutingDoc | null;
  /** null without routing; absent in static bundles and older APIs */
  routingMeta?: RoutingMeta | null;
  enemyCompNodes: string[];
}

// ---- ROUTING_DSL (private notes ROUTING_DSL) ----

export interface Predicate {
  m?: string;
  all?: Predicate[];
  any?: Predicate[];
  not?: Predicate;
  [param: string]: unknown;
}

export interface Rule {
  when?: Predicate;
  note?: string;
  uncertain?: boolean;
  source?: string;
  to?: string;
  random?: { to: string; p: number }[];
  los?: {
    cn: number;
    thresholds: { min: number; to: string }[];
    below: string;
    interpolate?: boolean;
  };
  select?: string[];
  rules?: Rule[];
}

export interface RoutingNode {
  rules?: Rule[];
  end?: boolean;
  note?: string;
}

export interface RoutingDoc {
  map: string;
  layout?: string;
  sources?: { id: string; note: string }[];
  defaults?: { select?: Record<string, string>; flags?: string[]; phase?: number; gauge?: number };
  /** 複数出撃地点の海域 (5-6, 6-4, 6-5): Start1/Start2… を選ぶ規則 (ROUTING_DSL §1)。 */
  start?: { rules: Rule[]; note?: string };
  nodes: Record<string, RoutingNode>;
}

// ---- enemy comps ----

export interface CompShip {
  shipId: number;
  level: number;
  hp: number;
  fp: number;
  tp: number;
  aa: number;
  ar: number;
  equips: number[];
}

export interface EnemyComp {
  id: number;
  kcnavMasterId?: number | null;
  formation: number | null;
  count: number;
  weight: number;
  /** KCNav のみ。観測 (poi-observed) の編成は null */
  airpower: number[] | null;
  lbasAirpower?: number[];
  main: CompShip[];
  escort: CompShip[];
  /** poi-observed のみ: 最初・最後に観測した日時 */
  firstSeen?: string;
  lastSeen?: string;
}

export interface EnemyCompSet {
  difficulty: number;
  periodStart: string | null;
  periodEnd: string | null;
  totalCount: number;
  retrievedAt: string;
  /** "kcnav" | "poi-observed" (自分たちの観測の集計) など */
  source: string;
  /** poi-observed のみ: 海域レイアウトの版と、このノードにまとめたマス番号 */
  layout?: number;
  cells?: number[];
  comps: EnemyComp[];
}

/** 難易度ごとの出典の選択 (観測数 ≥ minObserved なら poi-observed、でなければ KCNav)。 */
export interface CompSelection {
  difficulty: number;
  source: string | null;
  observedCount: number;
  minObserved: number;
}

/** `enemyComps` of `GET /api/v1/views/map/{map}`: every node's picked sets. */
export interface EnemyCompsResponse {
  map: string;
  minObserved: number;
  nodes: Record<string, { sets: EnemyCompSet[]; selection: CompSelection[] }>;
}

// ---- ships / equipment ----

export interface ApiShip {
  id: number;
  name: string;
  nameEn: string | null;
  yomi: string | null;
  stype: number;
  ctype: number | null;
  speed: number | null;
  range: number | null;
  slotNum: number | null;
  isAbyssal: boolean;
  hp: number | null;
  fp: number | null;
  tp: number | null;
  aa: number | null;
  ar: number | null;
  luck: number | null;
  maxStats: unknown;
  slots: number[] | null;
  equips: number[] | null;
  flags: unknown;
}

export type Confidence = "observed" | "datamined" | "db_estimate" | "placeholder" | "unknown";
/**
 * 隠しステータス。`acc` = 全攻撃に効く汎用の隠し命中 (推定器だけが出す) → hiddenAccuracy、
 * `tacc` = 雷撃だけに効く基礎命中 (kcsim TACC) → torpedoAccuracy (private notes API §2)。
 */
export type HiddenStat = "ev" | "asw" | "los" | "luck" | "acc" | "tacc";

export interface ShipEstimate {
  stat: HiddenStat;
  value: number;
  confidence: Confidence;
  sd: number | null;
  n: number | null;
  /** 推定器 (estimator:server) の 90% 信用区間。それ以外の出典は null */
  ci90?: [number, number] | null;
  source: string;
  note: string | null;
  updatedAt: string;
}

/** サーバが観測から推定する隠しステータス (`GET /api/v1/estimates`)。acc は sim-core の hiddenAccuracy。 */
export type EstimatedStat = "ev" | "acc" | "luck";

/** サーバの推定値の出典 (`estimates.source` / `best.*.source`)。 */
export const SERVER_ESTIMATOR_SOURCE = "estimator:server";

/** `best` / シミュレーションにサーバの推定値を使う最小観測数 (サーバが ships の estimates に載せる条件と同じ)。 */
export const ESTIMATE_MIN_N = 30;

/** 事前分布の出どころ。 */
export interface EstimatePrior {
  /** API の estimates.source。値が無いときは "flat" */
  source: string;
  confidence: Confidence | "none";
  value: number | null;
  /** グリッド上の事前分布の標準偏差 (平坦なら一様分布の sd) */
  sd: number;
}

/** グリッド上の周辺分布 (値 = min + i·step、確率の和 1)。 */
export interface EstimateDensity {
  min: number;
  step: number;
  posterior: number[];
  prior: number[];
}

export interface EstimateRow {
  shipId: number;
  stat: EstimatedStat;
  /** 事後平均 */
  mean: number;
  /** 事後標準偏差 */
  sd: number;
  /** 等裾 90% 信用区間 */
  ci90: [number, number];
  /** この値に効いた命中判定の数 (ev: 被弾側, acc: 攻撃側, luck: 両方) */
  n: number;
  priorSource: string;
  prior: EstimatePrior;
  /** `density=1` を付けた (shipId 指定の) 問い合わせだけ */
  density?: EstimateDensity;
  updatedAt: string;
}

export interface EstimatesResponse {
  source: string;
  /** サーバが最後に推定した時刻。まだ無ければ null */
  updatedAt: string | null;
  estimates: EstimateRow[];
}

export interface ShipDetail {
  ship: ApiShip;
  estimates: ShipEstimate[];
  best: Partial<Record<HiddenStat, { value: number; confidence: Confidence; source: string }>>;
}

export interface ApiEquipment {
  id: number;
  name: string;
  type: number[];
  typeId: number;
  icon: number | null;
  fp: number;
  tp: number;
  aa: number;
  ar: number;
  bomb: number;
  asw: number;
  los: number;
  acc: number;
  ev: number;
  luck: number;
  range: number | null;
  radius: number | null;
  cost: number | null;
  isAbyssal: boolean;
}

// ---- static bundle (private notes API §5) ----

export interface MapBundle {
  format: "kc-sim-map-bundle";
  version: number;
  generatedAt: string;
  map: MapDetail["map"];
  nodes: MapNode[];
  edges: MapEdge[];
  routing: RoutingDoc | null;
  /** node letter → API と同じ出典ポリシーで選んだ set (難易度ごと) */
  enemyComps: Record<string, EnemyCompSet[]>;
  enemyCompSelection?: Record<string, CompSelection[]>;
  /** 平坦な `Ship & {estimates, best}` (private notes API §5)。ShipDetail 形にも対応 */
  ships: Record<string, ShipDetail | (ShipDetail["ship"] & Pick<ShipDetail, "estimates" | "best">)>;
  equipments: Record<string, ApiEquipment>;
}
