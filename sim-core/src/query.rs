//! Forward model for estimators: hit/crit probability and damage distribution of one attack,
//! computed with exactly the engine's formulas (`battle::calc`).

use std::collections::BTreeMap;

use crate::battle::calc::{self, AttackAcc, NightEnv, Unit};
use crate::battle::{day_ci_of, night_attack_of};
use crate::equipment::f;
use crate::formation::engagement_mod;
use crate::model::*;
use crate::ship::{ShipCore, ShipState, MAX_SLOTS};

struct Ctx {
    att: ShipCore,
    def: ShipCore,
    ast: ShipState,
    dst: ShipState,
    q: AttackQuery,
}

impl Ctx {
    fn new(q: &AttackQuery) -> Result<Ctx, String> {
        for (name, s) in [("attacker", &q.attacker), ("defender", &q.defender)] {
            if s.max_hp <= 0 {
                return Err(format!("{name}: maxHp must be positive"));
            }
            if s.slots.len() > 5 {
                return Err(format!("{name}: {} slots (max 5)", s.slots.len()));
            }
        }
        let friend = q.attacker_side.unwrap_or(Side::Friend) == Side::Friend;
        let att = ShipCore::new(&q.attacker, friend);
        let def = ShipCore::new(&q.defender, !friend);
        let ast = att.initial_state(&q.attacker);
        let dst = def.initial_state(&q.defender);
        Ok(Ctx { att, def, ast, dst, q: q.clone() })
    }

    fn units(&self) -> (Unit<'_>, Unit<'_>) {
        let q = &self.q;
        let a = Unit {
            core: &self.att,
            st: &self.ast,
            form: q.attacker_formation.unwrap_or_default(),
            idx: q.attacker_index.unwrap_or(0),
            len: q.attacker_fleet_size.unwrap_or(6).max(1),
        };
        let d = Unit {
            core: &self.def,
            st: &self.dst,
            form: q.defender_formation.unwrap_or_default(),
            idx: q.defender_index.unwrap_or(0),
            len: q.defender_fleet_size.unwrap_or(6).max(1),
        };
        (a, d)
    }

    fn env(&self) -> NightEnv {
        let n = self.q.night.clone().unwrap_or_default();
        NightEnv {
            own_starshell: n.own_starshell,
            enemy_starshell: n.enemy_starshell,
            own_searchlight: n.own_searchlight,
            enemy_searchlight: n.enemy_searchlight,
            contact_acc: n.night_contact_accuracy,
        }
    }

    fn engagement(&self) -> f64 {
        engagement_mod(self.q.engagement.unwrap_or(Engagement::SameCourse))
    }

    fn special(&self) -> SpecialAttack {
        self.q.special.unwrap_or_default()
    }

    /// Attacking slot for air queries: requested slot, else the first bomber slot with planes.
    fn air_slot(&self) -> Result<usize, String> {
        if let Some(s) = self.q.slot {
            if s < MAX_SLOTS && self.att.slots[s].as_ref().is_some_and(|e| e.has(f::BOMBER)) {
                return Ok(s);
            }
            return Err(format!("slot {s} does not hold a bomber"));
        }
        (0..MAX_SLOTS)
            .find(|&s| self.att.slots[s].as_ref().is_some_and(|e| e.has(f::BOMBER)) && self.ast.planes[s] > 0)
            .ok_or_else(|| "attacker has no bomber with planes".to_string())
    }

    fn acc(&self) -> Result<AttackAcc, String> {
        let (a, d) = self.units();
        Ok(match self.q.kind {
            QueryKind::Shelling => calc::shelling_acc(&a, &d, day_ci_of(self.special())),
            QueryKind::Torpedo => {
                let power = calc::torpedo_power(&a, self.engagement(), a.hp_ratio());
                calc::torpedo_acc(&a, &d, power)
            }
            QueryKind::Night => calc::night_acc(&a, &d, &self.env(), night_attack_of(self.special())),
            QueryKind::Asw => calc::asw_acc(&a, &d, false),
            QueryKind::OpeningAsw => calc::asw_acc(&a, &d, true),
            QueryKind::Air => {
                self.air_slot()?;
                calc::air_acc(&a, &d)
            }
        })
    }

