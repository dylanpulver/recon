/**
 * Unit tests for the supporting modules: money, dates, reference
 * normalization, CSV/JSONL parsing, subset-sum, and the report renderer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmountToMinor, formatMinor } from '../src/money.js';
import { parseISODate, epochDayToISO } from '../src/dates.js';
import { normalizeReference } from '../src/normalize.js';
import { parseCSV, parseCSVTxns, parseJSONLTxns } from '../src/parse.js';
import { boundedSubsetSum } from '../src/subset-sum.js';
import { renderReport } from '../src/report.js';
import { reconcile } from '../src/engine.js';

/* --------------------------------- money ---------------------------------- */

test('money: parses strings and numbers to minor units', () => {
  assert.equal(parseAmountToMinor('42.50', 2), 4250);
  assert.equal(parseAmountToMinor('42.5', 2), 4250);
  assert.equal(parseAmountToMinor('42', 2), 4200);
  assert.equal(parseAmountToMinor('-0.01', 2), -1);
  assert.equal(parseAmountToMinor('+3.10', 2), 310);
  assert.equal(parseAmountToMinor(42.5, 2), 4250);
  assert.equal(parseAmountToMinor(0.1, 2), 10);
  assert.equal(parseAmountToMinor('1234', 0), 1234);
  assert.equal(parseAmountToMinor('0.12345678', 8), 12345678);
});

test('money: rejects ambiguity instead of guessing', () => {
  assert.throws(() => parseAmountToMinor('1,000.00', 2), /unparseable/);
  assert.throws(() => parseAmountToMinor('$10.00', 2), /unparseable/);
  assert.throws(() => parseAmountToMinor('10.005', 2), /fractional digits/);
  assert.throws(() => parseAmountToMinor('', 2), /unparseable/);
  assert.throws(() => parseAmountToMinor(NaN, 2), /not finite/);
  assert.throws(() => parseAmountToMinor(Infinity, 2), /not finite/);
});

test('money: formats minor units back to decimal strings', () => {
  assert.equal(formatMinor(4250, 2), '42.50');
  assert.equal(formatMinor(-1, 2), '-0.01');
  assert.equal(formatMinor(0, 2), '0.00');
  assert.equal(formatMinor(1234, 0), '1234');
  assert.equal(formatMinor(105, 2), '1.05');
});

test('money: round-trips are lossless', () => {
  for (const text of ['0.00', '0.01', '99999999.99', '-42.50', '7.07']) {
    assert.equal(formatMinor(parseAmountToMinor(text, 2), 2), text);
  }
});

/* --------------------------------- dates ---------------------------------- */

test('dates: parse/format round-trip, day arithmetic is subtraction', () => {
  const a = parseISODate('2026-03-01');
  const b = parseISODate('2026-03-04');
  assert.equal(b - a, 3);
  assert.equal(epochDayToISO(a), '2026-03-01');
  assert.equal(parseISODate('2026-03-01') - parseISODate('2026-02-28'), 1);
  assert.equal(parseISODate('2024-03-01') - parseISODate('2024-02-28'), 2); // leap year
});

test('dates: strict parsing', () => {
  assert.throws(() => parseISODate('03/01/2026'), /unparseable date/);
  assert.throws(() => parseISODate('2026-3-1'), /unparseable date/);
  assert.throws(() => parseISODate('2026-02-30'), /impossible calendar date/);
  assert.throws(() => parseISODate('2026-13-01'), /impossible calendar date/);
});

/* ------------------------------- normalize --------------------------------- */

test('normalize: case, whitespace, separators, prefixes, zero-padding', () => {
  assert.equal(normalizeReference('ORD-1042').value, 'ORD1042');
  assert.equal(normalizeReference('  ord 1042  ').value, 'ORD1042');
  assert.equal(normalizeReference('REF-ORD-1042').value, 'ORD1042');
  assert.equal(normalizeReference('payment txn 00042').value, '42');
  assert.equal(normalizeReference('TRX_ABC').value, 'ABC');
  assert.equal(normalizeReference('00042').value, '42');
});

test('normalize: never strips a prefix down to nothing', () => {
  assert.equal(normalizeReference('REF').value, 'REF');
  assert.equal(normalizeReference('TXN').value, 'TXN');
});

test('normalize: records the steps that fired', () => {
  const n = normalizeReference('  ref ord-0042 ');
  assert.equal(n.value, 'ORD0042'); // leading zeros only stripped on all-digit refs
  assert.deepEqual(n.steps, ['trim', 'uppercase', 'strip-separators', 'strip-prefix:REF']);
});

/* ---------------------------------- CSV ------------------------------------ */

test('csv: quoted fields, embedded commas and quotes, CRLF', () => {
  const rows = parseCSV('a,b,c\r\n"1,5","say ""hi""",plain\r\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['1,5', 'say "hi"', 'plain'],
  ]);
});

test('csv: unterminated quote is an error', () => {
  assert.throws(() => parseCSV('a,b\n"oops,1'), /unterminated/);
});

