# recon

[![CI](https://github.com/dylanpulver/recon/actions/workflows/ci.yml/badge.svg)](https://github.com/dylanpulver/recon/actions/workflows/ci.yml)

**Explainable transaction reconciliation. Every match carries a receipt.**

Zero runtime dependencies. TypeScript, Node 20+. MIT.

---

## Why reconciliation breaks

If you run money through a processor, your ledger and their settlement file
disagree every single day, and almost never because anything is actually wrong:

- **Fees.** The processor nets its fee off the gross, so your `250.00` arrives
  as `249.10`. Multiply by a thousand rows and naive equality matching reports
  a thousand "discrepancies" — all of them fine, all of them noise drowning the
  one row that isn't.
- **FX.** Currency conversion rounds in the counterparty's favor at the
  counterparty's precision. A few minor units of drift per row is normal; the
  same drift can also hide a real error, which is why tolerance has to be
  *declared and measured*, not eyeballed.
- **Batching.** You booked 37 card payments; the processor paid out one wire.
  One-to-one matching is structurally impossible — N of your rows have to sum
  to one of theirs, and finding which N is a subset-sum problem you must bound
  before it bounds you.
- **Timing.** You record on capture day, they settle T+1/T+2, weekends and
  cutoffs smear dates further. Same money, different calendar days.
- **Reference mangling.** Your `ORD-7312` comes back as `ord 7312`, `REF
  ORD7312`, or zero-padded. Every system in the chain decorates the reference
  and none of them tells you.

None of this is exotic. It is the everyday physics of settlement files. A
reconciliation engine has to absorb all of it *and still be able to say, for
every single match, exactly why it believed the two sides are the same money* —
because month-end close, disputes, and auditors all ask the same question:
"prove it."

`recon` is that engine, small enough to read in an afternoon.

## Quickstart

```sh
git clone <this repo> && cd recon
npm install        # dev deps only (typescript); zero runtime dependencies
npm test           # builds and runs the full suite — the tests are the pitch
```

CLI:

```sh
node dist/src/cli.js examples/internal.csv examples/settlement.csv --config examples/recon.json
# or, after `npm link`: recon internal.csv settlement.csv --json
```

Library:

```ts
import { reconcile, renderReport } from 'recon';

const result = reconcile(internalRows, settlementRows, {
  dateWindowDays: 3,
  amountToleranceBps: 50,
  manyToOne: { maxGroupSize: 6, dateWindowDays: 7 },
});

console.log(renderReport(result));        // human report
console.log(JSON.stringify(result));      // machine-readable, receipts included
```

Input rows (CSV with header, JSONL, JSON array, or plain objects):

```ts
{ id, date /* YYYY-MM-DD */, amount /* "42.50" */, currency, reference?, counterparty?, metadata? }
```

Amounts are parsed to integer minor units — floats never touch the matching
math, and ambiguous inputs (`"1,000"`, `"10.005"` at 2 decimals) are rejected
instead of silently rounded.

## The matching ladder

Tiers run strongest-evidence-first. A row claimed by a higher tier is never
revisited: an exact match cannot be stolen by a fuzzy one. Rows only ever
match within the same currency. Everything is deterministic — rows are
processed in canonical (date, amount, id) order and every tie breaks the same
way, so the same input produces byte-identical output regardless of input
array order.

| # | Rule | Evidence required | Typical real-world cause |
|---|------|-------------------|--------------------------|
| 1 | `exact` | amount + date + verbatim reference | the happy path |
| 2 | `reference-fuzzy` | amount + normalized reference + date window | case/whitespace/`REF`-prefix/zero-pad noise |
| 3 | `amount-date-window` | amount + date within ±N days | T+1/T+2 settlement, weekend cutoffs |
| 4 | `amount-tolerance` | amount within configurable bps + date window | netted fees, FX rounding drift |
| 5 | `many-to-one` | N internal rows sum to one settlement row (bounded subset-sum) | batched payouts |
| — | residuals | everything left, categorized | the rows a human actually needs to see |

Residual categories: `missing-in-settlement` (yours, not theirs),
`missing-in-internal` (theirs, not yours), and `amount-mismatch` — an
unmatched pair sharing a normalized reference but disagreeing on amount
beyond tolerance, reported with the exact signed delta. That last bucket is
where real investigations start.

## Receipts: every match is explainable or it doesn't count

A match without evidence is just an opinion with a checkmark. Every match
`recon` emits carries a receipt naming the rule, the fields compared, the date
delta, the amount delta, tolerance consumed (against the declared allowance),
and — for fuzzy matches — the raw references plus the exact normalization
steps that fired:

```json
{
  "rule": "amount-tolerance",
  "fields": ["currency", "amount(±50bps)", "date(±3d)"],
  "dateDeltaDays": 0,
  "amountDeltaMinor": 90,
  "tolerance": { "amountDeltaMinor": 90, "allowedDeltaMinor": 125, "consumedBps": 36 },
  "notes": ["amount delta 90 minor units within allowance 125 (50bps)"]
}
```

The receipt is not decoration; it is the contract. If a rule cannot fill in a
receipt, the engine may not emit the match.

## Invariants (property-tested)

The test suite generates random ledgers, derives settlement counterparts
through realistic corruptions (fee deduction, date shifts, batching, dropped
rows, duplicate references, currency traps), and asserts — for every seed:

1. **Partition** — every input row appears in exactly one output slot (one
   match group or one residual). No row matched twice, no row lost.
2. **Conservation** — each group's |internal − settlement| drift is within the
   tolerance *its own receipt declares* (zero for zero-tolerance rules), and
   the summary's drift totals are recomputable from the groups.
3. **Receipts** — every match names its rule and fields, respects its rule's
   date window, and never mixes currencies.
4. **Buckets** — every planted corruption lands exactly where it was planted:
   right tier for matches, right category and signed delta for residuals.
5. **Determinism** — same input ⇒ byte-identical output; shuffled input array
   order ⇒ byte-identical output.

The harness is a ~100-line seeded PRNG (mulberry32) property runner built into
the test suite — no test-framework dependency either; failures print the seed
for exact reproduction. `RECON_PROP_RUNS=500 npm test` turns up the volume.

## Example

`examples/` ships two small fictional files: the internal ledger of a coffee
shop ("Larkspur Coffee", plus a "Nimbus SaaS" invoice) against its processor's
settlement file. Every tier and every residual category appears. Running

```sh
node dist/src/cli.js examples/internal.csv examples/settlement.csv --config examples/recon.json
```

prints exactly:

```text
RECONCILIATION REPORT
=====================
internal rows: 9 | settlement rows: 7 | currencies: USD

MATCHED — 5 group(s)
  exact   1 | reference-fuzzy   1 | amount-date-window   1 | amount-tolerance   1 | many-to-one   1

[exact] LC-1001 <-> STL-9001 | 42.50 USD
    fields: currency, amount, date, reference
    note: reference "ORD-7311" identical on both sides
[reference-fuzzy] LC-1002 <-> STL-9002 | 18.20 USD
    fields: currency, amount, reference(normalized), date(±3d)
    normalized: "ORD-7312" / "ord 7312" -> "ORD7312"
    note: references normalize to "ORD7312" (steps: strip-separators, uppercase)
[amount-date-window] LC-1003 <-> STL-9003 | 96.00 USD
    fields: currency, amount, date(±3d)
    date delta: -2 day(s)
    note: amounts identical; dates 2 day(s) apart (window 3)
[amount-tolerance] LC-1004 <-> STL-9004 | 249.10 USD
    fields: currency, amount(±50bps), date(±3d)
    tolerance consumed: +0.90 of ±1.25 allowed (36bps)
    note: amount delta 90 minor units within allowance 125 (50bps)
[many-to-one] LC-1005 + LC-1006 + LC-1007 <-> STL-9005 | 43.50 USD
    fields: currency, sum(amount), date(±7d)
    date delta: -2 day(s)
    note: 3 internal rows sum to settlement row STL-9005 exactly

UNMATCHED INTERNAL — 2 row(s)
[missing-in-settlement] LC-1009 | 33.10 USD | 2026-03-05 | ref "ORD-7319"
[amount-mismatch] LC-1008 | 64.00 USD | 2026-03-05 | ref "ORD-7318"
    suspect counterpart: STL-9006 via shared ref "ORD7318", amount delta +6.00

UNMATCHED SETTLEMENT — 2 row(s)
[amount-mismatch] STL-9006 | 58.00 USD | 2026-03-05 | ref "ORD-7318"
    suspect counterpart: LC-1008 via shared ref "ORD7318", amount delta -6.00
[missing-in-internal] STL-9007 | 15.00 USD | 2026-03-06 | ref "ADJ-0042"

SUMMARY
  match rate: internal 77.78% (7/9) | settlement 71.43% (5/7)
  matched totals: internal 450.20 | settlement 449.30
  drift across matches: net +0.90 | absolute 0.90
  unmatched totals: internal 97.10 | settlement 73.00
```

Exit codes are CI-friendly: `0` fully reconciled, `1` unmatched rows remain,
`2` input/usage error. `--json` emits the full result object instead.

## Configuration

```jsonc
{
  "decimals": 2,                 // minor-unit precision for amount parsing
  "dateWindowDays": 3,           // ± window for tiers 2–4
  "amountToleranceBps": 50,      // tier-4 drift allowance, basis points
  "amountToleranceMinMinor": 0,  // absolute floor for tiny amounts
  "manyToOne": {
    "enabled": true,
    "maxGroupSize": 6,           // max internal rows per batch
    "maxCandidates": 24,         // candidate pool per settlement row
    "dateWindowDays": 7,         // batch component window
    "toleranceBps": 0,           // batch sums must be exact by default
    "maxNodes": 200000           // subset-sum search budget
  }
}
```

## Honest limits

- **No ML, no scoring.** Every rule is a hard predicate. That is a feature —
  probabilistic matching cannot produce receipts an auditor will accept — but
  it means genuinely ambiguous data lands in residuals for a human, by design.
- **Subset-sum is bounded.** Group size, candidate pool, and search nodes are
  all capped. A settlement row batching 200 transactions, or an adversarial
  pool, exhausts the budget and lands in residuals rather than burning CPU.
  Deterministic and explicit; not magic.
- **Many-to-one only, one direction.** N internal → 1 settlement (the payout
  case). One internal → N settlement (partial captures) and N-to-M are not
  implemented.
- **Refunds don't batch.** Non-positive rows reconcile one-to-one through
  tiers 1–4 but are excluded from batch candidates.
- **One currency per match, no FX conversion.** Multi-currency files are
  handled by strict partitioning — rows never match across currencies — but
  the engine will not convert `EUR` to `USD` to chase a match.
- **Calendar dates only.** No timestamps, no timezones. Settlement files speak
  in dates; pretending to more precision than the data has invents bugs.
- **Duplicate ids are an error**, not a warning. Fix the extract.

## License

MIT © 2026 Dylan Pulver
