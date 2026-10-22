//! Sortie (海域周回) simulator: routing evaluator + chained battles with state carry-over,
//! retreat policy, aggregation and gauge estimation. Contract: docs/SIM_INTERFACE.md "Sortie".

pub mod model;

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::battle::{validate_fleet, Battle, BattleSetup, FleetCore};
use crate::model::{BattleKind, Formation, Rank, RankRates};
use crate::rng::Rng;
use crate::routing::{RouteConfig, RouteCtx, RouteEquip, RouteShip, Router};
use crate::ship::ShipState;
use model::*;

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

struct NodeInfo {
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Retreat {
    Heavy,
    Moderate,
}

/// Boss battle of one sortie: (rank, flagship sunk, damage dealt to the flagship).
type BossResult = (Rank, bool, i32);

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
            match input.map.nodes.get(&letter) {
                None => {
                    if !letter.starts_with("Start") {
                        warning = Some(format!("node {letter} is not in map.nodes; treated as empty"));
                    }
                }
                Some(n) => {
                    boss = n.boss.unwrap_or(false) || n.kind == Some(NodeKind::Boss);
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
            nodes.push(NodeInfo { battle, boss, formation, warning });
        }

        let (friend, init) = FleetCore::build(&input.friend, true);
        for (i, s) in input.friend.ships.iter().enumerate() {
            if s.speed.is_none() {
                warnings.push(format!("friend ship #{i} has no speed; routing assumes fast (10)"));
            }
        }
        Ok(Sortie {
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
    fn run_one(&self, rng: &mut Rng, boss_override: Option<(&CompSet, Option<i32>)>, mut rec: Option<&mut Rec>) -> Option<BossResult> {
        let mut st = self.init.clone();
        let mut node = self.start_node(rng);
        let mut path: Vec<usize> = vec![node];
        let mut boss_result = None;
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
                let mut b = Battle::new([&self.friend, &comp.core], [std::mem::take(&mut st), enemy], setup, rng);
                let o = b.run();
                st = std::mem::take(&mut b.st[0]);
                fought = true;
                battles += 1;
                if info.boss {
                    let start = b.hp_start[1].first().copied().unwrap_or(0);
                    let end = b.st[1].first().map(|s| s.hp.max(0)).unwrap_or(0);
                    boss_result = Some((o.rank, start > 0 && end <= 0, (start - end).max(0)));
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
        if let Some(r) = rec {
            *r.paths.entry(path.iter().map(|&n| n as u16).collect()).or_insert(0) += 1;
            r.battles += battles;
            r.nodes += (path.len() - 1) as u64;
            if retreated {
                r.retreats += 1;
            }
            if boss_reached {
                r.boss_reach += 1;
            }
            if let Some((rank, sunk, dmg)) = boss_result {
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
                sr.fuel += (s0.fuel - s.fuel) as f64;
                sr.ammo += (s0.ammo - s.ammo) as f64;
                if s.damecon_slots != s0.damecon_slots {
                    sr.damecon += 1;
                }
            }
            if any_sunk {
                r.sunk_any += 1;
            }
        }
        boss_result
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
            self.run_one(rng, None, Some(&mut rec));
        }
        self.summarize(rec, count, top_paths)
    }

    fn gauge(&self, g: &GaugeInput, kill_rate: f64, rng: &mut Rng) -> Result<(GaugeSummary, Option<String>), String> {
        let max_sorties = g.max_sorties.unwrap_or(500).max(1);
        let has_boss = self.nodes.iter().any(|n| n.boss && n.battle.is_some());
        let mut warning = None;
        let mut sorties: Vec<u32> = Vec::new();
        let mut capped = 0u32;
        let runs;
        match g.kind {
            GaugeKind::Kill => {
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
                    } else {
                        capped += 1;
                    }
                }
            }
            GaugeKind::Hp => {
                runs = g.runs.unwrap_or(200);
                if !has_boss {
                    warning = Some("gauge: no boss battle node in the map; nothing to estimate".to_string());
                    capped = runs;
                } else {
                    let final_set = match &g.final_comps {
                        Some(c) => Some(CompSet::new("gauge.finalComps", c)?),
                        None => None,
                    };
                    let threshold = g.final_threshold.unwrap_or_else(|| {
                        let sets: Vec<&CompSet> = match &final_set {
                            Some(s) => vec![s],
                            None => self.nodes.iter().filter(|n| n.boss).filter_map(|n| n.battle.as_ref().map(|b| &b.1)).collect(),
                        };
                        sets.iter().flat_map(|s| s.comps.iter().map(|c| c.flagship_max_hp)).max().unwrap_or(0) as f64
                    });
                    for _ in 0..runs {
                        let mut remaining = g.remaining;
                        let mut s = 0;
                        let mut cleared = remaining <= 0.0;
                        while !cleared && s < max_sorties {
                            s += 1;
                            let is_final = remaining <= threshold;
                            let hp = remaining.ceil() as i32;
                            let result = if is_final {
                                match &final_set {
                                    Some(set) => self.run_one(rng, Some((set, Some(hp))), None),
                                    None => self.run_final_default(rng, hp),
                                }
                            } else {
                                self.run_one(rng, None, None)
                            };
                            if let Some((_, sunk, dmg)) = result {
                                if is_final && sunk {
                                    cleared = true;
                                } else {
                                    remaining -= dmg as f64;
                                    if !is_final && remaining <= 0.0 {
                                        cleared = true;
                                    }
                                    if is_final {
                                        remaining = remaining.max(1.0);
                                    }
                                }
                            }
                        }
                        if cleared {
                            sorties.push(s);
                        } else {
                            capped += 1;
                        }
                    }
                }
            }
        }
        sorties.sort_unstable();
        let pct = |q: f64| -> Option<f64> {
            if sorties.is_empty() {
                None
            } else {
                let i = ((q * sorties.len() as f64).ceil() as usize).clamp(1, sorties.len()) - 1;
                Some(sorties[i] as f64)
            }
        };
        let expected = if sorties.is_empty() { None } else { Some(sorties.iter().map(|&s| s as f64).sum::<f64>() / sorties.len() as f64) };
        Ok((
            GaugeSummary {
                kind: g.kind,
                remaining: g.remaining,
                expected_sorties: expected,
                p50_sorties: pct(0.5),
                p90_sorties: pct(0.9),
                capped_rate: if runs > 0 { capped as f64 / runs as f64 } else { 0.0 },
                runs,
            },
            warning,
        ))
    }

    /// Final form with the boss node's own comps: run with an HP override only.
    fn run_final_default(&self, rng: &mut Rng, hp: i32) -> Option<BossResult> {
        // The boss node's comps are used; the override set is looked up per boss node.
        let boss_set = self.nodes.iter().find(|n| n.boss).and_then(|n| n.battle.as_ref().map(|b| &b.1))?;
        self.run_one(rng, Some((boss_set, Some(hp))), None)
    }
}

/// `simulateSortie` entry point.
pub fn simulate_sortie(input: &SortieInput, count: u32, seed: u64) -> Result<SortieSummary, String> {
    let sortie = Sortie::new(input)?;
    let mut rng = Rng::new(seed);
    let top = input.top_paths.unwrap_or(20) as usize;
    let mut summary = sortie.simulate(count, &mut rng, top);
    if let Some(g) = &input.gauge {
        let (gs, warning) = sortie.gauge(g, summary.boss.kill_rate, &mut rng)?;
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
