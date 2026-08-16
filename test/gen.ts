/**
 * Scenario generator for property tests.
 *
 * Builds a random internal ledger, then derives its settlement counterpart by
 * applying realistic corruptions — each one planted with a recorded
 * expectation of where it must land in the reconciliation output:
 *
 *   exact copies          -> tier 1 (exact)
 *   reference decoration  -> tier 2 (reference-fuzzy)
 *   settlement date shift -> tier 3 (amount-date-window)
 *   fee deduction (bps)   -> tier 4 (amount-tolerance)
 *   batched payout        -> tier 5 (many-to-one)
 *   amount corruption     -> residual amount-mismatch, both sides
 *   dropped settlement    -> residual missing-in-settlement
 *   processor adjustment  -> residual missing-in-internal
 *   beyond-window timing  -> residual on both sides
 *   duplicate references  -> two exact matches, disambiguated by amount
 *   currency traps        -> same amount+date, different currency: no match
 *
 * AMBIGUITY CONTROL. Random data can accidentally create legitimate alternate
 * matches (two rows with nearly equal amounts, or an unplanned subset summing
 * to a batch total), which would make bucket assertions flaky even though the
 * engine is correct. The generator prevents this structurally:
 *   - every amount is drawn with a minimum separation (SEP) from all previously
 *     placed amounts, larger than 2x the maximum bps tolerance in play, so
 *     tolerance-tier matches are always unambiguous;
 *   - amount-corruption deltas are chosen beyond tolerance but closer than SEP
 *     to their partner, and re-rolled until they keep clear of every other row;
 *   - after assembly, a validation pass proves each planted batch total has a
 *     UNIQUE subset solution within its date window, and that every
 *     expected-unmatched settlement row has NO subset solution at all;
 *     violations are repaired by re-rolling amounts (bounded, deterministic).
 */

import type { MatchRule, ReconConfig, ResidualCategory, Txn } from '../src/types.js';
import { formatMinor } from '../src/money.js';
import { epochDayToISO, parseISODate } from '../src/dates.js';
import { Rng } from './harness.js';

export interface MatchExpectation {
  kind: 'match';
  rule: MatchRule;
  internalIds: string[];
  settlementIds: string[];
}

export interface ResidualExpectation {
  kind: 'residual';
  side: 'internal' | 'settlement';
  id: string;
  category: ResidualCategory;
  /** For amount-mismatch: the counterpart row the engine must point at. */
  candidateId?: string;
  /** For amount-mismatch: the exact signed delta the engine must report. */
  amountDeltaMinor?: number;
}

export type Expectation = MatchExpectation | ResidualExpectation;

export interface Scenario {
  internal: Txn[];
  settlement: Txn[];
  expectations: Expectation[];
}

/** The config every property scenario runs under. */
export const SCENARIO_CONFIG: ReconConfig = {
  decimals: 2,
  dateWindowDays: 3,
  amountToleranceBps: 50,
  amountToleranceMinMinor: 0,
  manyToOne: {
    enabled: true,
    maxGroupSize: 6,
    maxCandidates: 40,
    dateWindowDays: 7,
    toleranceBps: 0,
    maxNodes: 500_000,
  },
};

const MIN_AMT = 5_000; // 50.00
const MAX_AMT = 95_000; // 950.00
/** Minimum separation between placed amounts; > 2 x max tier-4 tolerance (475). */
const SEP = 1_200;
/** Expected-unmatched rows must stay this far from any foreign amount (> 475). */
const LOOSE_SEP = 501;
const MAX_GROUP = 6;
const BATCH_WINDOW = 7;

interface Entry {
  id: string;
  day: number;
  minor: number;
  currency: string;
  ref?: string;
}

class AmountPool {
  readonly taken: number[] = [];

  has(a: number): boolean {
    return this.taken.includes(a);
  }

  clearOf(a: number, sep: number, exclude?: number): boolean {
    return this.taken.every((p) => p === exclude || Math.abs(a - p) >= sep);
  }

  add(a: number): void {
    this.taken.push(a);
  }

