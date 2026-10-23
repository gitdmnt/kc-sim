//! Sortie (海域周回) simulator: routing evaluator + chained battles with state carry-over,
//! retreat policy with command-facility evacuation (護衛退避), node effects, land-base waves,
//! resource accounting and gauge estimation. Contract: docs/SIM_INTERFACE.md "Sortie".
//! A combined friend fleet is carried node to node as one side (main ships, then escort ships).

pub mod model;
pub mod resource;
pub mod tp;

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::rc::Rc;

use crate::battle::lbas::{initial_planes, LandBaseCore, LbPlanes};
use crate::battle::{validate_fleet, validate_friend, Battle, BattleSetup, FleetCore};
use crate::equipment::cat;
use crate::model::{BattleKind, CombinedType, Formation, Rank, RankRates, ShipInput};
use crate::rng::Rng;
use crate::routing::{RouteConfig, RouteCtx, RouteEquip, RouteShip, Router};
use crate::ship::ShipState;
use model::*;
use resource::*;
use tp::ShipTp;

/// Land bases of a sortie.
const MAX_BASES: usize = 3;
/// Friend ships of a sortie (7 main + 6 escort); bit masks of evacuated ships fit in a `u16`.
const MAX_FRIEND: usize = 13;

/// PT imp packs (kancolle-replay `kcSHIPDATA.js` `isPT`): a node of only these costs 4 % / 8 %.
const PT_IDS: [u32; 5] = [1637, 1638, 1639, 1640, 2192];
/// `api_type[2]` of combat rations and of underway replenishment (補給物資).
const CAT_RATION: u32 = 43;
const CAT_UNDERWAY: u32 = 44;
/// `api_type[2]` of the ship repair facility (艦艇修理施設).
const CAT_SRF: u32 = 31;
/// Canned saury (秋刀魚の缶詰), a ration with a larger morale gain.
const SAURY: u32 = 150;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NodeBattle {
    Day,
    Night,
    Air,
    Raid,
}

struct Comp {
    core: FleetCore,
    init: Vec<ShipState>,
    formation: Formation,
    flagship_max_hp: i32,
    /// Every ship is a PT imp pack.
    pt_only: bool,
}

/// One gauge of a gauge run with its comps already built.
struct PhaseRun {
    kind: GaugeKind,
    remaining: f64,
    boss_set: Option<CompSet>,
    final_set: Option<CompSet>,
    threshold: f64,
    routing_phase: Option<f64>,
    routing_gauge: Option<f64>,
    tank: usize,
    tp_override: Option<f64>,
}

struct CompSet {
    comps: Vec<Comp>,
    cum: Vec<f64>,
}

impl CompSet {
    fn new(what: &str, comps: &[EnemyComp]) -> Result<CompSet, String> {
        let mut out = Vec::with_capacity(comps.len());
        let mut cum = Vec::with_capacity(comps.len());
        let mut total = 0.0;
        for (i, c) in comps.iter().enumerate() {
            if !c.weight.is_finite() || c.weight < 0.0 {
                return Err(format!("{what} comp #{i}: weight must be a non-negative number"));
            }
            validate_fleet(&format!("{what} comp #{i}"), &c.fleet, false)?;
            let (core, init) = FleetCore::build(&c.fleet, false);
            let flagship_max_hp = core.ships[0].max_hp;
            let pt_only = c.fleet.ships.iter().all(|s| s.id.is_some_and(|id| PT_IDS.contains(&id)));
            total += c.weight;
            cum.push(total);
            out.push(Comp { core, init, formation: c.fleet.formation.unwrap_or_default(), flagship_max_hp, pt_only });
        }
        if out.is_empty() || total <= 0.0 {
            return Err(format!("{what}: comps need a positive total weight"));
        }
        Ok(CompSet { comps: out, cum })
    }

    fn pick(&self, rng: &mut Rng) -> &Comp {
        let u = rng.f64() * self.cum[self.cum.len() - 1];
        let i = self.cum.iter().position(|&c| c > u).unwrap_or(self.comps.len() - 1);
        &self.comps[i]
    }

    /// Every comp consists of submarines only.
    fn all_subs(&self) -> bool {
        self.comps.iter().all(|c| c.core.ships.iter().zip(&c.init).filter(|(_, s)| s.hp > 0).all(|(s, _)| s.class.is_sub()))
    }
}

enum Effect {
    None,
    Gain(ResourceAmounts),
    Maelstrom(Maelstrom),
    Anchorage,
}

struct NodeInfo {
    effect: Effect,
    battle: Option<(NodeBattle, CompSet)>,
    /// Boss node of the map (night policy `bossOnly`).
    boss: bool,
    /// Node whose battle feeds the boss outputs and the gauge: `config.target`, else the boss.
    goal: bool,
    /// Landing node (揚陸地点): TP is delivered on arrival when it is the goal and has no battle.
    landing: bool,
    formation: Formation,
    /// `node.supply`: fuel / ammo fractions of the battle.
    supply: Option<[f64; 2]>,
    advance: Option<Advance>,
    warning: Option<String>,
    /// Land-base waves at this node: base index per wave, in base order then target order.
    lb_waves: Vec<usize>,
}

/// Command facility of the main flagship (kancolle-replay `canContinue` / `getFCFShips`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fcf {
    None,
    /// 艦隊司令部施設 (107) in a combined fleet: the ship leaves with a healthy escort destroyer.
    Combined,
    /// 遊撃部隊 艦隊司令部施設 (272) in a striking force, or 精鋭水雷戦隊 司令部 (413) in a torpedo
    /// squadron: the ship leaves alone, losing 20 % of its max HP (and its ammo with 413).
    Single { ammo: bool },
}

/// Anchorage repair ship (kancolle-replay `_doAnchorageRepair`).
struct Repairer {
    ship: usize,
    rate: f64,
    /// Fleet positions it repairs.
    covered: Vec<usize>,
}

/// Prepared sortie (static derivations done once).
pub struct Sortie {
    router: Router,
    nodes: Vec<NodeInfo>,
    /// Friend fleet (main ships, then escort ships).
    friend: FleetCore,
    init: Vec<ShipState>,
    route_ships: Vec<RouteShip>,
    striking: bool,
    /// Fixed start node; `None` = picked per sortie by the routing document's start rules.
    start: Option<usize>,
    /// `config.target`: the sortie ends right after this node.
    target: Option<usize>,
    max_nodes: usize,
    night: NightPolicy,
    retreat: RetreatPolicy,
    fcf: Fcf,
    lbas: Vec<LandBaseCore>,
    lb_init: LbPlanes,
    /// Bases that sortie (a target in the routing document): their sortie cost is paid every sortie.
    lb_sortied: Vec<bool>,
    warnings: Vec<String>,
    stypes: Vec<u32>,
    married: Vec<bool>,
    radar: Vec<bool>,
    repairers: Vec<Repairer>,
    /// Underway replenishment items per ship (`None`: policy off or none equipped).
    underway: Option<Vec<u32>>,
    /// Rations per ship: (items, morale for the ship, morale for its neighbours).
    rations: Vec<(u32, i32, i32)>,
    has_effects: bool,
    /// Per-ship TP parts; `Some` when a gauge of kind `tp` is configured.
    tp_ships: Option<Vec<ShipTp>>,
    bucket_above: Option<f64>,
    extra: [f64; 4],
    /// Resource vector of the last `run_one` (see `Cost`).
    last_cost: Cell<Cost>,
    /// Friend fleets without the evacuated ships, by evacuation mask.
    sub_fleets: RefCell<Vec<(u16, Rc<FleetCore>)>>,
}

/// Net resources of one sortie: fuel, ammo, steel, bauxite, buckets, docking seconds.
type Cost = [f64; 6];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Retreat {
    Heavy,
    Moderate,
    /// `policy.advance` = `retreat` at the node.
    Choice,
}

/// Boss battle of one sortie.
#[derive(Clone, Copy)]
struct BossResult {
    rank: Rank,
    /// Flagship sunk (a kill on a kill gauge).
    sunk: bool,
    /// Damage dealt to the flagship.
    damage: i32,
    /// Fleet TP after the battle per tank mode (`tp::mode`); zeros unless a gauge needs TP.
    tp: [i32; 3],
}

