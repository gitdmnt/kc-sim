//! Routing rule DSL evaluator (private notes ROUTING_DSL v1). The document is parsed from JSON into a
//! compiled form (node letters interned, ship-type groups expanded to bit masks, flags resolved)
//! and validated on the way: unknown keys, metrics, ship types or equipment groups, a last rule with
//! `when`, bad `random` weights, non-descending `los` thresholds and unknown destinations are errors.

use std::cell::Cell;
use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::model::CombinedType;
use crate::rng::Rng;

// ------------------------------------------------------------- ship types ----

fn stype_id(code: &str) -> Option<u32> {
    Some(match code {
        "DE" => 1,
        "DD" => 2,
        "CL" => 3,
        "CLT" => 4,
        "CA" => 5,
        "CAV" => 6,
        "CVL" => 7,
        "FBB" => 8,
        "BB" => 9,
        "BBV" => 10,
        "CV" => 11,
        "XBB" => 12,
        "SS" => 13,
        "SSV" => 14,
        "AP" => 15,
        "AV" => 16,
        "LHA" => 17,
        "CVB" => 18,
        "AR" => 19,
        "AS" => 20,
        "CT" => 21,
        "AO" => 22,
        _ => return None,
    })
}

/// Bit mask over `api_stype` ids of a type code or group.
fn type_mask(code: &str) -> Option<u32> {
    let m = |codes: &[&str]| codes.iter().map(|c| 1u32 << stype_id(c).unwrap()).fold(0, |a, b| a | b);
    Some(match code {
        "BB_CLASS" => m(&["FBB", "BB", "BBV", "XBB"]),
        "BATTLESHIP" => m(&["FBB", "BB", "XBB"]),
        "CV_CLASS" => m(&["CV", "CVB", "CVL"]),
        "STD_CV" => m(&["CV", "CVB"]),
        "CA_CLASS" => m(&["CA", "CAV"]),
        "CL_CT" => m(&["CL", "CT"]),
        "CL_CLASS" => m(&["CL", "CT", "CLT"]),
        "DD_DE" => m(&["DD", "DE"]),
        "SS_CLASS" => m(&["SS", "SSV"]),
        c => 1u32 << stype_id(c)?,
    })
}

const SPEEDS: [(&str, f64); 4] = [("slow", 5.0), ("fast", 10.0), ("fastPlus", 15.0), ("fastest", 20.0)];

// ---------------------------------------------------------------- inputs ----

/// One equipment item as seen by routing.
#[derive(Clone, Debug, Default)]
pub struct RouteEquip {
    pub id: u32,
    pub cat: u32,
    pub los: f64,
    pub level: f64,
}

/// One ship as seen by routing (ROUTING_DSL §5).
#[derive(Clone, Debug, Default)]
pub struct RouteShip {
    pub stype: u32,
    pub id: u32,
    pub speed: f64,
    /// api_sakuteki[0] − Σ equipment LoS (visible fit-bonus LoS included).
    pub naked_los: f64,
    pub equips: Vec<RouteEquip>,
}

/// Sortie-level routing inputs.
#[derive(Clone, Debug, Default)]
pub struct RouteConfig {
    pub hq: f64,
    pub difficulty: f64,
    pub phase: Option<f64>,
    pub gauge: Option<f64>,
    pub flags: HashMap<String, bool>,
    pub selects: HashMap<String, String>,
}

/// LoS formula 33 (ROUTING_DSL §5) of a single fleet, floored to 2 decimals.
pub fn los33(ships: &[&RouteShip], cn: f64, hq: f64) -> f64 {
    los33_sized(ships, cn, hq, 6.0)
}

/// LoS formula 33 over both fleets of a combined fleet: the last term uses 12 instead of 6
/// (ROUTING_DSL §5 [unverified]).
pub fn los33_combined(ships: &[&RouteShip], cn: f64, hq: f64) -> f64 {
    los33_sized(ships, cn, hq, 12.0)
}

fn los33_sized(ships: &[&RouteShip], cn: f64, hq: f64, full: f64) -> f64 {
    let mut v = 0.0;
    for s in ships {
        v += s.naked_los.max(0.0).sqrt();
        for e in &s.equips {
            let sq = e.level.max(0.0).sqrt();
            let (coef, impr) = match e.cat {
                8 => (0.8, 0.0),
                9 | 94 => (1.0, 1.2 * sq),
                10 => (1.2, 1.2 * sq),
                11 => (1.1, 1.15 * sq),
                41 => (0.6, 1.2 * sq),
                12 => (0.6, 1.25 * sq),
                13 | 93 => (0.6, 1.4 * sq),
                _ if e.los > 0.0 => (0.6, 0.0),
                _ => continue,
            };
            v += cn * coef * (e.los + impr);
        }
    }
    v -= (0.4 * hq).ceil();
    v += 2.0 * (full - ships.len() as f64);
    // Floor to 2 decimals (compass sim / KC3); the epsilon absorbs float noise of the sum order.
    (v * 100.0 + 1e-7).floor() / 100.0
}

// --------------------------------------------------------------- compiled ----