  remove(a: number): void {
    const i = this.taken.indexOf(a);
    if (i < 0) throw new Error(`amount ${a} not in pool`);
    this.taken.splice(i, 1);
  }

  pick(rng: Rng): number {
    for (let attempt = 0; attempt < 5_000; attempt++) {
      const a = rng.int(MIN_AMT, MAX_AMT);
      if (this.clearOf(a, SEP)) {
        this.add(a);
        return a;
      }
    }
    throw new Error('amount pool exhausted — scenario too dense');
  }
}

function toTxn(e: Entry): Txn {
  const txn: Txn = {
    id: e.id,
    date: epochDayToISO(e.day),
    amount: formatMinor(e.minor, 2),
    currency: e.currency,
  };
  if (e.ref !== undefined) txn.reference = e.ref;
  return txn;
}

/** Decorations that must all normalize back to the original reference. */
function decorateRef(rng: Rng, ref: string): string {
  const variants = [
    `ref ${ref.toLowerCase()}`,
    `REF-${ref}`,
    `TXN ${ref}`,
    `payment ${ref.toLowerCase()}`,
    `  ${ref.toLowerCase()}  `,
    ref.replace(/-/g, ' ').toLowerCase(),
    `trx_${ref.toLowerCase()}`,
  ];
  return rng.pick(variants);
}

/**
 * Count subsets (size 2..maxSize) of `values` that sum exactly to `target`.
 * Stops counting at `cap`. Values must be positive and distinct.
 */