test('csv txns: required columns, optional columns, metadata passthrough', () => {
  const txns = parseCSVTxns(
    [
      'id,date,amount,currency,reference,counterparty,channel',
      'T-1,2026-03-02,42.50,USD,ORD-1,Larkspur Coffee,pos',
      'T-2,2026-03-03,9.99,USD,,,web',
    ].join('\n'),
  );
  assert.equal(txns.length, 2);
  assert.deepEqual(txns[0], {
    id: 'T-1',
    date: '2026-03-02',
    amount: '42.50',
    currency: 'USD',
    reference: 'ORD-1',
    counterparty: 'Larkspur Coffee',
    metadata: { channel: 'pos' },
  });
  assert.equal(txns[1].reference, undefined);
  assert.equal(txns[1].metadata?.channel, 'web');
});

test('csv txns: missing required column is an error', () => {
  assert.throws(() => parseCSVTxns('id,date,amount\nT-1,2026-03-02,1.00'), /required column "currency"/);
});

test('csv txns: ragged rows are an error', () => {
  assert.throws(
    () => parseCSVTxns('id,date,amount,currency\nT-1,2026-03-02,1.00'),
    /row 2 has 3 cells/,
  );
});

/* --------------------------------- JSONL ----------------------------------- */

test('jsonl: one object per line, blank lines skipped', () => {
  const txns = parseJSONLTxns(
    '{"id":"T-1","date":"2026-03-02","amount":"1.00","currency":"USD"}\n\n{"id":"T-2","date":"2026-03-03","amount":2.5,"currency":"USD"}\n',
  );
  assert.equal(txns.length, 2);
  assert.equal(txns[1].amount, 2.5);
});

test('jsonl: bad lines are errors with line numbers', () => {
  assert.throws(() => parseJSONLTxns('{"id":"a"}\nnot json'), /line 2/);
  assert.throws(() => parseJSONLTxns('[1,2,3]'), /not an object/);
});

/* ------------------------------- subset-sum -------------------------------- */

test('subset-sum: finds an exact bounded subset, deterministic indices', () => {
  const outcome = boundedSubsetSum([1275, 950, 2125, 4000], 4350, {
    maxSize: 6,
    tolerance: 0,
    maxNodes: 10_000,
  });
  assert.deepEqual(outcome.indices, [0, 1, 2]);
  assert.equal(outcome.exhausted, false);
});

test('subset-sum: honors maxSize and tolerance', () => {
  const none = boundedSubsetSum([10, 11, 12], 33, { maxSize: 2, tolerance: 0, maxNodes: 1000 });
  assert.equal(none.indices, null);
  const close = boundedSubsetSum([10, 11], 22, { maxSize: 2, tolerance: 1, maxNodes: 1000 });
  assert.deepEqual(close.indices, [0, 1]);
});

test('subset-sum: single rows never count as a "group"', () => {
  const outcome = boundedSubsetSum([4350], 4350, { maxSize: 6, tolerance: 0, maxNodes: 1000 });
  assert.equal(outcome.indices, null);
});

test('subset-sum: reports node-budget exhaustion instead of hanging', () => {
  // All-even values, odd target: unreachable by parity, but the bounds can't
  // prove it — the search has to grind, and must stop at the node budget.
  const values = Array.from({ length: 40 }, (_, i) => 1000 + 2 * i);
  const outcome = boundedSubsetSum(values, 10_001, { maxSize: 6, tolerance: 0, maxNodes: 50 });
  assert.equal(outcome.indices, null);
  assert.equal(outcome.exhausted, true);
});

test('subset-sum: rejects non-positive values', () => {
  assert.throws(
    () => boundedSubsetSum([10, -5], 5, { maxSize: 2, tolerance: 0, maxNodes: 100 }),
    /positive values/,
  );
});

/* --------------------------------- report ---------------------------------- */

test('report: renders rules, receipts, residuals, and summary', () => {
  const result = reconcile(
    [
      { id: 'a1', date: '2026-03-02', amount: '42.50', currency: 'USD', reference: 'ORD-1' },
      { id: 'a2', date: '2026-03-02', amount: '18.00', currency: 'USD', reference: 'ORD-2' },
    ],
    [
      { id: 'b1', date: '2026-03-02', amount: '42.50', currency: 'USD', reference: 'ORD-1' },
      { id: 'b2', date: '2026-03-02', amount: '11.00', currency: 'USD', reference: 'ord 2' },
    ],
  );
  const text = renderReport(result);
  assert.match(text, /RECONCILIATION REPORT/);
  assert.match(text, /\[exact\] a1 <-> b1 \| 42\.50 USD/);
  assert.match(text, /\[amount-mismatch\] a2 .* ref "ORD-2"/);
  assert.match(text, /suspect counterpart: b2 via shared ref "ORD2", amount delta \+7\.00/);
  assert.match(text, /match rate: internal 50\.00%/);
  assert.match(text, /UNMATCHED SETTLEMENT — 1 row\(s\)/);
});