#[derive(Clone, Copy, Debug, PartialEq)]
enum FleetSel {
    Main,
    Escort,
    All,
}

#[derive(Clone, Debug)]
enum EquipSel {
    Types { types: Vec<u32>, min_los: Option<f64> },
    Ids(Vec<u32>),
}

impl EquipSel {
    fn matches(&self, e: &RouteEquip) -> bool {
        match self {
            EquipSel::Types { types, min_los } => types.contains(&e.cat) && min_los.is_none_or(|m| e.los >= m),
            EquipSel::Ids(ids) => ids.contains(&e.id),
        }
    }
}

#[derive(Clone, Debug)]
enum Metric {
    Ships(FleetSel),
    Count { mask: u32, fleet: FleetSel, max_speed: Option<f64> },
    OnlyTypes { mask: u32, fleet: FleetSel },
    CountIds { ids: Vec<u32>, fleet: FleetSel },
    EquipShips { sel: EquipSel, fleet: FleetSel },
    EquipCount { sel: EquipSel, fleet: FleetSel },
    Speed,
    Los(f64),
    FleetType(Vec<String>),
    Flagship { mask: u32, fleet: FleetSel },
    Difficulty,
    Phase,
    Gauge,
    Hq,
    Visited(usize),
    Flag(bool),
}

#[derive(Clone, Debug, Default)]
struct Cmp {
    eq: Option<f64>,
    ne: Option<f64>,
    gt: Option<f64>,
    gte: Option<f64>,
    lt: Option<f64>,
    lte: Option<f64>,
    in_: Option<Vec<f64>>,
    bool_eq: Option<bool>,
}

impl Cmp {
    fn num(&self, v: f64) -> bool {
        self.eq.is_none_or(|x| v == x)
            && self.ne.is_none_or(|x| v != x)
            && self.gt.is_none_or(|x| v > x)
            && self.gte.is_none_or(|x| v >= x)
            && self.lt.is_none_or(|x| v < x)
            && self.lte.is_none_or(|x| v <= x)
            && self.in_.as_ref().is_none_or(|xs| xs.contains(&v))
    }
}

#[derive(Clone, Debug)]
enum Pred {
    All(Vec<Pred>),
    Any(Vec<Pred>),
    Not(Box<Pred>),
    Leaf(Metric, Cmp),
}

#[derive(Clone, Debug)]
enum Action {
    To(usize),
    Random(Vec<(usize, f64)>),
    Los { cn: f64, thresholds: Vec<(f64, usize)>, below: usize, interpolate: bool },
    /// Resolved player choice (config → defaults → first option).
    Select(usize),
    Rules(Vec<Rule>),
}

#[derive(Clone, Debug)]
struct Rule {
    when: Option<Pred>,
    action: Action,
}

#[derive(Clone, Debug)]
enum NodeDef {
    End,
    Rules(Vec<Rule>),
}

impl Rule {
    /// Every destination this rule can produce (nested rules included).
    fn dests(&self, out: &mut Vec<usize>) {
        match &self.action {
            Action::To(t) | Action::Select(t) => out.push(*t),
            Action::Random(list) => out.extend(list.iter().map(|&(t, _)| t)),
            Action::Los { thresholds, below, .. } => {
                out.extend(thresholds.iter().map(|&(_, t)| t));
                out.push(*below);
            }
            Action::Rules(rules) => rules.iter().for_each(|r| r.dests(out)),
        }
    }
}

/// Context of one routing decision.
pub struct RouteCtx<'a> {
    /// Ships currently counted (afloat, not retreated), in fleet order: main fleet, then escort.
    pub ships: &'a [&'a RouteShip],
    /// Number of main-fleet ships at the front of `ships` (`ships.len()` for a single fleet).
    pub main: usize,
    /// Friend combined fleet type (`None` = single fleet).
    pub combined: Option<CombinedType>,
    /// A single fleet sortied as a striking force (遊撃部隊): fleet type `striking`.
    pub striking: bool,
    /// Nodes passed so far, including the current node.
    pub visited: &'a [usize],
}

impl RouteCtx<'_> {
    fn los(&self, cn: f64, hq: f64) -> f64 {
        if self.combined.is_some() {
            los33_combined(self.ships, cn, hq)
        } else {
            los33(self.ships, cn, hq)
        }
    }
}

/// A compiled routing document.
pub struct Router {
    names: Vec<String>,
    index: HashMap<String, usize>,
    nodes: Vec<Option<NodeDef>>,
    /// Top-level `start.rules` (multi-start maps): picks the start node.
    start: Option<Vec<Rule>>,
    hq: f64,
    difficulty: f64,
    phase: Cell<f64>,
    gauge: Cell<f64>,
}

struct Compiler<'c> {
    names: Vec<String>,
    index: HashMap<String, usize>,
    known: &'c dyn Fn(&str) -> bool,
    flags: HashMap<String, bool>,
    default_flags: Vec<String>,
    selects: HashMap<String, String>,
    default_selects: HashMap<String, String>,
    /// Select options seen per node (validation of config selects).
    select_options: HashMap<String, Vec<String>>,
}

type R<T> = Result<T, String>;