export function countSubsetsSumming(
  values: readonly number[],
  target: number,
  maxSize: number,
  cap = 2,
): number {
  const order = [...values].sort((x, y) => y - x);
  const suffix: number[] = new Array(order.length + 1).fill(0);
  for (let i = order.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + order[i];
  let count = 0;
  const dfs = (pos: number, size: number, sum: number): void => {
    if (count >= cap) return;
    if (size >= 2 && sum === target) {
      count++;
      return; // positive values: extending can only overshoot
    }
    if (sum >= target) return;
    if (pos >= order.length || size >= maxSize) return;
    if (sum + suffix[pos] < target) return;
    dfs(pos + 1, size + 1, sum + order[pos]);
    dfs(pos + 1, size, sum);
  };
  dfs(0, 0, 0);
  return count;
}

interface Batch {
  settlement: Entry;
  components: Entry[];
}

interface UnmatchedTarget {
  entry: Entry;
  kind: 'mismatch' | 'timing' | 'adjustment' | 'trap';
  /** The internal partner whose amount is coupled to this row (mismatch/timing). */
  partner?: Entry;
}

export function buildScenario(rng: Rng): Scenario {
  const pool = new AmountPool();
  const internal: Entry[] = [];
  const settlement: Entry[] = [];
  const expectations: Expectation[] = [];
  const batches: Batch[] = [];
  const unmatchedTargets: UnmatchedTarget[] = [];
  const day0 = parseISODate('2026-03-01');

  let nextInternal = 0;
  let nextSettlement = 0;
  const internalId = () => `A-${String(++nextInternal).padStart(3, '0')}`;
  const settlementId = () => `S-${String(++nextSettlement).padStart(3, '0')}`;

  const addInternal = (e: Entry) => internal.push(e);
  const addSettlement = (e: Entry) => settlement.push(e);

  const n = rng.int(14, 26);
  const batchPool: Entry[] = [];

  type RowClass = 'exact' | 'fuzzy' | 'window' | 'fee' | 'mismatch' | 'dropped' | 'batch';
  const rollClass = (): RowClass => {
    const r = rng.float();
    if (r < 0.26) return 'exact';
    if (r < 0.4) return 'fuzzy';
    if (r < 0.54) return 'window';
    if (r < 0.68) return 'fee';
    if (r < 0.76) return 'mismatch';
    if (r < 0.87) return 'dropped';
    return 'batch';
  };

  for (let i = 0; i < n; i++) {
    const cls = rollClass();
    const a: Entry = {
      id: internalId(),
      day: day0 + rng.int(0, 20),
      minor: pool.pick(rng),
      currency: 'USD',
      ref: `ORD-${1000 + i}`,
    };
    addInternal(a);

    if (cls === 'exact') {
      const b: Entry = { ...a, id: settlementId() };
      addSettlement(b);
      expectations.push({ kind: 'match', rule: 'exact', internalIds: [a.id], settlementIds: [b.id] });
    } else if (cls === 'fuzzy') {
      const b: Entry = { ...a, id: settlementId(), ref: decorateRef(rng, a.ref!) };
      addSettlement(b);
      expectations.push({
        kind: 'match',
        rule: 'reference-fuzzy',
        internalIds: [a.id],
        settlementIds: [b.id],
      });
    } else if (cls === 'window') {
      // Settlement lands a few days late (or early), loses the reference.
      const shift = rng.pick([-3, -2, -1, 1, 2, 3]);
      const b: Entry = { id: settlementId(), day: a.day + shift, minor: a.minor, currency: 'USD' };
      addSettlement(b);
      expectations.push({
        kind: 'match',
        rule: 'amount-date-window',
        internalIds: [a.id],
        settlementIds: [b.id],
      });
    } else if (cls === 'fee') {
      // Processor nets a fee off the gross: within tolerance (<= 35bps of 50).
      const feeBps = rng.int(5, 35);
      const fee = Math.max(1, Math.floor((a.minor * feeBps) / 10_000));
      const b: Entry = {
        id: settlementId(),
        day: a.day + rng.int(0, 1),
        minor: a.minor - fee,
        currency: 'USD',
        ref: a.ref,
      };
      pool.add(b.minor);
      addSettlement(b);
      expectations.push({
        kind: 'match',
        rule: 'amount-tolerance',
        internalIds: [a.id],
        settlementIds: [b.id],
      });
    } else if (cls === 'mismatch') {
      // Same reference, corrupted amount: beyond tolerance, flagged for humans.
      const b: Entry = {
        id: settlementId(),
        day: a.day,
        minor: pickMismatchAmount(rng, pool, a.minor),
        currency: 'USD',
        ref: a.ref,
      };
      addSettlement(b);
      unmatchedTargets.push({ entry: b, kind: 'mismatch', partner: a });
      expectations.push({
        kind: 'residual',
        side: 'internal',
        id: a.id,
        category: 'amount-mismatch',
        candidateId: b.id,
        amountDeltaMinor: a.minor - b.minor,
      });
      expectations.push({
        kind: 'residual',
        side: 'settlement',
        id: b.id,
        category: 'amount-mismatch',
        candidateId: a.id,
        amountDeltaMinor: b.minor - a.minor,
      });
    } else if (cls === 'dropped') {
      // Processor never settled it. Nothing on the B side at all.
      expectations.push({
        kind: 'residual',
        side: 'internal',
        id: a.id,
        category: 'missing-in-settlement',
      });
    } else {
      batchPool.push(a);
    }
  }

  // Guarantee at least one batch per scenario — tier 5 is the hardest tier,
  // it must be exercised every run.
  while (batchPool.length < 2) {
    const a: Entry = {
      id: internalId(),
      day: day0 + rng.int(0, 20),
      minor: pool.pick(rng),
      currency: 'USD',
      ref: `ORD-${9000 + batchPool.length}`,
    };
    addInternal(a);
    batchPool.push(a);
  }

  // Group the pool into payout batches of 2..5 components.
  let cursor = 0;
  while (batchPool.length - cursor >= 2) {
    const size = Math.min(rng.int(2, 5), batchPool.length - cursor);
    const components = batchPool.slice(cursor, cursor + size);
    cursor += size;
    const batchDay = day0 + rng.int(4, 20);
    for (const c of components) c.day = batchDay - rng.int(1, 4);
    const b: Entry = {
      id: settlementId(),
      day: batchDay,
      minor: 0, // set by settleBatchSum
      currency: 'USD',
      ref: `PAYOUT-${batches.length + 1}`,
    };
    settleBatchSum(rng, pool, b, components);
    addSettlement(b);
    batches.push({ settlement: b, components });
    expectations.push({
      kind: 'match',
      rule: 'many-to-one',
      internalIds: components.map((c) => c.id),
      settlementIds: [b.id],
    });
  }
  // A leftover pool row (odd count) settles exactly.
  for (; cursor < batchPool.length; cursor++) {
    const a = batchPool[cursor];
    const b: Entry = { ...a, id: settlementId() };
    addSettlement(b);
    expectations.push({ kind: 'match', rule: 'exact', internalIds: [a.id], settlementIds: [b.id] });
  }

  // Timing breaks: settled far beyond every window — residual on both sides.
  if (rng.chance(0.7)) {
    const a: Entry = {
      id: internalId(),
      day: day0 + rng.int(0, 8),
      minor: pool.pick(rng),
      currency: 'USD',
      ref: `ORD-${8000}`,
    };
    addInternal(a);
    const b: Entry = { id: settlementId(), day: a.day + rng.int(9, 14), minor: a.minor, currency: 'USD' };
    addSettlement(b);
    unmatchedTargets.push({ entry: b, kind: 'timing', partner: a });
    expectations.push({ kind: 'residual', side: 'internal', id: a.id, category: 'missing-in-settlement' });
    expectations.push({ kind: 'residual', side: 'settlement', id: b.id, category: 'missing-in-internal' });
  }

  // Processor adjustments: settlement-only lines (chargeback fees, corrections).
  const adjustments = rng.int(1, 3);
  for (let k = 0; k < adjustments; k++) {
    const b: Entry = {
      id: settlementId(),
      day: day0 + rng.int(0, 20),
      minor: pool.pick(rng),
      currency: 'USD',
      ref: `ADJ-${100 + k}`,
    };
    addSettlement(b);
    unmatchedTargets.push({ entry: b, kind: 'adjustment' });
    expectations.push({ kind: 'residual', side: 'settlement', id: b.id, category: 'missing-in-internal' });
  }

  // Duplicate references: two internal rows share a reference; settlement has
  // exact copies of both. Amount disambiguates — and nothing may double-match.
  if (rng.chance(0.6)) {
    const day = day0 + rng.int(0, 20);
    for (let k = 0; k < 2; k++) {
      const a: Entry = { id: internalId(), day, minor: pool.pick(rng), currency: 'USD', ref: 'DUP-777' };
      addInternal(a);
      const b: Entry = { ...a, id: settlementId() };
      addSettlement(b);
      expectations.push({ kind: 'match', rule: 'exact', internalIds: [a.id], settlementIds: [b.id] });
    }
  }

  // A second currency, reconciled independently in the same run.
  if (rng.chance(0.5)) {
    for (let k = 0; k < 2; k++) {
      const a: Entry = {
        id: internalId(),
        day: day0 + rng.int(0, 20),
        minor: pool.pick(rng),
        currency: 'EUR',
        ref: `EUR-${200 + k}`,
      };
      addInternal(a);
      const b: Entry = { ...a, id: settlementId() };
      addSettlement(b);
      expectations.push({ kind: 'match', rule: 'exact', internalIds: [a.id], settlementIds: [b.id] });
    }
  }

  // Currency trap: identical amount and date, different currency. Must not match.
  if (rng.chance(0.4)) {
    const minor = pool.pick(rng);
    const day = day0 + rng.int(0, 20);
    const a: Entry = { id: internalId(), day, minor, currency: 'EUR' };
    addInternal(a);
    const b: Entry = { id: settlementId(), day, minor, currency: 'USD' };
    addSettlement(b);
    unmatchedTargets.push({ entry: b, kind: 'trap', partner: a });
    expectations.push({ kind: 'residual', side: 'internal', id: a.id, category: 'missing-in-settlement' });
    expectations.push({ kind: 'residual', side: 'settlement', id: b.id, category: 'missing-in-internal' });
  }

  validateAndRepair(rng, pool, internal, batches, unmatchedTargets, expectations);

  return {
    internal: internal.map(toTxn),
    settlement: settlement.map(toTxn),
    expectations,
  };
}

/**
 * Pick a corrupted amount for a mismatch row: beyond tier-4 tolerance of its
 * partner, but clear (> LOOSE_SEP) of every other placed amount so it cannot
 * fall into tolerance range of an unrelated row.
 */
function pickMismatchAmount(rng: Rng, pool: AmountPool, partnerMinor: number): number {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    const delta = rng.int(600, 1_100) * (rng.chance(0.5) ? 1 : -1);
    const s = partnerMinor + delta;
    if (s < 100) continue;
    if (pool.clearOf(s, LOOSE_SEP, partnerMinor) && !pool.has(s)) {
      pool.add(s);
      return s;
    }
  }
  throw new Error('could not place mismatch amount');
}

