/**
 * Core types for the reconciliation engine.
 *
 * Terminology used throughout:
 *  - "internal"   — side A, your own ledger (what you believe happened)
 *  - "settlement" — side B, the counterpart file (what the processor/bank says happened)
 *
 * All amounts are handled internally as integer minor units (e.g. cents) to
 * avoid floating-point drift. Inputs may be numbers or decimal strings.
 */

/** One transaction row, as supplied by the caller (array, CSV, or JSONL). */
export interface Txn {
  /** Unique id within its side. Duplicate ids on the same side are an error. */
  id: string;
  /** ISO calendar date, YYYY-MM-DD. */
  date: string;
  /** Amount in major units — a number or a decimal string like "42.50". */
  amount: number | string;
  /** ISO 4217-style currency code. Rows only ever match within one currency. */
  currency: string;
  /** Processor / bank / order reference, if any. */
  reference?: string;
  counterparty?: string;
  /** Extra columns / fields; carried through untouched, never used to match. */
  metadata?: Record<string, string>;
}

/** The five rungs of the matching ladder, in the order they run. */
export type MatchRule =
  | 'exact'
  | 'reference-fuzzy'
  | 'amount-date-window'
  | 'amount-tolerance'
  | 'many-to-one';

export const MATCH_RULES: readonly MatchRule[] = [
  'exact',
  'reference-fuzzy',
  'amount-date-window',
  'amount-tolerance',
  'many-to-one',
];

/** How much tolerance a match consumed, when a rule permits amount drift. */
export interface ToleranceReceipt {
  /** Signed delta in minor units: internal total minus settlement total. */
  amountDeltaMinor: number;
  /** The maximum delta this rule would have accepted, in minor units. */
  allowedDeltaMinor: number;
  /** |delta| expressed in basis points of the settlement amount (rounded). */
  consumedBps: number;
}

/** Reference-normalization evidence for a fuzzy match. */
export interface NormalizationReceipt {
  internalRaw: string;
  settlementRaw: string;
  /** The common normalized form both references reduce to. */
  normalized: string;
  /** Normalization steps that actually fired, e.g. "uppercase", "strip-prefix:REF". */
  steps: string[];
}

/**
 * The receipt: why this match exists. Every match carries one.
 * If a match cannot explain itself with a receipt, the engine may not emit it.
 */
export interface MatchReceipt {
  rule: MatchRule;
  /** The fields this rule compared, spelled with their applied constraints. */
  fields: string[];
  /** Signed date distance in days: internal date minus settlement date.
   *  For many-to-one groups: the largest |component − settlement| distance. */
  dateDeltaDays: number;
  /** Signed amount delta in minor units: internal total minus settlement total. */
  amountDeltaMinor: number;
  /** Present iff the rule consumed amount tolerance (zero-tolerance rules omit it). */
  tolerance?: ToleranceReceipt;
  /** Present iff reference normalization was needed to make the match. */
  normalization?: NormalizationReceipt;
  /** Free-form, human-readable evidence lines. */
  notes: string[];
}

/** A matched group. One-to-one for tiers 1–4; N-to-one for tier 5. */
export interface MatchGroup {
  internalIds: string[];
  settlementIds: string[];
  internalTotalMinor: number;
  settlementTotalMinor: number;
  currency: string;
  receipt: MatchReceipt;
}

/**
 * Residual categories for unmatched rows.
 *  - missing-in-settlement: internal row with no plausible settlement counterpart.
 *  - missing-in-internal:   settlement row with no plausible internal counterpart.
 *  - amount-mismatch:       an unmatched row that shares a (normalized) reference
 *    with an unmatched row on the other side, but the amounts disagree beyond
 *    tolerance — the classic "same payment, wrong amount" investigation case.
 */
export type ResidualCategory =
  | 'missing-in-settlement'
  | 'missing-in-internal'
  | 'amount-mismatch';

export interface ResidualCandidate {
  /** Id of the suspect counterpart row on the other side. */
  id: string;
  /** Signed delta in minor units (this row minus the candidate). */
  amountDeltaMinor: number;
  /** The shared normalized reference that links the two rows. */
  sharedReference: string;
}

export interface Residual {
  side: 'internal' | 'settlement';
  id: string;
  category: ResidualCategory;
  date: string;
  amountMinor: number;
  currency: string;
  reference?: string;
  /** Present iff category is "amount-mismatch". */
  candidate?: ResidualCandidate;
}