/// Per-sortie extras of `run_one` that only the cost and the records need.
#[derive(Default)]
struct Extras {
    gain: [f64; 4],
    /// Underway refill per ship (fuel, ammo): paid without the marriage discount.
    refill: Vec<(i32, i32)>,
    underway_used: u32,
    rations_used: u32,
    anchorage_hp: f64,
    anchorage_used: f64,
    lb_left: LbPlanes,
}

#[derive(Default)]
struct ShipRec {
    sunk: u32,
    heavy: u32,
    moderate: u32,
    damage_taken: f64,
    hp_missing: f64,
    fuel: f64,
    ammo: f64,
    damecon: u32,
    bauxite: f64,
    prof_lost: f64,
    evacuated: u32,
    rep_fuel: Vec<f64>,
    rep_steel: Vec<f64>,
    rep_time: Vec<f64>,
}

#[derive(Default)]
struct Rec {
    reach: Vec<u32>,
    battle: Vec<u32>,
    ranks: Vec<[u32; 7]>,
    retreat: Vec<u32>,
    retreat_heavy: Vec<u32>,
    retreat_moderate: Vec<u32>,
    night: Vec<u32>,
    fcf_node: Vec<u32>,
    paths: HashMap<Vec<u16>, u32>,
    boss_reach: u32,
    boss_ranks: [u32; 7],
    kills: u32,
    flag_sunk: u32,
    flag_damage: f64,
    retreats: u32,
    fcf: u32,
    sunk_any: u32,
    battles: u64,
    nodes: u64,
    ships: Vec<ShipRec>,
    fleet_fuel: Vec<f64>,
    fleet_steel: Vec<f64>,
    fleet_time_max: Vec<f64>,
    fleet_time_sum: Vec<f64>,
    costs: Vec<Cost>,
    gain: [f64; 4],
    mael_fuel: f64,
    mael_ammo: f64,
    anchorage_hp: f64,
    anchorage_mat: f64,
    underway_used: f64,
    rations_used: f64,
    lb_cost: [f64; 3],
    warnings: BTreeSet<String>,
}

fn route_ship(s: &ShipInput) -> RouteShip {
    let mut equips = Vec::new();
    for e in s.slots.iter().flatten().chain(s.ex_slot.iter()) {
        equips.push(RouteEquip {
            id: e.id,
            cat: e.types.get(2).copied().unwrap_or(0),
            los: e.stats.as_ref().and_then(|x| x.los).unwrap_or(0.0),
            level: e.improvement.unwrap_or(0) as f64,
        });
    }
    RouteShip {
        stype: s.ship_type,
        id: s.id.unwrap_or(0),
        speed: s.speed.unwrap_or(10.0),
        naked_los: s.stats.los.unwrap_or(0.0) + s.equip_bonus.as_ref().and_then(|b| b.los).unwrap_or(0.0),
        equips,
    }
}

fn rank_idx(r: Rank) -> usize {
    r as usize
}

fn rank_rates(c: &[u32; 7]) -> RankRates {
    let n: u32 = c.iter().sum();
    let r = |x: u32| if n > 0 { x as f64 / n as f64 } else { 0.0 };
    RankRates { ss: r(c[0]), s: r(c[1]), a: r(c[2]), b: r(c[3]), c: r(c[4]), d: r(c[5]), e: r(c[6]) }
}

fn equips(s: &ShipInput) -> impl Iterator<Item = &crate::model::EquipmentInput> {
    s.slots.iter().flatten().chain(s.ex_slot.iter())
}

/// kancolle-replay `Fleet.isTorpedoSquadron`: CL/DD flagship, the rest DD or CLT (≤ 3 CLT), at
/// least one DD.
fn torpedo_squadron(stypes: &[u32]) -> bool {
    let rest = &stypes[1..];
    matches!(stypes[0], 2 | 3)
        && rest.iter().all(|&t| t == 2 || t == 4)
        && rest.iter().filter(|&&t| t == 4).count() <= 3
        && stypes.contains(&2)
}

/// kancolle-replay `_doAnchorageRepair`: the first Akashi Kai (187, 30 %), Asahi Kai (958, 28 %)
/// or Akitsushima Kai (450, 25 %) outside the main flagship's seat with a ship repair facility;
/// each facility slot covers three seats of the main or escort fleet.
fn repairers(ships: &[&ShipInput], es: usize, combined: bool) -> Vec<Repairer> {
    let n = ships.len();
    let main = |a: usize, b: usize| (a..b.min(es)).collect::<Vec<_>>();
    let escort = |a: usize, b: usize| if combined { ((es + a)..(es + b).min(n)).collect() } else { Vec::new() };
    let mut out = Vec::new();
    for id in [187, 958, 450] {
        for (i, s) in ships.iter().enumerate().skip(1).filter(|(_, s)| s.id == Some(id)) {
            let srf = |k: usize| s.slots.get(k).and_then(|e| e.as_ref()).is_some_and(|e| e.types.get(2) == Some(&CAT_SRF));
            if !(0..4).any(srf) {
                continue;
            }
            let (rate, seats): (f64, [Vec<usize>; 4]) = match id {
                187 => (0.30, [main(0, 3), main(3, 7), escort(0, 3), escort(3, 6)]),
                958 => (0.28, [escort(0, 3), escort(3, 6), main(3, 7), Vec::new()]),
                _ => (0.25, [escort(0, 3), escort(3, 6), Vec::new(), Vec::new()]),
            };
            let covered = (0..4).filter(|&k| srf(k)).flat_map(|k| seats[k].clone()).collect();
            out.push(Repairer { ship: i, rate, covered });
        }
    }
    out
}

