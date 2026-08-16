/**
 * Money handling. Everything inside the engine is integer minor units.
 *
 * Parsing is strict on purpose: reconciliation is the wrong place to guess.
 * "1.005" with 2 decimals is an error, not a rounding decision made silently.
 */

const AMOUNT_RE = /^[-+]?\d+(\.\d+)?$/;

/**
 * Parse a major-unit amount (number or decimal string) into integer minor units.
 * Rejects: NaN/Infinity, thousands separators, currency symbols, and more
 * fractional digits than `decimals` allows.
 */
export function parseAmountToMinor(value: number | string, decimals: number): number {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`amount is not finite: ${value}`);
    // Fixed-notation render at the declared precision, then re-validate that
    // nothing was lost (guards against numbers finer than `decimals`).
    text = value.toFixed(decimals);
    const back = Number(text);
    if (Math.abs(back - value) > Number.EPSILON * Math.max(1, Math.abs(value)) * 4) {
      throw new Error(
        `amount ${value} has more precision than ${decimals} decimals; pass it as a string`,
      );
    }
  } else {
    text = value.trim();
  }
  if (!AMOUNT_RE.test(text)) {
    throw new Error(`unparseable amount ${JSON.stringify(value)} (expected e.g. "12.34")`);
  }
  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[-+]/, '');
  const [wholePart, fracPart = ''] = unsigned.split('.');
  if (fracPart.length > decimals) {
    throw new Error(
      `amount ${JSON.stringify(value)} has ${fracPart.length} fractional digits, config allows ${decimals}`,
    );
  }
  const minorText = wholePart + fracPart.padEnd(decimals, '0');
  const minor = Number(minorText);
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`amount ${JSON.stringify(value)} exceeds safe integer range in minor units`);
  }
  return negative ? -minor : minor;
}

/** Format minor units back to a major-unit decimal string, e.g. 4250 -> "42.50". */
export function formatMinor(minor: number, decimals: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const scale = 10 ** decimals;
  const whole = Math.floor(abs / scale);
  if (decimals === 0) return `${sign}${whole}`;
  const frac = String(abs % scale).padStart(decimals, '0');
  return `${sign}${whole}.${frac}`;
}
