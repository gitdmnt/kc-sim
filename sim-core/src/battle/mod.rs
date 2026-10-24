//! One battle (one node): setup, phase order, targeting, damage application, rank, supply, morale.
//! Phase logic ported from KC3Kai/kancolle-replay `js/kcsim.js` (`sim`, `choiceWProtect`,
//! `takeDamage`, `getRank` (rules from KC3Kai/ElectronicObserver), `updateSupply`, `updateMorale`)
//! and `js/kcsimcombined.js` (`simCombined`: friend combined fleet vs a single enemy fleet;
//! `sim6vs12` / `sim12vs12` against an enemy combined fleet, see `combined.rs`), MIT ©
//! fourinone41; morale/supply/protection rules per en.kancollewiki.net.
//!
//! A combined fleet (friend or enemy) is one side whose ships are the main fleet followed by the
//! escort (`FleetCore::escort_start`). Each phase engages a subset of a side (`Battle::engaged`):
//! against a single enemy the air phase both friend fleets, opening ASW / torpedo, closing torpedo
//! and night the friend escort, each shelling round one friend fleet (order per combined type as
//! in `simCombined`); against an enemy combined fleet see `combined.rs`.

mod air;
pub mod calc;
mod combined;
mod day;
pub mod friend;
mod jet;
pub mod lbas;
mod night;
pub mod raid;
pub mod special;
pub mod support;
mod torpedo;


pub use day::special_day_ci as day_ci_of;
pub use night::special_night as night_attack_of;
use crate::bonus::{self, BaseBonus, Bonus};
pub use special::{FleetCarry, Rates};
use crate::equipment::{f, ID_DAMECON_GODDESS, ID_DAMECON_TEAM};
use crate::formation::{self, roll_engagement};
use crate::formulas;
use crate::model::*;
use crate::rng::Rng;
use crate::ship::{ShipCore, ShipState, EX_SLOT, MAX_SLOTS};
use calc::{Cf, Unit, CF_NONE};
use friend::{FriendCore, FriendRun};
use lbas::{LandBaseCore, LbPlanes, MAX_SQUADRONS};
use support::{SupportCore, SupportRun};

/// Ships per fleet (main, or a single fleet).
pub const MAX_SHIPS: usize = 7;
/// Ships of a combined fleet's escort (and of a combined fleet's main fleet).
pub const MAX_ESCORT: usize = 6;
/// Capacity of position lists (main + escort).
pub const LIST_CAP: usize = MAX_SHIPS + MAX_ESCORT;

/// kcsim has no night-to-day battle for a friend combined fleet (`simNightFirstCombined` takes a
/// single friend fleet).
pub const NIGHT_TO_DAY_COMBINED: &str =
    "nightToDay: a friend combined fleet cannot fight a night-to-day battle (not modelled; kcsim has single friend fleets only)";

/// Small fixed-capacity index list (fleet positions).
#[derive(Clone, Copy, Debug, Default)]
pub struct List {
    n: usize,
    a: [usize; LIST_CAP],
}

