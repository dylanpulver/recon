/**
 * Bounded subset-sum for the many-to-one tier.
 *
 * Subset-sum is NP-hard in general; reconciliation batches are not general.
 * Real payout batches are small (a handful of transactions) and candidate
 * pools are pre-filtered by currency, sign, and date window. Within those
 * practical limits an exact branch-and-bound search is fast and — crucially —
 * deterministic: same inputs, same subset, every time.
 *
 * Hard limits (all configurable upstream):
 *  - maxSize:  maximum subset cardinality
 *  - maxNodes: absolute cap on search nodes; the search reports failure rather
 *              than blow the time budget when an adversarial pool is supplied
 *
 * All values and the target must be strictly positive — the engine filters
 * refunds/reversals out of batch candidates (documented limitation).
 */

export interface SubsetSumOptions {
  maxSize: number;
  /** Accepted |sum - target| in minor units. 0 means the sum must be exact. */
  tolerance: number;
  maxNodes: number;
}

export interface SubsetSumOutcome {
  /** Indices into the input `values` array, ascending; null if none found. */
  indices: number[] | null;
  /** True if the node budget was exhausted before the search space was covered. */
  exhausted: boolean;
}

export function boundedSubsetSum(
  values: readonly number[],
  target: number,
  options: SubsetSumOptions,
): SubsetSumOutcome {
  const { maxSize, tolerance, maxNodes } = options;
  if (target <= 0) return { indices: null, exhausted: false };
  for (const v of values) {
    if (v <= 0) throw new Error(`boundedSubsetSum requires positive values, got ${v}`);
  }

  // Search in descending-value order (stable on index) so large components are
  // placed first — best pruning power, and a canonical deterministic order.
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value || a.index - b.index);

  // suffixSum[i] = sum of order[i..] values, for the "can we still reach the
  // target even taking everything" prune.
  const suffixSum: number[] = new Array(order.length + 1).fill(0);
  for (let i = order.length - 1; i >= 0; i--) {
    suffixSum[i] = suffixSum[i + 1] + order[i].value;
  }

  let nodes = 0;
  let exhausted = false;
  const chosen: number[] = [];

  const dfs = (pos: number, count: number, sum: number): number[] | null => {
    if (nodes >= maxNodes) {
      exhausted = true;
      return null;
    }
    nodes++;
    if (count >= 2 && Math.abs(sum - target) <= tolerance) {
      return [...chosen];
    }
    if (pos >= order.length || count >= maxSize) return null;
    // Values are all positive: once the running sum exceeds target + tolerance
    // no extension can come back down.
    if (sum > target + tolerance) return null;
    // Even taking every remaining value cannot reach the target.
    if (sum + suffixSum[pos] < target - tolerance) return null;

    // Branch 1: take order[pos].
    chosen.push(order[pos].index);
    const withIt = dfs(pos + 1, count + 1, sum + order[pos].value);
    if (withIt) return withIt;
    chosen.pop();

    // Branch 2: skip it.
    return dfs(pos + 1, count, sum);
  };

  const found = dfs(0, 0, 0);
  if (!found) return { indices: null, exhausted };
  return { indices: found.sort((a, b) => a - b), exhausted: false };
}