impl Sortie {
    pub fn new(input: &SortieInput) -> Result<Sortie, String> {
        validate_friend(&input.friend)?;
        let combined = input.friend.combined;
        let striking = combined.is_none() && (input.striking.unwrap_or(false) || input.friend.ships.len() == 7);
        if combined.is_some() && input.striking == Some(true) {
            return Err("striking: a combined fleet cannot be a striking force".to_string());
        }
        let bases = input.lbas.as_deref().unwrap_or(&[]);
        if bases.len() > MAX_BASES {
            return Err(format!("lbas: {} land bases (max {MAX_BASES})", bases.len()));
        }
        let mut lbas = Vec::with_capacity(bases.len());
        for (i, b) in bases.iter().enumerate() {
            if b.targets.len() > 2 {
                return Err(format!("lbas #{i}: {} targets (max 2)", b.targets.len()));
            }
            lbas.push(LandBaseCore::new(&format!("lbas #{i}"), &b.squadrons)?);
        }
        let mut warnings = Vec::new();
        let cfg = RouteConfig {
            hq: input.hq_level,
            difficulty: input.config.difficulty.unwrap_or(0.0),
            phase: input.config.phase,
            gauge: input.config.gauge,
            flags: input.config.flags.clone(),
            selects: input.config.selects.clone(),
        };
        let mut map_nodes: Vec<String> = input.map.nodes.keys().cloned().collect();
        map_nodes.sort();
        let router = Router::compile(&input.map.routing, &map_nodes, &cfg)?;
        // Explicit config.start wins; else the document's start rules pick per sortie; else `Start`.
        let start = match &input.config.start {
            Some(name) => Some(router.index(name).ok_or_else(|| format!("start node '{name}' is not in the routing document"))?),
            None if router.has_start_rules() => None,
            None => Some(router.index("Start").ok_or("routing has neither a 'Start' node nor top-level start rules; set config.start")?),
        };
        let target = match &input.config.target {
            Some(t) => Some(router.index(t).ok_or_else(|| format!("config.target: node '{t}' is not in the routing document"))?),
            None => None,
        };
        for letter in input.policy.advance.keys() {
            if router.index(letter).is_none() {
                return Err(format!("policy.advance.{letter}: node is not in the routing document"));
            }
        }

        let mut nodes = Vec::with_capacity(router.len());
        for i in 0..router.len() {
            let letter = router.name(i).to_string();
            let mut warning = None;
            let mut battle = None;
            let mut boss = false;
            let mut landing = false;
            let mut supply = None;
            let mut effect = Effect::None;
            match input.map.nodes.get(&letter) {
                None => {
                    if !letter.starts_with("Start") {
                        warning = Some(format!("node {letter} is not in map.nodes; treated as empty"));
                    }
                }
                Some(n) => {
                    boss = n.boss.unwrap_or(false) || n.kind == Some(NodeKind::Boss);
                    landing = n.kind == Some(NodeKind::Landing);
                    supply = n.supply.map(|s| [s.fuel, s.ammo]);
                    match n.kind {
                        Some(NodeKind::Resource | NodeKind::Landing) => {
                            if let Some(r) = n.resource {
                                effect = Effect::Gain(r);
                            }
                        }
                        Some(NodeKind::Maelstrom) => {
                            if let Some(m) = &n.maelstrom {
                                if m.rate.is_none() {
                                    warning = Some(format!("node {letter}: maelstrom has no rate; no loss applied"));
                                } else {
                                    effect = Effect::Maelstrom(m.clone());
                                }
                            }
                        }
                        Some(NodeKind::AnchorageRepair) => effect = Effect::Anchorage,
                        _ => {}
                    }
                    let has_comps = n.comps.as_ref().is_some_and(|c| !c.is_empty());
                    let kind = match n.kind {
                        Some(NodeKind::Battle | NodeKind::Boss) => Some(NodeBattle::Day),
                        Some(NodeKind::NightBattle) => Some(NodeBattle::Night),
                        Some(NodeKind::AirBattle) => Some(NodeBattle::Air),
                        Some(NodeKind::AirRaid) => Some(NodeBattle::Raid),
                        Some(NodeKind::Unknown) => {
                            warning = Some(format!("node {letter}: unknown kind; treated as empty"));
                            None
                        }
                        Some(_) => None,
                        None if has_comps => {
                            warning = Some(format!("node {letter}: no kind; treated as a battle node (it has comps)"));
                            Some(NodeBattle::Day)
                        }
                        None => {
                            if !letter.starts_with("Start") {
                                warning = Some(format!("node {letter}: no kind; treated as empty"));
                            }
                            None
                        }
                    };
                    if let Some(k) = kind {
                        if has_comps {
                            battle = Some((k, CompSet::new(&format!("node {letter}"), n.comps.as_ref().unwrap())?));
                        } else {
                            warning = Some(format!("node {letter}: battle node without enemy comps; treated as empty"));
                        }
                    }
                }
            }
            let formation = match input.policy.formations.get(&letter) {
                Some(&f) => {
                    if f.is_combined() != combined.is_some() {
                        return Err(format!(
                            "policy.formations.{letter}: {} fleet cannot use formation {f:?}",
                            if combined.is_some() { "a combined" } else { "a single" }
                        ));
                    }
                    f
                }
                None => {
                    let subs = battle.as_ref().is_some_and(|(_, cs)| cs.all_subs());
                    match (combined.is_some(), subs) {
                        (false, true) => Formation::LineAbreast,
                        (false, false) => Formation::LineAhead,
                        (true, true) => Formation::CombinedAntiSub,
                        (true, false) => Formation::CombinedBattle,
                    }
                }
            };
            let lb_waves =
                bases.iter().enumerate().flat_map(|(b, base)| base.targets.iter().filter(|t| **t == letter).map(move |_| b)).collect();
            let goal = target.map_or(boss, |t| t == i);
            let advance = input.policy.advance.get(&letter).copied();
            nodes.push(NodeInfo { effect, battle, boss, goal, landing, formation, supply, advance, warning, lb_waves });
        }
        let mut lb_sortied = vec![false; bases.len()];
        for (i, b) in bases.iter().enumerate() {
            for t in &b.targets {
                if router.index(t).is_none() {
                    warnings.push(format!("lbas #{i}: target node {t} is not in the routing document; ignored"));
                } else {
                    lb_sortied[i] = true;
                }
            }
        }

        let (friend, init) = FleetCore::build(&input.friend, true);
        let ships: Vec<&ShipInput> = input.friend.ships.iter().chain(input.friend.escort_ships()).collect();
        for (i, s) in ships.iter().enumerate() {
            if s.speed.is_none() {
                warnings.push(format!("friend ship #{i} has no speed; routing assumes fast (10)"));
            }
            if s.level.is_none() || s.fuel_max.is_none() {
                warnings.push(format!("friend ship #{i} has no level/fuelMax; docking cost and time assume Lv1 / fuelMax 100"));
            }
        }
        let stypes: Vec<u32> = ships.iter().map(|s| s.ship_type).collect();
        let es = friend.escort_start;
        let flag_has = |id: u32| equips(ships[0]).any(|e| e.id == id);
        let fcf = if combined.is_some() && flag_has(107) {
            Fcf::Combined
        } else if striking && flag_has(272) {
            Fcf::Single { ammo: false }
        } else if combined.is_none() && flag_has(413) && torpedo_squadron(&stypes) {
            Fcf::Single { ammo: true }
        } else {
            Fcf::None
        };
        let radar = ships.iter().map(|s| equips(s).any(|e| matches!(e.types.get(2), Some(12 | 13)))).collect();
        let underway_items: Vec<u32> = ships.iter().map(|s| equips(s).filter(|e| e.types.get(2) == Some(&CAT_UNDERWAY)).count() as u32).collect();
        let underway = (input.policy.underway.unwrap_or(true) && underway_items.iter().any(|&n| n > 0)).then_some(underway_items);
        let rations = if input.policy.rations.unwrap_or(true) {
            ships
                .iter()
                .map(|s| {
                    // Older wikiwiki figures [unverified]: ration +10 (8–12) / neighbours +2,
                    // canned saury +12 / +9; they add up.
                    equips(s).filter(|e| e.types.get(2) == Some(&CAT_RATION)).fold((0, 0, 0), |(n, me, nb), e| {
                        let (a, b) = if e.id == SAURY { (12, 9) } else { (10, 2) };
                        (n + 1, me + a, nb + b)
                    })
                })
                .collect()
        } else {
            vec![(0, 0, 0); ships.len()]
        };
        let wants_tp = input.gauge.as_ref().is_some_and(|g| g.kind == GaugeKind::Tp || g.phases.iter().flatten().any(|p| p.kind == GaugeKind::Tp));
        if wants_tp {
            for (i, s) in ships.iter().enumerate() {
                if tp::stype_tp(s.ship_type).is_none() {
                    warnings.push(format!("friend ship #{i}: ship type {} has no TP in the source table; counted as 0", s.ship_type));
                }
            }
        }
        let has_effects = nodes.iter().any(|n| !matches!(n.effect, Effect::None));
        Ok(Sortie {
            married: friend.ships.iter().map(|c| c.level >= MARRIED_LEVEL).collect(),
            repairers: repairers(&ships, es, combined.is_some()),
            stypes,
            radar,
            underway,
            rations,
            has_effects,
            bucket_above: input.repair.and_then(|r| r.bucket_above_sec),
            extra: input.extra_per_sortie.map_or([0.0; 4], |e| [e.fuel, e.ammo, e.steel, e.bauxite]),
            last_cost: Cell::new([0.0; 6]),
            tp_ships: wants_tp.then(|| ships.iter().map(|s| tp::ship_tp(s)).collect()),
            route_ships: ships.iter().map(|s| route_ship(s)).collect(),
            striking,
            router,
            nodes,
            friend,
            init,
            start,
            target,
            max_nodes: input.max_nodes.unwrap_or(20) as usize,
            night: input.policy.night,
            retreat: input.policy.retreat.clone(),
            fcf,
            lb_init: initial_planes(&lbas),
            lb_sortied,
            lbas,
            warnings,
            sub_fleets: RefCell::new(Vec::new()),
        })
    }

