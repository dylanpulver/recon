/**
 * recon — explainable transaction reconciliation.
 * Public API surface.
 */

export { reconcile } from './engine.js';
export { renderReport } from './report.js';
export { parseCSV, parseCSVTxns, parseJSONLTxns } from './parse.js';
export { normalizeReference } from './normalize.js';
export { parseAmountToMinor, formatMinor } from './money.js';
export { parseISODate, epochDayToISO } from './dates.js';
export { boundedSubsetSum } from './subset-sum.js';
export { resolveConfig, MATCH_RULES } from './types.js';
export type {
  Txn,
  MatchRule,
  MatchReceipt,
  MatchGroup,
  ToleranceReceipt,
  NormalizationReceipt,
  Residual,
  ResidualCategory,
  ResidualCandidate,
  Summary,
  ReconResult,
  ReconConfig,
  ManyToOneConfig,
  ResolvedConfig,
} from './types.js';
