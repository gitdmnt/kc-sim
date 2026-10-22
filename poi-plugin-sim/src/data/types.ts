/** docs/API.md §2 の応答型 (camelCase)。 */

export type NodeType =
  | "start" | "battle" | "boss" | "night_battle" | "air_battle" | "air_raid"
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
  routing: { ruleCount: number; uncertainCount: number } | null;
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
}

export interface MapEdge {
  id: number;
  from: string;
  to: string;
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
  enemyCompNodes: string[];
}

// ---- ROUTING_DSL (docs/ROUTING_DSL.md) ----

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

export interface EnemyCompsResponse {
  map: string;
  node: string;
  sets: EnemyCompSet[];
  minObserved?: number;
  selection?: CompSelection[];
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
 * `tacc` = 雷撃だけに効く基礎命中 (kcsim TACC) → torpedoAccuracy (docs/API.md §2)。
 */
export type HiddenStat = "ev" | "asw" | "los" | "luck" | "acc" | "tacc";

export interface ShipEstimate {
  stat: HiddenStat;
  value: number;
  confidence: Confidence;
  sd: number | null;
  n: number | null;
  source: string;
  note: string | null;
  updatedAt: string;
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

// ---- static bundle (docs/API.md §5) ----

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
  /** 平坦な `Ship & {estimates, best}` (API.md §5)。ShipDetail 形にも対応 */
  ships: Record<string, ShipDetail | (ShipDetail["ship"] & Pick<ShipDetail, "estimates" | "best">)>;
  equipments: Record<string, ApiEquipment>;
}