    /// (post-cap power, armor, branches of the torpedo-bomber multiplier with probabilities).
    fn power(&self) -> Result<(Vec<(f64, f64)>, f64), String> {
        let (a, d) = self.units();
        let eng = self.engagement();
        let armor = self.def.ar;
        Ok(match self.q.kind {
            QueryKind::Shelling => (vec![(calc::shelling_power(&a, &d, eng, day_ci_of(self.special())), 1.0)], armor),
            QueryKind::Torpedo => (vec![(calc::torpedo_power(&a, eng, a.hp_ratio()), 1.0)], armor),
            QueryKind::Night => (vec![(calc::night_power(&a, &d, &self.env(), night_attack_of(self.special())), 1.0)], armor),
            QueryKind::Asw | QueryKind::OpeningAsw => {
                (vec![(calc::asw_power(&a, eng, false), 1.0)], calc::effective_armor(&self.att, &self.def))
            }
            QueryKind::Air => {
                let slot = self.air_slot()?;
                let (_, dive) = calc::air_plane_base(&self.att, slot, &self.def);
                let contact = self.q.contact_modifier.unwrap_or(1.0);
                let planes = self.ast.planes[slot];
                let p = |m: f64| calc::air_power(&self.att, slot, planes, &self.def, m, contact);
                let branches = if dive { vec![(p(1.0), 1.0)] } else { vec![(p(0.8), 0.5), (p(1.5), 0.5)] };
                (branches, armor)
            }
        })
    }
}

pub fn hit_probability(q: &AttackQuery) -> Result<HitProbability, String> {
    let ctx = Ctx::new(q)?;
    let acc = ctx.acc()?;
    Ok(HitProbability { p_hit: acc.hc.p_hit(), p_crit: acc.hc.p_crit(), accuracy: acc.hc.hit_term, evasion: acc.hc.dodge_term })
}

fn grid_core(ctx: &mut Ctx, target: GridTarget) -> &mut ShipCore {
    match target {
        GridTarget::Attacker => &mut ctx.att,
        GridTarget::Defender => &mut ctx.def,
    }
}

/// [`hit_probability`] over the cartesian grid evasion × luck × hidden accuracy of one ship
/// (empty axis = the query's value). Returns `[pHit, pCrit]` pairs, evasion outermost and hidden
/// accuracy innermost. The ship is built once and its totals are shifted by the change of the naked
/// value (totals are naked + bonus + equipment sums), so integer-valued stats give exactly the
/// [`hit_probability`] result of the rebuilt query.
pub fn hit_probability_grid(g: &HitGridQuery) -> Result<Vec<f64>, String> {
    let mut ctx = Ctx::new(&g.query)?;
    let input = match g.target {
        GridTarget::Attacker => &g.query.attacker,
        GridTarget::Defender => &g.query.defender,
    };
    let (ev0, luck0, acc0) = (input.stats.evasion.unwrap_or(0.0), input.stats.luck.unwrap_or(0.0), input.hidden_accuracy.unwrap_or(0.0));
    let (ev_rest, luck_rest) = {
        let c = grid_core(&mut ctx, g.target);
        (c.ev - ev0, c.luck - luck0)
    };
    let axis = |v: &[f64], base: f64| if v.is_empty() { vec![base] } else { v.to_vec() };
    let (evs, lucks, accs) = (axis(&g.evasion, ev0), axis(&g.luck, luck0), axis(&g.hidden_accuracy, acc0));
    let mut out = Vec::with_capacity(2 * evs.len() * lucks.len() * accs.len());
    for &ev in &evs {
        for &luck in &lucks {
            for &acc in &accs {
                let c = grid_core(&mut ctx, g.target);
                c.ev = ev_rest + ev;
                c.luck = luck_rest + luck;
                c.hidden_acc = acc;
                let hc = ctx.acc()?.hc;
                out.push(hc.p_hit());
                out.push(hc.p_crit());
            }
        }
    }
    Ok(out)
}

/// Exact distribution of `floor((pow − armor roll) × ammo)` with scratch damage when ≤ 0.
fn distribution(pow: f64, armor: f64, ammo: f64, hp: i32, weight: f64, out: &mut BTreeMap<i32, f64>) {
    let n_armor = armor.floor().max(1.0) as i32;
    let p_armor = weight / n_armor as f64;
    for k in 0..n_armor {
        let def = 0.7 * armor + 0.6 * if armor.floor() >= 1.0 { k as f64 } else { 0.0 };
        let dmg = ((pow - def) * ammo).floor();
        if dmg > 0.0 {
            *out.entry(dmg as i32).or_insert(0.0) += p_armor;
        } else if hp <= 0 {
            *out.entry(0).or_insert(0.0) += p_armor;
        } else {
            let p_s = p_armor / hp as f64;
            for j in 0..hp {
                let s = (hp as f64 * 0.06 + 0.08 * j as f64).floor() as i32;
                *out.entry(s).or_insert(0.0) += p_s;
            }
        }
    }
}

