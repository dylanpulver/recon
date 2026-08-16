#!/usr/bin/env node
/**
 * recon CLI.
 *
 *   recon <internal-file> <settlement-file> [--config recon.json] [--json]
 *
 * File formats by extension: .csv (header row), .jsonl (one object per line),
 * .json (array of objects).
 *
 * Exit codes:
 *   0 — everything matched
 *   1 — reconciliation ran, unmatched rows remain (useful in CI/cron)
 *   2 — bad usage or input error
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { reconcile } from './engine.js';
import { parseCSVTxns, parseJSONLTxns } from './parse.js';
import { renderReport } from './report.js';
import type { ReconConfig, Txn } from './types.js';

const USAGE = `usage: recon <internal-file> <settlement-file> [--config recon.json] [--json]

  <internal-file>    your ledger (side A): .csv, .jsonl, or .json
  <settlement-file>  the processor/bank file (side B): .csv, .jsonl, or .json
  --config <file>    JSON file with matching configuration
  --json             emit the full machine-readable result instead of the report

exit codes: 0 fully matched, 1 unmatched rows remain, 2 error`;

function loadTxns(path: string): Txn[] {
  const text = readFileSync(path, 'utf8');
  const ext = extname(path).toLowerCase();
  if (ext === '.csv') return parseCSVTxns(text);
  if (ext === '.jsonl' || ext === '.ndjson') return parseJSONLTxns(text);
  if (ext === '.json') {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(`${path}: expected a JSON array of transactions`);
    return parsed as Txn[];
  }
  throw new Error(`${path}: unsupported extension "${ext}" (use .csv, .jsonl, or .json)`);
}

export function main(argv: string[]): number {
  const positional: string[] = [];
  let configPath: string | undefined;
  let asJson = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      asJson = true;
    } else if (arg === '--config') {
      configPath = argv[++i];
      if (configPath === undefined) {
        process.stderr.write('error: --config requires a file path\n');
        return 2;
      }
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE + '\n');
      return 0;
    } else if (arg.startsWith('-')) {
      process.stderr.write(`error: unknown flag "${arg}"\n${USAGE}\n`);
      return 2;
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 2) {
    process.stderr.write(USAGE + '\n');
    return 2;
  }

  try {
    const internal = loadTxns(positional[0]);
    const settlement = loadTxns(positional[1]);
    const config: ReconConfig = configPath
      ? (JSON.parse(readFileSync(configPath, 'utf8')) as ReconConfig)
      : {};
    const result = reconcile(internal, settlement, config);
    if (asJson) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(renderReport(result) + '\n');
    }
    const clean =
      result.unmatchedInternal.length === 0 && result.unmatchedSettlement.length === 0;
    return clean ? 0 : 1;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
