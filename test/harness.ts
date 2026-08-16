/**
 * Tiny seeded property-testing harness. Zero dependencies on purpose: a
 * reconciliation engine claiming determinism should not need a framework to
 * prove it — a PRNG, a loop, and a reproducible seed in every failure
 * message are enough.
 *
 * PRNG: mulberry32 — small, fast, well-distributed enough for test data.
 * No shrinking; failures print the seed so any case replays exactly.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;

  constructor(public readonly seed: number) {
    this.next = mulberry32(seed);
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty array');
    return items[this.int(0, items.length - 1)];
  }

  /** Fisher–Yates shuffle into a new array; input untouched. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

/**
 * Run `body` once per seed. On failure, rethrow with the seed baked into the
 * message so the exact case is reproducible with Rng(seed).
 */
export function forAllSeeds(
  runs: number,
  firstSeed: number,
  body: (rng: Rng, seed: number) => void,
): void {
  for (let i = 0; i < runs; i++) {
    const seed = firstSeed + i;
    try {
      body(new Rng(seed), seed);
    } catch (err) {
      const e = err as Error;
      e.message = `[property failed at seed ${seed}] ${e.message}`;
      throw e;
    }
  }
}

/** Property-run count: RECON_PROP_RUNS env var, default 40. */
export function propertyRuns(defaultRuns = 40): number {
  const env = process.env.RECON_PROP_RUNS;
  if (!env) return defaultRuns;
  const n = Number(env);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`bad RECON_PROP_RUNS: ${env}`);
  return n;
}
