//! One battle (one node): setup, phase order, targeting, damage application, rank, supply, morale.
//! Phase logic ported from KC3Kai/kancolle-replay `js/kcsim.js` (`sim`, `choiceWProtect`,
//! `takeDamage`, `getRank` (rules from KC3Kai/ElectronicObserver), `updateSupply`, `updateMorale`),
//! MIT © fourinone41; morale/supply/protection rules per en.kancollewiki.net.

mod air;
pub mod calc;
mod day;
mod night;
mod torpedo;


pub use day::special_day_ci as day_ci_of;
pub use night::special_night as night_attack_of;
use crate::equipment::{f, ID_DAMECON_GODDESS, ID_DAMECON_TEAM};
use crate::formation::{self, roll_engagement};
use crate::formulas;
use crate::model::*;
use crate::rng::Rng;
use crate::ship::{ShipCore, ShipState, EX_SLOT, MAX_SLOTS};
use calc::Unit;

pub const MAX_SHIPS: usize = 7;

/// Small fixed-capacity index list (fleet positions).
#[derive(Clone, Copy, Debug, Default)]
pub struct List {
    n: usize,
    a: [usize; MAX_SHIPS],
}

impl List {
    #[inline]
    pub fn push(&mut self, i: usize) {
        if self.n < MAX_SHIPS {
            self.a[self.n] = i;
            self.n += 1;
        }
    }
    #[inline]
    pub fn as_slice(&self) -> &[usize] {
        &self.a[..self.n]
    }
    #[inline]
    pub fn len(&self) -> usize {
        self.n
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.n == 0
    }
}

/// Static derived data of one fleet (no formation: that is a per-battle setting).
pub struct FleetCore {
    pub ships: Vec<ShipCore>,
    pub is_player: bool,
}

impl FleetCore {
    /// Derive cores and the initial battle state of a fleet.
    pub fn build(fl: &FleetInput, player: bool) -> (FleetCore, Vec<ShipState>) {
        let ships: Vec<ShipCore> = fl.ships.iter().map(|s| ShipCore::new(s, player)).collect();
        let states = ships.iter().zip(&fl.ships).map(|(c, s)| c.initial_state(s)).collect();
        (FleetCore { ships, is_player: player }, states)
    }
}

/// Per-battle settings.
#[derive(Clone, Copy, Debug)]
pub struct BattleSetup {
    pub kind: BattleKind,
    pub engagement: Option<Engagement>,
    pub formations: [Formation; 2],
    /// `dayNight` only: pursue at night only when the day rank is worse than this.
    pub night_unless: Option<Rank>,
    pub log: bool,
}

/// Validated input with all static derivations done once (reused across Monte-Carlo runs).
pub struct Prepared {
    pub fleets: [FleetCore; 2],
    pub init: [Vec<ShipState>; 2],
    pub setup: BattleSetup,
}

pub fn validate_fleet(name: &str, fleet: &FleetInput, allow_empty: bool) -> Result<(), String> {
    if fleet.ships.is_empty() && !allow_empty {
        return Err(format!("{name} fleet must have at least one ship"));
    }
    if fleet.ships.len() > MAX_SHIPS {
        return Err(format!("{name} fleet has {} ships (max {MAX_SHIPS})", fleet.ships.len()));
    }
    for (i, s) in fleet.ships.iter().enumerate() {
        if s.slots.len() > 5 {
            return Err(format!("{name} ship #{i}: {} slots (max 5)", s.slots.len()));
        }
        if s.max_hp <= 0 {
            return Err(format!("{name} ship #{i}: maxHp must be positive"));
        }
    }
    Ok(())
}