fn obj<'v>(v: &'v Value, path: &str) -> R<&'v Map<String, Value>> {
    v.as_object().ok_or_else(|| format!("{path}: expected an object"))
}

fn check_keys(o: &Map<String, Value>, allowed: &[&str], path: &str) -> R<()> {
    for k in o.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(format!("{path}: unknown key '{k}'"));
        }
    }
    Ok(())
}

fn num(v: &Value, path: &str) -> R<f64> {
    v.as_f64().ok_or_else(|| format!("{path}: expected a number"))
}

fn string<'v>(v: &'v Value, path: &str) -> R<&'v str> {
    v.as_str().ok_or_else(|| format!("{path}: expected a string"))
}

fn array<'v>(v: &'v Value, path: &str) -> R<&'v Vec<Value>> {
    v.as_array().ok_or_else(|| format!("{path}: expected an array"))
}

fn letter_ok(s: &str) -> bool {
    if let Some(rest) = s.strip_prefix("Start") {
        return rest.chars().all(|c| c.is_ascii_digit());
    }
    let mut cs = s.chars();
    matches!(cs.next(), Some(c) if c.is_ascii_uppercase()) && cs.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

impl<'c> Compiler<'c> {
    fn intern(&mut self, s: &str) -> usize {
        if let Some(&i) = self.index.get(s) {
            return i;
        }
        self.names.push(s.to_string());
        self.index.insert(s.to_string(), self.names.len() - 1);
        self.names.len() - 1
    }

    fn dest(&mut self, v: &Value, path: &str) -> R<usize> {
        let s = string(v, path)?;
        if !letter_ok(s) {
            return Err(format!("{path}: '{s}' is not a node letter"));
        }
        if !(self.known)(s) {
            return Err(format!("{path}: destination '{s}' is neither a routing node nor a map node"));
        }
        Ok(self.intern(s))
    }

    fn fleet(o: &Map<String, Value>, path: &str, allow_all: bool) -> R<FleetSel> {
        match o.get("fleet") {
            None => Ok(if allow_all { FleetSel::All } else { FleetSel::Main }),
            Some(v) => match string(v, &format!("{path}.fleet"))? {
                "main" => Ok(FleetSel::Main),
                "escort" => Ok(FleetSel::Escort),
                "all" if allow_all => Ok(FleetSel::All),
                s => Err(format!("{path}.fleet: invalid value '{s}'")),
            },
        }
    }

    fn types(v: Option<&Value>, path: &str) -> R<u32> {
        let v = v.ok_or_else(|| format!("{path}: missing 'types'"))?;
        let a = array(v, path)?;
        if a.is_empty() {
            return Err(format!("{path}: 'types' must not be empty"));
        }
        let mut mask = 0;
        for (i, t) in a.iter().enumerate() {
            let s = string(t, &format!("{path}[{i}]"))?;
            mask |= type_mask(s).ok_or_else(|| format!("{path}[{i}]: unknown ship type or group '{s}'"))?;
        }
        Ok(mask)
    }

    fn ints(v: Option<&Value>, key: &str, path: &str) -> R<Vec<u32>> {
        let v = v.ok_or_else(|| format!("{path}: missing '{key}'"))?;
        let a = array(v, path)?;
        if a.is_empty() {
            return Err(format!("{path}.{key}: must not be empty"));
        }
        a.iter().enumerate().map(|(i, x)| x.as_u64().map(|n| n as u32).ok_or_else(|| format!("{path}.{key}[{i}]: expected an integer"))).collect()
    }

    fn equip(v: Option<&Value>, path: &str) -> R<EquipSel> {
        let v = v.ok_or_else(|| format!("{path}: missing 'equip'"))?;
        let o = obj(v, path)?;
        if let Some(g) = o.get("group") {
            check_keys(o, &["group"], path)?;
            return Ok(match string(g, path)? {
                "RADAR" => EquipSel::Types { types: vec![12, 13, 93], min_los: None },
                "SURFACE_RADAR" => EquipSel::Types { types: vec![12, 13, 93], min_los: Some(5.0) },
                "DRUM" => EquipSel::Ids(vec![75]),
                "LANDING_CRAFT" => EquipSel::Types { types: vec![24, 46], min_los: None },
                "SONAR" => EquipSel::Types { types: vec![14, 40], min_los: None },
                s => return Err(format!("{path}.group: unknown equipment group '{s}'")),
            });
        }
        if o.contains_key("types") {
            check_keys(o, &["types", "minLos"], path)?;
            let min_los = o.get("minLos").map(|v| num(v, &format!("{path}.minLos"))).transpose()?;
            return Ok(EquipSel::Types { types: Self::ints(o.get("types"), "types", path)?, min_los });
        }
        if o.contains_key("ids") {
            check_keys(o, &["ids"], path)?;
            return Ok(EquipSel::Ids(Self::ints(o.get("ids"), "ids", path)?));
        }
        Err(format!("{path}: equipment selector needs 'group', 'types' or 'ids'"))
    }

    fn cmp(o: &Map<String, Value>, path: &str, speed: bool, boolean: bool) -> R<Cmp> {
        let mut c = Cmp::default();
        let val = |v: &Value, p: &str| -> R<f64> {
            if speed {
                if let Some(s) = v.as_str() {
                    return SPEEDS.iter().find(|(n, _)| *n == s).map(|(_, x)| *x).ok_or_else(|| format!("{p}: unknown speed '{s}'"));
                }
            }
            num(v, p)
        };
        for (k, v) in o {
            let p = format!("{path}.{k}");
            match k.as_str() {
                "eq" if boolean => c.bool_eq = Some(v.as_bool().ok_or_else(|| format!("{p}: expected a boolean"))?),
                "eq" => c.eq = Some(val(v, &p)?),
                "ne" if !boolean => c.ne = Some(val(v, &p)?),
                "gt" if !boolean => c.gt = Some(val(v, &p)?),
                "gte" if !boolean => c.gte = Some(val(v, &p)?),
                "lt" if !boolean => c.lt = Some(val(v, &p)?),
                "lte" if !boolean => c.lte = Some(val(v, &p)?),
                "in" if !boolean && !speed => {
                    c.in_ = Some(array(v, &p)?.iter().enumerate().map(|(i, x)| num(x, &format!("{p}[{i}]"))).collect::<R<_>>()?)
                }
                _ => {}
            }
        }
        Ok(c)
    }

    fn pred(&mut self, v: &Value, path: &str) -> R<Pred> {
        let o = obj(v, path)?;
        if let Some(a) = o.get("all").or_else(|| o.get("any")) {
            let key = if o.contains_key("all") { "all" } else { "any" };
            check_keys(o, &[key], path)?;
            let a = array(a, &format!("{path}.{key}"))?;
            if a.is_empty() {
                return Err(format!("{path}.{key}: must not be empty"));
            }
            let ps = a.iter().enumerate().map(|(i, p)| self.pred(p, &format!("{path}.{key}[{i}]"))).collect::<R<Vec<_>>>()?;
            return Ok(if key == "all" { Pred::All(ps) } else { Pred::Any(ps) });
        }
        if let Some(n) = o.get("not") {
            check_keys(o, &["not"], path)?;
            return Ok(Pred::Not(Box::new(self.pred(n, &format!("{path}.not"))?)));
        }
        let m = o.get("m").ok_or_else(|| format!("{path}: predicate needs 'm', 'all', 'any' or 'not'"))?;
        let m = string(m, &format!("{path}.m"))?;
        const NUM_OPS: [&str; 7] = ["eq", "ne", "gt", "gte", "lt", "lte", "in"];
        let keys = |extra: &[&str], ops: &[&str]| -> Vec<&'static str> {
            let mut k: Vec<&'static str> = vec!["m"];
            for e in extra.iter().chain(ops) {
                k.push(match *e {
                    "fleet" => "fleet",
                    "types" => "types",
                    "maxSpeed" => "maxSpeed",
                    "ids" => "ids",
                    "equip" => "equip",
                    "cn" => "cn",
                    "node" => "node",
                    "name" => "name",
                    "eq" => "eq",
                    "ne" => "ne",
                    "gt" => "gt",
                    "gte" => "gte",
                    "lt" => "lt",
                    "lte" => "lte",
                    "in" => "in",
                    _ => "?",
                });
            }
            k
        };
        let (metric, allowed, speed, boolean) = match m {
            "ships" => (Metric::Ships(Self::fleet(o, path, true)?), keys(&["fleet"], &NUM_OPS), false, false),
            "count" => {
                let max_speed = match o.get("maxSpeed") {
                    None => None,
                    Some(v) => {
                        let s = string(v, &format!("{path}.maxSpeed"))?;
                        Some(SPEEDS.iter().find(|(n, _)| *n == s).map(|(_, x)| *x).ok_or_else(|| format!("{path}.maxSpeed: unknown speed '{s}'"))?)
                    }
                };
                let mask = Self::types(o.get("types"), &format!("{path}.types"))?;
                (Metric::Count { mask, fleet: Self::fleet(o, path, true)?, max_speed }, keys(&["types", "fleet", "maxSpeed"], &NUM_OPS), false, false)
            }
            "onlyTypes" => {
                let mask = Self::types(o.get("types"), &format!("{path}.types"))?;
                (Metric::OnlyTypes { mask, fleet: Self::fleet(o, path, true)? }, keys(&["types", "fleet"], &["eq"]), false, true)
            }
            "countIds" => (
                Metric::CountIds { ids: Self::ints(o.get("ids"), "ids", path)?, fleet: Self::fleet(o, path, true)? },
                keys(&["ids", "fleet"], &NUM_OPS),
                false,
                false,
            ),
            "equipShips" | "equipCount" => {
                let sel = Self::equip(o.get("equip"), &format!("{path}.equip"))?;
                let fleet = Self::fleet(o, path, true)?;
                let metric = if m == "equipShips" { Metric::EquipShips { sel, fleet } } else { Metric::EquipCount { sel, fleet } };
                (metric, keys(&["equip", "fleet"], &NUM_OPS), false, false)
            }
            "speed" => (Metric::Speed, keys(&[], &["eq", "ne", "gt", "gte", "lt", "lte"]), true, false),
            "los" => {
                let cn = num(o.get("cn").ok_or_else(|| format!("{path}: missing 'cn'"))?, &format!("{path}.cn"))?;
                if ![1.0, 2.0, 3.0, 4.0].contains(&cn) {
                    return Err(format!("{path}.cn: must be 1, 2, 3 or 4"));
                }
                (Metric::Los(cn), keys(&["cn"], &NUM_OPS), false, false)
            }
            "fleetType" => {
                let v = o.get("in").ok_or_else(|| format!("{path}: missing 'in'"))?;
                let mut list = Vec::new();
                for (i, x) in array(v, &format!("{path}.in"))?.iter().enumerate() {
                    let s = string(x, &format!("{path}.in[{i}]"))?;
                    if !["single", "ctf", "stf", "tcf", "striking"].contains(&s) {
                        return Err(format!("{path}.in[{i}]: unknown fleet type '{s}'"));
                    }
                    list.push(s.to_string());
                }
                check_keys(o, &["m", "in"], path)?;
                return Ok(Pred::Leaf(Metric::FleetType(list), Cmp::default()));
            }
            "flagship" => {
                let mask = Self::types(o.get("in"), &format!("{path}.in"))?;
                check_keys(o, &["m", "in", "fleet"], path)?;
                return Ok(Pred::Leaf(Metric::Flagship { mask, fleet: Self::fleet(o, path, false)? }, Cmp::default()));
            }
            "difficulty" => (Metric::Difficulty, keys(&[], &NUM_OPS), false, false),
            "phase" => (Metric::Phase, keys(&[], &NUM_OPS), false, false),
            "gauge" => (Metric::Gauge, keys(&[], &NUM_OPS), false, false),
            "hq" => (Metric::Hq, keys(&[], &NUM_OPS), false, false),
            "visited" => {
                let n = string(o.get("node").ok_or_else(|| format!("{path}: missing 'node'"))?, &format!("{path}.node"))?;
                if !letter_ok(n) {
                    return Err(format!("{path}.node: '{n}' is not a node letter"));
                }
                let idx = self.intern(n);
                (Metric::Visited(idx), keys(&["node"], &["eq"]), false, true)
            }
            "flag" => {
                let name = string(o.get("name").ok_or_else(|| format!("{path}: missing 'name'"))?, &format!("{path}.name"))?;
                if name.is_empty() {
                    return Err(format!("{path}.name: must not be empty"));
                }
                let value = self.flags.get(name).copied().unwrap_or_else(|| self.default_flags.iter().any(|f| f == name));
                (Metric::Flag(value), keys(&["name"], &["eq"]), false, true)
            }
            other => return Err(format!("{path}: unknown predicate metric '{other}'")),
        };
        check_keys(o, &allowed, path)?;
        Ok(Pred::Leaf(metric, Self::cmp(o, path, speed, boolean)?))
    }

    fn rules(&mut self, node: &str, v: &Value, path: &str) -> R<Vec<Rule>> {
        let a = array(v, path)?;
        if a.is_empty() {
            return Err(format!("{path}: must not be empty"));
        }
        let mut out = Vec::with_capacity(a.len());
        for (i, r) in a.iter().enumerate() {
            let p = format!("{path}[{i}]");
            let o = obj(r, &p)?;
            let actions: Vec<&str> = ["to", "random", "los", "select", "rules"].into_iter().filter(|k| o.contains_key(*k)).collect();
            if actions.len() != 1 {
                return Err(format!("{p}: a rule needs exactly one of to/random/los/select/rules"));
            }
            check_keys(o, &["when", "note", "uncertain", "source", actions[0]], &p)?;
            if let Some(u) = o.get("uncertain") {
                u.as_bool().ok_or_else(|| format!("{p}.uncertain: expected a boolean"))?;
            }
            for k in ["note", "source"] {
                if let Some(x) = o.get(k) {
                    string(x, &format!("{p}.{k}"))?;
                }
            }
            if i + 1 == a.len() && o.contains_key("when") {
                return Err(format!("{p}: the last rule of a list must not have 'when'"));
            }
            let when = o.get("when").map(|w| self.pred(w, &format!("{p}.when"))).transpose()?;
            let action = match actions[0] {
                "to" => Action::To(self.dest(&o["to"], &format!("{p}.to"))?),
                "random" => {
                    let entries = array(&o["random"], &format!("{p}.random"))?;
                    if entries.len() < 2 {
                        return Err(format!("{p}.random: needs at least 2 entries"));
                    }
                    let mut list = Vec::new();
                    let mut sum = 0.0;
                    for (j, e) in entries.iter().enumerate() {
                        let ep = format!("{p}.random[{j}]");
                        let eo = obj(e, &ep)?;
                        check_keys(eo, &["to", "p"], &ep)?;
                        let to = self.dest(eo.get("to").ok_or_else(|| format!("{ep}: missing 'to'"))?, &format!("{ep}.to"))?;
                        let pr = num(eo.get("p").ok_or_else(|| format!("{ep}: missing 'p'"))?, &format!("{ep}.p"))?;
                        if !(pr > 0.0 && pr <= 1.0) {
                            return Err(format!("{ep}.p: must be in (0, 1]"));
                        }
                        sum += pr;
                        list.push((to, pr));
                    }
                    if (sum - 1.0).abs() > 1e-6 {
                        return Err(format!("{p}.random: weights sum to {sum}, expected 1"));
                    }
                    Action::Random(list)
                }
                "los" => {
                    let lp = format!("{p}.los");
                    let lo = obj(&o["los"], &lp)?;
                    check_keys(lo, &["cn", "thresholds", "below", "interpolate"], &lp)?;
                    let cn = num(lo.get("cn").ok_or_else(|| format!("{lp}: missing 'cn'"))?, &format!("{lp}.cn"))?;
                    if ![1.0, 2.0, 3.0, 4.0].contains(&cn) {
                        return Err(format!("{lp}.cn: must be 1, 2, 3 or 4"));
                    }
                    let ts = array(lo.get("thresholds").ok_or_else(|| format!("{lp}: missing 'thresholds'"))?, &format!("{lp}.thresholds"))?;
                    if ts.is_empty() {
                        return Err(format!("{lp}.thresholds: must not be empty"));
                    }
                    let mut thresholds = Vec::new();
                    for (j, t) in ts.iter().enumerate() {
                        let tp = format!("{lp}.thresholds[{j}]");
                        let to = obj(t, &tp)?;
                        check_keys(to, &["min", "to"], &tp)?;
                        let min = num(to.get("min").ok_or_else(|| format!("{tp}: missing 'min'"))?, &format!("{tp}.min"))?;
                        let dest = self.dest(to.get("to").ok_or_else(|| format!("{tp}: missing 'to'"))?, &format!("{tp}.to"))?;
                        if let Some(&(prev, _)) = thresholds.last() {
                            if min >= prev {
                                return Err(format!("{tp}.min: thresholds must be strictly descending"));
                            }
                        }
                        thresholds.push((min, dest));
                    }
                    let below = self.dest(lo.get("below").ok_or_else(|| format!("{lp}: missing 'below'"))?, &format!("{lp}.below"))?;
                    let interpolate = match lo.get("interpolate") {
                        None => true,
                        Some(v) => v.as_bool().ok_or_else(|| format!("{lp}.interpolate: expected a boolean"))?,
                    };
                    Action::Los { cn, thresholds, below, interpolate }
                }
                "select" => {
                    let opts = array(&o["select"], &format!("{p}.select"))?;
                    if opts.len() < 2 {
                        return Err(format!("{p}.select: needs at least 2 options"));
                    }
                    let mut list = Vec::new();
                    let mut letters = Vec::new();
                    for (j, x) in opts.iter().enumerate() {
                        list.push(self.dest(x, &format!("{p}.select[{j}]"))?);
                        letters.push(x.as_str().unwrap_or_default().to_string());
                    }
                    let pick = [self.selects.get(node), self.default_selects.get(node)]
                        .into_iter()
                        .flatten()
                        .find_map(|c| letters.iter().position(|l| l == c))
                        .unwrap_or(0);
                    self.select_options.entry(node.to_string()).or_default().extend(letters.iter().cloned());
                    Action::Select(list[pick])
                }
                _ => Action::Rules(self.rules(node, &o["rules"], &format!("{p}.rules"))?),
            };
            out.push(Rule { when, action });
        }
        Ok(out)
    }
}

