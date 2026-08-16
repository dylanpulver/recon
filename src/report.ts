/**
 * Human-readable terminal report. Plain ASCII, no color codes — it should
 * paste cleanly into a ticket, an email, or a month-end close doc.
 */

import type { MatchGroup, ReconResult, Residual } from './types.js';
import { formatMinor } from './money.js';

function money(minor: number, currency: string, decimals: number): string {
  return `${formatMinor(minor, decimals)} ${currency}`;
}

function signed(minor: number, decimals: number): string {
  const text = formatMinor(minor, decimals);
  return minor > 0 ? `+${text}` : text;
}

function describeMatch(m: MatchGroup, decimals: number): string[] {
  const r = m.receipt;
  const left = m.internalIds.join(' + ');
  const right = m.settlementIds.join(' + ');
  const head = `[${r.rule}] ${left} <-> ${right} | ${money(m.settlementTotalMinor, m.currency, decimals)}`;
  const lines = [head];
  lines.push(`    fields: ${r.fields.join(', ')}`);
  if (r.dateDeltaDays !== 0) lines.push(`    date delta: ${r.dateDeltaDays} day(s)`);
  if (r.tolerance) {
    lines.push(
      `    tolerance consumed: ${signed(r.tolerance.amountDeltaMinor, decimals)} of ±${formatMinor(r.tolerance.allowedDeltaMinor, decimals)} allowed (${r.tolerance.consumedBps}bps)`,
    );
  }
  if (r.normalization) {
    lines.push(
      `    normalized: "${r.normalization.internalRaw}" / "${r.normalization.settlementRaw}" -> "${r.normalization.normalized}"`,
    );
  }
  for (const note of r.notes) lines.push(`    note: ${note}`);
  return lines;
}

function describeResidual(res: Residual, decimals: number): string[] {
  const head = `[${res.category}] ${res.id} | ${money(res.amountMinor, res.currency, decimals)} | ${res.date}${res.reference ? ` | ref "${res.reference}"` : ''}`;
  const lines = [head];
  if (res.candidate) {
    lines.push(
      `    suspect counterpart: ${res.candidate.id} via shared ref "${res.candidate.sharedReference}", amount delta ${signed(res.candidate.amountDeltaMinor, decimals)}`,
    );
  }
  return lines;
}

export function renderReport(result: ReconResult): string {
  const d = result.config.decimals;
  const s = result.summary;
  const out: string[] = [];
  const rule = (n: number) => String(n).padStart(3);

  out.push('RECONCILIATION REPORT');
  out.push('=====================');
  out.push(
    `internal rows: ${s.internalRows} | settlement rows: ${s.settlementRows} | currencies: ${s.currencies.join(', ') || '(none)'}`,
  );
  out.push('');
  out.push(`MATCHED — ${s.matchGroups} group(s)`);
  out.push(
    `  exact ${rule(s.byRule['exact'])} | reference-fuzzy ${rule(s.byRule['reference-fuzzy'])} | amount-date-window ${rule(s.byRule['amount-date-window'])} | amount-tolerance ${rule(s.byRule['amount-tolerance'])} | many-to-one ${rule(s.byRule['many-to-one'])}`,
  );
  out.push('');
  for (const m of result.matches) out.push(...describeMatch(m, d));
  if (result.matches.length === 0) out.push('(none)');
  out.push('');
  out.push(`UNMATCHED INTERNAL — ${result.unmatchedInternal.length} row(s)`);
  for (const res of result.unmatchedInternal) out.push(...describeResidual(res, d));
  if (result.unmatchedInternal.length === 0) out.push('(none)');
  out.push('');
  out.push(`UNMATCHED SETTLEMENT — ${result.unmatchedSettlement.length} row(s)`);
  for (const res of result.unmatchedSettlement) out.push(...describeResidual(res, d));
  if (result.unmatchedSettlement.length === 0) out.push('(none)');
  out.push('');
  out.push('SUMMARY');
  out.push(
    `  match rate: internal ${(s.matchRateInternal * 100).toFixed(2)}% (${s.matchedInternal}/${s.internalRows}) | settlement ${(s.matchRateSettlement * 100).toFixed(2)}% (${s.matchedSettlement}/${s.settlementRows})`,
  );
  out.push(
    `  matched totals: internal ${formatMinor(s.matchedInternalTotalMinor, d)} | settlement ${formatMinor(s.matchedSettlementTotalMinor, d)}`,
  );
  out.push(
    `  drift across matches: net ${signed(s.driftNetMinor, d)} | absolute ${formatMinor(s.driftAbsMinor, d)}`,
  );
  out.push(
    `  unmatched totals: internal ${formatMinor(s.unmatchedInternalTotalMinor, d)} | settlement ${formatMinor(s.unmatchedSettlementTotalMinor, d)}`,
  );
  return out.join('\n');
}