impl Prepared {
    pub fn new(input: &BattleInput) -> Result<Prepared, String> {
        validate_fleet("friend", &input.friend, false)?;
        validate_fleet("enemy", &input.enemy, true)?;
        let (ff, fs) = FleetCore::build(&input.friend, true);
        let (ef, es) = FleetCore::build(&input.enemy, false);
        Ok(Prepared {
            fleets: [ff, ef],
            init: [fs, es],
            setup: BattleSetup {
                kind: input.options.kind,
                engagement: input.options.engagement,
                formations: [input.friend.formation.unwrap_or_default(), input.enemy.formation.unwrap_or_default()],
                night_unless: None,
                log: input.options.log,
            },
        })
    }

    pub fn battle<'a>(&'a self, rng: &'a mut Rng) -> Battle<'a> {
        Battle::new([&self.fleets[0], &self.fleets[1]], [self.init[0].clone(), self.init[1].clone()], self.setup, rng)
    }
}

/// Air state of `side` (2 AS+ .. -2 AI) from the friend-perspective value.
#[inline]
fn side_air(air: i8, side: usize) -> i8 {
    if side == 0 {
        air
    } else {
        -air
    }
}

pub struct Outcome {
    pub rank: Rank,
    pub mvp: usize,
    pub engagement: Engagement,
    pub air_state: AirState,
    pub detection: Detection,
    pub night: bool,
    pub enemy_gauge: i32,
    pub friend_gauge: i32,
}

pub struct Battle<'a> {
    pub fleets: [&'a FleetCore; 2],
    pub setup: BattleSetup,
    pub st: [Vec<ShipState>; 2],
    pub hp_start: [Vec<i32>; 2],
    rng: &'a mut Rng,
    no_red_t: bool,
    second_shelling: bool,
    /// Every enemy ship afloat at the start is a submarine (8% fuel / 0% ammo node).
    sub_only_enemy: bool,
    /// Fleet AA (formation applied) per side.
    fleet_aa: [f64; 2],
    engagement: Engagement,
    eng: f64,
    /// Friend-perspective air state (2..-2); meaningful only when `air_combat`.
    air: i8,
    air_combat: bool,
    fleet_los: [f64; 2],
    phase: Phase,
    pub events: Option<Vec<AttackEvent>>,
}

impl<'a> Battle<'a> {
    /// `st` is the state of both fleets at the start of the battle (carried over in sorties).
    pub fn new(fleets: [&'a FleetCore; 2], mut st: [Vec<ShipState>; 2], setup: BattleSetup, rng: &'a mut Rng) -> Battle<'a> {
        for s in st.iter_mut().flatten() {
            s.dmg_dealt = 0;
            s.damecon_used = None;
        }
        let hp_start = [st[0].iter().map(|s| s.hp).collect(), st[1].iter().map(|s| s.hp).collect()];
        let alive = |side: usize| fleets[side].ships.iter().zip(&st[side]).filter(|(_, s)| s.hp > 0).map(|(c, _)| c);
        let second_shelling = alive(0).chain(alive(1)).any(|c| c.class.is_bb_class());
        let no_red_t = fleets[0].ships.iter().chain(fleets[1].ships.iter()).any(|c| c.no_red_t);
        let sub_only_enemy = alive(1).next().is_some() && alive(1).all(|c| c.class.is_sub());
        let fleet_aa = |side: usize| {
            let base = alive(side).map(|c| c.fleet_aa).sum::<f64>().floor();
            (base * formation::mods(setup.formations[side], 0, fleets[side].ships.len()).aa).floor()
        };
        let fleet_aa = [fleet_aa(0), fleet_aa(1)];
        Battle {
            fleets,
            setup,
            st,
            hp_start,
            rng,
            no_red_t,
            second_shelling,
            sub_only_enemy,
            fleet_aa,
            engagement: Engagement::SameCourse,
            eng: 1.0,
            air: 0,
            air_combat: false,
            fleet_los: [0.0; 2],
            phase: Phase::AirStrike,
            events: if setup.log { Some(Vec::new()) } else { None },
        }
    }

