/**
 * CLI integration tests: run the built CLI against the shipped examples and
 * assert on the real stdout/exit codes — the same output the README shows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // dist/test at runtime
const cliPath = join(here, '..', 'src', 'cli.js');
const repoRoot = join(here, '..', '..');
const example = (name: string) => join(repoRoot, 'examples', name);

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

test('cli: examples produce the full ladder report, exit code 1 (unmatched remain)', () => {
  const { status, stdout } = runCli([
    example('internal.csv'),
    example('settlement.csv'),
    '--config',
    example('recon.json'),
  ]);
  assert.equal(status, 1);
  assert.match(stdout, /\[exact\] LC-1001 <-> STL-9001/);
  assert.match(stdout, /\[reference-fuzzy\] LC-1002 <-> STL-9002/);
  assert.match(stdout, /\[amount-date-window\] LC-1003 <-> STL-9003/);
  assert.match(stdout, /\[amount-tolerance\] LC-1004 <-> STL-9004/);
  assert.match(stdout, /\[many-to-one\] LC-1005 \+ LC-1006 \+ LC-1007 <-> STL-9005/);
  assert.match(stdout, /\[amount-mismatch\] LC-1008/);
  assert.match(stdout, /suspect counterpart: STL-9006/);
  assert.match(stdout, /\[missing-in-settlement\] LC-1009/);
  assert.match(stdout, /\[missing-in-internal\] STL-9007/);
});

test('cli: --json emits the machine-readable result with receipts', () => {
  const { status, stdout } = runCli([
    example('internal.csv'),
    example('settlement.csv'),
    '--config',
    example('recon.json'),
    '--json',
  ]);
  assert.equal(status, 1);
  const result = JSON.parse(stdout);
  assert.equal(result.summary.internalRows, 9);
  assert.equal(result.summary.settlementRows, 7);
  assert.equal(result.summary.matchGroups, 5);
  assert.equal(result.summary.byRule['many-to-one'], 1);
  const fee = result.matches.find(
    (m: { receipt: { rule: string } }) => m.receipt.rule === 'amount-tolerance',
  );
  assert.equal(fee.receipt.tolerance.amountDeltaMinor, 90);
  assert.equal(fee.receipt.tolerance.consumedBps, 36);
});

test('cli: fully-matched inputs exit 0', () => {
  const { status, stdout } = runCli([example('internal.csv'), example('internal.csv')]);
  assert.equal(status, 0);
  assert.match(stdout, /match rate: internal 100\.00%/);
});

test('cli: bad usage exits 2 with usage text', () => {
  const one = runCli([example('internal.csv')]);
  assert.equal(one.status, 2);
  assert.match(one.stderr, /usage: recon/);
  const flag = runCli([example('internal.csv'), example('settlement.csv'), '--bogus']);
  assert.equal(flag.status, 2);
  assert.match(flag.stderr, /unknown flag/);
});

test('cli: missing file and bad extension are clean errors, exit 2', () => {
  const missing = runCli([example('nope.csv'), example('settlement.csv')]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^error: /);
  const badExt = runCli([example('recon.json').replace('recon.json', '../README.md'), example('settlement.csv')]);
  assert.equal(badExt.status, 2);
});

test('cli: --help exits 0', () => {
  const { status, stdout } = runCli(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /exit codes/);
});
