/**
 * Date handling. Dates are calendar days (YYYY-MM-DD), held internally as an
 * integer epoch-day so "N days apart" is plain subtraction. No timezones —
 * settlement files carry calendar dates, and pretending otherwise invents
 * off-by-one bugs at midnight UTC.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Parse strict YYYY-MM-DD into an epoch-day integer. Rejects impossible dates. */
export function parseISODate(text: string): number {
  const m = DATE_RE.exec(text.trim());
  if (!m) throw new Error(`unparseable date ${JSON.stringify(text)} (expected YYYY-MM-DD)`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new Error(`impossible calendar date ${JSON.stringify(text)}`);
  }
  return ms / MS_PER_DAY;
}

/** Epoch-day integer back to YYYY-MM-DD. */
export function epochDayToISO(day: number): string {
  const d = new Date(day * MS_PER_DAY);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