    #[inline]
    pub fn core(&self, side: usize, i: usize) -> &'a ShipCore {
        &self.fleets[side].ships[i]
    }

    #[inline]
    pub fn len(&self, side: usize) -> usize {
        self.fleets[side].ships.len()
    }

    #[inline]
    pub fn unit(&self, side: usize, i: usize) -> Unit<'_> {
        let fl = self.fleets[side];
        Unit { core: &fl.ships[i], st: &self.st[side][i], form: self.setup.formations[side], idx: i, len: fl.ships.len() }
    }

    #[inline]
    pub fn alive(&self, side: usize, i: usize) -> bool {
        self.st[side][i].hp > 0
    }

    /// Afloat surface ships (non-submarines) of `side`.
    pub fn surface(&self, side: usize) -> List {
        let mut l = List::default();
        for i in 0..self.len(side) {
            if self.alive(side, i) && !self.core(side, i).class.is_sub() {
                l.push(i);
            }
        }
        l
    }

    /// Afloat submarines of `side`.
    pub fn subs(&self, side: usize) -> List {
        let mut l = List::default();
        for i in 0..self.len(side) {
            if self.alive(side, i) && self.core(side, i).class.is_sub() {
                l.push(i);
            }
        }
        l
    }

    pub fn any_alive(&self, side: usize) -> bool {
        (0..self.len(side)).any(|i| self.alive(side, i))
    }

    /// kcsim `choiceWProtect`: random target, searchlight re-rolls, vanguard re-roll, flagship
    /// protection. Returns (target, covered).
    pub fn choose_target(&mut self, def_side: usize, cands: &[usize], sl_rerolls: u8) -> (usize, bool) {
        let n = cands.len();
        let mut t = cands[self.rng.below(n)];
        for _ in 0..sl_rerolls {
            if self.core(def_side, t).searchlight > 0 {
                break;
            }
            t = cands[self.rng.below(n)];
        }
        let form = self.setup.formations[def_side];
        if form == Formation::Vanguard && formation::vanguard_front(t, self.len(def_side)) {
            t = cands[self.rng.below(n)];
        }
        if t != 0 || self.core(def_side, t).is_installation {
            return (t, false);
        }
        let rate = formation::protection_rate(form);
        if self.rng.chance(rate) {
            let mut defenders = List::default();
            for &c in cands {
                let core = self.core(def_side, c);
                if c != t && self.st[def_side][c].hp_ratio(core.max_hp) > 0.75 && !core.is_installation {
                    defenders.push(c);
                }
            }
            if defenders.is_empty() {
                return (t, false);
            }
            let d = defenders.as_slice()[self.rng.below(defenders.len())];
            return (d, true);
        }
        (t, false)
    }

    /// Apply damage (sinking protection, damage control). Returns the HP actually removed.
    pub fn take_damage(&mut self, side: usize, i: usize, dmg: i32) -> i32 {
        let core = &self.fleets[side].ships[i];
        let st = &mut self.st[side][i];
        let mut dmg = dmg.max(0);
        if st.protected {
            let red = i != 0 && st.morale < 20;
            dmg = formulas::protect(self.rng, dmg, st.hp, red);
        }
        st.hp -= dmg;
        if st.hp <= 0 {
            st.hp = 0;
            if st.damecon_slots != 0 {
                let slot = st.damecon_slots.trailing_zeros() as usize;
                st.damecon_slots &= !(1 << slot);
                let id = core.slots[slot].as_ref().map(|e| e.id).unwrap_or(ID_DAMECON_TEAM);
                if id == ID_DAMECON_GODDESS {
                    st.hp = core.max_hp;
                    st.fuel = st.fuel_max;
                    st.ammo = st.ammo_max;
                } else {
                    st.hp = (0.2 * core.max_hp as f64).floor() as i32;
                }
                st.damecon_used = Some(id);
                if core.is_player {
                    st.protected = true;
                }
            }
        }
        dmg
    }

    /// Credit damage to the attacker (MVP) and record the event.
    #[allow(clippy::too_many_arguments)]
    pub fn record(
        &mut self,
        kind: AttackKind,
        special: SpecialAttack,
        att_side: usize,
        a: usize,
        d: usize,
        covered: bool,
        slot: Option<usize>,
        roll: formulas::Roll,
        damage: i32,
        hp_before: i32,
        hc: &formulas::HitCrit,
    ) {
        self.st[att_side][a].dmg_dealt += damage;
        if let Some(ev) = self.events.as_mut() {
            ev.push(AttackEvent {
                phase: self.phase,
                kind,
                special,
                attacker_side: if att_side == 0 { Side::Friend } else { Side::Enemy },
                attacker: a,
                defender: d,
                covered,
                slot,
                hit: match roll {
                    formulas::Roll::Miss => HitResult::Miss,
                    formulas::Roll::Hit => HitResult::Hit,
                    formulas::Roll::Crit(_) => HitResult::Critical,
                },
                damage,
                defender_hp_before: hp_before,
                defender_hp_after: self.st[1 - att_side][d].hp,
                p_hit: hc.p_hit(),
                p_crit: hc.p_crit(),
            });
        }
    }

    #[inline]
    pub fn rng(&mut self) -> &mut Rng {
        self.rng
    }

    /// Ranges descending, ties in the game's order (kcsim `orderByRange`, see [`game_range_sort`]).
    pub fn order_by_range(&mut self, side: usize, mut l: List) -> List {
        let n = l.n;
        let mut range = [0u8; MAX_SHIPS];
        for (r, &i) in range.iter_mut().zip(&l.a[..n]) {
            *r = self.core(side, i).range;
        }
        game_range_sort(&mut l.a[..n], &mut range[..n], self.rng);
        l
    }

    /// Run the whole battle.
    pub fn run(&mut self) -> Outcome {
        let kind = self.setup.kind;
        let night_only = kind == BattleKind::NightOnly;
        // Morale cost of entering the battle (applied before combat).
        for (i, st) in self.st[0].iter_mut().enumerate() {
            if st.hp <= 0 {
                continue;
            }
            if night_only {
                st.morale -= 2;
            } else {
                if st.morale < 30 {
                    st.morale -= 6;
                }
                st.morale -= 3;
            }
            st.morale = st.morale.max(0);
            let core = &self.fleets[0].ships[i];
            st.protected = i == 0 || st.hp_ratio(core.max_hp) > 0.25;
        }
        self.engagement = match self.setup.engagement {
            Some(e) => e,
            None => {
                let r = self.rng.f64();
                roll_engagement(r, self.no_red_t)
            }
        };
        self.eng = formation::engagement_mod(self.engagement);

        let mut detection = Detection::Success;
        let mut did_night = false;
        match kind {
            BattleKind::NightOnly => {
                if self.both_alive() {
                    self.phase = Phase::Night;
                    self.night_phase(true);
                    did_night = true;
                }
            }
            BattleKind::AirRaid => {
                if self.both_alive() {
                    self.air_phase(false, false);
                }
            }
            BattleKind::AirBattle => {
                detection = self.detection();
                let failed = matches!(detection, Detection::Failure | Detection::FailureLost | Detection::NotFound);
                for _ in 0..2 {
                    if self.both_alive() {
                        self.air_phase(failed, true);
                    }
                }
            }
            BattleKind::Day | BattleKind::DayNight => {
                detection = self.detection();
                let failed = matches!(detection, Detection::Failure | Detection::FailureLost | Detection::NotFound);
                if self.both_alive() {
                    self.air_phase(failed, true);
                }
                if self.both_alive() {
                    self.phase = Phase::OpeningAsw;
                    self.opening_asw();
                }
                if self.both_alive() {
                    self.phase = Phase::OpeningTorpedo;
                    self.torpedo_phase(true);
                }
                self.fleet_los = [self.compute_fleet_los(0), self.compute_fleet_los(1)];
                if self.both_alive() {
                    self.phase = Phase::Shelling1;
                    self.shelling(false);
                }
                if self.second_shelling && self.both_alive() {
                    self.phase = Phase::Shelling2;
                    self.shelling(true);
                }
                if self.both_alive() {
                    self.phase = Phase::ClosingTorpedo;
                    self.torpedo_phase(false);
                }
                let pursue = kind == BattleKind::DayNight
                    && self.both_alive()
                    && self.setup.night_unless.is_none_or(|r| self.rank().0 > r);
                if pursue {
                    for st in self.st[0].iter_mut() {
                        if st.hp > 0 {
                            st.morale = (st.morale - 2).max(0);
                        }
                    }
                    self.phase = Phase::Night;
                    self.night_phase(false);
                    did_night = true;
                }
            }
        }

        let (rank, enemy_gauge, friend_gauge) = if kind == BattleKind::AirRaid { self.raid_rank() } else { self.rank() };
        let mvp = self.mvp();
        self.update_morale(rank, mvp);
        self.update_supply(did_night);
        Outcome {
            rank,
            mvp,
            engagement: self.engagement,
            air_state: self.air_state(),
            detection,
            night: did_night,
            enemy_gauge,
            friend_gauge,
        }
    }

    fn both_alive(&self) -> bool {
        self.any_alive(0) && self.any_alive(1)
    }

    fn air_state(&self) -> AirState {
        if !self.air_combat {
            return AirState::None;
        }
        match self.air {
            2 => AirState::Supremacy,
            1 => AirState::Superiority,
            0 => AirState::Parity,
            -1 => AirState::Denial,
            _ => AirState::Incapability,
        }
    }

    /// kcsim `getDetection` (friend side; enemies always detect).
    fn detection(&mut self) -> Detection {
        use crate::equipment::cat;
        const W: [f64; 6] = [2.0, 5.0, 8.0, 8.0, 8.0, 8.0];
        let mut weighted = 0.0;
        let mut recon_slots = 0.0;
        let mut carriers = 0.0f64;
        let mut ships = 0.0f64;
        let mut k = 0;
        let mut recon_list: Vec<(usize, usize)> = Vec::new();
        for i in 0..self.len(0) {
            if !self.alive(0, i) {
                continue;
            }
            let c = self.core(0, i);
            weighted += W.get(k).map(|w| c.los / w).unwrap_or(0.0);
            k += 1;
            for s in 0..MAX_SLOTS {
                let Some(e) = c.slots[s].as_ref() else { continue };
                let planes = self.st[0][i].planes[s];
                if planes <= 0 {
                    continue;
                }
                if [cat::CARRIER_SCOUT, cat::CARRIER_SCOUT2, cat::SEAPLANE, cat::SEAPLANE_BOMBER, cat::FLYING_BOAT].contains(&e.cat) {
                    recon_slots += planes as f64;
                    recon_slots += match e.rank {
                        7 => 30.0,
                        4..=6 => 15.0,
                        2 | 3 => 5.0,
                        _ => 0.0,
                    };
                    recon_list.push((i, s));
                }
            }
            if c.class.is_carrier() {
                carriers += 1.0;
            }
            ships += 1.0;
        }
        if carriers > 0.0 {
            recon_slots += 20.0 + 10.0 * carriers;
        }
        let mut fighter_slots = 0.0;
        for i in 0..self.len(1) {
            if !self.alive(1, i) {
                continue;
            }
            let c = self.core(1, i);
            for s in 0..MAX_SLOTS {
                if c.slots[s].as_ref().is_some_and(|e| e.cat == cat::FIGHTER) {
                    fighter_slots += self.st[1][i].planes[s].max(0) as f64;
                }
            }
        }
        let defence = if fighter_slots <= 0.0 {
            0.0
        } else if fighter_slots <= 30.0 {
            1.0 + fighter_slots / 9.0
        } else if fighter_slots <= 120.0 {
            2.0 + fighter_slots / 20.0
        } else {
            6.0 + (fighter_slots - 120.0) / 40.0
        };
        let detect = weighted + (ships - 2.0).max(0.0) - 20.0 + (10.0 * recon_slots).sqrt().floor();
        let shotdown = recon_slots - (defence * (1.0 + 0.1 * self.rng.floor_mul(5.0))).floor();
        let lost = shotdown <= 0.0;
        if lost {
            for &(i, s) in &recon_list {
                let n = (self.rng.floor_mul(3.0) as i32).min(self.st[0][i].planes[s]);
                self.st[0][i].planes[s] -= n;
            }
        }
        let r = self.rng.floor_mul(20.0);
        match (r <= detect, recon_slots <= 0.0, lost) {
            (true, true, _) => Detection::Found,
            (true, false, true) => Detection::SuccessLost,
            (true, false, false) => Detection::Success,
            (false, true, _) => Detection::NotFound,
            (false, false, true) => Detection::FailureLost,
            (false, false, false) => Detection::Failure,
        }
    }

    /// Fleet LoS for artillery spotting: naked LoS + recon seaplane LoS × floor(√planes).
    fn compute_fleet_los(&self, side: usize) -> f64 {
        let mut los = 0.0;
        for i in 0..self.len(side) {
            if !self.alive(side, i) {
                continue;
            }
            let c = self.core(side, i);
            los += c.naked.los;
            for s in 0..MAX_SLOTS {
                if let Some(e) = c.slots[s].as_ref() {
                    if e.has(f::RECON) && e.los > 0.0 {
                        los += e.los * (self.st[side][i].planes[s].max(0) as f64).sqrt().floor();
                    }
                }
            }
        }
        los
    }

    fn rank(&self) -> (Rank, i32, i32) {
        let hp = |side: usize| -> Vec<RankShip> {
            (0..self.len(side))
                .map(|i| RankShip { start: self.hp_start[side][i], end: self.st[side][i].hp, max: self.core(side, i).max_hp })
                .collect()
        };
        compute_rank(&hp(0), &hp(1))
    }

    /// Air-raid rank (ElectronicObserver kcmemo): friend HP-loss rate 0 → SS, < 10 A, < 20 B,
    /// < 50 C, < 80 D, else E. Returns (rank, enemy gauge, friend gauge).
    fn raid_rank(&self) -> (Rank, i32, i32) {
        let (_, enemy_gauge, _) = self.rank();
        let (mut start, mut end) = (0i64, 0i64);
        for i in 0..self.len(0) {
            if self.hp_start[0][i] > 0 {
                start += self.hp_start[0][i] as i64;
                end += self.st[0][i].hp.max(0) as i64;
            }
        }
        let lost = if start > 0 { ((start - end) as f64 / start as f64 * 100.0).floor().max(0.0) as i32 } else { 0 };
        let rank = match lost {
            0 => Rank::SS,
            l if l < 10 => Rank::A,
            l if l < 20 => Rank::B,
            l if l < 50 => Rank::C,
            l if l < 80 => Rank::D,
            _ => Rank::E,
        };
        (rank, enemy_gauge, lost)
    }

    fn mvp(&self) -> usize {
        let mut best = 0;
        for i in 1..self.len(0) {
            if self.st[0][i].dmg_dealt > self.st[0][best].dmg_dealt {
                best = i;
            }
        }
        best
    }

    /// Post-battle morale (wiki): S +4, A +3, B +2, C +1, flagship +3 (≥ C), MVP +10.
    fn update_morale(&mut self, rank: Rank, mvp: usize) {
        let rank_bonus = match rank {
            Rank::SS | Rank::S => 4,
            Rank::A => 3,
            Rank::B => 2,
            Rank::C => 1,
            Rank::D | Rank::E => 0,
        };
        for (i, st) in self.st[0].iter_mut().enumerate() {
            if self.hp_start[0][i] <= 0 {
                continue;
            }
            let mut m = st.morale + rank_bonus;
            if i == 0 && rank <= Rank::C {
                m += 3;
            }
            if i == mvp {
                m += 10;
            }
            st.morale = m.clamp(0, 100);
        }
    }

    /// Fuel/ammo consumption (wiki "Map Mechanics and Nodes").
    fn update_supply(&mut self, did_night: bool) {
        let kind = self.setup.kind;
        let night_only = kind == BattleKind::NightOnly;
        let (cf, ca) = if kind == BattleKind::AirRaid {
            (0.06, 0.04)
        } else if self.sub_only_enemy {
            (0.08, 0.0)
        } else if night_only {
            (0.1, 0.1)
        } else {
            (0.2, 0.2)
        };
        for st in self.st[0].iter_mut() {
            if st.hp <= 0 {
                continue;
            }
            let fuel = ((st.fuel_max as f64 * cf).floor() as i32).max(1);
            st.fuel = (st.fuel - fuel).max(0);
            if ca > 0.0 {
                let mut ammo = ((st.ammo_max as f64 * ca).floor() as i32).max(1);
                if did_night && !night_only {
                    ammo += (st.ammo_max as f64 * ca / 2.0).ceil() as i32;
                }
                st.ammo = (st.ammo - ammo).max(0);
            }
        }
    }
}