    /// Counted routing ships (afloat, not evacuated): main fleet, then escort. Returns the
    /// main-fleet count.
    fn counted<'s>(&'s self, st: &[ShipState], gone: u16, out: &mut Vec<&'s RouteShip>) -> usize {
        let es = self.friend.escort_start;
        let mut main = 0;
        for (i, (r, s)) in self.route_ships.iter().zip(st).enumerate() {
            if s.hp > 0 && gone & (1 << i) == 0 {
                out.push(r);
                if i < es {
                    main += 1;
                }
            }
        }
        main
    }

    fn route_ctx<'a>(&self, ships: &'a [&'a RouteShip], main: usize, visited: &'a [usize]) -> RouteCtx<'a> {
        RouteCtx { ships, main, combined: self.combined(), striking: self.striking, visited }
    }

    fn combined(&self) -> Option<CombinedType> {
        self.friend.combined
    }

    /// The friend fleet without the ships in `gone` (cached per mask).
    fn sub_fleet(&self, gone: u16) -> Rc<FleetCore> {
        if let Some((_, f)) = self.sub_fleets.borrow().iter().find(|(m, _)| *m == gone) {
            return f.clone();
        }
        let keep = |i: &usize| gone & (1 << i) == 0;
        let es = self.friend.escort_start;
        let ships = (0..self.friend.ships.len()).filter(keep).map(|i| self.friend.ships[i].clone()).collect();
        let escort_start = if self.friend.combined.is_some() { (0..es).filter(keep).count() } else { usize::MAX };
        let mut f = FleetCore { ships, is_player: true, escort_start, combined: self.friend.combined };
        if f.combined.is_none() {
            f.escort_start = f.ships.len();
        }
        let f = Rc::new(f);
        self.sub_fleets.borrow_mut().push((gone, f.clone()));
        f
    }

    fn setup(&self, nb: NodeBattle, info: &NodeInfo, comp: &Comp) -> BattleSetup {
        let (kind, night_unless) = match nb {
            NodeBattle::Night => (BattleKind::NightOnly, None),
            NodeBattle::Air => (BattleKind::AirBattle, None),
            NodeBattle::Raid => (BattleKind::AirRaid, None),
            NodeBattle::Day => match self.night {
                NightPolicy::Never => (BattleKind::Day, None),
                NightPolicy::BossOnly if info.boss => (BattleKind::DayNight, None),
                NightPolicy::BossOnly => (BattleKind::Day, None),
                NightPolicy::Always => (BattleKind::DayNight, None),
                NightPolicy::IfNotSRank => (BattleKind::DayNight, Some(Rank::S)),
                NightPolicy::IfNotARank => (BattleKind::DayNight, Some(Rank::A)),
            },
        };
        // wikiwiki 資材 (2024-03): PT-only nodes 4 % / 8 %; a submarine boss costs like a battle.
        let supply = info.supply.or_else(|| {
            if comp.pt_only {
                Some([0.04, 0.08])
            } else if info.boss && kind != BattleKind::AirRaid && comp.core.ships.iter().all(|s| s.class.is_sub()) {
                Some([0.2, 0.2])
            } else {
                None
            }
        });
        BattleSetup { kind, engagement: None, formations: [info.formation, comp.formation], night_unless, log: false, supply }
    }

    /// Decision after a battle (kancolle-replay `canContinue`). A heavily damaged main flagship
    /// always ends the sortie and the escort flagship is ignored (it cannot sink). Ships the
    /// policy would retreat for are "blockers"; exactly one blocker can be evacuated by the
    /// command facility (with an escort destroyer above 75 % HP for 107), which updates `st` and
    /// `gone`. Returns the retreat reason, if any, and whether a ship was evacuated.
    fn after_battle(&self, st: &mut [ShipState], gone: &mut u16, push: bool) -> (Option<Retreat>, bool) {
        let ratio = |st: &[ShipState], i: usize| st[i].hp_ratio(self.friend.ships[i].max_hp);
        if ratio(st, 0) <= 0.25 {
            return (Some(Retreat::Heavy), false);
        }
        let es = self.friend.escort_start;
        let escort_flag = self.friend.combined.map(|_| es);
        let present = |st: &[ShipState], gone: u16, i: usize| st[i].hp > 0 && gone & (1 << i) == 0;
        let mut blockers: Vec<usize> = Vec::new();
        let mut moderate = false;
        for i in 1..st.len() {
            if !present(st, *gone, i) {
                continue;
            }
            let r = ratio(st, i);
            if r <= 0.25 {
                if Some(i) != escort_flag && self.retreat.on_heavy && !push && !(self.retreat.allow_damecon && st[i].damecon_slots != 0) {
                    blockers.push(i);
                }
            } else if r <= 0.5 && self.retreat.on_moderate && !push {
                moderate = true;
            }
        }
        let mut evacuated = false;
        if let [ship] = blockers[..] {
            if self.retreat.use_fcf {
                match self.fcf {
                    Fcf::Combined => {
                        let escort = (es + 1..st.len()).find(|&i| i != ship && present(st, *gone, i) && self.stypes[i] == 2 && ratio(st, i) > 0.75);
                        if let Some(e) = escort {
                            for i in [ship, e] {
                                st[i].fuel = 0;
                                st[i].morale = 49;
                                *gone |= 1 << i;
                            }
                            evacuated = true;
                        }
                    }
                    Fcf::Single { ammo } => {
                        let s = &mut st[ship];
                        s.hp = (s.hp - (self.friend.ships[ship].max_hp as f64 * 0.2).floor() as i32).max(1);
                        s.fuel = 0;
                        if ammo {
                            s.ammo = 0;
                        }
                        s.morale = 49;
                        *gone |= 1 << ship;
                        evacuated = true;
                    }
                    Fcf::None => {}
                }
            }
            if evacuated {
                blockers.clear();
            }
        }
        let reason = if !blockers.is_empty() {
            Some(Retreat::Heavy)
        } else if moderate {
            Some(Retreat::Moderate)
        } else {
            None
        };
        (reason, evacuated)
    }

    fn start_node(&self, rng: &mut Rng) -> usize {
        if let Some(s) = self.start {
            return s;
        }
        let mut ships = Vec::with_capacity(self.route_ships.len());
        let main = self.counted(&self.init, 0, &mut ships);
        self.router.start_node(&self.route_ctx(&ships, main, &[]), rng).expect("router has start rules when start is None")
    }

    /// Underway replenishment before the boss battle (kancolle-replay `underwaySupply`): items on
    /// ships still in the fleet refill every such ship by 25/36/47 % (combined 15/27.5/40 %) of
    /// its capacity for 1/2/3+ items. Returns the items used.
    fn underway(&self, st: &mut [ShipState], gone: u16, refill: &mut [(i32, i32)]) -> u32 {
        let Some(items) = &self.underway else { return 0 };
        let here = |i: usize| st[i].hp > 0 && gone & (1 << i) == 0;
        let num: u32 = (0..st.len()).filter(|&i| here(i)).map(|i| items[i]).sum();
        if num == 0 {
            return 0;
        }
        let k = num.min(3) as usize - 1;
        let amount = if self.friend.combined.is_some() { [0.15, 0.275, 0.4][k] } else { [0.25, 0.36, 0.47][k] };
        let present: Vec<usize> = (0..st.len()).filter(|&i| here(i)).collect();
        for i in present {
            let s = &mut st[i];
            let add = |max: i32, have: i32| (((max as f64 * amount).floor() as i32).max(1)).min(max - have).max(0);
            let (f, a) = (add(s.fuel_max, s.fuel), add(s.ammo_max, s.ammo));
            s.fuel += f;
            s.ammo += a;
            refill[i].0 += f;
            refill[i].1 += a;
        }
        num.min(3)
    }

    /// Rations before the boss battle: every ship carrying one eats all of them, gaining its
    /// morale and giving its neighbours (same fleet) theirs. Returns the items eaten.
    fn eat_rations(&self, st: &mut [ShipState], gone: u16) -> u32 {
        let es = self.friend.escort_start;
        let mut eaten = 0;
        for i in 0..st.len() {
            let (n, me, nb) = self.rations[i];
            if n == 0 || st[i].hp <= 0 || gone & (1 << i) != 0 {
                continue;
            }
            eaten += n;
            st[i].morale = (st[i].morale + me).min(100);
            let (lo, hi) = if i < es { (0, es) } else { (es, st.len()) };
            for j in [i.wrapping_sub(1), i + 1] {
                if (lo..hi).contains(&j) && st[j].hp > 0 && gone & (1 << j) == 0 {
                    st[j].morale = (st[j].morale + nb).min(100);
                }
            }
        }
        eaten
    }

    /// One sortie. `boss_override`: comps and flagship HP for boss battles (HP-gauge final form).
    fn run_one(&self, rng: &mut Rng, boss_override: Option<(&CompSet, Option<i32>)>, mut rec: Option<&mut Rec>, morale: Option<&mut Vec<i32>>) -> Option<BossResult> {
        let mut st = self.init.clone();
        if let Some(m) = morale.as_deref() {
            for (s, &v) in st.iter_mut().zip(m) {
                s.morale = v;
            }
        }
        let mut node = self.start_node(rng);
        let mut path: Vec<usize> = vec![node];
        let mut boss_result = None;
        let mut ex = Extras { refill: vec![(0, 0); st.len()], ..Extras::default() };
        let mut boss_reached = false;
        let mut battles = 0u64;
        let mut retreated = false;
        let mut fcf_used = false;
        // Evacuated ships (bit per friend index).
        let mut gone: u16 = 0;
        let mut ships_ctx: Vec<&RouteShip> = Vec::with_capacity(self.route_ships.len());
        // Land-base squadron sizes: full at the start of every sortie, carried between nodes.
        let mut lb_planes = self.lb_init;
        loop {
            let info = &self.nodes[node];
            let first_visit = !path[..path.len() - 1].contains(&node);
            if let Some(r) = rec.as_deref_mut() {
                if let Some(w) = &info.warning {
                    if !r.warnings.contains(w) {
                        r.warnings.insert(w.clone());
                    }
                }
                if first_visit {
                    r.reach[node] += 1;
                }
            }
            if info.goal {
                boss_reached = true;
            }
            match &info.effect {
                Effect::None => {}
                Effect::Gain(g) => {
                    for (a, b) in ex.gain.iter_mut().zip([g.fuel, g.ammo, g.steel, g.bauxite]) {
                        *a += b;
                    }
                }
                Effect::Maelstrom(m) => {
                    let (fuel, total) = self.maelstrom(m, &mut st, gone, rng);
                    if let Some(r) = rec.as_deref_mut() {
                        if fuel {
                            r.mael_fuel += total;
                        } else {
                            r.mael_ammo += total;
                        }
                    }
                }
                Effect::Anchorage => {
                    let (hp, used) = self.anchorage(&mut st, gone);
                    ex.anchorage_hp += hp;
                    ex.anchorage_used += used;
                }
            }
            let tp_counts = |st: &[ShipState], i: usize| st[i].hp > 0 && gone & (1 << i) == 0 && st[i].hp_ratio(self.friend.ships[i].max_hp) > 0.25;
            let mut fought = false;
            if let Some((nb, comps)) = &info.battle {
                let (set, hp_override) = match boss_override {
                    Some((set, hp)) if info.goal => (set, hp),
                    _ => (comps, None),
                };
                if info.goal {
                    ex.underway_used += self.underway(&mut st, gone, &mut ex.refill);
                    ex.rations_used += self.eat_rations(&mut st, gone);
                }
                let comp = set.pick(rng);
                let mut enemy = comp.init.clone();
                if let (Some(hp), Some(flag)) = (hp_override, enemy.first_mut()) {
                    flag.hp = hp.clamp(1, comp.flagship_max_hp);
                }
                let setup = self.setup(*nb, info, comp);
                let holder;
                let (fleet, states): (&FleetCore, Vec<ShipState>) = if gone == 0 {
                    (&self.friend, std::mem::take(&mut st))
                } else {
                    holder = self.sub_fleet(gone);
                    (&holder, st.iter().enumerate().filter(|(i, _)| gone & (1 << i) == 0).map(|(_, s)| s.clone()).collect())
                };
                let mut b = Battle::new([fleet, &comp.core], [states, enemy], setup, rng);
                if !info.lb_waves.is_empty() {
                    b.set_lbas(&self.lbas, &info.lb_waves, lb_planes);
                }
                let o = b.run();
                if let Some(p) = b.lb_planes() {
                    lb_planes = p;
                }
                let after = std::mem::take(&mut b.st[0]);
                if gone == 0 {
                    st = after;
                } else {
                    let kept = (0..st.len()).filter(|i| gone & (1 << i) == 0);
                    for (i, s) in kept.zip(after) {
                        st[i] = s;
                    }
                }
                fought = true;
                battles += 1;
                if info.goal {
                    let start = b.hp_start[1].first().copied().unwrap_or(0);
                    let end = b.st[1].first().map(|s| s.hp.max(0)).unwrap_or(0);
                    let tp = match &self.tp_ships {
                        Some(t) => tp::fleet_tp(t, |i| tp_counts(&st, i)),
                        None => [0; 3],
                    };
                    boss_result = Some(BossResult { rank: o.rank, sunk: start > 0 && end <= 0, damage: (start - end).max(0), tp });
                }
                if let Some(r) = rec.as_deref_mut() {
                    r.battle[node] += 1;
                    r.ranks[node][rank_idx(o.rank)] += 1;
                    if o.night {
                        r.night[node] += 1;
                    }
                }
            } else if info.goal && info.landing {
                // A landing goal delivers its TP on arrival (S-rank equivalent).
                let tp = match &self.tp_ships {
                    Some(t) => tp::fleet_tp(t, |i| tp_counts(&st, i)),
                    None => [0; 3],
                };
                boss_result = Some(BossResult { rank: Rank::S, sunk: false, damage: 0, tp });
            }
            if self.target == Some(node) || !self.router.has_rules(node) {
                break;
            }
            let push = info.advance == Some(Advance::Push);
            let (mut reason, evacuated) = if fought { self.after_battle(&mut st, &mut gone, push) } else { (None, false) };
            if evacuated {
                fcf_used = true;
                if let Some(r) = rec.as_deref_mut() {
                    r.fcf_node[node] += 1;
                }
            }
            if reason.is_none() && info.advance == Some(Advance::Retreat) {
                reason = Some(Retreat::Choice);
            }
            if let Some(reason) = reason {
                retreated = true;
                if let Some(r) = rec.as_deref_mut() {
                    r.retreat[node] += 1;
                    match reason {
                        Retreat::Heavy => r.retreat_heavy[node] += 1,
                        Retreat::Moderate => r.retreat_moderate[node] += 1,
                        Retreat::Choice => {}
                    }
                }
                break;
            }
            if path.len() > self.max_nodes {
                if let Some(r) = rec.as_deref_mut() {
                    r.warnings.insert(format!("maxNodes ({}) reached; sortie stopped", self.max_nodes));
                }
                break;
            }
            ships_ctx.clear();
            let main = self.counted(&st, gone, &mut ships_ctx);
            match self.router.next(node, &self.route_ctx(&ships_ctx, main, &path), rng) {
                Some(next) => {
                    path.push(next);
                    node = next;
                }
                None => break,
            }
        }
        ex.lb_left = lb_planes;
        let (cost, lb_cost) = self.cost_of(&st, &ex);
        self.last_cost.set(cost);
        if let Some(r) = rec {
            r.costs.push(cost);
            *r.paths.entry(path.iter().map(|&n| n as u16).collect()).or_insert(0) += 1;
            r.battles += battles;
            r.nodes += (path.len() - 1) as u64;
            if retreated {
                r.retreats += 1;
            }
            if fcf_used {
                r.fcf += 1;
            }
            if boss_reached {
                r.boss_reach += 1;
            }
            if let Some(BossResult { rank, sunk, damage, .. }) = boss_result {
                r.boss_ranks[rank_idx(rank)] += 1;
                if sunk {
                    r.kills += 1;
                    r.flag_sunk += 1;
                }
                r.flag_damage += damage as f64;
            }
            for (a, b) in r.gain.iter_mut().zip(ex.gain) {
                *a += b;
            }
            r.anchorage_hp += ex.anchorage_hp;
            r.anchorage_mat += ex.anchorage_used;
            r.underway_used += ex.underway_used as f64;
            r.rations_used += ex.rations_used as f64;
            for (a, b) in r.lb_cost.iter_mut().zip(lb_cost) {
                *a += b;
            }
            let mut any_sunk = false;
            let (mut fleet_f, mut fleet_s, mut fleet_tmax, mut fleet_tsum) = (0.0, 0.0, 0.0f64, 0.0);
            for (i, (s, s0)) in st.iter().zip(&self.init).enumerate() {
                let max = self.friend.ships[i].max_hp;
                let sr = &mut r.ships[i];
                if s0.hp > 0 && s.hp <= 0 {
                    sr.sunk += 1;
                    any_sunk = true;
                } else if s.hp > 0 {
                    let ratio = s.hp_ratio(max);
                    if ratio <= 0.25 {
                        sr.heavy += 1;
                    } else if ratio <= 0.5 {
                        sr.moderate += 1;
                    }
                }
                if gone & (1 << i) != 0 {
                    sr.evacuated += 1;
                }
                let (rf, ra) = ex.refill[i];
                sr.damage_taken += (s0.hp - s.hp) as f64;
                sr.hp_missing += (max - s.hp.max(0)) as f64;
                sr.fuel += (resupply_cost(s0.fuel - s.fuel, self.married[i]) + rf) as f64;
                sr.ammo += (resupply_cost(s0.ammo - s.ammo, self.married[i]) + ra) as f64;
                if s.damecon_slots != s0.damecon_slots {
                    sr.damecon += 1;
                }
                let lost: i32 = s0.planes.iter().zip(&s.planes).map(|(a, b)| (a - b).max(0)).sum();
                sr.bauxite += 5.0 * lost as f64;
                sr.prof_lost += s0.planes.iter().zip(&s.planes).zip(s0.exp.iter().zip(&s.exp)).filter(|((p0, p1), (e0, e1))| **p0 > 0 && **p1 <= 0 && **e0 > 0.0 && **e1 <= 0.0).count() as f64;
                let missing = if s.hp > 0 { max - s.hp } else { 0 };
                let (f, t) = repair_cost(s.fuel_max, missing);
                let secs = repair_time_sec(self.stypes[i], self.friend.ships[i].level, missing);
                sr.rep_fuel.push(f as f64);
                sr.rep_steel.push(t as f64);
                sr.rep_time.push(secs as f64);
                fleet_f += f as f64;
                fleet_s += t as f64;
                fleet_tmax = fleet_tmax.max(secs as f64);
                fleet_tsum += secs as f64;
            }
            r.fleet_fuel.push(fleet_f);
            r.fleet_steel.push(fleet_s);
            r.fleet_time_max.push(fleet_tmax);
            r.fleet_time_sum.push(fleet_tsum);
            if any_sunk {
                r.sunk_any += 1;
            }
        }
        if let Some(m) = morale {
            for (i, v) in m.iter_mut().enumerate() {
                *v = if st[i].hp <= 0 { self.init[i].morale } else { st[i].morale };
            }
        }
        boss_result
    }

    /// Land-base cost of a sortie (kancolle-replay `LandBase.getCost`): sortie fuel / ammo per
    /// squadron by its full size (land attackers ⌈1.5n⌉ / ⌊0.7n⌋, large land bombers ⌈2n⌉ / ⌈2n⌉,
    /// others ⌈n⌉ / ⌈0.6n⌉) plus 3 fuel and 5 bauxite per plane lost.
    fn lb_cost(&self, left: &LbPlanes) -> [f64; 3] {
        let mut c = [0.0; 3];
        for (b, base) in self.lbas.iter().enumerate().filter(|(b, _)| self.lb_sortied[*b]) {
            for (k, e) in base.squadrons.iter().enumerate() {
                let n = base.planes[k] as f64;
                let (f, a) = match e.cat {
                    cat::LAND_BOMBER => ((1.5 * n).ceil(), (0.7 * n).floor()),
                    cat::LAND_BOMBER_L => ((2.0 * n).ceil(), (2.0 * n).ceil()),
                    _ => (n.ceil(), (0.6 * n).ceil()),
                };
                let lost = (base.planes[k] - left[b][k]).max(0) as f64;
                c[0] += f + 3.0 * lost;
                c[1] += a;
                c[2] += 5.0 * lost;
            }
        }
        c
    }

    /// Net resources of a finished sortie (resupply, bauxite, docking or buckets, land bases,
    /// anchorage steel, extras, minus node gains), and the land-base part (fuel, ammo, bauxite).
    fn cost_of(&self, st: &[ShipState], ex: &Extras) -> (Cost, [f64; 3]) {
        let mut c: Cost = [0.0; 6];
        for (i, (s, s0)) in st.iter().zip(&self.init).enumerate() {
            let (rf, ra) = ex.refill[i];
            c[0] += (resupply_cost(s0.fuel - s.fuel, self.married[i]) + rf) as f64;
            c[1] += (resupply_cost(s0.ammo - s.ammo, self.married[i]) + ra) as f64;
            c[3] += 5.0 * s0.planes.iter().zip(&s.planes).map(|(a, b)| (a - b).max(0)).sum::<i32>() as f64;
            if s.hp <= 0 {
                continue;
            }
            let missing = self.friend.ships[i].max_hp - s.hp;
            let secs = repair_time_sec(self.stypes[i], self.friend.ships[i].level, missing) as f64;
            let (f, t) = repair_cost(s.fuel_max, missing);
            c[0] += f as f64;
            c[2] += t as f64;
            if secs > 0.0 && self.bucket_above.is_some_and(|b| secs > b) {
                c[4] += 1.0;
            } else {
                c[5] = c[5].max(secs);
            }
        }
        let lb = self.lb_cost(&ex.lb_left);
        c[0] += lb[0];
        c[1] += lb[1];
        c[3] += lb[2];
        c[2] += 3.0 * ex.anchorage_hp;
        for ((x, e), g) in c.iter_mut().zip(self.extra).zip(ex.gain) {
            *x += e - g;
        }
        (c, lb)
    }

    /// Applies a maelstrom to the ships still in the fleet; returns (is fuel, total lost).
    fn maelstrom(&self, m: &Maelstrom, st: &mut [ShipState], gone: u16, rng: &mut Rng) -> (bool, f64) {
        let fuel = m.resource == MaelstromResource::Fuel;
        let mut rate = m.rate.unwrap_or(0.0);
        if let (Some(h), Some(c)) = (m.rate_high, m.high_chance) {
            if c > 0.0 && rng.chance(c) {
                rate = h;
            }
        }
        let here = |i: usize, s: &ShipState| s.hp > 0 && gone & (1 << i) == 0;
        let radars = st.iter().enumerate().filter(|(i, s)| here(*i, s) && self.radar[*i]).count();
        let mut total = 0.0;
        for (_, s) in st.iter_mut().enumerate().filter(|(i, s)| here(*i, s)) {
            let have = if fuel { &mut s.fuel } else { &mut s.ammo };
            let loss = maelstrom_loss(*have, rate, m.max, radars, m.radar_reducible.unwrap_or(true));
            *have -= loss;
            total += loss as f64;
        }
        (fuel, total)
    }

    /// Anchorage repair (kancolle-replay `_doAnchorageRepair`): the first repair ship above 50 %
    /// HP heals its covered seats above 25 % HP by ⌈rate × max HP⌉ (+7 morale). Returns (HP
    /// restored, repairs used).
    fn anchorage(&self, st: &mut [ShipState], gone: u16) -> (f64, f64) {
        let Some(r) = self.repairers.iter().find(|r| {
            let s = &st[r.ship];
            s.hp > 0 && gone & (1 << r.ship) == 0 && s.hp_ratio(self.friend.ships[r.ship].max_hp) > 0.5
        }) else {
            return (0.0, 0.0);
        };
        let mut healed = 0.0;
        for &k in &r.covered {
            let max = self.friend.ships[k].max_hp;
            let s = &mut st[k];
            if gone & (1 << k) != 0 || s.hp >= max || s.hp_ratio(max) <= 0.25 {
                continue;
            }
            let add = ((max as f64 * r.rate).ceil() as i32).min(max - s.hp);
            healed += add as f64;
            s.hp += add;
            s.morale = (s.morale + 7).min(100);
        }
        (healed, 1.0)
    }

    fn summarize(&self, rec: Rec, count: u32, top: usize) -> SortieSummary {
        let n = count as f64;
        let rate = |x: u32| if count > 0 { x as f64 / n } else { 0.0 };
        let mean = |x: f64| if count > 0 { x / n } else { 0.0 };
        let mut paths: Vec<(Vec<u16>, u32)> = rec.paths.into_iter().collect();
        paths.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let shown: u32 = paths.iter().take(top).map(|p| p.1).sum();
        let path_rates = paths
            .iter()
            .take(top)
            .map(|(p, c)| PathRate { path: p.iter().map(|&i| self.router.name(i as usize).to_string()).collect(), rate: rate(*c) })
            .collect();
        let mut nodes = BTreeMap::new();
        for i in 0..self.router.len() {
            let battles = rec.battle[i];
            nodes.insert(
                self.router.name(i).to_string(),
                NodeSummary {
                    reach_rate: rate(rec.reach[i]),
                    battle_rate: rate(battles),
                    rank_rates: rank_rates(&rec.ranks[i]),
                    retreat_rate: rate(rec.retreat[i]),
                    retreat_heavy_rate: rate(rec.retreat_heavy[i]),
                    retreat_moderate_rate: rate(rec.retreat_moderate[i]),
                    night_rate: if battles > 0 { rec.night[i] as f64 / battles as f64 } else { 0.0 },
                    fcf_rate: rate(rec.fcf_node[i]),
                },
            );
        }
        let mut warnings: BTreeSet<String> = rec.warnings;
        warnings.extend(self.warnings.iter().cloned());
        let total_paths: u32 = paths.iter().map(|p| p.1).sum();
        SortieSummary {
            count,
            paths: path_rates,
            other_paths_rate: rate(total_paths - shown),
            nodes,
            boss: BossSummary {
                reach_rate: rate(rec.boss_reach),
                rank_rates: rank_rates(&rec.boss_ranks),
                kill_rate: rate(rec.kills),
                flagship_sunk_rate: rate(rec.flag_sunk),
                flagship_damage_mean: mean(rec.flag_damage),
            },
            retreat_rate: rate(rec.retreats),
            sunk_rate: rate(rec.sunk_any),
            battles_mean: mean(rec.battles as f64),
            nodes_mean: mean(rec.nodes as f64),
            fuel_used_mean: mean(rec.ships.iter().map(|s| s.fuel).sum()),
            ammo_used_mean: mean(rec.ships.iter().map(|s| s.ammo).sum()),
            bauxite_mean: mean(rec.ships.iter().map(|s| s.bauxite).sum()),
            resources_per_sortie: resources_summary(&rec.costs),
            fcf_rate: rate(rec.fcf),
            underway_used_mean: mean(rec.underway_used),
            rations_used_mean: mean(rec.rations_used),
            lbas_cost_mean: self.lb_sortied.iter().any(|&b| b).then(|| ResourceAmounts {
                fuel: mean(rec.lb_cost[0]),
                ammo: mean(rec.lb_cost[1]),
                steel: 0.0,
                bauxite: mean(rec.lb_cost[2]),
            }),
            repair: FleetRepairSummary {
                fuel: dist(&rec.fleet_fuel),
                steel: dist(&rec.fleet_steel),
                time_sec: dist(&rec.fleet_time_max),
                time_sec_total: dist(&rec.fleet_time_sum),
            },
            effects: self.has_effects.then(|| NodeEffectsSummary {
                gained_mean: ResourceAmounts { fuel: mean(rec.gain[0]), ammo: mean(rec.gain[1]), steel: mean(rec.gain[2]), bauxite: mean(rec.gain[3]) },
                maelstrom_fuel_mean: mean(rec.mael_fuel),
                maelstrom_ammo_mean: mean(rec.mael_ammo),
                anchorage_hp_mean: mean(rec.anchorage_hp),
                anchorage_materials_mean: mean(rec.anchorage_mat),
                anchorage_steel_mean: mean(3.0 * rec.anchorage_hp),
            }),
            friend: rec
                .ships
                .iter()
                .map(|s| SortieShipSummary {
                    sunk_rate: rate(s.sunk),
                    heavy_rate: rate(s.heavy),
                    moderate_rate: rate(s.moderate),
                    damage_taken_mean: mean(s.damage_taken),
                    hp_missing_mean: mean(s.hp_missing),
                    fuel_used_mean: mean(s.fuel),
                    ammo_used_mean: mean(s.ammo),
                    bauxite_mean: mean(s.bauxite),
                    proficiency_lost_mean: mean(s.prof_lost),
                    repair: RepairSummary { fuel: dist(&s.rep_fuel), steel: dist(&s.rep_steel), time_sec: dist(&s.rep_time) },
                    damecon: DameconSummary { used_rate: rate(s.damecon) },
                    evacuated_rate: rate(s.evacuated),
                })
                .collect(),
            gauge: None,
            warnings: warnings.into_iter().collect(),
        }
    }

    fn new_rec(&self) -> Rec {
        let n = self.router.len();
        Rec {
            reach: vec![0; n],
            battle: vec![0; n],
            ranks: vec![[0; 7]; n],
            retreat: vec![0; n],
            retreat_heavy: vec![0; n],
            retreat_moderate: vec![0; n],
            night: vec![0; n],
            fcf_node: vec![0; n],
            ships: (0..self.friend.ships.len()).map(|_| ShipRec::default()).collect(),
            ..Rec::default()
        }
    }

    /// Run `count` sorties and aggregate.
    pub fn simulate(&self, count: u32, rng: &mut Rng, top_paths: usize) -> SortieSummary {
        let mut rec = self.new_rec();
        for _ in 0..count {
            self.run_one(rng, None, Some(&mut rec), None);
        }
        self.summarize(rec, count, top_paths)
    }

    /// Waits between sorties per `cfg` and recovers morale +3 per 3 minutes up to 49 (kcwiki 士气); returns minutes.
    fn wait_recover(m: &mut [i32], cfg: &GaugeMorale) -> f64 {
        let mut minutes = cfg.wait_minutes.unwrap_or(0.0).max(0.0);
        if let Some(t) = cfg.until_morale {
            let t = t.min(49);
            let ticks = m.iter().filter(|&&v| v < t).map(|&v| (t - v + 2) / 3).max().unwrap_or(0);
            minutes = minutes.max(3.0 * ticks as f64);
        }
        let ticks = (minutes / 3.0).floor() as i32;
        for v in m.iter_mut().filter(|v| **v < 49) {
            *v = (*v + 3 * ticks).min(49);
        }
        minutes
    }

    fn phase_run(&self, p: &GaugePhase) -> Result<PhaseRun, String> {
        let boss_set = match &p.comps {
            Some(c) => Some(CompSet::new("gauge.comps", c)?),
            None => None,
        };
        let final_set = match &p.final_comps {
            Some(c) if p.kind == GaugeKind::Hp => Some(CompSet::new("gauge.finalComps", c)?),
            _ => None,
        };
        let threshold = p.final_threshold.unwrap_or_else(|| {
            let sets: Vec<&CompSet> = match (&final_set, &boss_set) {
                (Some(s), _) | (None, Some(s)) => vec![s],
                _ => self.nodes.iter().filter(|n| n.goal).filter_map(|n| n.battle.as_ref().map(|b| &b.1)).collect(),
            };
            sets.iter().flat_map(|s| s.comps.iter().map(|c| c.flagship_max_hp)).max().unwrap_or(0) as f64
        });
        Ok(PhaseRun {
            kind: p.kind,
            remaining: p.remaining,
            boss_set,
            final_set,
            threshold,
            routing_phase: p.phase,
            routing_gauge: p.gauge,
            tank: tp::mode(p.tank),
            tp_override: p.tp_per_sortie,
        })
    }

    /// One sortie of a gauge phase; returns whether the phase is now cleared.
    fn phase_sortie(&self, ph: &PhaseRun, remaining: &mut f64, rng: &mut Rng, morale: Option<&mut Vec<i32>>) -> bool {
        let over = |hp: Option<i32>| ph.boss_set.as_ref().map(|s| (s, hp));
        match ph.kind {
            GaugeKind::Kill => {
                if self.run_one(rng, over(None), None, morale).is_some_and(|r| r.sunk) {
                    *remaining -= 1.0;
                }
                remaining.ceil() <= 0.0
            }
            GaugeKind::Tp => {
                if let Some(r) = self.run_one(rng, over(None), None, morale) {
                    *remaining -= tp::gained(ph.tp_override.unwrap_or(r.tp[ph.tank] as f64), r.rank);
                }
                *remaining <= 0.0
            }
            GaugeKind::Hp => {
                let is_final = *remaining <= ph.threshold;
                let hp = remaining.ceil() as i32;
                let result = if is_final {
                    match (&ph.final_set, over(Some(hp))) {
                        (Some(set), _) => self.run_one(rng, Some((set, Some(hp))), None, morale),
                        (None, Some(o)) => self.run_one(rng, Some(o), None, morale),
                        (None, None) => self.run_final_default(rng, hp, morale),
                    }
                } else {
                    self.run_one(rng, over(None), None, morale)
                };
                let Some(r) = result else { return false };
                if is_final && r.sunk {
                    return true;
                }
                *remaining -= r.damage as f64;
                if is_final {
                    *remaining = remaining.max(1.0);
                }
                !is_final && *remaining <= 0.0
            }
        }
    }

    fn gauge(&self, g: &GaugeInput, kill_rate: f64, mean_cost: Cost, rng: &mut Rng) -> Result<(GaugeSummary, Option<String>), String> {
        let max_sorties = g.max_sorties.unwrap_or(500).max(1);
        let has_goal = self.nodes.iter().any(|n| n.goal && (n.battle.is_some() || n.landing));
        let mut warning = None;
        let mut sorties: Vec<u32> = Vec::new();
        let mut waits: Vec<f64> = Vec::new();
        let mut run_costs: Vec<Cost> = Vec::new();
        let mut per_phase: Vec<Vec<u32>> = Vec::new();
        let mut capped = 0u32;
        let runs;
        let init_morale: Vec<i32> = self.init.iter().map(|s| s.morale).collect();
        let phased = g.phases.as_ref().is_some_and(|p| !p.is_empty());
        let geometric = g.kind == GaugeKind::Kill && g.morale.is_none() && !phased;
        if geometric {
            runs = g.runs.unwrap_or(2000);
            let need = g.remaining.ceil().max(0.0) as u32;
            for _ in 0..runs {
                let (mut k, mut s) = (0, 0);
                while k < need && s < max_sorties {
                    s += 1;
                    if rng.chance(kill_rate) {
                        k += 1;
                    }
                }
                if k >= need {
                    sorties.push(s);
                    // No sortie is simulated here: the mean sortie cost times the sorties drawn.
                    run_costs.push(mean_cost.map(|c| c * s as f64));
                } else {
                    capped += 1;
                }
            }
        } else if !has_goal {
            runs = g.runs.unwrap_or(200);
            warning = Some("gauge: no boss battle node in the map; nothing to estimate".to_string());
            capped = runs;
        } else {
            runs = g.runs.unwrap_or(200);
            let phases: Vec<PhaseRun> = if phased {
                g.phases.iter().flatten().map(|p| self.phase_run(p)).collect::<Result<_, _>>()?
            } else {
                vec![self.phase_run(&GaugePhase {
                    kind: g.kind,
                    remaining: g.remaining,
                    comps: None,
                    final_comps: g.final_comps.clone(),
                    final_threshold: g.final_threshold,
                    phase: Some(self.router.phase()),
                    gauge: Some(self.router.gauge()),
                    tank: g.tank,
                    tp_per_sortie: g.tp_per_sortie,
                })?]
            };
            let n = phases.len();
            let (base_phase, base_gauge) = (self.router.phase(), self.router.gauge());
            let empty = |ph: &PhaseRun| if ph.kind == GaugeKind::Kill { ph.remaining.ceil() <= 0.0 } else { ph.remaining <= 0.0 };
            for _ in 0..runs {
                let mut s = 0;
                let mut wait = 0.0;
                let mut m = init_morale.clone();
                let mut spent = vec![0u32; n];
                let mut cost: Cost = [0.0; 6];
                let mut idx = 0;
                let mut remaining = phases[0].remaining;
                let mut cleared = empty(&phases[0]);
                loop {
                    while cleared {
                        idx += 1;
                        if idx == n {
                            break;
                        }
                        remaining = phases[idx].remaining;
                        cleared = empty(&phases[idx]);
                    }
                    if idx == n || s >= max_sorties {
                        break;
                    }
                    s += 1;
                    spent[idx] += 1;
                    let ph = &phases[idx];
                    self.router.set_phase(ph.routing_phase.unwrap_or(base_phase + idx as f64));
                    self.router.set_gauge(ph.routing_gauge.unwrap_or(base_gauge + idx as f64));
                    let mor = g.morale.as_ref().map(|_| &mut m);
                    cleared = self.phase_sortie(ph, &mut remaining, rng, mor);
                    for (a, b) in cost.iter_mut().zip(self.last_cost.get()) {
                        *a += b;
                    }
                    if !(cleared && idx + 1 == n) {
                        if let Some(cfg) = &g.morale {
                            wait += Self::wait_recover(&mut m, cfg);
                        }
                    }
                }
                if idx == n {
                    sorties.push(s);
                    waits.push(wait);
                    per_phase.push(spent);
                    run_costs.push(cost);
                } else {
                    capped += 1;
                }
            }
            self.router.set_phase(base_phase);
            self.router.set_gauge(base_gauge);
        }
        let stats = |v: &mut Vec<u32>| {
            v.sort_unstable();
            let pct = |q: f64| (!v.is_empty()).then(|| v[((q * v.len() as f64).ceil() as usize).clamp(1, v.len()) - 1] as f64);
            ((!v.is_empty()).then(|| v.iter().map(|&s| s as f64).sum::<f64>() / v.len() as f64), pct(0.5), pct(0.9))
        };
        let phase_stats = if phased {
            let kinds: Vec<GaugeKind> = g.phases.iter().flatten().map(|p| p.kind).collect();
            Some(
                kinds
                    .into_iter()
                    .enumerate()
                    .map(|(i, kind)| {
                        let (expected_sorties, _, p90_sorties) = stats(&mut per_phase.iter().map(|r| r[i]).collect());
                        PhaseSummary { kind, expected_sorties, p90_sorties }
                    })
                    .collect(),
            )
        } else {
            None
        };
        let (expected, p50, p90) = stats(&mut sorties);
        waits.sort_by(|a, b| a.total_cmp(b));
        let waiting = g.morale.is_some() && !waits.is_empty();
        Ok((
            GaugeSummary {
                kind: g.kind,
                remaining: g.remaining,
                expected_sorties: expected,
                p50_sorties: p50,
                p90_sorties: p90,
                expected_wait_minutes: waiting.then(|| waits.iter().sum::<f64>() / waits.len() as f64),
                p50_wait_minutes: waiting.then(|| percentile(&waits, 0.5)),
                p90_wait_minutes: waiting.then(|| percentile(&waits, 0.9)),
                phases: phase_stats,
                resources: (!run_costs.is_empty()).then(|| resources_summary(&run_costs)),
                capped_rate: if runs > 0 { capped as f64 / runs as f64 } else { 0.0 },
                runs,
            },
            warning,
        ))
    }

    /// Final form with the boss (or `config.target`) node's own comps: HP override only.
    fn run_final_default(&self, rng: &mut Rng, hp: i32, morale: Option<&mut Vec<i32>>) -> Option<BossResult> {
        let boss_set = self.nodes.iter().find(|n| n.goal).and_then(|n| n.battle.as_ref().map(|b| &b.1))?;
        self.run_one(rng, Some((boss_set, Some(hp))), None, morale)
    }
}