/** Set a batch settlement row's amount to the component sum, jittering
 *  components until the sum keeps SEP distance from every placed amount. */
function settleBatchSum(rng: Rng, pool: AmountPool, b: Entry, components: Entry[]): void {
  for (let attempt = 0; attempt < 200; attempt++) {
    const sum = components.reduce((s, c) => s + c.minor, 0);
    if (pool.clearOf(sum, SEP)) {
      pool.add(sum);
      b.minor = sum;
      return;
    }
    const victim = rng.pick(components);
    pool.remove(victim.minor);
    victim.minor = pool.pick(rng);
  }
  throw new Error('could not place batch sum');
}

/**
 * Post-assembly validation: prove the scenario is unambiguous under subset
 * sums, repairing (deterministically, via the seeded rng) when it is not.
 *  - each planted batch total must have exactly ONE subset solution among all
 *    internal rows inside its date window;
 *  - each expected-unmatched settlement row must have NO subset solution.
 */
function validateAndRepair(
  rng: Rng,
  pool: AmountPool,
  internal: Entry[],
  batches: Batch[],
  unmatchedTargets: UnmatchedTarget[],
  expectations: Expectation[],
): void {
  const windowAmounts = (target: Entry): number[] =>
    internal
      .filter(
        (a) =>
          a.currency === target.currency &&
          a.minor > 0 &&
          Math.abs(a.day - target.day) <= BATCH_WINDOW,
      )
      .map((a) => a.minor);

  for (let pass = 0; pass < 60; pass++) {
    let dirty = false;

    for (const batch of batches) {
      const solutions = countSubsetsSumming(
        windowAmounts(batch.settlement),
        batch.settlement.minor,
        MAX_GROUP,
      );
      if (solutions < 1) {
        throw new Error(`planted batch ${batch.settlement.id} has no subset solution — generator bug`);
      }
      if (solutions > 1) {
        // Ambiguous: re-roll one component and recompute the sum.
        const victim = rng.pick(batch.components);
        pool.remove(victim.minor);
        pool.remove(batch.settlement.minor);
        victim.minor = pool.pick(rng);
        settleBatchSum(rng, pool, batch.settlement, batch.components);
        dirty = true;
      }
    }

    for (const target of unmatchedTargets) {
      const solutions = countSubsetsSumming(
        windowAmounts(target.entry),
        target.entry.minor,
        MAX_GROUP,
        1,
      );
      if (solutions === 0) continue;
      dirty = true;
      if (target.kind === 'mismatch') {
        pool.remove(target.entry.minor);
        target.entry.minor = pickMismatchAmount(rng, pool, target.partner!.minor);
        // Keep the planted expectations' deltas in sync.
        for (const exp of expectations) {
          if (exp.kind !== 'residual' || exp.amountDeltaMinor === undefined) continue;
          if (exp.id === target.entry.id) {
            exp.amountDeltaMinor = target.entry.minor - target.partner!.minor;
          } else if (exp.candidateId === target.entry.id) {
            exp.amountDeltaMinor = target.partner!.minor - target.entry.minor;
          }
        }
      } else if (target.kind === 'timing' || target.kind === 'trap') {
        // Amount is coupled to an internal partner row — re-roll both together.
        pool.remove(target.entry.minor);
        const fresh = pool.pick(rng);
        target.partner!.minor = fresh;
        target.entry.minor = fresh;
      } else {
        pool.remove(target.entry.minor);
        target.entry.minor = pool.pick(rng);
      }
    }

    if (!dirty) return;
  }
  throw new Error('scenario failed to stabilize after 60 repair passes');
}
