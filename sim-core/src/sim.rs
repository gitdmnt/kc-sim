//! Native entry points: one battle with post-battle state, and Monte-Carlo aggregation.

use crate::battle::raid::RaidAcc;
use crate::battle::{damage_state, write_state, Battle, Prepared};
use crate::model::*;
use crate::rng::Rng;

fn ship_results(b: &Battle, side: usize) -> Vec<ShipResult> {
    (0..b.len(side))
        .map(|i| {
            let c = b.core(side, i);
            let st = &b.st[side][i];
            let hp_start = b.hp_start[side][i];
            ShipResult {
                max_hp: c.max_hp,
                hp_start,
                hp_end: st.hp,
                sunk: hp_start > 0 && st.hp <= 0,
                damage_state: damage_state(st.hp, c.max_hp),
                damage_dealt: st.dmg_dealt,
                damecon_used: st.damecon_used,
            }
        })
        .collect()
}

/// One battle; returns the result and the post-battle fleets (for chaining sortie nodes).
pub fn run_battle(input: &BattleInput, seed: u64) -> Result<RunBattleOutput, String> {
    let p = Prepared::new(input)?;
    let mut rng = Rng::new(seed);
    let base_raid = p.raid.as_ref().map(|r| r.run(&mut rng));
    let mut b = p.battle(&mut rng);
    let o = b.run();
    let result = BattleResult {
        rank: o.rank,
        mvp: o.mvp,
        mvp_escort: o.mvp_escort,
        engagement: o.engagement,
        air_state: o.air_state,
        detection: o.detection,
        night_battle: o.night,
        enemy_gauge: o.enemy_gauge,
        friend_gauge: o.friend_gauge,
        friend: ship_results(&b, 0),
        enemy: ship_results(&b, 1),
        events: b.events.take(),
        smoke: (o.smoke > 0).then_some(o.smoke),
        air_defense: b.air_events.take(),
        support: b.support_result(),
        friend_fleet: b.friend_fleet_fought(),
        base_raid,
    };
    let mut state = BattleState { friend: input.friend.clone(), enemy: input.enemy.clone() };
    write_state(&mut state.friend, &p.fleets[0].ships, &b.st[0]);
    write_state(&mut state.enemy, &p.fleets[1].ships, &b.st[1]);
    b.carry.write(&mut state.friend);
    Ok(RunBattleOutput { result, state })
}

struct ShipAcc {
    max_hp: i32,
    hist: Vec<u32>,
    hp_sum: f64,
    states: [u32; 5],
    dmg_sum: f64,
    mvp: u32,
}

impl ShipAcc {
    fn new(max_hp: i32) -> Self {
        ShipAcc { max_hp, hist: vec![0; max_hp as usize + 1], hp_sum: 0.0, states: [0; 5], dmg_sum: 0.0, mvp: 0 }
    }

    fn add(&mut self, hp: i32, dmg: i32) {
        let hp = hp.clamp(0, self.max_hp);
        self.hist[hp as usize] += 1;
        self.hp_sum += hp as f64;
        self.dmg_sum += dmg as f64;
        let k = match damage_state(hp, self.max_hp) {
            DamageState::Sunk => 0,
            DamageState::Heavy => 1,
            DamageState::Moderate => 2,
            DamageState::Light => 3,
            DamageState::Healthy => 4,
        };
        self.states[k] += 1;
    }

    fn summary(self, n: f64) -> ShipSummary {
        let r = |x: f64| if n > 0.0 { x / n } else { 0.0 };
        ShipSummary {
            max_hp: self.max_hp,
            hp_mean: r(self.hp_sum),
            hp_histogram: self.hist,
            sunk_rate: r(self.states[0] as f64),
            heavy_rate: r(self.states[1] as f64),
            moderate_rate: r(self.states[2] as f64),
            light_rate: r(self.states[3] as f64),
            healthy_rate: r(self.states[4] as f64),
            damage_dealt_mean: r(self.dmg_sum),
            mvp_rate: r(self.mvp as f64),
        }
    }
}

