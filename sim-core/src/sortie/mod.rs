//! Sortie (海域周回) simulator: routing evaluator + chained battles with state carry-over,
//! retreat policy, aggregation and gauge estimation. Contract: docs/SIM_INTERFACE.md "Sortie".

pub mod model;
pub mod resource;
pub mod tp;

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::battle::{validate_fleet, Battle, BattleSetup, FleetCore};
use crate::model::{BattleKind, Formation, Rank, RankRates};
use crate::rng::Rng;
use crate::routing::{RouteConfig, RouteCtx, RouteEquip, RouteShip, Router};
use crate::ship::ShipState;
use model::*;
use resource::*;
use std::cell::Cell;
use tp::ShipTp;

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
}

/// One gauge of a gauge run with its comps already built.
struct PhaseRun {
    kind: GaugeKind,
    remaining: f64,
    boss_set: Option<CompSet>,
    final_set: Option<CompSet>,
    threshold: f64,
    routing_phase: Option<f64>,
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
            total += c.weight;
            cum.push(total);
            out.push(Comp { core, init, formation: c.fleet.formation.unwrap_or_default(), flagship_max_hp });
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
    boss: bool,
    formation: Formation,
    warning: Option<String>,
}

/// Prepared sortie (static derivations done once).
pub struct Sortie {
    router: Router,
    nodes: Vec<NodeInfo>,
    friend: FleetCore,
    init: Vec<ShipState>,
    route_ships: Vec<RouteShip>,
    /// Fixed start node; `None` = picked per sortie by the routing document's start rules.
    start: Option<usize>,
    max_nodes: usize,
    night: NightPolicy,
    retreat: RetreatPolicy,
    warnings: Vec<String>,
    stypes: Vec<u32>,
    married: Vec<bool>,
    radar: Vec<bool>,
    /// Anchorage repair ships: (ship index, heal rate, covered fleet positions).
    repairers: Vec<(usize, f64, Vec<usize>)>,
    has_effects: bool,
    /// Per-ship TP parts; `Some` when a gauge of kind `tp` is configured.
    tp_ships: Option<Vec<ShipTp>>,
    bucket_above: Option<f64>,
    extra: [f64; 4],
    /// Resource vector of the last `run_one` (see `Cost`).
    last_cost: Cell<Cost>,
}

/// Net resources of one sortie: fuel, ammo, steel, bauxite, buckets, docking seconds.
type Cost = [f64; 6];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Retreat {
    Heavy,
    Moderate,
}

/// Boss battle of one sortie.
#[derive(Clone, Copy)]
struct BossResult {
    rank: Rank,
    /// Flagship sunk.
    sunk: bool,
    /// Damage dealt to the flagship.
    damage: i32,
    /// Fleet TP on arrival per tank mode (`tp::mode`); zeros unless a gauge needs TP.
    tp: [i32; 3],
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
    paths: HashMap<Vec<u16>, u32>,
    boss_reach: u32,
    boss_ranks: [u32; 7],
    kills: u32,
    flag_sunk: u32,
    flag_damage: f64,
    retreats: u32,
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
    warnings: BTreeSet<String>,
}

