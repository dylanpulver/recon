/**
 * Input parsing: CSV (RFC 4180 subset) and JSONL, both to Txn[].
 * Zero dependencies — the CSV parser handles quoted fields, embedded commas,
 * escaped quotes, and CRLF/LF line endings, which covers every settlement
 * file format worth supporting without a dependency tree.
 */

import type { Txn } from './types.js';

/** Parse CSV text into rows of string cells. */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let sawAny = false;

  const pushCell = () => {
    row.push(cell);
    cell = '';
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    sawAny = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushCell();
    } else if (ch === '\n') {
      pushRow();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      pushRow();
    } else {
      cell += ch;
    }
  }
  if (inQuotes) throw new Error('malformed CSV: unterminated quoted field');
  if (cell.length > 0 || row.length > 0) pushRow();
  if (!sawAny) return [];
  // Drop fully-empty trailing rows (files ending in a newline).
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return rows;
}

const KNOWN_COLUMNS = new Set(['id', 'date', 'amount', 'currency', 'reference', 'counterparty']);
const REQUIRED_COLUMNS = ['id', 'date', 'amount', 'currency'] as const;

/**
 * Parse CSV text with a header row into transactions.
 * Required columns: id, date, amount, currency.
 * Optional: reference, counterparty. Any other column lands in metadata.
 */
export function parseCSVTxns(text: string): Txn[] {
  const rows = parseCSV(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  for (const col of REQUIRED_COLUMNS) {
    if (!header.includes(col)) {
      throw new Error(`CSV is missing required column "${col}" (header: ${header.join(', ')})`);
    }
  }
  const txns: Txn[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length !== header.length) {
      throw new Error(
        `CSV row ${r + 1} has ${cells.length} cells, header has ${header.length}`,
      );
    }
    const record: Record<string, string> = {};
    header.forEach((name, c) => {
      record[name] = cells[c];
    });
    const txn: Txn = {
      id: record.id.trim(),
      date: record.date.trim(),
      amount: record.amount.trim(),
      currency: record.currency.trim(),
    };
    if (record.reference !== undefined && record.reference.trim() !== '') {
      txn.reference = record.reference;
    }
    if (record.counterparty !== undefined && record.counterparty.trim() !== '') {
      txn.counterparty = record.counterparty.trim();
    }
    const metadata: Record<string, string> = {};
    let hasMetadata = false;
    for (const name of header) {
      if (!KNOWN_COLUMNS.has(name)) {
        metadata[name] = record[name];
        hasMetadata = true;
      }
    }
    if (hasMetadata) txn.metadata = metadata;
    txns.push(txn);
  }
  return txns;
}

/** Parse JSONL text (one JSON object per non-empty line) into transactions. */
export function parseJSONLTxns(text: string): Txn[] {
  const txns: Txn[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new Error(`JSONL line ${i + 1} is not valid JSON: ${(err as Error).message}`);
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      throw new Error(`JSONL line ${i + 1} is not an object`);
    }
    txns.push(obj as Txn);
  }
  return txns;
}