impl List {
    #[inline]
    pub fn push(&mut self, i: usize) {
        if self.n < LIST_CAP {
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
    /// Main fleet ships, then escort ships.
    pub ships: Vec<ShipCore>,
    pub is_player: bool,
    /// Index of the first escort ship (`ships.len()` for a single fleet).
    pub escort_start: usize,
    pub combined: Option<CombinedType>,
}

impl FleetCore {
    /// Derive cores and the initial battle state of a fleet (main then escort).
    pub fn build(fl: &FleetInput, player: bool) -> (FleetCore, Vec<ShipState>) {
        let inputs = || fl.ships.iter().chain(fl.escort_ships());
        let mut ships: Vec<ShipCore> = inputs().map(|s| ShipCore::new(s, player)).collect();
        let states = ships.iter().zip(inputs()).map(|(c, s)| c.initial_state(s)).collect();
        let escort_start = if fl.escort_ships().is_empty() { ships.len() } else { fl.ships.len() };
        let (main, escort) = ships.split_at_mut(escort_start);
        crate::install::spread_anti_pt(main);
        crate::install::spread_anti_pt(escort);
        (FleetCore { ships, is_player: player, escort_start, combined: fl.combined }, states)
    }
}

/// Per-battle settings.
#[derive(Clone, Copy, Debug, Default)]
pub struct BattleSetup {
    pub kind: BattleKind,
    pub engagement: Option<Engagement>,
    pub formations: [Formation; 2],
    /// `dayNight` only: pursue at night only when the day rank is worse than this.
    pub night_unless: Option<Rank>,
    pub log: bool,
    /// Fuel / ammo consumption fractions replacing the kind-based ones (sortie node types).
    pub supply: Option<[f64; 2]>,
    /// The friend fleet tries to deploy a smoke screen (unless `smoke_used`).
    pub smoke: bool,
    /// A smoke screen was already deployed earlier in the sortie.
    pub smoke_used: bool,
    /// Forced smoke layers (0..3) in place of the roll (`BattleOptions.smokeLayers`).
    pub smoke_layers: Option<u8>,
    /// Barrage-balloon node.
    pub balloons: bool,
    /// Atoll node: friend anti-atoll ships attack with their amphibious tanks.
    pub atoll: bool,
}

/// Validated input with all static derivations done once (reused across Monte-Carlo runs).
pub struct Prepared {
    pub fleets: [FleetCore; 2],
    pub init: [Vec<ShipState>; 2],
    pub setup: BattleSetup,
    /// Land bases of the waves (consecutive identical waves share one base).
    pub lbas: Vec<LandBaseCore>,
    /// Base index of each wave.
    lb_waves: Vec<usize>,
    /// Event bonuses of the friend ships (main then escort) and of the waves (empty = none).
    bonus: Vec<Option<Bonus>>,
    lb_bonus: Vec<Option<BaseBonus>>,
    /// Friend sortie carry-over at the start of the battle and special-attack trigger rates.
    pub carry: FleetCarry,
    pub rates: Rates,
    pub support: Option<SupportCore>,
    pub friend_fleet: Option<FriendCore>,
    /// Event bonuses of the friend fleet's ships (empty = none).
    ff_bonus: Vec<Option<Bonus>>,
    /// Enemy air raid on the bases, resolved before the battle.
    pub raid: Option<raid::BattleRaid>,
}

fn validate_ships(name: &str, ships: &[ShipInput], max: usize) -> Result<(), String> {
    if ships.len() > max {
        return Err(format!("{name} fleet has {} ships (max {max})", ships.len()));
    }
    for (i, s) in ships.iter().enumerate() {
        if s.slots.len() > 5 {
            return Err(format!("{name} ship #{i}: {} slots (max 5)", s.slots.len()));
        }
        if s.max_hp <= 0 {
            return Err(format!("{name} ship #{i}: maxHp must be positive"));
        }
    }
    Ok(())
}

/// An enemy fleet (or enemy comp): single, or combined (main `ships` + 1..6 `escort` ships with a
/// combined formation). `combined` (the combined type) is for the friend fleet only.
pub fn validate_fleet(name: &str, fleet: &FleetInput, allow_empty: bool) -> Result<(), String> {
    let escort = fleet.escort_ships();
    if fleet.ships.is_empty() && !(allow_empty && escort.is_empty()) {
        return Err(format!("{name} fleet must have at least one ship"));
    }
    if fleet.combined.is_some() {
        return Err(format!("{name} fleet: `combined` (combined fleet type) is for the friend fleet only; an enemy combined fleet is given by `escort`"));
    }
    if escort.is_empty() {
        if fleet.formation.is_some_and(Formation::is_combined) {
            return Err(format!("{name} fleet: combined formations need a combined fleet"));
        }
        return validate_ships(name, &fleet.ships, MAX_SHIPS);
    }
    if fleet.formation.is_some_and(|f| !f.is_combined()) {
        return Err(format!("{name} fleet: a combined fleet (escort) needs a combined formation (combinedAntiSub / combinedForward / combinedDiamond / combinedBattle)"));
    }
    validate_ships(name, &fleet.ships, MAX_ESCORT)?;
    validate_ships(&format!("{name} escort"), escort, MAX_ESCORT)
}

/// The friend fleet: single, or combined (`combined` + 1..6 escort ships + a combined formation).
pub fn validate_friend(fleet: &FleetInput) -> Result<(), String> {
    let escort = fleet.escort_ships();
    match (escort.is_empty(), fleet.combined) {
        (true, None) => {
            return validate_fleet("friend", fleet, false);
        }
        (false, None) => return Err("friend fleet: escort given without combined (carrier / surface / transport)".into()),
        (true, Some(_)) => return Err("friend fleet: combined fleet needs 1..6 escort ships".into()),
        (false, Some(_)) => {}
    }
    if fleet.ships.is_empty() {
        return Err("friend fleet must have at least one ship".into());
    }
    if fleet.formation.is_some_and(|f| !f.is_combined()) {
        return Err("friend fleet: a combined fleet needs a combined formation (combinedAntiSub / combinedForward / combinedDiamond / combinedBattle)".into());
    }
    validate_ships("friend", &fleet.ships, MAX_SHIPS)?;
    validate_ships("friend escort", escort, MAX_ESCORT)
}

/// Friend formation with the default for the fleet kind.
pub fn friend_formation(fleet: &FleetInput) -> Formation {
    fleet.formation.unwrap_or(if fleet.combined.is_some() { Formation::CombinedBattle } else { Formation::LineAhead })
}

/// Enemy formation: given, else `combinedBattle` for a combined fleet and `lineAhead` otherwise.
pub fn enemy_formation(fleet: &FleetInput) -> Formation {
    fleet.formation.unwrap_or(if fleet.escort_ships().is_empty() { Formation::LineAhead } else { Formation::CombinedBattle })
}

impl Prepared {
    pub fn new(input: &BattleInput) -> Result<Prepared, String> {
        validate_friend(&input.friend)?;
        validate_fleet("enemy", &input.enemy, true)?;
        if input.options.kind == BattleKind::NightToDay && input.friend.combined.is_some() {
            return Err(NIGHT_TO_DAY_COMBINED.into());
        }
        let waves = input.lbas.as_deref().unwrap_or(&[]);
        if waves.len() > lbas::MAX_WAVES {
            return Err(format!("lbas: {} waves (max {})", waves.len(), lbas::MAX_WAVES));
        }
        let mut lbas = Vec::with_capacity(waves.len());
        let mut lb_waves = Vec::with_capacity(waves.len());
        for (i, w) in waves.iter().enumerate() {
            if i == 0 || w.squadrons != waves[i - 1].squadrons {
                lbas.push(LandBaseCore::new(&format!("lbas wave #{i}"), &w.squadrons)?);
            }
            lb_waves.push(lbas.len() - 1);
        }
        let raid = input.base_raid.as_ref().map(raid::BattleRaid::new).transpose()?;
        let (ff, fs) = FleetCore::build(&input.friend, true);
        let debuffs = input.debuffs.as_deref().unwrap_or(&[]);
        bonus::validate_debuffs("battle", debuffs)?;
        let (ef, es) = FleetCore::build(&bonus::debuffed(&input.enemy, debuffs), false);
        let (main, esc) = (input.friend.ships.len(), input.friend.escort_ships().len());
        let ship_bonus = bonus::build_fleet(input.bonuses.as_deref(), input.escort_bonuses.as_deref(), main, esc, "")?;
        // Per wave; a concentrated base takes its first wave's bonus.
        let wave_bonus = bonus::build_bases("lbasBonuses", input.lbas_bonuses.as_deref(), waves.len(), MAX_SQUADRONS)?;
        let lb_bonus = if wave_bonus.is_empty() {
            wave_bonus
        } else {
            (0..lbas.len()).map(|b| lb_waves.iter().position(|&x| x == b).and_then(|w| wave_bonus.get(w).cloned().flatten())).collect()
        };
        Ok(Prepared {
            fleets: [ff, ef],
            init: [fs, es],
            setup: BattleSetup {
                kind: input.options.kind,
                engagement: input.options.engagement,
                formations: [friend_formation(&input.friend), enemy_formation(&input.enemy)],
                night_unless: None,
                log: input.options.log,
                supply: None,
                smoke: input.options.smoke,
                smoke_used: input.friend.smoke_used.unwrap_or(false),
                smoke_layers: input.options.smoke_layers,
                balloons: input.options.balloons,
                atoll: input.options.atoll,
            },
            lb_waves,
            lbas,
            bonus: ship_bonus,
            lb_bonus,
            carry: FleetCarry::of(&input.friend),
            rates: Rates::new(input.options.special_attack_rates.as_ref()),
            support: input.support.as_ref().map(|s| SupportCore::new(s, s.boss.unwrap_or(false))).transpose()?,
            friend_fleet: input.friend_fleet.as_ref().map(FriendCore::new).transpose()?,
            ff_bonus: friend::bonuses(input.friend_fleet.as_ref(), input.friend_fleet_bonuses.as_deref(), "")?,
            raid,
        })
    }

    pub fn battle<'a>(&'a self, rng: &'a mut Rng) -> Battle<'a> {
        let mut b = Battle::new([&self.fleets[0], &self.fleets[1]], [self.init[0].clone(), self.init[1].clone()], self.setup, rng);
        b.set_bonuses(&self.bonus, &self.lb_bonus);
        if !self.lbas.is_empty() {
            b.set_lbas(&self.lbas, &self.lb_waves, lbas::initial_planes(&self.lbas));
        }
        b.carry = self.carry;
        b.special_rates = self.rates;
        if let Some(s) = &self.support {
            b.set_support(s, s.init.clone());
        }
        if let Some(f) = &self.friend_fleet {
            b.set_friend_fleet(f, &self.ff_bonus);
        }
        b
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
    /// Main-fleet MVP.
    pub mvp: usize,
    /// Escort-fleet MVP (combined friend fleets).
    pub mvp_escort: Option<usize>,
    pub engagement: Engagement,
    pub air_state: AirState,
    pub detection: Detection,
    pub night: bool,
    pub enemy_gauge: i32,
    pub friend_gauge: i32,
    /// Smoke screen layers deployed by the friend fleet (0 = none).
    pub smoke: u8,
}

/// Land-base waves of one battle: bases, the base index of each wave, and the bases' plane
/// counts (updated by the waves; read back by sorties).
struct LbRun<'a> {
    bases: &'a [LandBaseCore],
    waves: &'a [usize],
    planes: LbPlanes,
}

/// Shelling power bonus and accuracy base of a side during the current shelling round.
const SHELL_SINGLE: (f64, f64) = (CF_NONE.shell_pow, CF_NONE.shell_acc);

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
    /// Fleet LoS per side of its (main, escort) fleet; a single fleet is its "main" fleet.
    fleet_los: [[f64; 2]; 2],
    phase: Phase,
    /// Friend combined fleet type.
    combined: Option<CombinedType>,
    /// Ship index range of each side that can be targeted in the current phase (and attacks,
    /// unless `att` says otherwise).
    engaged: [(usize, usize); 2],
    /// Attacking ship ranges when they differ from `engaged` (enemy combined fleet battles).
    att: Option<[(usize, usize); 2]>,
    /// Friend combined vs single: shelling (power bonus, accuracy base) per side in the current
    /// round.
    shell_cf: [(f64, f64); 2],
    /// 6 vs 12 / 12 vs 12 day battle: kcsim `COMBINEDCONSTS[type].ecombined`, `combinedAll`
    /// torpedoes and both fleets of each side in the air phase.
    ecombined: bool,
    /// Shelling round against both fleets of a combined side: each shot picks the fleet first
    /// (kcsim `shellPhaseC` / `doShellC`).
    pools: bool,
    lbas: Option<LbRun<'a>>,
    support: Option<SupportRun<'a>>,
    friend_fleet: Option<FriendRun<'a>>,
    /// The friend fleet phase is running (side 0 = the friend fleet): a first pick of the enemy
    /// surface flagship is re-rolled (kcsim `nightPhaseTargetFF`, `MECHANICS.ffReroll`), and no
    /// fleet special attack may fire (wikiwiki 友軍艦隊 「特殊砲撃(Nelson Touch等)は…発動しない」).
    ff_phase: bool,
    pub events: Option<Vec<AttackEvent>>,
    /// Smoke screen layers deployed by the friend fleet this battle (0 = none).
    smoke: u8,
    /// Event bonuses of the friend ships (main then escort) and of the land bases (by base index);
    /// empty / missing = none.
    bonus: &'a [Option<Bonus>],
    lb_bonus: &'a [Option<BaseBonus>],
    /// AACI / rocket barrage log (`setup.log`).
    pub air_events: Option<Vec<AirDefenseEvent>>,
    /// Friend sortie carry-over (special attacks used), updated by the battle.
    pub carry: FleetCarry,
    /// Fleet special attack trigger-rate overrides.
    pub special_rates: Rates,
}

impl<'a> Battle<'a> {
    /// `st` is the state of both fleets at the start of the battle (carried over in sorties).
    pub fn new(fleets: [&'a FleetCore; 2], mut st: [Vec<ShipState>; 2], mut setup: BattleSetup, rng: &'a mut Rng) -> Battle<'a> {
        for s in st.iter_mut().flatten() {
            s.dmg_dealt = 0;
            s.damecon_used = None;
        }
        let combined = fleets[0].combined;
        let has_escort = |side: usize| fleets[side].escort_start < fleets[side].ships.len();
        // kcsimcombined `simCombined` / `sim6vs12`: a single fleet facing a combined fleet uses the
        // old echelon table (en wiki Combat: echelon "single vs combined fleet battles").
        for side in 0..2 {
            if has_escort(1 - side) && setup.formations[side] == Formation::Echelon {
                setup.formations[side] = Formation::EchelonOld;
            }
        }
        let hp_start = [st[0].iter().map(|s| s.hp).collect(), st[1].iter().map(|s| s.hp).collect()];
        let alive = |side: usize| fleets[side].ships.iter().zip(&st[side]).filter(|(_, s)| s.hp > 0).map(|(c, _)| c);
        // kcsim `doShell2`: friend combined vs single counts the friend main fleet and the enemy;
        // `sim6vs12` / `sim12vs12` every fleet of both sides.
        let friend_end = if combined.is_some() && !has_escort(1) { fleets[0].escort_start } else { fleets[0].ships.len() };
        let friend_bb = fleets[0].ships[..friend_end].iter().zip(&st[0]).any(|(c, s)| s.hp > 0 && c.class.is_bb_class());
        let second_shelling = friend_bb || alive(1).any(|c| c.class.is_bb_class());
        let no_red_t = fleets[0].ships.iter().chain(fleets[1].ships.iter()).any(|c| c.no_red_t);
        let sub_only_enemy = alive(1).next().is_some() && alive(1).all(|c| c.class.is_sub());
        let fleet_aa = |side: usize| {
            let base = alive(side).map(|c| c.fleet_aa).sum::<f64>().floor();
            (base * formation::mods(setup.formations[side], 0, fleets[side].ships.len()).aa).floor()
        };
        let fleet_aa = [fleet_aa(0), fleet_aa(1)];
        let engaged = [(0, fleets[0].ships.len()), (0, fleets[1].ships.len())];
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
            fleet_los: [[0.0; 2]; 2],
            phase: Phase::AirStrike,
            combined,
            engaged,
            att: None,
            shell_cf: [SHELL_SINGLE; 2],
            ecombined: has_escort(1),
            pools: false,
            lbas: None,
            support: None,
            friend_fleet: None,
            ff_phase: false,
            events: if setup.log { Some(Vec::new()) } else { None },
            smoke: 0,
            bonus: &[],
            lb_bonus: &[],
            air_events: if setup.log { Some(Vec::new()) } else { None },
            carry: FleetCarry::default(),
            special_rates: Rates::default(),
        }
    }