impl Router {
    /// Parse and validate a routing document. `map_nodes`: node letters known from the map
    /// (destinations must be a routing node or a map node).
    pub fn compile(doc: &Value, map_nodes: &[String], cfg: &RouteConfig) -> R<Router> {
        let root = obj(doc, "routing")?;
        check_keys(root, &["$schema", "map", "layout", "sources", "defaults", "start", "nodes"], "routing")?;
        let map = string(root.get("map").ok_or("routing: missing 'map'")?, "routing.map")?;
        let mut parts = map.split('-');
        let valid_map = matches!((parts.next(), parts.next(), parts.next()), (Some(a), Some(b), None)
            if !a.is_empty() && !b.is_empty() && a.chars().all(|c| c.is_ascii_digit()) && b.chars().all(|c| c.is_ascii_digit()));
        if !valid_map {
            return Err(format!("routing.map: '{map}' is not like '1-5'"));
        }
        let sources = array(root.get("sources").ok_or("routing: missing 'sources'")?, "routing.sources")?;
        if sources.is_empty() {
            return Err("routing.sources: must not be empty".into());
        }
        for (i, s) in sources.iter().enumerate() {
            let p = format!("routing.sources[{i}]");
            let so = obj(s, &p)?;
            check_keys(so, &["id", "note"], &p)?;
            string(so.get("id").ok_or_else(|| format!("{p}: missing 'id'"))?, &p)?;
            string(so.get("note").ok_or_else(|| format!("{p}: missing 'note'"))?, &p)?;
        }
        let nodes = obj(root.get("nodes").ok_or("routing: missing 'nodes'")?, "routing.nodes")?;
        let mut default_selects = HashMap::new();
        let mut default_flags = Vec::new();
        let (mut phase, mut gauge) = (None, None);
        if let Some(d) = root.get("defaults") {
            let d = obj(d, "routing.defaults")?;
            check_keys(d, &["select", "flags", "phase", "gauge"], "routing.defaults")?;
            if let Some(s) = d.get("select") {
                for (k, v) in obj(s, "routing.defaults.select")? {
                    default_selects.insert(k.clone(), string(v, &format!("routing.defaults.select.{k}"))?.to_string());
                }
            }
            if let Some(f) = d.get("flags") {
                for (i, x) in array(f, "routing.defaults.flags")?.iter().enumerate() {
                    default_flags.push(string(x, &format!("routing.defaults.flags[{i}]"))?.to_string());
                }
            }
            phase = d.get("phase").map(|v| num(v, "routing.defaults.phase")).transpose()?;
            gauge = d.get("gauge").map(|v| num(v, "routing.defaults.gauge")).transpose()?;
        }
        let known = |s: &str| nodes.contains_key(s) || map_nodes.iter().any(|m| m == s);
        let mut c = Compiler {
            names: Vec::new(),
            index: HashMap::new(),
            known: &known,
            flags: cfg.flags.clone(),
            default_flags,
            selects: cfg.selects.clone(),
            default_selects,
            select_options: HashMap::new(),
        };
        for name in nodes.keys().chain(map_nodes.iter()) {
            c.intern(name);
        }
        let mut defs: Vec<(usize, NodeDef)> = Vec::new();
        for (name, v) in nodes {
            let p = format!("routing.nodes.{name}");
            if !letter_ok(name) {
                return Err(format!("{p}: '{name}' is not a node letter"));
            }
            let o = obj(v, &p)?;
            let def = if o.contains_key("end") {
                check_keys(o, &["end", "note"], &p)?;
                if o["end"] != Value::Bool(true) {
                    return Err(format!("{p}.end: must be true"));
                }
                NodeDef::End
            } else {
                check_keys(o, &["rules", "note"], &p)?;
                NodeDef::Rules(c.rules(name, o.get("rules").ok_or_else(|| format!("{p}: needs 'rules' or 'end'"))?, &format!("{p}.rules"))?)
            };
            if let Some(n) = o.get("note") {
                string(n, &format!("{p}.note"))?;
            }
            defs.push((c.index[name.as_str()], def));
        }
        let start = match root.get("start") {
            None => None,
            Some(v) => {
                let o = obj(v, "routing.start")?;
                check_keys(o, &["rules", "note"], "routing.start")?;
                if let Some(n) = o.get("note") {
                    string(n, "routing.start.note")?;
                }
                let rules = c.rules("start", o.get("rules").ok_or("routing.start: needs 'rules'")?, "routing.start.rules")?;
                let mut dests = Vec::new();
                rules.iter().for_each(|r| r.dests(&mut dests));
                if let Some(&bad) = dests.iter().find(|&&d| !c.names[d].starts_with("Start")) {
                    return Err(format!("routing.start.rules: destination '{}' is not a start node", c.names[bad]));
                }
                Some(rules)
            }
        };
        for (node, choice) in &cfg.selects {
            match c.select_options.get(node) {
                Some(opts) if opts.contains(choice) => {}
                Some(opts) => return Err(format!("config.selects.{node}: '{choice}' is not one of {opts:?}")),
                None => return Err(format!("config.selects.{node}: node has no select rule")),
            }
        }
        let mut node_defs: Vec<Option<NodeDef>> = vec![None; c.names.len()];
        for (i, d) in defs {
            node_defs[i] = Some(d);
        }
        Ok(Router {
            names: c.names,
            index: c.index,
            nodes: node_defs,
            start,
            hq: cfg.hq,
            difficulty: cfg.difficulty,
            phase: Cell::new(cfg.phase.or(phase).unwrap_or(1.0)),
            gauge: Cell::new(cfg.gauge.or(gauge).unwrap_or(1.0)),
        })
    }