/// `simulateSortie` entry point.
pub fn simulate_sortie(input: &SortieInput, count: u32, seed: u64) -> Result<SortieSummary, String> {
    if input.friend.ships.len() + input.friend.escort_ships().len() > MAX_FRIEND {
        return Err(format!("friend fleet has more than {MAX_FRIEND} ships"));
    }
    let sortie = Sortie::new(input)?;
    let mut rng = Rng::new(seed);
    let top = input.top_paths.unwrap_or(20) as usize;
    let mut summary = sortie.simulate(count, &mut rng, top);
    if let Some(g) = &input.gauge {
        let r = &summary.resources_per_sortie;
        let mean_cost = [r.fuel.mean, r.ammo.mean, r.steel.mean, r.bauxite.mean, r.buckets.mean, r.time_sec.mean];
        let (gs, warning) = sortie.gauge(g, summary.boss.kill_rate, mean_cost, &mut rng)?;
        if let Some(w) = warning {
            summary.warnings.push(w);
        }
        summary.gauge = Some(gs);
    }
    Ok(summary)
}

/// Route-only helper for tests and tools: one path from the start node for `ships` (no battles).
pub fn route_once(input: &SortieInput, seed: u64) -> Result<Vec<String>, String> {
    let sortie = Sortie::new(input)?;
    let mut rng = Rng::new(seed);
    let mut ships = Vec::with_capacity(sortie.route_ships.len());
    let main = sortie.counted(&sortie.init, 0, &mut ships);
    let mut node = sortie.start_node(&mut rng);
    let mut path = vec![node];
    while path.len() <= sortie.max_nodes {
        match sortie.router.next(node, &sortie.route_ctx(&ships, main, &path), &mut rng) {
            Some(n) => {
                path.push(n);
                node = n;
            }
            None => break,
        }
    }
    Ok(path.into_iter().map(|i| sortie.router.name(i).to_string()).collect())
}
