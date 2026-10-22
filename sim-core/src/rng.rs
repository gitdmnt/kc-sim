//! Seeded, platform-independent RNG (xoshiro256++ seeded through SplitMix64).

use rand_core::{RngCore, SeedableRng};
use rand_xoshiro::Xoshiro256PlusPlus;

pub struct Rng(Xoshiro256PlusPlus);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(Xoshiro256PlusPlus::seed_from_u64(seed))
    }

    /// Uniform in [0, 1) with 53-bit resolution (JS `Math.random()` equivalent).
    #[inline]
    pub fn f64(&mut self) -> f64 {
        (self.0.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    /// Uniform integer in [0, n). `n == 0` returns 0.
    #[inline]
    pub fn below(&mut self, n: usize) -> usize {
        (self.f64() * n as f64) as usize
    }

    /// `rand < p`.
    #[inline]
    pub fn chance(&mut self, p: f64) -> bool {
        self.f64() < p
    }

    /// `floor(rand * n)` for a float `n` (armor / scratch rolls).
    #[inline]
    pub fn floor_mul(&mut self, n: f64) -> f64 {
        (self.f64() * n).floor()
    }
}