    /// Gauge phase seen by the `phase` predicate (advanced between the phases of a gauge run).
    pub fn phase(&self) -> f64 {
        self.phase.get()
    }

    pub fn set_phase(&self, phase: f64) {
        self.phase.set(phase);
    }

    /// Gauge number seen by the `gauge` predicate (advanced between the gauges of a gauge run).
    pub fn gauge(&self) -> f64 {
        self.gauge.get()
    }

    pub fn set_gauge(&self, gauge: f64) {
        self.gauge.set(gauge);
    }

    pub fn len(&self) -> usize {
        self.names.len()
    }

    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }

    pub fn name(&self, i: usize) -> &str {
        &self.names[i]
    }

    pub fn index(&self, name: &str) -> Option<usize> {
        self.index.get(name).copied()
    }

    /// The node has outgoing rules (not `end`, not missing).
    pub fn has_rules(&self, node: usize) -> bool {
        matches!(self.nodes.get(node), Some(Some(NodeDef::Rules(_))))
    }

    /// Next node from `node`, or `None` at an end node / a node without rules.
    pub fn next(&self, node: usize, ctx: &RouteCtx, rng: &mut Rng) -> Option<usize> {
        match self.nodes.get(node)? {
            Some(NodeDef::Rules(rules)) => Some(self.eval(rules, ctx, rng)),
            _ => None,
        }
    }

    /// The document has top-level start rules (multi-start map).
    pub fn has_start_rules(&self) -> bool {
        self.start.is_some()
    }

    /// Start node chosen by the top-level start rules (`ctx.visited` empty), `None` without them.
    pub fn start_node(&self, ctx: &RouteCtx, rng: &mut Rng) -> Option<usize> {
        self.start.as_ref().map(|rules| self.eval(rules, ctx, rng))
    }

    fn eval(&self, rules: &[Rule], ctx: &RouteCtx, rng: &mut Rng) -> usize {
        for (i, r) in rules.iter().enumerate() {
            let last = i + 1 == rules.len();
            if !last && !r.when.as_ref().is_none_or(|p| self.test(p, ctx)) {
                continue;
            }
            return match &r.action {
                Action::To(t) => *t,
                Action::Random(list) => {
                    let u = rng.f64();
                    let mut cum = 0.0;
                    for &(to, p) in list {
                        cum += p;
                        if cum > u {
                            return to;
                        }
                    }
                    list.last().unwrap().0
                }
                Action::Los { cn, thresholds, below, interpolate } => {
                    let v = ctx.los(*cn, self.hq);
                    if v >= thresholds[0].0 {
                        return thresholds[0].1;
                    }
                    for w in thresholds.windows(2) {
                        let (hi, lo) = (w[0], w[1]);
                        if v >= lo.0 && v < hi.0 {
                            if !interpolate {
                                return lo.1;
                            }
                            let p = (v - lo.0) / (hi.0 - lo.0);
                            return if rng.f64() < p { hi.1 } else { lo.1 };
                        }
                    }
                    *below
                }
                Action::Select(pick) => *pick,
                Action::Rules(nested) => self.eval(nested, ctx, rng),
            };
        }
        unreachable!("validated: the last rule of a list has no `when`")
    }

    fn fleet<'s>(ctx: &'s RouteCtx, f: FleetSel) -> &'s [&'s RouteShip] {
        match f {
            FleetSel::Main => &ctx.ships[..ctx.main],
            FleetSel::Escort => &ctx.ships[ctx.main..],
            FleetSel::All => ctx.ships,
        }
    }

    fn test(&self, p: &Pred, ctx: &RouteCtx) -> bool {
        match p {
            Pred::All(ps) => ps.iter().all(|p| self.test(p, ctx)),
            Pred::Any(ps) => ps.iter().any(|p| self.test(p, ctx)),
            Pred::Not(p) => !self.test(p, ctx),
            Pred::Leaf(m, c) => {
                let in_mask = |mask: u32, s: &RouteShip| s.stype < 32 && mask & (1 << s.stype) != 0;
                let boolean = |v: bool| c.bool_eq.map_or(v, |e| v == e);
                match m {
                    Metric::Ships(f) => c.num(Self::fleet(ctx, *f).len() as f64),
                    Metric::Count { mask, fleet, max_speed } => {
                        let n = Self::fleet(ctx, *fleet).iter().filter(|s| in_mask(*mask, s) && max_speed.is_none_or(|ms| s.speed <= ms)).count();
                        c.num(n as f64)
                    }
                    Metric::OnlyTypes { mask, fleet } => boolean(Self::fleet(ctx, *fleet).iter().all(|s| in_mask(*mask, s))),
                    Metric::CountIds { ids, fleet } => c.num(Self::fleet(ctx, *fleet).iter().filter(|s| ids.contains(&s.id)).count() as f64),
                    Metric::EquipShips { sel, fleet } => {
                        c.num(Self::fleet(ctx, *fleet).iter().filter(|s| s.equips.iter().any(|e| sel.matches(e))).count() as f64)
                    }
                    Metric::EquipCount { sel, fleet } => {
                        c.num(Self::fleet(ctx, *fleet).iter().map(|s| s.equips.iter().filter(|e| sel.matches(e)).count()).sum::<usize>() as f64)
                    }
                    Metric::Speed => c.num(ctx.ships.iter().map(|s| s.speed).fold(f64::INFINITY, f64::min).min(20.0)),
                    Metric::Los(cn) => c.num(ctx.los(*cn, self.hq)),
                    Metric::FleetType(list) => {
                        let t = match ctx.combined {
                            None if ctx.striking => "striking",
                            None => "single",
                            Some(CombinedType::Carrier) => "ctf",
                            Some(CombinedType::Surface) => "stf",
                            Some(CombinedType::Transport) => "tcf",
                        };
                        list.iter().any(|x| x == t)
                    }
                    Metric::Flagship { mask, fleet } => Self::fleet(ctx, *fleet).first().is_some_and(|s| in_mask(*mask, s)),
                    Metric::Difficulty => c.num(self.difficulty),
                    Metric::Phase => c.num(self.phase.get()),
                    Metric::Gauge => c.num(self.gauge.get()),
                    Metric::Hq => c.num(self.hq),
                    Metric::Visited(n) => boolean(ctx.visited.contains(n)),
                    Metric::Flag(v) => boolean(*v),
                }
            }
        }
    }
}