/// Damage state of a ship at the end of a battle.
pub fn damage_state(hp: i32, max_hp: i32) -> DamageState {
    if hp <= 0 {
        return DamageState::Sunk;
    }
    let r = hp as f64 / max_hp.max(1) as f64;
    if r <= 0.25 {
        DamageState::Heavy
    } else if r <= 0.5 {
        DamageState::Moderate
    } else if r <= 0.75 {
        DamageState::Light
    } else {
        DamageState::Healthy
    }
}

/// Write post-battle values back into an input-shaped fleet.
pub fn write_state(fleet: &mut FleetInput, cores: &[ShipCore], states: &[ShipState]) {
    for ((ship, core), st) in fleet.ships.iter_mut().zip(cores).zip(states) {
        ship.hp = Some(st.hp);
        if core.is_player {
            ship.fuel = Some(st.fuel);
            ship.ammo = Some(st.ammo);
            ship.morale = Some(st.morale);
        }
        for s in 0..MAX_SLOTS {
            let Some(ec) = core.slots[s].as_ref() else { continue };
            let slot = if s == EX_SLOT { &mut ship.ex_slot } else { &mut ship.slots[s] };
            let consumed = core.is_player
                && ec.has(f::DAMECON)
                && (ec.id == ID_DAMECON_TEAM || ec.id == ID_DAMECON_GODDESS)
                && st.damecon_slots & (1 << s) == 0;
            if consumed {
                *slot = None;
                continue;
            }
            let Some(e) = slot.as_mut() else { continue };
            if ec.has(f::PLANE) && s != EX_SLOT {
                e.planes = Some(st.planes[s]);
                if st.planes[s] <= 0 && e.proficiency.unwrap_or(0) > 0 {
                    e.proficiency = Some(0);
                }
            }
        }
    }
}