/// Monte-Carlo: `count` independent battles from the same start state.
pub fn simulate(input: &BattleInput, count: u32, seed: u64) -> Result<SimulationSummary, String> {
    let p = Prepared::new(input)?;
    let mut rng = Rng::new(seed);
    let mut acc: [Vec<ShipAcc>; 2] = [
        p.fleets[0].ships.iter().map(|c| ShipAcc::new(c.max_hp)).collect(),
        p.fleets[1].ships.iter().map(|c| ShipAcc::new(c.max_hp)).collect(),
    ];
    let mut raids = RaidAcc::default();
    let mut ranks = [0u32; 7];
    let mut airs = [0u32; 6];
    let (mut nights, mut flag_sunk, mut heavy_any, mut sunk_any) = (0u32, 0u32, 0u32, 0u32);
    let (mut supports, mut friend_fleets) = (0u32, 0u32);
    for _ in 0..count {
        if let Some(r) = &p.raid {
            let o = r.run(&mut rng);
            raids.add(o.air_state, &o.hp_lost);
        }
        let mut b = p.battle(&mut rng);
        let o = b.run();
        ranks[o.rank as usize] += 1;
        airs[match o.air_state {
            AirState::None => 0,
            AirState::Supremacy => 1,
            AirState::Superiority => 2,
            AirState::Parity => 3,
            AirState::Denial => 4,
            AirState::Incapability => 5,
        }] += 1;
        nights += o.night as u32;
        supports += b.support_result().is_some_and(|s| s.arrived) as u32;
        friend_fleets += b.friend_fleet_fought().unwrap_or(false) as u32;
        if b.len(1) > 0 && b.hp_start[1][0] > 0 && b.st[1][0].hp <= 0 {
            flag_sunk += 1;
        }
        let (mut heavy, mut sunk) = (false, false);
        for side in 0..2 {
            for (i, a) in acc[side].iter_mut().enumerate() {
                let st = &b.st[side][i];
                a.add(st.hp, st.dmg_dealt);
                if side == 0 && b.hp_start[0][i] > 0 {
                    match damage_state(st.hp, a.max_hp) {
                        DamageState::Sunk => sunk = true,
                        DamageState::Heavy => heavy = true,
                        _ => {}
                    }
                }
            }
        }
        acc[0][o.mvp].mvp += 1;
        if let Some(e) = o.mvp_escort {
            acc[0][e].mvp += 1;
        }
        heavy_any += heavy as u32;
        sunk_any += sunk as u32;
    }
    let n = count as f64;
    let r = |x: u32| if count > 0 { x as f64 / n } else { 0.0 };
    let [fa, ea] = acc;
    Ok(SimulationSummary {
        count,
        rank_rates: RankRates {
            ss: r(ranks[0]),
            s: r(ranks[1]),
            a: r(ranks[2]),
            b: r(ranks[3]),
            c: r(ranks[4]),
            d: r(ranks[5]),
            e: r(ranks[6]),
        },
        air_state_rates: AirStateRates {
            none: r(airs[0]),
            supremacy: r(airs[1]),
            superiority: r(airs[2]),
            parity: r(airs[3]),
            denial: r(airs[4]),
            incapability: r(airs[5]),
        },
        night_battle_rate: r(nights),
        enemy_flagship_sunk_rate: r(flag_sunk),
        friend_heavy_any_rate: r(heavy_any),
        friend_sunk_any_rate: r(sunk_any),
        friend: fa.into_iter().map(|a| a.summary(n)).collect(),
        enemy: ea.into_iter().map(|a| a.summary(n)).collect(),
        support_rate: p.support.as_ref().map(|_| r(supports)),
        friend_fleet_rate: p.friend_fleet.as_ref().map(|_| r(friend_fleets)),
        base_raid: p.raid.as_ref().map(|r| raids.summary(None, r.bases())),
    })
}