    /// Land-base waves for this battle: `waves[k]` is the base of wave k; `planes` the bases'
    /// current squadron sizes.
    pub fn set_lbas(&mut self, bases: &'a [LandBaseCore], waves: &'a [usize], planes: LbPlanes) {
        self.lbas = Some(LbRun { bases, waves, planes });
    }

    /// Event bonuses: friend ships (main then escort) and land bases (indexed like `set_lbas`' bases).
    pub fn set_bonuses(&mut self, ships: &'a [Option<Bonus>], bases: &'a [Option<BaseBonus>]) {
        self.bonus = ships;
        self.lb_bonus = bases;
    }

    /// Squadron sizes of the land bases after the battle.
    pub fn lb_planes(&self) -> Option<LbPlanes> {
        self.lbas.as_ref().map(|r| r.planes)
    }

    #[inline]
    pub fn core(&self, side: usize, i: usize) -> &'a ShipCore {
        &self.fleets[side].ships[i]
    }

    #[inline]
    pub fn len(&self, side: usize) -> usize {
        self.fleets[side].ships.len()
    }

    /// First escort index of `side` (its length when it has no escort).
    #[inline]
    fn escort_start(&self, side: usize) -> usize {
        self.fleets[side].escort_start
    }

    /// `side` is a combined fleet (has an escort).
    #[inline]
    pub fn has_escort(&self, side: usize) -> bool {
        self.escort_start(side) < self.len(side)
    }

    /// Flagship of the main fleet or of the escort (kcsim `Fleet.loadShips`: each fleet's first
    /// ship is a flagship).
    #[inline]
    pub fn is_flagship(&self, side: usize, i: usize) -> bool {
        i == 0 || (i == self.escort_start(side) && self.has_escort(side))
    }

    /// Ships of `side` taking part in the current phase.
    #[inline]
    pub fn engaged(&self, side: usize) -> std::ops::Range<usize> {
        self.engaged[side].0..self.engaged[side].1
    }

    /// Ships of `side` attacking in the current phase (default: the engaged ones).
    #[inline]
    pub fn attackers(&self, side: usize) -> std::ops::Range<usize> {
        let (lo, hi) = self.att.map_or(self.engaged[side], |a| a[side]);
        lo..hi
    }

    #[inline]
    pub fn unit(&self, side: usize, i: usize) -> Unit<'_> {
        let fl = self.fleets[side];
        let es = fl.escort_start;
        let (idx, len) = if i >= es { (i - es, fl.ships.len() - es) } else { (i, es) };
        // Smoke and balloons act in the day battle only.
        let day = self.phase != Phase::Night;
        let smoke = if day { self.smoke } else { 0 };
        let balloons = if day { self.balloons(side) } else { 0 };
        let bonus = if side == 0 { self.bonus.get(i).and_then(Option::as_ref) } else { None };
        Unit { core: &fl.ships[i], st: &self.st[side][i], form: self.setup.formations[side], idx, len, cf: self.cf(side, i), smoke, balloons, bonus }
    }

    /// kcships `Fleet.getNumBalloons`: afloat ships of `side` (main and escort) with a barrage
    /// balloon, max 3; 0 outside balloon nodes.
    pub(crate) fn balloons(&self, side: usize) -> u8 {
        if !self.setup.balloons {
            return 0;
        }
        (0..self.len(side)).filter(|&i| self.alive(side, i) && self.core(side, i).vs.balloon).count().min(3) as u8
    }

    /// Smoke screen of the friend fleet at the start of the battle (kcsim `getSmokeType` with
    /// `Fleet.getSmokeRates`, the wikiwiki 発煙装置 formulas): n = generators + 2 × Kai among
    /// afloat ships, k = ⌈√(flagship luck) + 0.3·Σ★ + 0.5·Σ★Kai⌉, failure = clamp(3.2 − 0.2k − n);
    /// layers: n ≥ 3: 3 with 3⌈5n − 15 + s⌉ + 1 %, 2 with min(30, rest) %; n = 2: 2 with
    /// 3⌈5n − 5 + s⌉ + 1 % (s = 1.5√luck + 0.3·Σ★ + 0.5·Σ★Kai). A single fleet needs ≥ 4 surface
    /// ships afloat. Once per sortie.
    fn deploy_smoke(&mut self) {
        if let Some(l) = self.setup.smoke_layers {
            self.smoke = l.min(3);
            return;
        }
        if !self.setup.smoke || self.setup.smoke_used {
            return;
        }
        if self.combined.is_none() && self.surface(0).len() < 4 {
            return;
        }
        let (mut n, mut stars, mut stars_kai) = (0.0f64, 0.0, 0.0);
        for i in 0..self.len(0) {
            if !self.alive(0, i) || self.core(0, i).class.is_sub() {
                continue;
            }
            for e in self.core(0, i).slots.iter().flatten() {
                if e.id == crate::install::ID_SMOKE {
                    n += 1.0;
                    stars += e.level as f64;
                } else if e.id == crate::install::ID_SMOKE_KAI {
                    n += 2.0;
                    stars_kai += e.level as f64;
                }
            }
        }
        if n <= 0.0 {
            return;
        }
        let u = self.rng.f64();
        self.smoke = crate::install::smoke_layers(u, n, self.core(0, 0).luck.max(0.0), stars, stars_kai);
    }

    /// Combined-fleet attack terms of a ship (kcsim `COMBINEDCONSTS`, `torpedoPhase`, `airstrike`).
    fn cf(&self, side: usize, i: usize) -> Cf {
        if self.combined.is_none() && !self.has_escort(1) {
            return CF_NONE;
        }
        let escort = i >= self.escort_start(side);
        let mut cf = CF_NONE;
        if self.ecombined {
            (cf.shell_pow, cf.shell_acc) = combined::ecombined_shell(self.combined, side, escort);
            cf.torp_pow = 15.0;
            cf.torp_acc = match (side, self.combined.is_some()) {
                (0, false) => -35.0,
                (0, true) => -40.0,
                (_, false) => 0.0,
                (_, true) => -30.0,
            };
        } else if self.combined.is_some() {
            (cf.shell_pow, cf.shell_acc) = self.shell_cf[side];
            // Every torpedo shot of a combined-vs-single battle involves an escort ship: no +5.
            cf.torp_pow = 0.0;
        }
        // Airstrike target terms of a ship in a combined fleet.
        if self.has_escort(side) {
            let raid = self.setup.kind == BattleKind::AirRaid;
            (cf.air_acc, cf.air_pow) = match (side, escort, raid) {
                (0, false, false) => (15.0 / 100.0, -10.0),
                (0, false, true) => (10.0 / 100.0, -10.0),
                (0, true, false) => (-20.0 / 100.0, -20.0),
                (0, true, true) => (-25.0 / 100.0, -20.0),
                (_, false, _) => (15.0 / 100.0, -10.0),
                (_, true, _) => (-15.0 / 100.0, -20.0),
            };
        }
        cf
    }

    #[inline]
    pub fn alive(&self, side: usize, i: usize) -> bool {
        self.st[side][i].hp > 0
    }

    /// Afloat surface ships (non-submarines) of `side` taking part in the current phase.
    pub fn surface(&self, side: usize) -> List {
        let mut l = List::default();
        for i in self.engaged(side) {
            if self.alive(side, i) && !self.core(side, i).class.is_sub() {
                l.push(i);
            }
        }
        l
    }

    /// Afloat submarines of `side` taking part in the current phase.
    pub fn subs(&self, side: usize) -> List {
        let mut l = List::default();
        for i in self.engaged(side) {
            if self.alive(side, i) && self.core(side, i).class.is_sub() {
                l.push(i);
            }
        }
        l
    }

    /// Any ship of `side` taking part in the current phase is afloat.
    pub fn any_alive(&self, side: usize) -> bool {
        self.engaged(side).any(|i| self.alive(side, i))
    }

    /// kcsim `choiceWProtect`: random target, searchlight re-rolls, vanguard re-roll, flagship
    /// protection. Returns (target, covered). Combined fleets (en wiki "Shooting Order and
    /// Targeting", Combined Fleets): by day only the main flagship is protected, by escort ships
    /// only in airstrikes, both jet assaults (kcsim `airPhase` → `choiceWProtect(…, true)`) and
    /// opening ASW (kcsim `includeEscort`); at night the flagship of the
    /// fleet fighting is protected.
    pub fn choose_target(&mut self, def_side: usize, cands: &[usize], sl_rerolls: u8) -> (usize, bool) {
        self.choose_target_ex(def_side, cands, sl_rerolls, true, None)
    }

    /// [`Battle::choose_target`]; `vanguard: false` skips the vanguard re-roll (kcsim
    /// `choiceWProtect(…, ignoreVanguard)`, support shelling); `include_escort` overrides the
    /// phase rule for escort covering ships (air support: kcsim `choiceWProtect(…, true)`).
    pub fn choose_target_ex(&mut self, def_side: usize, cands: &[usize], sl_rerolls: u8, vanguard: bool, include_escort: Option<bool>) -> (usize, bool) {
        let mut t = self.pick_target(def_side, cands, sl_rerolls, vanguard);
        if self.ff_phase && t == 0 && def_side == 1 && !self.core(1, 0).class.is_sub() {
            t = self.pick_target(def_side, cands, sl_rerolls, vanguard);
        }
        let form = self.setup.formations[def_side];
        // The friend fleet phase engages the whole enemy: its flagship is the main flagship and
        // escorts cover it (kcsim `friendFleetPhase` → `nightPhaseTarget(…, includeEscort)`).
        let night = matches!(self.phase, Phase::Night | Phase::FriendFleet);
        let flag = if night { self.engaged[def_side].0 } else { 0 };
        if t != flag || self.core(def_side, t).is_installation {
            return (t, false);
        }
        let es = self.escort_start(def_side);
        let include_escort =
            include_escort.unwrap_or(night || matches!(self.phase, Phase::AirStrike | Phase::JetAirStrike | Phase::JetLandBase | Phase::OpeningAsw));
        let rate = formation::protection_rate(form);
        if self.rng.chance(rate) {
            let mut defenders = List::default();
            for &c in cands {
                let core = self.core(def_side, c);
                if c != t && (include_escort || c < es) && self.st[def_side][c].hp_ratio(core.max_hp) > 0.75 && !core.is_installation {
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

    /// [`Battle::choose_target`] with kcsim's `targetsProtectOverride`: covering ships are drawn
    /// from `protect` instead of `cands` (anti-PT ships aiming at PT imps).
    pub fn choose_target_protect(&mut self, def_side: usize, cands: &[usize], protect: &[usize]) -> (usize, bool) {
        let n = cands.len();
        let t = cands[self.rng.below(n)];
        let form = self.setup.formations[def_side];
        let t = if form == Formation::Vanguard && formation::vanguard_front(t, self.len(def_side)) { cands[self.rng.below(n)] } else { t };
        if t != 0 || self.core(def_side, t).is_installation || !self.rng.chance(formation::protection_rate(form)) {
            return (t, false);
        }
        let mut defenders = List::default();
        for &c in protect {
            let core = self.core(def_side, c);
            if c != t && self.st[def_side][c].hp_ratio(core.max_hp) > 0.75 && !core.is_installation {
                defenders.push(c);
            }
        }
        if defenders.is_empty() {
            return (t, false);
        }
        (defenders.as_slice()[self.rng.below(defenders.len())], true)
    }

    /// kcsim `shellPhaseTarget` / `nightPhaseTarget` preferences: anti-PT ships aim at PT imps (by
    /// day the covering ship still comes from all `targets`), anti-installation ships at
    /// installations. Returns (target, covered).
    pub(crate) fn choose_preferred(&mut self, att_side: usize, a: usize, targets: &[usize], day: bool, sl_rerolls: u8) -> (usize, bool) {
        let def = 1 - att_side;
        let vs = self.core(att_side, a).vs;
        let pick = |b: &Battle, f: &dyn Fn(&ShipCore) -> bool| {
            let mut l = List::default();
            for &t in targets {
                if f(b.core(def, t)) {
                    l.push(t);
                }
            }
            l
        };
        if vs.anti_install {
            let inst = pick(self, &|d| d.is_installation);
            if !inst.is_empty() {
                return self.choose_target(def, inst.as_slice(), sl_rerolls);
            }
        }
        if vs.anti_pt {
            let pt = pick(self, &|d| d.target.pt);
            if !pt.is_empty() {
                return if day { self.choose_target_protect(def, pt.as_slice(), targets) } else { self.choose_target(def, pt.as_slice(), sl_rerolls) };
            }
        }
        self.choose_target(def, targets, sl_rerolls)
    }

    /// Random target with searchlight re-rolls and the vanguard re-roll (no flagship protection).
    fn pick_target(&mut self, def_side: usize, cands: &[usize], sl_rerolls: u8, vanguard: bool) -> usize {
        let n = cands.len();
        let mut t = cands[self.rng.below(n)];
        for _ in 0..sl_rerolls {
            if self.core(def_side, t).searchlight > 0 {
                break;
            }
            t = cands[self.rng.below(n)];
        }
        if vanguard && self.setup.formations[def_side] == Formation::Vanguard && formation::vanguard_front(t, self.len(def_side)) {
            t = cands[self.rng.below(n)];
        }
        t
    }

    /// Apply damage (sinking protection, damage control). Returns the HP actually removed.
    pub fn take_damage(&mut self, side: usize, i: usize, dmg: i32) -> i32 {
        let flagship = self.is_flagship(side, i);
        let core = &self.fleets[side].ships[i];
        let st = &mut self.st[side][i];
        let mut dmg = dmg.max(0);
        if st.protected {
            // wikiwiki 戦闘について (轟沈ストッパー): a red-morale escort of a single fleet is left at
            // 1 HP; combined-fleet ships keep the proportional replacement whatever their morale.
            // An enemy ship is protected only as the last one in the friend fleet phase.
            dmg = if core.is_player {
                let red = !flagship && st.morale < 20 && self.fleets[side].combined.is_none();
                formulas::protect(self.rng, dmg, st.hp, red)
            } else {
                friend::last_enemy_protect(self.rng, dmg, st.hp)
            };
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
        let mut range = [0u8; LIST_CAP];
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
        // Morale cost of entering the battle (wikiwiki 疲労度): taken before combat, so a ship
        // needs 53 to fight a day battle sparkled — except when either side is a combined fleet:
        // the state is judged first and the cost taken after the day battle (sparkled from 50;
        // the KCNav packets show it, docs/VALIDATION.md §4).
        let mut entry_cost_due = !night_only && (self.combined.is_some() || self.ecombined);
        if !night_only && !entry_cost_due {
            self.entry_morale_cost();
        }
        for i in 0..self.len(0) {
            let flagship = self.is_flagship(0, i);
            let st = &mut self.st[0][i];
            if st.hp <= 0 {
                continue;
            }
            if night_only {
                st.morale = (st.morale - 2).max(0);
            }
            let core = &self.fleets[0].ships[i];
            st.protected = flagship || st.hp_ratio(core.max_hp) > 0.25;
        }
        self.engagement = match self.setup.engagement {
            Some(e) => e,
            None => {
                let r = self.rng.f64();
                roll_engagement(r, self.no_red_t)
            }
        };
        self.eng = formation::engagement_mod(self.engagement);
        if kind != BattleKind::NightOnly {
            self.deploy_smoke();
        }

        let mut detection = Detection::Success;
        let mut did_night = false;
        match kind {
            BattleKind::NightOnly => {
                if self.night_ready() {
                    self.support_phase(false, true);
                    self.friend_fleet_phase();
                    if self.night_ready() {
                        self.night_phase(true);
                    }
                    did_night = true;
                }
            }
            BattleKind::AirRaid => {
                self.land_base_phases(false);
                if self.both_alive() {
                    self.air_phase(false, false);
                } else {
                    self.raid_cleared();
                }
            }
            BattleKind::AirBattle => {
                detection = self.detection();
                let failed = matches!(detection, Detection::Failure | Detection::FailureLost | Detection::NotFound);
                self.land_base_phases(true);
                for k in 0..2 {
                    if self.both_alive() {
                        self.air_phase(failed, true);
                    }
                    // Air support between the two air phases (api_kouku, api_support_info, api_kouku2).
                    if k == 0 {
                        self.support_phase(true, false);
                    }
                }
            }
            BattleKind::Day | BattleKind::DayNight => {
                detection = self.day_battle();
                if entry_cost_due {
                    self.entry_morale_cost();
                    entry_cost_due = false;
                }
                let pursue = kind == BattleKind::DayNight
                    && self.both_alive()
                    && self.night_ready()
                    && self.setup.night_unless.is_none_or(|r| self.rank().0 > r);
                if pursue {
                    for st in self.st[0].iter_mut() {
                        if st.hp > 0 {
                            st.morale = (st.morale - 2).max(0);
                        }
                    }
                    self.friend_fleet_phase();
                    if self.night_ready() {
                        self.night_phase(false);
                    }
                    did_night = true;
                }
            }
            BattleKind::NightToDay => {
                if self.has_escort(1) {
                    if let Some(d) = self.night_to_day_combined() {
                        detection = d;
                    }
                    did_night = true;
                } else {
                    // Single enemy: a night-battle node, then the day battle while both sides are
                    // afloat (kcsim chplayer `nightToDay`: NB-only `sim`, then a day `sim`).
                    if self.night_ready() {
                        self.support_phase(false, true);
                        self.friend_fleet_phase();
                        if self.night_ready() {
                            self.night_phase(true);
                        }
                        did_night = true;
                    }
                    if self.both_alive() {
                        detection = self.day_battle();
                    }
                }
            }
        }
        if entry_cost_due {
            self.entry_morale_cost();
        }

        let (rank, enemy_gauge, friend_gauge) = if kind == BattleKind::AirRaid { self.raid_rank() } else { self.rank() };
        let (mvp, mvp_escort) = self.mvp();
        self.update_morale(rank, mvp, mvp_escort, did_night);
        self.update_supply(did_night);
        Outcome {
            rank,
            mvp,
            mvp_escort,
            engagement: self.engagement,
            air_state: self.air_state(),
            detection,
            night: did_night,
            enemy_gauge,
            friend_gauge,
            smoke: self.smoke,
        }
    }

    /// Day battle: detection, jet assaults, land-base waves, air phase and the surface phases of the
    /// fleet matchup.
    fn day_battle(&mut self) -> Detection {
        let detection = self.detection();
        let failed = matches!(detection, Detection::Failure | Detection::FailureLost | Detection::NotFound);
        self.land_base_phases(true);
        // Night-to-day: air support before the air phase (shelling / torpedo support came at night).
        let night_first = self.setup.kind == BattleKind::NightToDay;
        if night_first {
            self.support_phase(true, false);
        }
        if self.both_alive() {
            self.air_phase(failed, true);
        }
        if !night_first {
            self.support_phase(true, true);
        }
        match self.combined {
            _ if self.ecombined => self.ecombined_day(),
            Some(ct) => self.combined_day(ct),
            None => self.single_day(),
        }
        detection
    }

    /// Fleet LoS of every fleet for artillery spotting (kcsim `clearFleetLoS` before shelling).
    fn update_fleet_los(&mut self) {
        for side in 0..2 {
            let (es, n) = (self.escort_start(side), self.len(side));
            self.fleet_los[side] = [self.compute_fleet_los(side, 0, es), self.compute_fleet_los(side, es, n)];
        }
    }

    /// Day phases after the air phase, single friend fleet (kcsim `sim`).
    fn single_day(&mut self) {
        if self.both_alive() {
            self.phase = Phase::OpeningAsw;
            self.opening_asw();
        }
        if self.both_alive() {
            self.phase = Phase::OpeningTorpedo;
            self.torpedo_phase(true);
        }
        self.update_fleet_los();
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
    }

    /// Day phases after the air phase, friend combined fleet vs a single enemy fleet
    /// (kcsimcombined `simCombined`): opening ASW / torpedo by the escort; shelling rounds
    /// (api_hougeki1..3) carrier & transport: escort, [closing torpedo], main by range, main by
    /// position; surface: main by range, main by position, escort, [closing torpedo].
    fn combined_day(&mut self, ct: CombinedType) {
        let (es, n) = (self.escort_start(0), self.len(0));
        let (main, escort) = ((0, es), (es, n));
        self.engaged[0] = escort;
        if self.both_alive() {
            self.phase = Phase::OpeningAsw;
            self.opening_asw();
        }
        if self.both_alive() {
            self.phase = Phase::OpeningTorpedo;
            self.torpedo_phase(true);
        }
        self.engaged[0] = (0, n);
        self.update_fleet_los();
        let (cm, ce) = combined_shell_consts(ct);
        let second = self.second_shelling;
        if ct == CombinedType::Surface {
            self.shell_round(main, cm, false, Phase::Shelling1);
            if second {
                self.shell_round(main, cm, true, Phase::Shelling2);
            }
            self.shell_round(escort, ce, false, Phase::Shelling3);
            self.closing_torpedo_escort(escort);
        } else {
            self.shell_round(escort, ce, false, Phase::Shelling1);
            self.closing_torpedo_escort(escort);
            self.shell_round(main, cm, false, Phase::Shelling2);
            if second {
                self.shell_round(main, cm, true, Phase::Shelling3);
            }
        }
    }

    /// One shelling round of one friend fleet (`group`) against the enemy, with that fleet's
    /// combined power/accuracy terms ([friend power, friend acc, enemy power, enemy acc]).
    fn shell_round(&mut self, group: (usize, usize), c: [f64; 4], second: bool, phase: Phase) {
        self.engaged[0] = group;
        if self.both_alive() {
            self.phase = phase;
            self.shell_cf = [(c[0], c[1]), (c[2], c[3])];
            self.shelling(second);
            self.shell_cf = [SHELL_SINGLE; 2];
        }
        self.engaged[0] = (0, self.len(0));
    }

    fn closing_torpedo_escort(&mut self, escort: (usize, usize)) {
        self.engaged[0] = escort;
        if self.both_alive() {
            self.phase = Phase::ClosingTorpedo;
            self.torpedo_phase(false);
        }
        self.engaged[0] = (0, self.len(0));
    }

    /// Friend ships fighting at night: the escort of a combined fleet, else the whole fleet.
    fn night_range(&self) -> (usize, usize) {
        match self.combined {
            Some(_) => (self.escort_start(0), self.len(0)),
            None => (0, self.len(0)),
        }
    }

    /// Enemy ships fighting at night: an enemy combined fleet's escort or main fleet
    /// ([`Battle::night_fights_escort`]), else the whole fleet.
    fn enemy_night_range(&self) -> (usize, usize) {
        let (es, n) = (self.escort_start(1), self.len(1));
        match (es < n, es < n && self.night_fights_escort()) {
            (false, _) => (0, n),
            (true, true) => (es, n),
            (true, false) => (0, es),
        }
    }

    /// The night fleet and the enemy are afloat.
    fn night_ready(&self) -> bool {
        let (lo, hi) = self.night_range();
        (lo..hi).any(|i| self.alive(0, i)) && self.any_alive(1)
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

    /// kcsim `getDetection` (friend side; enemies always detect), checked against the en wiki
    /// (Day Battle → Detection, Vita formula; Combined Fleet: a combined fleet against a single
    /// enemy detects with its main fleet only). Friend combined fleets always detect with the main
    /// fleet [12 vs 12 unverified: the wiki says "same as single fleet"]. Position weights
    /// 2 / 5 / 8 / 8 / 8 / 8; a 7th ship (striking force) adds no weighted LoS as in kcsim
    /// [unverified: the wiki table stops at 6 ships]. The enemy fighters shooting at recons are
    /// those of the fleets in the air phase.
    fn detection(&mut self) -> Detection {
        use crate::equipment::cat;
        const W: [f64; 6] = [2.0, 5.0, 8.0, 8.0, 8.0, 8.0];
        let mut weighted = 0.0;
        let mut recon_slots = 0.0;
        let mut carriers = 0.0f64;
        let mut ships = 0.0f64;
        let mut k = 0;
        let mut recon_list: Vec<(usize, usize)> = Vec::new();
        for i in 0..self.escort_start(0) {
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
        for i in 0..self.air_fleet_end(1) {
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

    /// Fleet LoS for artillery spotting over ships `lo..hi` of `side` (one fleet): naked LoS +
    /// recon seaplane LoS × floor(√planes).
    fn compute_fleet_los(&self, side: usize, lo: usize, hi: usize) -> f64 {
        let mut los = 0.0;
        for i in lo..hi {
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

    /// MVP of friend ships `lo..hi` (most damage dealt, first ship on ties).
    fn mvp_in(&self, lo: usize, hi: usize) -> usize {
        let mut best = lo;
        for i in lo + 1..hi {
            if self.st[0][i].dmg_dealt > self.st[0][best].dmg_dealt {
                best = i;
            }
        }
        best
    }

    /// (main-fleet MVP, escort MVP): each fleet of a combined fleet has its own MVP.
    fn mvp(&self) -> (usize, Option<usize>) {
        let (es, n) = (self.escort_start(0), self.len(0));
        (self.mvp_in(0, es), self.combined.map(|_| self.mvp_in(es, n)))
    }

    /// Battle-entry morale cost (wikiwiki 疲労度): −3, −9 under 30, for the ships afloat at the
    /// start of the battle.
    fn entry_morale_cost(&mut self) {
        for (st, &hp) in self.st[0].iter_mut().zip(&self.hp_start[0]) {
            if hp > 0 {
                st.morale = (st.morale - if st.morale < 30 { 9 } else { 3 }).max(0);
            }
        }
    }

    /// Post-battle morale (wiki): S +4, A +3, B +2, C +1, flagship +3 (≥ C), MVP +10. Combined
    /// fleets: both flagships and both MVPs; after a night battle the main-fleet MVP bonus goes to
    /// the main flagship (kcsimcombined `updateMorale(ships1, rank, didNB ? 0 : MVP)`).
    fn update_morale(&mut self, rank: Rank, mvp: usize, mvp_escort: Option<usize>, did_night: bool) {
        let rank_bonus = match rank {
            Rank::SS | Rank::S => 4,
            Rank::A => 3,
            Rank::B => 2,
            Rank::C => 1,
            Rank::D | Rank::E => 0,
        };
        let mvp = if mvp_escort.is_some() && did_night { 0 } else { mvp };
        for i in 0..self.len(0) {
            if self.hp_start[0][i] <= 0 {
                continue;
            }
            let flagship = self.is_flagship(0, i);
            let st = &mut self.st[0][i];
            let mut m = st.morale + rank_bonus;
            if flagship && rank <= Rank::C {
                m += 3;
            }
            if i == mvp || Some(i) == mvp_escort {
                m += 10;
            }
            st.morale = m.clamp(0, 100);
        }
    }

    /// Fuel/ammo consumption (wiki "Map Mechanics and Nodes").
    fn update_supply(&mut self, did_night: bool) {
        let kind = self.setup.kind;
        let night_only = kind == BattleKind::NightOnly;
        let (cf, ca) = if let Some([f, a]) = self.setup.supply {
            (f, a)
        } else if kind == BattleKind::AirRaid {
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

/// kcsim `COMBINEDCONSTS[type].esingle` (combined friend vs single enemy): for the main and the
/// escort round, [friend power bonus, friend accuracy base, enemy power bonus, enemy accuracy
/// base]. Power bonuses are added to the usual +5.
fn combined_shell_consts(ct: CombinedType) -> ([f64; 4], [f64; 4]) {
    match ct {
        CombinedType::Carrier => ([2.0, 78.0, 10.0, 88.0], [10.0, 45.0, 5.0, 65.0]),
        CombinedType::Surface => ([10.0, 45.0, 5.0, 65.0], [-5.0, 67.0, -5.0, 75.0]),
        CombinedType::Transport => ([-5.0, 54.0, 10.0, 88.0], [10.0, 45.0, 5.0, 65.0]),
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

/// Write post-battle values back into an input-shaped fleet (main ships, then escort ships).
pub fn write_state(fleet: &mut FleetInput, cores: &[ShipCore], states: &[ShipState]) {
    let ships = fleet.ships.iter_mut().chain(fleet.escort.iter_mut().flatten());
    for ((ship, core), st) in ships.zip(cores).zip(states) {
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
    let mut stack = [(0usize, 0usize); LIST_CAP];
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