/// HP of one ship for rank computation.
#[derive(Clone, Copy, Debug)]
pub struct RankShip {
    pub start: i32,
    pub end: i32,
    pub max: i32,
}

/// Battle rank by the KC3Kai / ElectronicObserver (kcmemo) rules. Ships with `start <= 0` are not
/// part of the battle. Returns (rank, enemy damage gauge %, friend damage gauge %).
pub fn compute_rank(friend: &[RankShip], enemy: &[RankShip]) -> (Rank, i32, i32) {
    let tally = |ships: &[RankShip]| {
        let (mut count, mut sunk, mut start, mut end) = (0i32, 0i32, 0i64, 0i64);
        for s in ships.iter().filter(|s| s.start > 0) {
            count += 1;
            let e = s.end.max(0);
            if e <= 0 {
                sunk += 1;
            }
            start += s.start as i64;
            end += e as i64;
        }
        (count, sunk, start, end)
    };
    let (fc, fs, f_start, f_end) = tally(friend);
    let (ec, es, e_start, e_end) = tally(enemy);
    let gauge = |start: i64, end: i64| {
        if start <= 0 {
            0
        } else {
            (((start - end) as f64 / start as f64) * 100.0).floor().max(0.0) as i32
        }
    };
    let friend_gauge = gauge(f_start, f_end);
    let enemy_gauge = gauge(e_start, e_end);
    let enemy_flag_sunk = enemy.first().is_some_and(|s| s.start > 0 && s.end <= 0);
    let friend_flag_heavy = friend.first().is_some_and(|s| s.end as f64 / s.max.max(1) as f64 <= 0.25);
    let rank = if fs == 0 && es == ec {
        if f_end >= f_start {
            Rank::SS
        } else {
            Rank::S
        }
    } else if fs == 0 && ec > 1 && es >= (ec as f64 * 0.7).floor() as i32 {
        Rank::A
    } else if enemy_flag_sunk && fs < es {
        Rank::B
    } else if fc == 1 && friend_flag_heavy {
        Rank::D
    } else if enemy_gauge as f64 > 2.5 * friend_gauge as f64 {
        Rank::B
    } else if enemy_gauge as f64 > 0.9 * friend_gauge as f64 {
        Rank::C
    } else if fs > 0 && fc - fs == 1 {
        Rank::E
    } else {
        Rank::D
    };
    (rank, enemy_gauge, friend_gauge)
}