fn route_ship(s: &crate::model::ShipInput) -> RouteShip {
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

impl Sortie {
    pub fn new(input: &SortieInput) -> Result<Sortie, String> {
        validate_fleet("friend", &input.friend, false)?;
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

        let mut nodes = Vec::with_capacity(router.len());
        for i in 0..router.len() {
            let letter = router.name(i).to_string();
            let mut warning = None;
            let mut battle = None;
            let mut boss = false;
            let mut effect = Effect::None;
            match input.map.nodes.get(&letter) {
                None => {
                    if !letter.starts_with("Start") {
                        warning = Some(format!("node {letter} is not in map.nodes; treated as empty"));
                    }
                }
                Some(n) => {
                    boss = n.boss.unwrap_or(false) || n.kind == Some(NodeKind::Boss);
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
                Some(f) => *f,
                None if battle.as_ref().is_some_and(|(_, cs)| cs.all_subs()) => Formation::LineAbreast,
                None => Formation::LineAhead,
            };
            nodes.push(NodeInfo { effect, battle, boss, formation, warning });
        }

        let (friend, init) = FleetCore::build(&input.friend, true);
        for (i, s) in input.friend.ships.iter().enumerate() {
            if s.speed.is_none() {
                warnings.push(format!("friend ship #{i} has no speed; routing assumes fast (10)"));
            }
        }
        let radar: Vec<bool> = input.friend.ships.iter().map(|s| s.slots.iter().flatten().chain(s.ex_slot.iter()).any(|e| matches!(e.types.get(2), Some(12 | 13)))).collect();
        let mut repairers = Vec::new();
        for (i, s) in input.friend.ships.iter().enumerate() {
            // Akashi Kai 187 heals 30%, Akitsushima Kai 450 25% (kcwiki 修船 紧急泊地修理); facility in slot k covers positions 3k..3k+3.
            let rate = match s.id {
                Some(187) => 0.30,
                Some(450) => 0.25,
                _ => continue,
            };
            let covered: Vec<usize> = s.slots.iter().take(2).enumerate().filter(|(_, e)| e.as_ref().is_some_and(|e| e.types.get(2) == Some(&31))).flat_map(|(k, _)| 3 * k..3 * k + 3).collect();
            if !covered.is_empty() {
                repairers.push((i, rate, covered));
            }
        }
        let wants_tp = input.gauge.as_ref().is_some_and(|g| g.kind == GaugeKind::Tp || g.phases.iter().flatten().any(|p| p.kind == GaugeKind::Tp));
        if wants_tp {
            for (i, s) in input.friend.ships.iter().enumerate() {
                if tp::stype_tp(s.ship_type).is_none() {
                    warnings.push(format!("friend ship #{i}: ship type {} has no TP in the source table; counted as 0", s.ship_type));
                }
            }
        }
        let has_effects = nodes.iter().any(|n| !matches!(n.effect, Effect::None));
        for (i, s) in input.friend.ships.iter().enumerate() {
            if s.level.is_none() || s.fuel_max.is_none() {
                warnings.push(format!("friend ship #{i} has no level/fuelMax; docking cost and time assume Lv1 / fuelMax 100"));
            }
        }
        Ok(Sortie {
            stypes: input.friend.ships.iter().map(|s| s.ship_type).collect(),
            married: friend.ships.iter().map(|c| c.level >= MARRIED_LEVEL).collect(),
            radar,
            repairers,
            has_effects,
            bucket_above: input.repair.and_then(|r| r.bucket_above_sec),
            extra: input.extra_per_sortie.map_or([0.0; 4], |e| [e.fuel, e.ammo, e.steel, e.bauxite]),
            last_cost: Cell::new([0.0; 6]),
            tp_ships: wants_tp.then(|| input.friend.ships.iter().map(tp::ship_tp).collect()),
            router,
            nodes,
            friend,
            init,
            route_ships: input.friend.ships.iter().map(route_ship).collect(),
            start,
            max_nodes: input.max_nodes.unwrap_or(20) as usize,
            night: input.policy.night,
            retreat: input.policy.retreat.clone(),
            warnings,
        })
    }

    fn setup(&self, nb: NodeBattle, boss: bool, formation: Formation, enemy_formation: Formation) -> BattleSetup {
        let (kind, night_unless) = match nb {
            NodeBattle::Night => (BattleKind::NightOnly, None),
            NodeBattle::Air => (BattleKind::AirBattle, None),
            NodeBattle::Raid => (BattleKind::AirRaid, None),
            NodeBattle::Day => match self.night {
                NightPolicy::Never => (BattleKind::Day, None),
                NightPolicy::BossOnly if boss => (BattleKind::DayNight, None),
                NightPolicy::BossOnly => (BattleKind::Day, None),
                NightPolicy::Always => (BattleKind::DayNight, None),
                NightPolicy::IfNotSRank => (BattleKind::DayNight, Some(Rank::S)),
                NightPolicy::IfNotARank => (BattleKind::DayNight, Some(Rank::A)),
            },
        };
        BattleSetup { kind, engagement: None, formations: [formation, enemy_formation], night_unless, log: false }
    }

    fn retreat_reason(&self, st: &[ShipState]) -> Option<Retreat> {
        let mut reason = None;
        for (i, (s, c)) in st.iter().zip(&self.friend.ships).enumerate() {
            if s.hp <= 0 {
                continue;
            }
            let r = s.hp_ratio(c.max_hp);
            if r <= 0.25 {
                if i == 0 || (self.retreat.on_heavy && !(self.retreat.allow_damecon && s.damecon_slots != 0)) {
                    return Some(Retreat::Heavy);
                }
            } else if r <= 0.5 && self.retreat.on_moderate {
                reason = Some(Retreat::Moderate);
            }
        }
        reason
    }

    fn start_node(&self, rng: &mut Rng) -> usize {
        if let Some(s) = self.start {
            return s;
        }
        let ships: Vec<&RouteShip> = self.route_ships.iter().zip(&self.init).filter(|(_, s)| s.hp > 0).map(|(r, _)| r).collect();
        self.router.start_node(&RouteCtx { ships: &ships, visited: &[] }, rng).expect("router has start rules when start is None")
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
        let mut gain = [0.0f64; 4];
        let mut boss_reached = false;
        let mut battles = 0u64;
        let mut retreated = false;
        let mut ships_ctx: Vec<&RouteShip> = Vec::with_capacity(7);
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
            if info.boss {
                boss_reached = true;
            }
            match &info.effect {
                Effect::None => {}
                Effect::Gain(g) => {
                    gain[0] += g.fuel;
                    gain[1] += g.ammo;
                    gain[2] += g.steel;
                    gain[3] += g.bauxite;
                    if let Some(r) = rec.as_deref_mut() {
                        r.gain[0] += g.fuel;
                        r.gain[1] += g.ammo;
                        r.gain[2] += g.steel;
                        r.gain[3] += g.bauxite;
                    }
                }
                Effect::Maelstrom(m) => {
                    let (fuel, total) = self.maelstrom(m, &mut st, rng);
                    if let Some(r) = rec.as_deref_mut() {
                        if fuel {
                            r.mael_fuel += total;
                        } else {
                            r.mael_ammo += total;
                        }
                    }
                }
                Effect::Anchorage => {
                    let (hp, used) = self.anchorage(&mut st);
                    if let Some(r) = rec.as_deref_mut() {
                        r.anchorage_hp += hp;
                        r.anchorage_mat += used;
                    }
                }
            }
            let mut fought = false;
            if let Some((nb, comps)) = &info.battle {
                let (set, hp_override) = match boss_override {
                    Some((set, hp)) if info.boss => (set, hp),
                    _ => (comps, None),
                };
                let comp = set.pick(rng);
                let mut enemy = comp.init.clone();
                if let (Some(hp), Some(flag)) = (hp_override, enemy.first_mut()) {
                    flag.hp = hp.clamp(1, comp.flagship_max_hp);
                }
                let setup = self.setup(*nb, info.boss, info.formation, comp.formation);
                let tp = match (&self.tp_ships, info.boss) {
                    (Some(t), true) => tp::fleet_tp(t, |i| st[i].hp > 0 && st[i].hp_ratio(self.friend.ships[i].max_hp) > 0.25),
                    _ => [0; 3],
                };
                let mut b = Battle::new([&self.friend, &comp.core], [std::mem::take(&mut st), enemy], setup, rng);
                let o = b.run();
                st = std::mem::take(&mut b.st[0]);
                fought = true;
                battles += 1;
                if info.boss {
                    let start = b.hp_start[1].first().copied().unwrap_or(0);
                    let end = b.st[1].first().map(|s| s.hp.max(0)).unwrap_or(0);
                    boss_result = Some(BossResult { rank: o.rank, sunk: start > 0 && end <= 0, damage: (start - end).max(0), tp });
                }
                if let Some(r) = rec.as_deref_mut() {
                    r.battle[node] += 1;
                    r.ranks[node][rank_idx(o.rank)] += 1;
                    if o.night {
                        r.night[node] += 1;
                    }
                }
            }
            if !self.router.has_rules(node) {
                break;
            }
            if fought {
                if let Some(reason) = self.retreat_reason(&st) {
                    retreated = true;
                    if let Some(r) = rec.as_deref_mut() {
                        r.retreat[node] += 1;
                        match reason {
                            Retreat::Heavy => r.retreat_heavy[node] += 1,
                            Retreat::Moderate => r.retreat_moderate[node] += 1,
                        }
                    }
                    break;
                }
            }
            if path.len() > self.max_nodes {
                if let Some(r) = rec.as_deref_mut() {
                    r.warnings.insert(format!("maxNodes ({}) reached; sortie stopped", self.max_nodes));
                }
                break;
            }
            ships_ctx.clear();
            ships_ctx.extend(self.route_ships.iter().zip(&st).filter(|(_, s)| s.hp > 0).map(|(r, _)| r));
            let ctx = RouteCtx { ships: &ships_ctx, visited: &path };
            match self.router.next(node, &ctx, rng) {
                Some(next) => {
                    path.push(next);
                    node = next;
                }
                None => break,
            }
        }
        let cost = self.cost_of(&st, gain);
        self.last_cost.set(cost);
        if let Some(r) = rec {
            r.costs.push(cost);
            *r.paths.entry(path.iter().map(|&n| n as u16).collect()).or_insert(0) += 1;
            r.battles += battles;
            r.nodes += (path.len() - 1) as u64;
            if retreated {
                r.retreats += 1;
            }
            if boss_reached {
                r.boss_reach += 1;
            }
            if let Some(BossResult { rank, sunk, damage: dmg, .. }) = boss_result {
                r.boss_ranks[rank_idx(rank)] += 1;
                if rank <= Rank::A {
                    r.kills += 1;
                }
                if sunk {
                    r.flag_sunk += 1;
                }
                r.flag_damage += dmg as f64;
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
                sr.damage_taken += (s0.hp - s.hp) as f64;
                sr.hp_missing += (max - s.hp.max(0)) as f64;
                sr.fuel += resupply_cost(s0.fuel - s.fuel, self.married[i]) as f64;
                sr.ammo += resupply_cost(s0.ammo - s.ammo, self.married[i]) as f64;
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

    /// Net resources of a finished sortie (resupply, bauxite, docking or buckets, extras, minus node gains).
    fn cost_of(&self, st: &[ShipState], gain: [f64; 4]) -> Cost {
        let mut c: Cost = [0.0; 6];
        for (i, (s, s0)) in st.iter().zip(&self.init).enumerate() {
            c[0] += resupply_cost(s0.fuel - s.fuel, self.married[i]) as f64;
            c[1] += resupply_cost(s0.ammo - s.ammo, self.married[i]) as f64;
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
        for k in 0..4 {
            c[k] += self.extra[k] - gain[k];
        }
        c
    }

    /// Applies a maelstrom to the fleet; returns (is fuel, total lost).
    fn maelstrom(&self, m: &Maelstrom, st: &mut [ShipState], rng: &mut Rng) -> (bool, f64) {
        let fuel = m.resource == MaelstromResource::Fuel;
        let mut rate = m.rate.unwrap_or(0.0);
        if let (Some(h), Some(c)) = (m.rate_high, m.high_chance) {
            if c > 0.0 && rng.chance(c) {
                rate = h;
            }
        }
        let radars = st.iter().zip(&self.radar).filter(|(s, &r)| s.hp > 0 && r).count();
        let mut total = 0.0;
        for s in st.iter_mut().filter(|s| s.hp > 0) {
            let have = if fuel { &mut s.fuel } else { &mut s.ammo };
            let loss = maelstrom_loss(*have, rate, m.max, radars, m.radar_reducible.unwrap_or(true));
            *have -= loss;
            total += loss as f64;
        }
        (fuel, total)
    }

    /// Anchorage repair (kcwiki 紧急泊地修理): heal ceil(rate × max HP) of covered ships above 25% HP, +7 morale,
    /// by a repair ship above 50% HP. Returns (HP restored, materials used).
    fn anchorage(&self, st: &mut [ShipState]) -> (f64, f64) {
        let mut healed = 0.0;
        let mut used = 0.0;
        for (i, rate, covered) in &self.repairers {
            let max_i = self.friend.ships[*i].max_hp;
            if st[*i].hp <= 0 || st[*i].hp_ratio(max_i) <= 0.5 {
                continue;
            }
            let mut any = false;
            for &k in covered {
                let Some(core) = self.friend.ships.get(k) else { continue };
                let s = &mut st[k];
                if s.hp <= 0 || s.hp >= core.max_hp || s.hp_ratio(core.max_hp) <= 0.25 {
                    continue;
                }
                let new = (s.hp + (core.max_hp as f64 * rate).ceil() as i32).min(core.max_hp);
                healed += (new - s.hp) as f64;
                s.hp = new;
                s.morale = (s.morale + 7).min(100);
                any = true;
            }
            if any {
                used += 1.0;
                break;
            }
        }
        (healed, used)
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

    fn phase_run(&self, kind: GaugeKind, remaining: f64, comps: &Option<Vec<EnemyComp>>, final_comps: &Option<Vec<EnemyComp>>, threshold: Option<f64>, routing_phase: Option<f64>, tank: Option<TankType>, tp: Option<f64>) -> Result<PhaseRun, String> {
        let boss_set = match comps {
            Some(c) => Some(CompSet::new("gauge.comps", c)?),
            None => None,
        };
        let final_set = match final_comps {
            Some(c) if kind == GaugeKind::Hp => Some(CompSet::new("gauge.finalComps", c)?),
            _ => None,
        };
        let threshold = threshold.unwrap_or_else(|| {
            let sets: Vec<&CompSet> = match (&final_set, &boss_set) {
                (Some(s), _) | (None, Some(s)) => vec![s],
                _ => self.nodes.iter().filter(|n| n.boss).filter_map(|n| n.battle.as_ref().map(|b| &b.1)).collect(),
            };
            sets.iter().flat_map(|s| s.comps.iter().map(|c| c.flagship_max_hp)).max().unwrap_or(0) as f64
        });
        Ok(PhaseRun { kind, remaining, boss_set, final_set, threshold, routing_phase, tank: tp::mode(tank), tp_override: tp })
    }

    /// One sortie of a gauge phase; returns whether the phase is now cleared.
    fn phase_sortie(&self, ph: &PhaseRun, remaining: &mut f64, rng: &mut Rng, morale: Option<&mut Vec<i32>>) -> bool {
        let over = |hp: Option<i32>| ph.boss_set.as_ref().map(|s| (s, hp));
        match ph.kind {
            GaugeKind::Kill => {
                if let Some(r) = self.run_one(rng, over(None), None, morale) {
                    if r.rank <= Rank::A {
                        *remaining -= 1.0;
                    }
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
        let has_boss = self.nodes.iter().any(|n| n.boss && n.battle.is_some());
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
        } else if !has_boss {
            runs = g.runs.unwrap_or(200);
            warning = Some("gauge: no boss battle node in the map; nothing to estimate".to_string());
            capped = runs;
        } else {
            runs = g.runs.unwrap_or(200);
            let phases: Vec<PhaseRun> = if phased {
                g.phases.iter().flatten().map(|p| self.phase_run(p.kind, p.remaining, &p.comps, &p.final_comps, p.final_threshold, p.phase, p.tank, p.tp_per_sortie)).collect::<Result<_, _>>()?
            } else {
                vec![self.phase_run(g.kind, g.remaining, &None, &g.final_comps, g.final_threshold, None, g.tank, g.tp_per_sortie)?]
            };
            let n = phases.len();
            let base_phase = self.router.phase();
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

    /// Final form with the boss node's own comps: run with an HP override only.
    fn run_final_default(&self, rng: &mut Rng, hp: i32, morale: Option<&mut Vec<i32>>) -> Option<BossResult> {
        // The boss node's comps are used; the override set is looked up per boss node.
        let boss_set = self.nodes.iter().find(|n| n.boss).and_then(|n| n.battle.as_ref().map(|b| &b.1))?;
        self.run_one(rng, Some((boss_set, Some(hp))), None, morale)
    }
}

/// `simulateSortie` entry point.
pub fn simulate_sortie(input: &SortieInput, count: u32, seed: u64) -> Result<SortieSummary, String> {
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
    let ships: Vec<&RouteShip> = sortie.route_ships.iter().zip(&sortie.init).filter(|(_, s)| s.hp > 0).map(|(r, _)| r).collect();
    let mut node = sortie.start_node(&mut rng);
    let mut path = vec![node];
    while path.len() <= sortie.max_nodes {
        let ctx = RouteCtx { ships: &ships, visited: &path };
        match sortie.router.next(node, &ctx, &mut rng) {
            Some(n) => {
                path.push(n);
                node = n;
            }
            None => break,
        }
    }
    Ok(path.into_iter().map(|i| sortie.router.name(i).to_string()).collect())
}