export interface Summary {
  internalRows: number;
  settlementRows: number;
  matchedInternal: number;
  matchedSettlement: number;
  matchGroups: number;
  byRule: Record<MatchRule, number>;
  /** matchedInternal / internalRows, rounded to 4 decimals. 1 when 0 rows. */
  matchRateInternal: number;
  matchRateSettlement: number;
  matchedInternalTotalMinor: number;
  matchedSettlementTotalMinor: number;
  /** Net drift across matched groups: internal total − settlement total.
   *  Positive means the settlement side paid out less (fees, FX shaves). */
  driftNetMinor: number;
  /** Sum of |per-group delta| — total tolerance actually consumed. */
  driftAbsMinor: number;
  unmatchedInternalTotalMinor: number;
  unmatchedSettlementTotalMinor: number;
  currencies: string[];
}

export interface ReconResult {
  matches: MatchGroup[];
  unmatchedInternal: Residual[];
  unmatchedSettlement: Residual[];
  summary: Summary;
  /** The fully-resolved configuration this run used (defaults applied). */
  config: ResolvedConfig;
}

/* ----------------------------- configuration ----------------------------- */

export interface ManyToOneConfig {
  /** Turn the tier off entirely. Default true. */
  enabled?: boolean;
  /** Maximum internal rows allowed to sum into one settlement row. Default 6. */
  maxGroupSize?: number;
  /** Maximum candidate rows considered per settlement row (nearest first). Default 24. */
  maxCandidates?: number;
  /** Date window for batch components around the settlement date. Default 7. */
  dateWindowDays?: number;
  /** Tolerance on the group sum, in bps. Default 0 — the sum must be exact. */
  toleranceBps?: number;
  /** Hard cap on subset-sum search nodes per settlement row. Default 200000. */
  maxNodes?: number;
}

export interface ReconConfig {
  /** Minor-unit decimals for amount parsing/formatting. Default 2. */
  decimals?: number;
  /** Date window (± days) for tiers 2–4. Default 3. */
  dateWindowDays?: number;
  /** Amount tolerance for tier 4, in basis points. Default 50 (0.50%). */
  amountToleranceBps?: number;
  /** Absolute floor for tier-4 tolerance in minor units (helps tiny amounts). Default 0. */
  amountToleranceMinMinor?: number;
  manyToOne?: ManyToOneConfig;
}

export interface ResolvedManyToOneConfig {
  enabled: boolean;
  maxGroupSize: number;
  maxCandidates: number;
  dateWindowDays: number;
  toleranceBps: number;
  maxNodes: number;
}

export interface ResolvedConfig {
  decimals: number;
  dateWindowDays: number;
  amountToleranceBps: number;
  amountToleranceMinMinor: number;
  manyToOne: ResolvedManyToOneConfig;
}

export function resolveConfig(config: ReconConfig = {}): ResolvedConfig {
  const m = config.manyToOne ?? {};
  const resolved: ResolvedConfig = {
    decimals: config.decimals ?? 2,
    dateWindowDays: config.dateWindowDays ?? 3,
    amountToleranceBps: config.amountToleranceBps ?? 50,
    amountToleranceMinMinor: config.amountToleranceMinMinor ?? 0,
    manyToOne: {
      enabled: m.enabled ?? true,
      maxGroupSize: m.maxGroupSize ?? 6,
      maxCandidates: m.maxCandidates ?? 24,
      dateWindowDays: m.dateWindowDays ?? 7,
      toleranceBps: m.toleranceBps ?? 0,
      maxNodes: m.maxNodes ?? 200_000,
    },
  };
  const nonNegative: Array<[string, number]> = [
    ['decimals', resolved.decimals],
    ['dateWindowDays', resolved.dateWindowDays],
    ['amountToleranceBps', resolved.amountToleranceBps],
    ['amountToleranceMinMinor', resolved.amountToleranceMinMinor],
    ['manyToOne.maxGroupSize', resolved.manyToOne.maxGroupSize],
    ['manyToOne.maxCandidates', resolved.manyToOne.maxCandidates],
    ['manyToOne.dateWindowDays', resolved.manyToOne.dateWindowDays],
    ['manyToOne.toleranceBps', resolved.manyToOne.toleranceBps],
    ['manyToOne.maxNodes', resolved.manyToOne.maxNodes],
  ];
  for (const [name, value] of nonNegative) {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new Error(`config.${name} must be a non-negative integer, got ${value}`);
    }
  }
  if (resolved.decimals > 8) {
    throw new Error(`config.decimals must be <= 8, got ${resolved.decimals}`);
  }
  if (resolved.manyToOne.maxGroupSize < 2 && resolved.manyToOne.enabled) {
    throw new Error(
      `config.manyToOne.maxGroupSize must be >= 2 when enabled, got ${resolved.manyToOne.maxGroupSize}`,
    );
  }
  return resolved;
}