/// Sorts `items` by `range` descending the way the game client orders shelling turns (kcsim
/// `orderByRange` + `COMMON.zendQsort`, dube116/kancolle-shelling-order): its quicksort with a
/// comparator that answers a fresh coin flip for equal ranges. The resulting tie order is not
/// uniform (3 equal ranges: the first ship leads 50% of the time).
pub fn game_range_sort(items: &mut [usize], range: &mut [u8], rng: &mut Rng) {
    let n = items.len();
    if n < 2 {
        return;
    }
    // after(x, y) ⇔ cmp(x, y) > 0 ⇔ x sorts after y.
    let mut after = |x: u8, y: u8| if x != y { y > x } else { rng.f64() < 0.5 };
    let swap = |items: &mut [usize], range: &mut [u8], i: usize, j: usize| {
        items.swap(i, j);
        range.swap(i, j);
    };
    let mut stack = [(0usize, 0usize); MAX_SHIPS];
    let mut sp = 1;
    stack[0] = (0, n - 1);
    while sp > 0 {
        sp -= 1;
        let (mut begin, mut end) = stack[sp];
        while begin < end {
            swap(items, range, begin, begin + ((end - begin) >> 1));
            let (mut s1, mut s2) = (begin + 1, end);
            loop {
                while s1 < s2 && after(range[begin], range[s1]) {
                    s1 += 1;
                }
                while s2 >= s1 && after(range[s2], range[begin]) {
                    s2 -= 1;
                }
                if s1 >= s2 {
                    break;
                }
                swap(items, range, s1, s2);
                s1 += 1;
                s2 -= 1;
            }
            swap(items, range, begin, s2);
            if s2 - begin <= end - s2 {
                if s2 + 1 < end {
                    stack[sp] = (s2 + 1, end);
                    sp += 1;
                }
                if s2 == begin {
                    break;
                }
                end = s2 - 1;
            } else {
                if begin + 1 < s2 {
                    stack[sp] = (begin, s2 - 1);
                    sp += 1;
                }
                begin = s2 + 1;
            }
        }
    }
}

