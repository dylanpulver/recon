/**
 * Unit tests for each ladder tier, residual categorization, and the engine's
 * guardrails. Small handwritten fixtures — the property suite covers breadth,
 * these pin the exact semantics of every rule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../src/engine.js';
import type { ReconConfig, Txn } from '../src/types.js';

const t = (partial: Partial<Txn> & { id: string; amount: number | string }): Txn => ({
  date: '2026-03-10',
  currency: 'USD',
  ...partial,
});

test('tier 1 exact: amount + date + verbatim reference', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '10.00', reference: 'ORD-1' })],
    [t({ id: 'b1', amount: '10.00', reference: 'ORD-1' })],
  );
  assert.equal(result.matches.length, 1);
  const m = result.matches[0];
  assert.equal(m.receipt.rule, 'exact');
  assert.deepEqual(m.internalIds, ['a1']);
  assert.deepEqual(m.settlementIds, ['b1']);
  assert.equal(m.receipt.amountDeltaMinor, 0);
  assert.equal(m.receipt.dateDeltaDays, 0);
  assert.deepEqual(m.receipt.fields, ['currency', 'amount', 'date', 'reference']);
});

test('tier 1 exact: requires a reference on both sides — blank is not identity', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '10.00' })],
    [t({ id: 'b1', amount: '10.00' })],
  );
  // Still matches — but via tier 3 (amount + date window), not exact.
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].receipt.rule, 'amount-date-window');
});

test('tier 1 exact: reference is case-sensitive; case noise drops to fuzzy', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '10.00', reference: 'ORD-1' })],
    [t({ id: 'b1', amount: '10.00', reference: 'ord-1' })],
  );
  assert.equal(result.matches[0].receipt.rule, 'reference-fuzzy');
});

test('tier 2 fuzzy: prefix/case/whitespace/zero-padding noise, with receipt evidence', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '10.00', reference: '00042' })],
    [t({ id: 'b1', amount: '10.00', date: '2026-03-12', reference: 'REF 42' })],
  );
  assert.equal(result.matches.length, 1);
  const m = result.matches[0];
  assert.equal(m.receipt.rule, 'reference-fuzzy');
  assert.equal(m.receipt.dateDeltaDays, -2);
  assert.ok(m.receipt.normalization);
  assert.equal(m.receipt.normalization.normalized, '42');
  assert.equal(m.receipt.normalization.internalRaw, '00042');
  assert.equal(m.receipt.normalization.settlementRaw, 'REF 42');
  assert.ok(m.receipt.normalization.steps.includes('strip-prefix:REF'));
  assert.ok(m.receipt.normalization.steps.includes('strip-leading-zeros'));
});

test('tier 2 fuzzy: same normalized ref but amounts differ — no fuzzy match', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '10.00', reference: 'ORD-9' })],
    [t({ id: 'b1', amount: '99.00', reference: 'ord 9' })],
  );
  assert.equal(result.matches.length, 0);
  assert.equal(result.unmatchedInternal[0].category, 'amount-mismatch');
});

test('tier 2 fuzzy: respects the date window', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '10.00', reference: 'ORD-9' })],
    [t({ id: 'b1', amount: '10.00', date: '2026-03-20', reference: 'ord 9' })],
    { dateWindowDays: 3 },
  );
  assert.equal(result.matches.length, 0);
});

test('tier 3 window: T+2 settlement without references', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '25.00' })],
    [t({ id: 'b1', amount: '25.00', date: '2026-03-12' })],
  );
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].receipt.rule, 'amount-date-window');
  assert.equal(result.matches[0].receipt.dateDeltaDays, -2);
});

test('tier 3 window: outside the window means no match', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '25.00' })],
    [t({ id: 'b1', amount: '25.00', date: '2026-03-14' })],
    { dateWindowDays: 3 },
  );
  assert.equal(result.matches.length, 0);
});

test('tier 3 window: ambiguity resolves to the closest date, deterministically', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '25.00' })],
    [
      t({ id: 'b-far', amount: '25.00', date: '2026-03-13' }),
      t({ id: 'b-near', amount: '25.00', date: '2026-03-11' }),
    ],
  );
  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.matches[0].settlementIds, ['b-near']);
});

test('tier 4 tolerance: fee drift within bps, receipt shows consumption', () => {
  // 250.00 vs 249.10 = 90 minor units on 24910 = ~36bps, allowed 125 (50bps of 25000).
  const result = reconcile(
    [t({ id: 'a1', amount: '250.00', reference: 'INV-1' })],
    [t({ id: 'b1', amount: '249.10', reference: 'INV-1' })],
  );
  assert.equal(result.matches.length, 1);
  const m = result.matches[0];
  assert.equal(m.receipt.rule, 'amount-tolerance');
  assert.equal(m.receipt.amountDeltaMinor, 90);
  assert.ok(m.receipt.tolerance);
  assert.equal(m.receipt.tolerance.amountDeltaMinor, 90);
  assert.equal(m.receipt.tolerance.allowedDeltaMinor, 125);
  assert.equal(m.receipt.tolerance.consumedBps, 36);
});

test('tier 4 tolerance: drift beyond bps does not match', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '250.00' })],
    [t({ id: 'b1', amount: '248.00' })], // 200 minor > 125 allowed
  );
  assert.equal(result.matches.length, 0);
});

test('tier 4 tolerance: absolute floor rescues tiny amounts', () => {
  // 1.00 vs 0.98: 2 minor units, but 50bps of 100 floors to 0 without a floor.
  const without = reconcile([t({ id: 'a1', amount: '1.00' })], [t({ id: 'b1', amount: '0.98' })]);
  assert.equal(without.matches.length, 0);
  const withFloor = reconcile(
    [t({ id: 'a1', amount: '1.00' })],
    [t({ id: 'b1', amount: '0.98' })],
    { amountToleranceMinMinor: 2 },
  );
  assert.equal(withFloor.matches.length, 1);
  assert.equal(withFloor.matches[0].receipt.rule, 'amount-tolerance');
});

test('tier 4 tolerance: picks the smallest delta among candidates', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '250.00' })],
    [
      t({ id: 'b-far', amount: '249.00' }),
      t({ id: 'b-near', amount: '249.90' }),
    ],
  );
  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.matches[0].settlementIds, ['b-near']);
});

test('tier 5 many-to-one: batched payout, exact sum', () => {
  const result = reconcile(
    [
      t({ id: 'a1', amount: '12.75', date: '2026-03-08' }),
      t({ id: 'a2', amount: '9.50', date: '2026-03-09' }),
      t({ id: 'a3', amount: '21.25', date: '2026-03-09' }),
    ],
    [t({ id: 'b1', amount: '43.50', reference: 'PAYOUT-1' })],
  );
  assert.equal(result.matches.length, 1);
  const m = result.matches[0];
  assert.equal(m.receipt.rule, 'many-to-one');
  assert.deepEqual([...m.internalIds].sort(), ['a1', 'a2', 'a3']);
  assert.equal(m.internalTotalMinor, 4350);
  assert.equal(m.receipt.amountDeltaMinor, 0);
});

test('tier 5 many-to-one: no phantom subsets — near-miss sums stay unmatched', () => {
  const result = reconcile(
    [
      t({ id: 'a1', amount: '12.75' }),
      t({ id: 'a2', amount: '9.50' }),
    ],
    [t({ id: 'b1', amount: '22.26' })], // components sum to 22.25
  );
  assert.equal(result.matches.length, 0);
});

test('tier 5 many-to-one: group size is bounded by maxGroupSize', () => {
  const internal = [
    t({ id: 'a1', amount: '10.00' }),
    t({ id: 'a2', amount: '11.00' }),
    t({ id: 'a3', amount: '12.00' }),
  ];
  const settlement = [t({ id: 'b1', amount: '33.00' })];
  const config: ReconConfig = { manyToOne: { maxGroupSize: 2 } };
  const result = reconcile(internal, settlement, config);
  assert.equal(result.matches.length, 0, 'a 3-row group must not form when the cap is 2');
});

test('tier 5 many-to-one: respects the batch date window', () => {
  const result = reconcile(
    [
      t({ id: 'a1', amount: '10.00', date: '2026-03-01' }),
      t({ id: 'a2', amount: '11.00', date: '2026-03-01' }),
    ],
    [t({ id: 'b1', amount: '21.00', date: '2026-03-12' })],
    { manyToOne: { dateWindowDays: 7 } },
  );
  assert.equal(result.matches.length, 0);
});

test('tier 5 many-to-one: disabled by config', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '10.00' }), t({ id: 'a2', amount: '11.00' })],
    [t({ id: 'b1', amount: '21.00' })],
    { manyToOne: { enabled: false } },
  );
  assert.equal(result.matches.length, 0);
});

test('tier 5 many-to-one: refunds (non-positive rows) are never batch components', () => {
  const result = reconcile(
    [
      t({ id: 'a1', amount: '30.00' }),
      t({ id: 'a-refund', amount: '-9.00' }),
    ],
    [t({ id: 'b1', amount: '21.00' })],
  );
  assert.equal(result.matches.length, 0);
});

test('tier 5 many-to-one: optional bps tolerance on the batch sum', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '100.00' }), t({ id: 'a2', amount: '150.00' })],
    [t({ id: 'b1', amount: '249.90' })], // 10 minor short of 250.00 (4bps)
    { manyToOne: { toleranceBps: 10 } },
  );
  assert.equal(result.matches.length, 1);
  const m = result.matches[0];
  assert.equal(m.receipt.rule, 'many-to-one');
  assert.equal(m.receipt.amountDeltaMinor, 10);
  assert.ok(m.receipt.tolerance);
  assert.equal(m.receipt.tolerance.allowedDeltaMinor, 24);
});

test('ladder order: an exact match is never stolen by a lower tier', () => {
  // b-exact matches a1 exactly; b-drift is within tolerance of a1 too.
  // The exact rung must win; b-drift stays unmatched.
  const result = reconcile(
    [t({ id: 'a1', amount: '100.00', reference: 'ORD-7' })],
    [
      t({ id: 'b-drift', amount: '99.80' }),
      t({ id: 'b-exact', amount: '100.00', reference: 'ORD-7' }),
    ],
  );
  const exact = result.matches.find((m) => m.internalIds.includes('a1'));
  assert.ok(exact);
  assert.equal(exact.receipt.rule, 'exact');
  assert.deepEqual(exact.settlementIds, ['b-exact']);
});

test('currencies never cross: identical amount/date/ref in EUR vs USD stays unmatched', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '10.00', currency: 'EUR', reference: 'X-1' })],
    [t({ id: 'b1', amount: '10.00', currency: 'USD', reference: 'X-1' })],
  );
  assert.equal(result.matches.length, 0);
  assert.equal(result.unmatchedInternal[0].category, 'missing-in-settlement');
  assert.equal(result.unmatchedSettlement[0].category, 'missing-in-internal');
});

test('residuals: amount-mismatch carries candidate id, shared ref, and signed delta', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '64.00', reference: 'ORD-18' })],
    [t({ id: 'b1', amount: '58.00', reference: 'ord 18' })],
  );
  assert.equal(result.matches.length, 0);
  const ra = result.unmatchedInternal[0];
  assert.equal(ra.category, 'amount-mismatch');
  assert.ok(ra.candidate);
  assert.equal(ra.candidate.id, 'b1');
  assert.equal(ra.candidate.amountDeltaMinor, 600);
  assert.equal(ra.candidate.sharedReference, 'ORD18');
  const rb = result.unmatchedSettlement[0];
  assert.equal(rb.category, 'amount-mismatch');
  assert.equal(rb.candidate?.id, 'a1');
  assert.equal(rb.candidate?.amountDeltaMinor, -600);
});

test('residuals: equal amounts with shared ref beyond the window stay missing-in-*', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '40.00', reference: 'ORD-5' })],
    [t({ id: 'b1', amount: '40.00', date: '2026-03-25', reference: 'ORD-5' })],
  );
  assert.equal(result.matches.length, 0);
  assert.equal(result.unmatchedInternal[0].category, 'missing-in-settlement');
  assert.equal(result.unmatchedSettlement[0].category, 'missing-in-internal');
});

test('summary: rates, counts, and totals', () => {
  const result = reconcile(
    [
      t({ id: 'a1', amount: '10.00', reference: 'R1' }),
      t({ id: 'a2', amount: '55.00' }),
    ],
    [t({ id: 'b1', amount: '10.00', reference: 'R1' })],
  );
  const s = result.summary;
  assert.equal(s.internalRows, 2);
  assert.equal(s.settlementRows, 1);
  assert.equal(s.matchGroups, 1);
  assert.equal(s.byRule['exact'], 1);
  assert.equal(s.matchRateInternal, 0.5);
  assert.equal(s.matchRateSettlement, 1);
  assert.equal(s.matchedInternalTotalMinor, 1000);
  assert.equal(s.unmatchedInternalTotalMinor, 5500);
  assert.equal(s.driftNetMinor, 0);
});

test('guardrails: duplicate ids on one side are an error', () => {
  assert.throws(
    () => reconcile([t({ id: 'a1', amount: '1.00' }), t({ id: 'a1', amount: '2.00' })], []),
    /duplicate id "a1"/,
  );
});

test('guardrails: invalid dates and malformed amounts are errors, not guesses', () => {
  assert.throws(() => reconcile([t({ id: 'a1', amount: '1.00', date: '2026-02-30' })], []), /impossible calendar date/);
  assert.throws(() => reconcile([t({ id: 'a1', amount: '1,000.00' })], []), /unparseable amount/);
  assert.throws(() => reconcile([t({ id: 'a1', amount: '1.005' })], []), /fractional digits/);
});

test('guardrails: config validation rejects nonsense', () => {
  assert.throws(() => reconcile([], [], { dateWindowDays: -1 }), /non-negative integer/);
  assert.throws(() => reconcile([], [], { manyToOne: { maxGroupSize: 1 } }), /maxGroupSize/);
});

test('negative amounts (refunds) still reconcile one-to-one', () => {
  const result = reconcile(
    [t({ id: 'a1', amount: '-15.00', reference: 'RFND-1' })],
    [t({ id: 'b1', amount: '-15.00', reference: 'RFND-1' })],
  );
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].receipt.rule, 'exact');
});
