/**
 * Property-based tests: the credibility centerpiece.
 *
 * A seeded generator builds a random internal ledger and derives its
 * settlement counterpart through realistic corruptions (fees, date shifts,
 * batching, drops, duplicate refs, currency traps). Then, for every seed:
 *
 *   1. PARTITION      every input row appears in exactly one place in the
 *                     output (a match group or a residual) — no row matched
 *                     twice, no row lost.
 *   2. CONSERVATION   per match group, |internal total − settlement total| is
 *                     within the tolerance the receipt itself declares; the
 *                     summary's drift figures are recomputable from groups.
 *   3. RECEIPTS       every match names its rule and fields; date deltas
 *                     respect the rule's declared window; currencies never mix.
 *   4. BUCKETS        every planted corruption lands where planted: right
 *                     tier for matches, right category (and delta) for
 *                     residuals.
 *   5. DETERMINISM    same input => byte-identical output, and shuffled input
 *                     order => byte-identical output.
 *
 * Failures print the seed; re-run with the same seed to reproduce exactly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../src/engine.js';
import type { ReconResult, Txn } from '../src/types.js';
import { Rng, forAllSeeds, propertyRuns } from './harness.js';
import { SCENARIO_CONFIG, buildScenario, type Scenario } from './gen.js';

const RUNS = propertyRuns();
const FIRST_SEED = 1_000;

function run(scenario: Scenario): ReconResult {
  return reconcile(scenario.internal, scenario.settlement, SCENARIO_CONFIG);
}

function collectIds(result: ReconResult, side: 'internal' | 'settlement'): string[] {
  const fromMatches = result.matches.flatMap((m) =>
    side === 'internal' ? m.internalIds : m.settlementIds,
  );
  const fromResiduals = (
    side === 'internal' ? result.unmatchedInternal : result.unmatchedSettlement
  ).map((r) => r.id);
  return [...fromMatches, ...fromResiduals];
}

test('property: partition — every row lands in exactly one output slot', () => {
  forAllSeeds(RUNS, FIRST_SEED, (rng) => {
    const scenario = buildScenario(rng);
    const result = run(scenario);
    for (const side of ['internal', 'settlement'] as const) {
      const input = (side === 'internal' ? scenario.internal : scenario.settlement)
        .map((t) => t.id)
        .sort();
      const output = collectIds(result, side).sort();
      assert.deepEqual(
        output,
        input,
        `${side} side: output ids must be exactly the input ids, once each`,
      );
    }
  });
});

test('property: conservation — drift stays within each receipt\'s declared tolerance', () => {
  forAllSeeds(RUNS, FIRST_SEED, (rng) => {
    const scenario = buildScenario(rng);
    const result = run(scenario);
    let net = 0;
    let abs = 0;
    for (const m of result.matches) {
      const delta = m.internalTotalMinor - m.settlementTotalMinor;
      assert.equal(
        m.receipt.amountDeltaMinor,
        delta,
        `receipt delta must equal recomputed group delta (${m.receipt.rule})`,
      );
      const allowed = m.receipt.tolerance?.allowedDeltaMinor ?? 0;
      assert.ok(
        Math.abs(delta) <= allowed,
        `group ${m.internalIds.join('+')} drifted ${delta} but rule ${m.receipt.rule} allows ${allowed}`,
      );
      net += delta;
      abs += Math.abs(delta);
    }
    assert.equal(result.summary.driftNetMinor, net, 'summary net drift must be recomputable');
    assert.equal(result.summary.driftAbsMinor, abs, 'summary abs drift must be recomputable');
    const sumInternal = result.matches.reduce((s, m) => s + m.internalTotalMinor, 0);
    const sumSettlement = result.matches.reduce((s, m) => s + m.settlementTotalMinor, 0);
    assert.equal(result.summary.matchedInternalTotalMinor, sumInternal);
    assert.equal(result.summary.matchedSettlementTotalMinor, sumSettlement);
  });
});

test('property: receipts — every match is explainable and inside its rule\'s windows', () => {
  const dateWindow = SCENARIO_CONFIG.dateWindowDays!;
  const batchWindow = SCENARIO_CONFIG.manyToOne!.dateWindowDays!;
  forAllSeeds(RUNS, FIRST_SEED, (rng) => {
    const scenario = buildScenario(rng);
    const result = run(scenario);
    const currencyOf = new Map<string, string>();
    for (const t of [...scenario.internal, ...scenario.settlement]) {
      currencyOf.set(t.id, t.currency);
    }
    for (const m of result.matches) {
      assert.ok(m.receipt.fields.length > 0, 'receipt must name compared fields');
      assert.ok(m.receipt.notes.length > 0, 'receipt must carry evidence notes');
      const window = m.receipt.rule === 'many-to-one' ? batchWindow : dateWindow;
      assert.ok(
        Math.abs(m.receipt.dateDeltaDays) <= window,
        `${m.receipt.rule} date delta ${m.receipt.dateDeltaDays} exceeds window ${window}`,
      );
      if (m.receipt.rule === 'exact') {
        assert.equal(m.receipt.dateDeltaDays, 0, 'exact matches may not move dates');
        assert.equal(m.receipt.amountDeltaMinor, 0, 'exact matches may not move amounts');
      }
      if (m.receipt.rule === 'many-to-one') {
        assert.ok(m.internalIds.length >= 2, 'many-to-one groups need >= 2 internal rows');
        assert.equal(m.settlementIds.length, 1, 'many-to-one groups target one settlement row');
      } else {
        assert.equal(m.internalIds.length, 1);
        assert.equal(m.settlementIds.length, 1);
      }
      for (const id of [...m.internalIds, ...m.settlementIds]) {
        assert.equal(currencyOf.get(id), m.currency, 'a match group may not mix currencies');
      }
    }
  });
});

test('property: buckets — every planted corruption lands where it was planted', () => {
  forAllSeeds(RUNS, FIRST_SEED, (rng) => {
    const scenario = buildScenario(rng);
    const result = run(scenario);
    for (const exp of scenario.expectations) {
      if (exp.kind === 'match') {
        const group = result.matches.find((m) =>
          m.settlementIds.includes(exp.settlementIds[0]),
        );
        assert.ok(
          group,
          `expected ${exp.rule} match for settlement ${exp.settlementIds[0]}, found none`,
        );
        assert.equal(
          group.receipt.rule,
          exp.rule,
          `settlement ${exp.settlementIds[0]}: wrong ladder tier`,
        );
        assert.deepEqual([...group.internalIds].sort(), [...exp.internalIds].sort());
        assert.deepEqual([...group.settlementIds].sort(), [...exp.settlementIds].sort());
      } else {
        const residuals =
          exp.side === 'internal' ? result.unmatchedInternal : result.unmatchedSettlement;
        const residual = residuals.find((r) => r.id === exp.id);
        assert.ok(residual, `expected ${exp.side} residual for ${exp.id}, found none`);
        assert.equal(residual.category, exp.category, `${exp.id}: wrong residual category`);
        if (exp.candidateId !== undefined) {
          assert.ok(residual.candidate, `${exp.id}: amount-mismatch must carry a candidate`);
          assert.equal(residual.candidate.id, exp.candidateId);
          assert.equal(residual.candidate.amountDeltaMinor, exp.amountDeltaMinor);
        }
      }
    }
  });
});

test('property: determinism — same input, same bytes; shuffled input, same bytes', () => {
  forAllSeeds(RUNS, FIRST_SEED, (rng) => {
    const scenario = buildScenario(rng);
    const first = JSON.stringify(run(scenario));
    const second = JSON.stringify(run(scenario));
    assert.equal(first, second, 'two identical runs must serialize identically');

    const shuffler = new Rng(rng.seed ^ 0x5eed);
    const shuffled: Scenario = {
      internal: shuffler.shuffle(scenario.internal),
      settlement: shuffler.shuffle(scenario.settlement),
      expectations: scenario.expectations,
    };
    const third = JSON.stringify(run(shuffled));
    assert.equal(first, third, 'input array order must not affect the output');
  });
});

test('property: generator sanity — scenarios exercise the whole ladder across seeds', () => {
  // Not an engine invariant, a test-of-the-test: across the seed range, every
  // tier and residual category must actually get exercised.
  const rulesSeen = new Set<string>();
  const categoriesSeen = new Set<string>();
  forAllSeeds(RUNS, FIRST_SEED, (rng) => {
    const scenario = buildScenario(rng);
    for (const exp of scenario.expectations) {
      if (exp.kind === 'match') rulesSeen.add(exp.rule);
      else categoriesSeen.add(exp.category);
    }
  });
  for (const rule of ['exact', 'reference-fuzzy', 'amount-date-window', 'amount-tolerance', 'many-to-one']) {
    assert.ok(rulesSeen.has(rule), `no scenario exercised tier "${rule}"`);
  }
  for (const cat of ['missing-in-settlement', 'missing-in-internal', 'amount-mismatch']) {
    assert.ok(categoriesSeen.has(cat), `no scenario exercised residual "${cat}"`);
  }
});

test('property: idempotent re-reconciliation of matched output is stable', () => {
  // Feeding back only the unmatched rows must reproduce exactly the same
  // residual categorization — reconciliation of residue is a fixpoint.
  forAllSeeds(Math.min(RUNS, 15), FIRST_SEED, (rng) => {
    const scenario = buildScenario(rng);
    const result = run(scenario);
    const unmatchedInternalIds = new Set(result.unmatchedInternal.map((r) => r.id));
    const unmatchedSettlementIds = new Set(result.unmatchedSettlement.map((r) => r.id));
    const residueA: Txn[] = scenario.internal.filter((t) => unmatchedInternalIds.has(t.id));
    const residueB: Txn[] = scenario.settlement.filter((t) => unmatchedSettlementIds.has(t.id));
    const again = reconcile(residueA, residueB, SCENARIO_CONFIG);
    assert.equal(again.matches.length, 0, 'residue must not re-match against itself');
    assert.deepEqual(
      again.unmatchedInternal.map((r) => [r.id, r.category]),
      result.unmatchedInternal.map((r) => [r.id, r.category]),
    );
    assert.deepEqual(
      again.unmatchedSettlement.map((r) => [r.id, r.category]),
      result.unmatchedSettlement.map((r) => [r.id, r.category]),
    );
  });
});
