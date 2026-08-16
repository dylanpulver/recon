/**
 * Reference normalization — the workhorse of tier 2.
 *
 * Real settlement files decorate references relentlessly: case changes,
 * whitespace, dashes, "REF"/"TXN"/"PAYMENT" prefixes bolted on by whichever
 * system touched the row last, and zero-padding. Two references are treated
 * as the same identity when they survive to the same normalized form.
 *
 * Every step that actually changed the string is recorded, so a fuzzy match
 * can show its work in the receipt.
 */

export interface NormalizedRef {
  value: string;
  steps: string[];
}

/** Prefixes commonly bolted onto references by upstream systems. */
const NOISE_PREFIXES = [
  'PAYMENT',
  'PAYOUT',
  'TRANSFER',
  'TXN',
  'TRX',
  'PMT',
  'REF',
  'TX',
] as const;

export function normalizeReference(raw: string): NormalizedRef {
  const steps: string[] = [];
  let s = raw;

  const trimmed = s.trim();
  if (trimmed !== s) steps.push('trim');
  s = trimmed;

  const upper = s.toUpperCase();
  if (upper !== s) steps.push('uppercase');
  s = upper;

  const stripped = s.replace(/[^A-Z0-9]/g, '');
  if (stripped !== s) steps.push('strip-separators');
  s = stripped;

  // Strip noise prefixes repeatedly ("REF TXN 42" -> "42"), but never strip a
  // prefix that would leave less than 2 characters of actual reference
  // ("TXN" must stay "TXN", not become "N").
  let strippedPrefix = true;
  while (strippedPrefix) {
    strippedPrefix = false;
    for (const prefix of NOISE_PREFIXES) {
      if (s.startsWith(prefix) && s.length >= prefix.length + 2) {
        s = s.slice(prefix.length);
        steps.push(`strip-prefix:${prefix}`);
        strippedPrefix = true;
        break;
      }
    }
  }

  // Zero-padding: purely numeric references drop leading zeros ("00042" -> "42").
  if (/^0+\d+$/.test(s)) {
    s = s.replace(/^0+/, '');
    steps.push('strip-leading-zeros');
  }

  return { value: s, steps };
}
