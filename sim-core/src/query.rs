//! Forward model for estimators: hit/crit probability and damage distribution of one attack,
//! computed with exactly the engine's formulas (`battle::calc`).

use std::collections::BTreeMap;

use crate::battle::calc::{self, AccTerms, NightEnv, Special, Unit};
use crate::battle::special::night_zuiun_mods;
use crate::battle::{day_ci_of, night_attack_of};
use crate::bonus::Bonus;
use crate::equipment::f;
use crate::formulas::{evade, evade_luck, hit_term, HitCrit};
use crate::formation::engagement_mod;
use crate::model::*;
use crate::ship::{ShipCore, ShipState, MAX_SLOTS};

struct Ctx {
    att: ShipCore,
    def: ShipCore,
    ast: ShipState,
    dst: ShipState,
    q: AttackQuery,
    /// Event bonuses of the attacker and the defender.
    bonus: [Option<Bonus>; 2],
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
        let bonus = |name: &str, s: &Option<ShipBonusSet>| s.as_ref().map(|s| Bonus::build(name, s)).transpose();
        let bonus = [bonus("attackerBonus", &q.attacker_bonus)?, bonus("defenderBonus", &q.defender_bonus)?];
        Ok(Ctx { att, def, ast, dst, q: q.clone(), bonus })
    }

    fn units(&self) -> (Unit<'_>, Unit<'_>) {
        let q = &self.q;
        let a = Unit {
            core: &self.att,
            st: &self.ast,
            form: q.attacker_formation.unwrap_or_default(),
            idx: q.attacker_index.unwrap_or(0),
            len: q.attacker_fleet_size.unwrap_or(6).max(1),
            cf: calc::CF_NONE,
            smoke: 0,
            balloons: 0,
            bonus: self.bonus[0].as_ref(),
        };
        let d = Unit {
            core: &self.def,
            st: &self.dst,
            form: q.defender_formation.unwrap_or_default(),
            idx: q.defender_index.unwrap_or(0),
            len: q.defender_fleet_size.unwrap_or(6).max(1),
            cf: calc::CF_NONE,
            smoke: 0,
            balloons: 0,
            bonus: self.bonus[1].as_ref(),
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

    /// Night Zuiun cut-in modifiers. Fleet special attacks depend on the whole fleet (partners,
    /// positions) and are not supported by the single-ship forward model.
    fn special_mods(&self) -> Result<Option<Special>, String> {
        use SpecialAttack::*;
        let s = self.special();
        if let Some((pow, acc)) = night_zuiun_mods(s) {
            return Ok(Some(Special { pow, acc, sub: false }));
        }
        match s {
            NelsonTouch | NagatoCutin | MutsuCutin | ColoradoCutin | KongouCutin | RichelieuCutin | QueenElizabethCutin | SubFleetAttack
            | YamatoCutin3 | YamatoCutin2 => Err(format!("special {s:?}: fleet special attacks are not supported by the forward model")),
            _ => Ok(None),
        }
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

    fn acc(&self) -> Result<AccTerms, String> {
        let (a, d) = self.units();
        Ok(match self.q.kind {
            QueryKind::Shelling => calc::shelling_terms(&a, &d, day_ci_of(self.special()), self.special_mods()?),
            QueryKind::Torpedo => {
                let power = calc::torpedo_power(&a, self.engagement(), a.hp_ratio());
                calc::torpedo_terms(&a, &d, power)
            }
            QueryKind::Night => calc::night_terms(&a, &d, &self.env(), night_attack_of(self.special()), self.special_mods()?),
            QueryKind::Asw => calc::asw_terms(&a, &d, false),
            QueryKind::OpeningAsw => calc::asw_terms(&a, &d, true),
            QueryKind::Air => {
                self.air_slot()?;
                calc::air_terms(&a, &d)
            }
        })
    }

    /// (post-cap power, armor, branches of the torpedo-bomber multiplier with probabilities).
    fn power(&self) -> Result<(Vec<(f64, f64)>, f64), String> {
        let (a, d) = self.units();
        let eng = self.engagement();
        let armor = self.def.ar;
        Ok(match self.q.kind {
            QueryKind::Shelling => (vec![(calc::shelling_power(&a, &d, eng, day_ci_of(self.special()), self.special_mods()?), 1.0)], armor),
            QueryKind::Torpedo => {
                let power = a.bonus_dmg(calc::torpedo_power(&a, eng, a.hp_ratio()), || false);
                let pow = calc::torpedo_target_power(&self.att, &self.def, power);
                (vec![(pow, 1.0)], armor)
            }
            QueryKind::Night => (vec![(calc::night_power(&a, &d, &self.env(), night_attack_of(self.special()), self.special_mods()?), 1.0)], armor),
            QueryKind::Asw | QueryKind::OpeningAsw => {
                (vec![(calc::asw_power(&a, eng, false, self.q.kind == QueryKind::OpeningAsw), 1.0)], calc::effective_armor(&self.att, &self.def))
            }
            QueryKind::Air => {
                let slot = self.air_slot()?;
                let (_, dive) = calc::air_plane_base(&self.att, slot, &self.def);
                let contact = self.q.contact_modifier.unwrap_or(1.0);
                let planes = self.ast.planes[slot];
                let p = |m: f64| calc::air_power(&self.att, slot, planes, &self.def, m, contact, calc::AIR_BASE);
                let branches = if dive { vec![(p(1.0), 1.0)] } else { vec![(p(0.8), 0.5), (p(1.5), 0.5)] };
                // Target bonus (special abyssals, PT imps, supply depots, dive-bomber weakness).
                let (tp, hi, lo) = calc::air_target_mod(&self.att, slot, &self.def);
                let branches: Vec<(f64, f64)> = if tp >= 1.0 {
                    branches.into_iter().map(|(v, w)| (v * hi, w)).collect()
                } else {
                    branches.into_iter().flat_map(|(v, w)| [(v * hi, w * tp), (v * lo, w * (1.0 - tp))]).collect()
                };
                // Event bonus of the attacker (after the target bonus, as in the engine).
                let branches = branches.into_iter().map(|(v, w)| (a.bonus_dmg(v, || true), w)).collect();
                (branches, armor)
            }
        })
    }
}

pub fn hit_probability(q: &AttackQuery) -> Result<HitProbability, String> {
    let ctx = Ctx::new(q)?;
    let hc = ctx.acc()?.resolve().hc;
    Ok(HitProbability { p_hit: hc.p_hit(), p_crit: hc.p_crit(), accuracy: hc.hit_term, evasion: hc.dodge_term })
}

/// Largest span of integer keys tabulated by [`hit_probability_grid`].
const GRID_TABLE_MAX: f64 = 65_536.0;

/// [`hit_probability`] over the cartesian grid evasion × luck × hidden accuracy of one ship
/// (empty axis = the query's value). Returns `[hit %, crit %]` pairs (`pHit = hit / 100`), evasion
/// outermost and hidden accuracy innermost.
///
/// Each axis replaces the naked value, and the ship totals are naked + bonus + equipment sums, so an
/// axis value enters as `rest + value` (the [`hit_probability`] result of the rebuilt query for
/// integer-valued stats). The target's stats enter the accuracy formulas in one place each:
/// - defender: evasion and luck only through the integer evade value `floor((ev + √(2·luck)) × mod)`;
///   its hidden accuracy not at all;
/// - attacker: luck and hidden accuracy only through the integer hit term; its evasion not at all.
///
/// So the attack is built once, the key (evade or hit term) is computed per point from per-axis
/// partial values with the engine's own functions (the floats are identical), and `hit_crit` runs
/// once per integer key.
pub fn hit_probability_grid(g: &HitGridQuery) -> Result<Vec<u8>, String> {
    let ctx = Ctx::new(&g.query)?;
    let (input, core) = match g.target {
        GridTarget::Attacker => (&g.query.attacker, &ctx.att),
        GridTarget::Defender => (&g.query.defender, &ctx.def),
    };
    let (ev0, luck0, acc0) = (input.stats.evasion.unwrap_or(0.0), input.stats.luck.unwrap_or(0.0), input.hidden_accuracy.unwrap_or(0.0));
    let (ev_rest, luck_rest) = (core.ev - ev0, core.luck - luck0);
    let axis = |v: &[f64], base: f64| if v.is_empty() { vec![base] } else { v.to_vec() };
    let (evs, lucks, accs) = (axis(&g.evasion, ev0), axis(&g.luck, luck0), axis(&g.hidden_accuracy, acc0));
    let t = ctx.acc()?;
    let pct = |hc: HitCrit| [hc.hit_pct(), hc.crit_pct()];
    Ok(match g.target {
        GridTarget::Defender => {
            let fixed = hit_term(t.hit.eval(t.luck, t.hidden_acc));
            let evs: Vec<f64> = evs.iter().map(|&e| ev_rest + e).collect();
            let lps: Vec<f64> = lucks.iter().map(|&l| evade_luck(luck_rest + l)).collect();
            fill_grid(&evs, &lps, accs.len(), 1, |e, lp| evade(e, lp, t.ev.ev_mod), |k| pct(t.hit_crit(fixed, k)))
        }
        GridTarget::Attacker => {
            let fixed = evade(t.ev.ev, evade_luck(t.ev.luck), t.ev.ev_mod);
            let lps: Vec<f64> = lucks.iter().map(|&l| t.hit.luck_part(luck_rest + l)).collect();
            let flats: Vec<f64> = accs.iter().map(|&a| t.hit.flat(a)).collect();
            fill_grid(&lps, &flats, 1, evs.len(), |lp, fl| hit_term(t.hit.finish(lp, fl)), |k| pct(t.hit_crit(k, fixed)))
        }
    })
}

/// The grid output when the integer key varies over a 2-D block `rows × cols` (row-major): the defender's
/// evade over ev × luck, each value repeated `inner` times (hidden accuracy); the attacker's hit term over
/// luck × acc, the block repeated `outer` times (evasion). `pct` runs once per key of the block's range:
/// rounded IEEE arithmetic and floor are monotone, so the block's corners bound the keys. The bound only
/// sizes the table; a key outside it is computed directly.
fn fill_grid(rows: &[f64], cols: &[f64], inner: usize, outer: usize, key: impl Fn(f64, f64) -> f64, pct: impl Fn(f64) -> [u8; 2]) -> Vec<u8> {
    let span = |v: &[f64]| v.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &x| (lo.min(x), hi.max(x)));
    let ((r0, r1), (c0, c1)) = (span(rows), span(cols));
    let (lo, hi) = span(&[key(r0, c0), key(r0, c1), key(r1, c0), key(r1, c1)]);
    let table: Vec<[u8; 2]> = if hi - lo <= GRID_TABLE_MAX { (0..=(hi - lo) as usize).map(|i| pct(lo + i as f64)).collect() } else { vec![] };
    let block = 2 * rows.len() * cols.len() * inner;
    let mut out = vec![0u8; block * outer];
    let mut chunks = out[..block].chunks_exact_mut(2 * inner);
    for &r in rows {
        for (&c, chunk) in cols.iter().zip(chunks.by_ref()) {
            let k = key(r, c);
            let i = k - lo;
            let p = if i >= 0.0 && (i as usize) < table.len() { table[i as usize] } else { pct(k) };
            for x in chunk.chunks_exact_mut(2) {
                x.copy_from_slice(&p);
            }
        }
    }
    for r in 1..outer {
        out.copy_within(..block, r * block);
    }
    out
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
    use crate::rng::Rng;

    /// Grid percents as probabilities.
    fn probs(out: &[u8]) -> Vec<f64> {
        out.iter().map(|&k| k as f64 / 100.0).collect()
    }

    /// `hit_probability` of `q` with the target's naked evasion / luck / hidden accuracy replaced.
    fn rebuilt(q: &AttackQuery, target: GridTarget, ev: f64, luck: f64, acc: f64) -> Result<HitProbability, String> {
        let mut r = q.clone();
        let s = if target == GridTarget::Attacker { &mut r.attacker } else { &mut r.defender };
        s.stats.evasion = Some(ev);
        s.stats.luck = Some(luck);
        s.hidden_accuracy = Some(acc);
        hit_probability(&r)
    }

    /// The grid point by point as before the per-axis rewrite: shift the built ship's totals, run the whole
    /// accuracy computation. Equal to the rebuilt query for integer stats, and the reference for any value.
    fn shifted_grid(g: &HitGridQuery) -> Result<Vec<u8>, String> {
        fn core(ctx: &mut Ctx, target: GridTarget) -> &mut ShipCore {
            if target == GridTarget::Attacker { &mut ctx.att } else { &mut ctx.def }
        }
        let mut ctx = Ctx::new(&g.query)?;
        let input = if g.target == GridTarget::Attacker { &g.query.attacker } else { &g.query.defender };
        let (ev0, luck0, acc0) = (input.stats.evasion.unwrap_or(0.0), input.stats.luck.unwrap_or(0.0), input.hidden_accuracy.unwrap_or(0.0));
        let (ev_rest, luck_rest) = (core(&mut ctx, g.target).ev - ev0, core(&mut ctx, g.target).luck - luck0);
        let axis = |v: &[f64], base: f64| if v.is_empty() { vec![base] } else { v.to_vec() };
        let mut out = vec![];
        for ev in axis(&g.evasion, ev0) {
            for luck in axis(&g.luck, luck0) {
                for acc in axis(&g.hidden_accuracy, acc0) {
                    let c = core(&mut ctx, g.target);
                    (c.ev, c.luck, c.hidden_acc) = (ev_rest + ev, luck_rest + luck, acc);
                    let hc = ctx.acc()?.resolve().hc;
                    out.extend([hc.hit_pct(), hc.crit_pct()]);
                }
            }
        }
        Ok(out)
    }

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
                let out = probs(&hit_probability_grid(&g).unwrap());
                let mut i = 0;
                for &ev in &g.evasion {
                    for &luck in &g.luck {
                        for &acc in &g.hidden_accuracy {
                            let hp = rebuilt(&q, target, ev, luck, acc).unwrap();
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
        assert_eq!(probs(&one), vec![hp.p_hit, hp.p_crit]);
    }

    const SPECIALS: [SpecialAttack; 26] = [
        SpecialAttack::Normal, SpecialAttack::DoubleAttack, SpecialAttack::CutinMainSecondary, SpecialAttack::CutinMainRadar,
        SpecialAttack::CutinMainAp, SpecialAttack::CutinMainMain, SpecialAttack::CvciFba, SpecialAttack::CvciBba, SpecialAttack::CvciBa,
        SpecialAttack::NightDoubleAttack, SpecialAttack::NightCutinMixed, SpecialAttack::NightCutinTorpedo,
        SpecialAttack::NightCutinGunSecondary, SpecialAttack::NightCutinGunMain, SpecialAttack::DdciGunTorpRadar,
        SpecialAttack::DdciLookoutTorpRadar, SpecialAttack::DdciTorpLookoutTorp, SpecialAttack::DdciTorpLookoutDrum,
        SpecialAttack::DdciGunTorpRadarDouble, SpecialAttack::DdciLookoutTorpRadarDouble, SpecialAttack::DdciTorpLookoutTorpDouble,
        SpecialAttack::DdciTorpLookoutDrumDouble, SpecialAttack::NightCvciFfa, SpecialAttack::NightCvciFa, SpecialAttack::NightCvciBomber,
        SpecialAttack::NightCvciFOther,
    ];
    const KINDS: [QueryKind; 6] = [QueryKind::Shelling, QueryKind::Torpedo, QueryKind::Night, QueryKind::Asw, QueryKind::OpeningAsw, QueryKind::Air];
    const FORMATIONS: [Formation; 6] =
        [Formation::LineAhead, Formation::DoubleLine, Formation::Diamond, Formation::Echelon, Formation::LineAbreast, Formation::Vanguard];
    const ENGAGEMENTS: [Engagement; 4] = [Engagement::SameCourse, Engagement::HeadOn, Engagement::TAdvantage, Engagement::TDisadvantage];
    /// DE, DD, CL, CLT, CA, CAV, CVL, FBB, BB, BBV, CV, SS, SSV, AV, CVB, AO
    const STYPES: [u32; 16] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 16, 18, 22];

    fn pick<T: Copy>(rng: &mut Rng, v: &[T]) -> T {
        v[rng.below(v.len())]
    }

    fn stat(rng: &mut Rng, max: usize) -> f64 {
        rng.below(max + 1) as f64
    }

    /// (id, api_type category, icon): guns, torpedoes, radars, AP shell, sonar, depth charge, lookouts,
    /// searchlight, drum, planes (fighters, bombers, night planes, recon), abyssal equipment.
    fn equipment(rng: &mut Rng) -> EquipmentInput {
        let (id, cat, icon) = pick(
            rng,
            &[
                (63, 1, 1), (50, 2, 2), (8, 3, 3), (12, 4, 4), (15, 5, 5), (28, 12, 11), (31, 13, 11), (36, 19, 13), (46, 14, 18),
                (45, 15, 17), (129, 39, 32), (74, 29, 24), (75, 30, 25), (22, 6, 6), (24, 7, 7), (52, 8, 8), (25, 10, 10),
                (254, 6, 45), (320, 7, 7), (242, 8, 46), (1502, 1, 1), (1513, 5, 5), (1505, 2, 2), (1501, 3, 3),
            ],
        );
        let opt = |rng: &mut Rng, max: usize| if rng.chance(0.5) { Some(stat(rng, max)) } else { None };
        EquipmentInput {
            id,
            types: vec![0, 0, cat, icon, 0],
            stats: Some(EquipmentStats {
                firepower: opt(rng, 20), torpedo: opt(rng, 15), accuracy: opt(rng, 8), evasion: opt(rng, 4), asw: opt(rng, 10),
                bombing: opt(rng, 13), luck: opt(rng, 3), los: opt(rng, 8), ..Default::default()
            }),
            improvement: Some(rng.below(11) as u32),
            proficiency: Some(rng.below(8) as u32),
            planes: Some(rng.below(40) as i32),
        }
    }

    fn ship(rng: &mut Rng) -> ShipInput {
        let max_hp = 10 + rng.below(90) as i32;
        let fuel_max = 10 + rng.below(90) as i32;
        ShipInput {
            ship_type: pick(rng, &STYPES),
            level: Some(1.0 + stat(rng, 174)),
            max_hp,
            hp: rng.chance(0.5).then(|| 1 + rng.below(max_hp as usize) as i32),
            stats: ShipStats {
                firepower: stat(rng, 120), torpedo: stat(rng, 120), anti_air: stat(rng, 80), armor: stat(rng, 100),
                evasion: Some(stat(rng, 120)), asw: Some(stat(rng, 90)), los: Some(stat(rng, 40)), luck: Some(stat(rng, 60)),
            },
            hidden_accuracy: rng.chance(0.5).then(|| stat(rng, 40) - 10.0),
            torpedo_accuracy: rng.chance(0.3).then(|| stat(rng, 20)),
            morale: rng.chance(0.7).then(|| rng.below(101) as i32),
            fuel: rng.chance(0.5).then(|| rng.below(fuel_max as usize + 1) as i32),
            fuel_max: Some(fuel_max),
            slots: (0..rng.below(6)).map(|_| rng.chance(0.85).then(|| equipment(rng))).collect(),
            ex_slot: rng.chance(0.2).then(|| equipment(rng)),
            ..Default::default()
        }
    }

    fn query(rng: &mut Rng) -> AttackQuery {
        let (attacker, defender) = (ship(rng), ship(rng));
        AttackQuery {
            kind: pick(rng, &KINDS),
            attacker,
            defender,
            attacker_side: Some(if rng.chance(0.5) { Side::Friend } else { Side::Enemy }),
            attacker_formation: Some(pick(rng, &FORMATIONS)),
            defender_formation: Some(pick(rng, &FORMATIONS)),
            attacker_index: Some(rng.below(7)),
            attacker_fleet_size: Some(1 + rng.below(7)),
            defender_index: Some(rng.below(7)),
            defender_fleet_size: Some(1 + rng.below(7)),
            engagement: Some(pick(rng, &ENGAGEMENTS)),
            special: Some(pick(rng, &SPECIALS)),
            night: rng.chance(0.7).then(|| NightContext {
                own_starshell: rng.chance(0.3), enemy_starshell: rng.chance(0.3), own_searchlight: rng.chance(0.3),
                enemy_searchlight: rng.chance(0.3), night_contact_accuracy: rng.chance(0.3).then(|| stat(rng, 4)),
            }),
            slot: None,
            contact_modifier: None,
            attacker_bonus: rng.chance(0.3).then(|| bonus(rng)),
            defender_bonus: rng.chance(0.3).then(|| bonus(rng)),
        }
    }

    fn bonus(rng: &mut Rng) -> ShipBonusSet {
        let m = |rng: &mut Rng| rng.chance(0.7).then(|| 1.0 + rng.below(30) as f64 / 100.0);
        let mods = DamageMods { dmg: m(rng), acc: m(rng), eva: m(rng) };
        let planes = rng.chance(0.5).then(|| {
            vec![PlaneBonusGroup { slots: vec![rng.below(6)], mods: DamageMods { dmg: m(rng), acc: m(rng), eva: m(rng) }, not_air_only: rng.chance(0.5) }]
        });
        ShipBonusSet { mods, planes }
    }

    /// 1–5 values from `lo..=hi`, integers or (with `fractions`) quarter steps.
    fn axis(rng: &mut Rng, lo: f64, hi: f64, fractions: bool) -> Vec<f64> {
        let step = if fractions { 0.25 } else { 1.0 };
        let n = ((hi - lo) / step) as usize;
        (0..1 + rng.below(5)).map(|_| lo + rng.below(n + 1) as f64 * step).collect()
    }

    #[test]
    fn grid_matches_hit_probability_on_random_queries() {
        let mut rng = Rng::new(20261022);
        let (mut checked, mut errors, mut kinds, mut distinct) = (0, 0, vec![], std::collections::BTreeSet::new());
        for _ in 0..1500 {
            let q = query(&mut rng);
            for target in [GridTarget::Attacker, GridTarget::Defender] {
                let g = HitGridQuery {
                    query: q.clone(),
                    target,
                    evasion: if rng.chance(0.2) { vec![] } else { axis(&mut rng, -10.0, 220.0, false) },
                    luck: if rng.chance(0.2) { vec![] } else { axis(&mut rng, -5.0, 130.0, false) },
                    hidden_accuracy: if rng.chance(0.2) { vec![] } else { axis(&mut rng, -30.0, 220.0, false) },
                };
                let out = match hit_probability_grid(&g) {
                    Ok(out) => probs(&out),
                    Err(e) => {
                        assert_eq!(Err(e), hit_probability(&q).map(|_| ()), "grid fails only where the query fails");
                        errors += 1;
                        continue;
                    }
                };
                let input = if target == GridTarget::Attacker { &q.attacker } else { &q.defender };
                let axis = |v: &Vec<f64>, base: Option<f64>| if v.is_empty() { vec![base.unwrap_or(0.0)] } else { v.clone() };
                let mut i = 0;
                for ev in axis(&g.evasion, input.stats.evasion) {
                    for luck in axis(&g.luck, input.stats.luck) {
                        for acc in axis(&g.hidden_accuracy, input.hidden_accuracy) {
                            let hp = rebuilt(&q, target, ev, luck, acc).unwrap();
                            assert_eq!((out[i], out[i + 1]), (hp.p_hit, hp.p_crit), "{q:?} {target:?} ev {ev} luck {luck} acc {acc}");
                            i += 2;
                        }
                    }
                }
                assert_eq!(i, out.len());
                checked += 1;
                if !kinds.contains(&q.kind) {
                    kinds.push(q.kind);
                }
                distinct.extend(out.chunks(2).map(|p| ((p[0] * 100.0).round() as u8, (p[1] * 100.0).round() as u8)));
            }
        }
        assert!(checked > 2500 && errors > 0, "checked {checked}, air queries without bombers {errors}");
        assert_eq!(kinds.len(), KINDS.len());
        assert!(distinct.len() > 500, "{} distinct (hit, crit) pairs", distinct.len());
    }

    #[test]
    fn grid_matches_shifted_evaluation_for_any_values() {
        let mut rng = Rng::new(7);
        for _ in 0..1500 {
            let mut q = query(&mut rng);
            // fractional naked stats
            q.defender.stats.evasion = q.defender.stats.evasion.map(|v| v + 0.5);
            q.attacker.stats.luck = q.attacker.stats.luck.map(|v| v + 0.75);
            for target in [GridTarget::Attacker, GridTarget::Defender] {
                let g = HitGridQuery {
                    query: q.clone(),
                    target,
                    evasion: axis(&mut rng, -10.0, 220.0, true),
                    luck: axis(&mut rng, -5.0, 130.0, true),
                    hidden_accuracy: axis(&mut rng, -30.0, 220.0, true),
                };
                assert_eq!(hit_probability_grid(&g), shifted_grid(&g), "{g:?}");
            }
        }
        // the estimator's full 201 × 101 axes, and values too far apart for the lookup table
        let full = |n: usize| (0..n).map(|i| i as f64).collect::<Vec<_>>();
        for _ in 0..20 {
            let q = query(&mut rng);
            for g in [
                HitGridQuery { query: q.clone(), target: GridTarget::Defender, evasion: full(201), luck: full(101), hidden_accuracy: vec![] },
                HitGridQuery { query: q.clone(), target: GridTarget::Attacker, evasion: vec![], luck: full(101), hidden_accuracy: full(201) },
                HitGridQuery { query: q.clone(), target: GridTarget::Defender, evasion: vec![0.0, 1e9], luck: vec![0.0, 1e12], hidden_accuracy: vec![] },
                HitGridQuery { query: q.clone(), target: GridTarget::Attacker, evasion: vec![], luck: vec![3.0], hidden_accuracy: vec![-1e9, 0.0, 1e9] },
            ] {
                assert_eq!(hit_probability_grid(&g), shifted_grid(&g));
            }
        }
    }
}