pub fn damage_distribution(q: &AttackQuery) -> Result<DamageDistribution, String> {
    let ctx = Ctx::new(q)?;
    let acc = ctx.acc()?;
    let (branches, armor) = ctx.power()?;
    let ammo = ctx.units().0.ammo_mod();
    let hp = ctx.dst.hp;
    let mut hit = BTreeMap::new();
    let mut crit = BTreeMap::new();
    for (pow, w) in branches {
        distribution(pow, armor, ammo, hp, w, &mut hit);
        let pc = (pow * crate::formulas::CRIT_MOD * acc.crit_dmg).floor();
        distribution(pc, armor, ammo, hp, w, &mut crit);
    }
    let to_vec = |m: BTreeMap<i32, f64>| m.into_iter().map(|(damage, p)| DamagePoint { damage, p }).collect::<Vec<_>>();
    let mean = |v: &Vec<DamagePoint>| v.iter().map(|d| d.damage as f64 * d.p).sum::<f64>();
    let hit = to_vec(hit);
    let critical = to_vec(crit);
    Ok(DamageDistribution { mean_hit: mean(&hit), mean_critical: mean(&critical), hit, critical })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_matches_rebuilt_queries() {
        let q: AttackQuery = serde_json::from_str(
            r#"{"kind":"shelling","attackerSide":"enemy","defenderFormation":"diamond",
              "attacker":{"shipType":2,"level":50,"maxHp":30,"stats":{"firepower":10,"torpedo":20,"antiAir":5,"armor":8,"luck":5},
                          "hiddenAccuracy":3,"slots":[{"id":1502,"types":[1,1,1,1,0],"stats":{"firepower":2,"accuracy":4,"luck":1}}]},
              "defender":{"shipType":3,"level":80,"maxHp":40,"morale":20,"stats":{"firepower":40,"torpedo":60,"antiAir":30,"armor":40,"evasion":60,"luck":20},
                          "fuel":50,"slots":[{"id":30,"types":[17,17,17,17,0],"stats":{"evasion":3}}]}}"#,
        )
        .unwrap();
        let check = |target: GridTarget, kinds: &[QueryKind]| {
            for &kind in kinds {
                let mut q = q.clone();
                q.kind = kind;
                let g = HitGridQuery { query: q.clone(), target, evasion: vec![0.0, 37.0, 120.0], luck: vec![0.0, 13.0], hidden_accuracy: vec![-5.0, 40.0] };
                let out = hit_probability_grid(&g).unwrap();
                let mut i = 0;
                for &ev in &g.evasion {
                    for &luck in &g.luck {
                        for &acc in &g.hidden_accuracy {
                            let mut r = q.clone();
                            let s = if target == GridTarget::Attacker { &mut r.attacker } else { &mut r.defender };
                            s.stats.evasion = Some(ev);
                            s.stats.luck = Some(luck);
                            s.hidden_accuracy = Some(acc);
                            let hp = hit_probability(&r).unwrap();
                            assert_eq!((out[i], out[i + 1]), (hp.p_hit, hp.p_crit), "{kind:?} {target:?} ev {ev} luck {luck} acc {acc}");
                            i += 2;
                        }
                    }
                }
                assert_eq!(i, out.len());
            }
        };
        let kinds = [QueryKind::Shelling, QueryKind::Torpedo, QueryKind::Night, QueryKind::Asw];
        check(GridTarget::Attacker, &kinds);
        check(GridTarget::Defender, &kinds);
        // empty axes keep the query's values
        let one = hit_probability_grid(&HitGridQuery { query: q.clone(), target: GridTarget::Defender, evasion: vec![], luck: vec![], hidden_accuracy: vec![] }).unwrap();
        let hp = hit_probability(&q).unwrap();
        assert_eq!(one, vec![hp.p_hit, hp.p_crit]);
    }
}
