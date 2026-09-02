// Connect opportunity invariants — the SINGLE definition of the rules that
// both the MCP boundary and the standalone spec validator enforce.
//
// These lived only in `mcp/connect/` until 0.13.1133, which meant a second
// consumer had to copy them: the repo convention is that `mcp/` imports
// `lib/` and never the reverse, so `lib/connect-opp-spec.ts` re-derived the
// regex and the capacity formula and pinned them equal with a test.
//
// A pin is strictly worse than one definition. It detects drift instead of
// preventing it, and the first review of that arrangement found the two copies
// had ALREADY diverged on the case that matters: `numberOfUsers`'s `users < 1`
// is `false` for `NaN`, so a non-numeric budget failed OPEN on both sides —
// the exact class the guard exists to stop (ace#722, ace#729, and the
// bednet-spot-check/20260606-2013 dollars-vs-cents miss that made it code in
// the first place). So the values move here and `mcp/connect/` imports them.
//
// `mcp/connect/opportunity-name.ts` and `opportunity-capacity.ts` keep their
// `ConnectError` subclasses — those belong at the boundary that throws them.
// Only the pure values and formulas live here.

/**
 * Run-id front prefix required on an `is_test` opportunity name:
 * `YYYYMMDD-HHMM` + space + U+00B7 MIDDLE DOT + space, e.g.
 * `"20260609-0909 · Bednet Spot-Check"`.
 *
 * Phase 6's mobile recipes anchor their opp-tile match on
 * `text: ".*${OPP_RUN_ID}.*"`, and the test user accumulates dozens of
 * near-identical invites across runs, so the run-id is the only token that
 * disambiguates one run's opp — and it must LEAD, so it lands on the tile's
 * first, never-clipped line (jjackson/ace#755).
 */
export const OPP_NAME_RUN_ID_PREFIX_RE = /^\d{8}-\d{4} · /u;

/**
 * Server-enforced ceiling on `Opportunity.short_description`.
 *
 * `CharField(max_length=50)` on the model, but the DRF serializer is wrongly
 * typed `max_length=255`: a 51–255 char payload validates clean at the DRF
 * layer, then Postgres raises `DataError: value too long` inside
 * `transaction.atomic()`, which `program/api/views.py` does not catch (it
 * catches only httpx errors) — so it surfaces as a Django 500 with no
 * actionable body. Bisected deterministically 2026-05-12: 49 chars → 201,
 * 51 chars → 500. Nothing truncates.
 */
export const SHORT_DESCRIPTION_MAX = 50;

/** A payment unit, reduced to the fields the capacity formula reads. */
export interface CapacityPaymentUnit {
  name?: string;
  amount: number;
  org_amount?: number;
  max_total: number;
}

/**
 * Σ over payment units of `max_total × (amount + org_amount)` — the budget
 * that funds exactly one FLW at the configured payment-unit maxima.
 *
 * Returns `NaN` if any input is non-finite, so a malformed spec propagates as
 * "unknown" rather than as a number. See `numberOfUsers` for why that matters.
 */
export function minBudgetForOneUser(paymentUnits: CapacityPaymentUnit[]): number {
  return paymentUnits.reduce((sum, pu) => {
    // Coerce nothing: a string here is a caller bug, and silently summing
    // "2" + 0 === "20" is how a valid spec gets rejected for being 10x
    // underfunded (or an invalid one accepted).
    const amount = typeof pu.amount === 'number' ? pu.amount : NaN;
    const org = pu.org_amount === undefined || pu.org_amount === null ? 0
      : typeof pu.org_amount === 'number' ? pu.org_amount : NaN;
    const maxTotal = typeof pu.max_total === 'number' ? pu.max_total : NaN;
    return sum + maxTotal * (amount + org);
  }, 0);
}

/**
 * Connect's managed-opp capacity formula
 * (`Opportunity.number_of_users` in `commcare_connect/opportunity/models.py`).
 *
 * Returns `Infinity` for a zero-cost (free) opportunity so a `< 1` check is a
 * no-op there, and `NaN` when any input is non-finite.
 *
 * **`NaN` is not "fine" — callers must test it explicitly.** `NaN < 1` is
 * `false`, so a bare `< 1` guard passes a malformed budget silently. Use
 * `fundsAtLeastOneUser` rather than comparing this yourself.
 */
export function numberOfUsers(total_budget: number, paymentUnits: CapacityPaymentUnit[]): number {
  const min = minBudgetForOneUser(paymentUnits);
  if (Number.isNaN(min) || typeof total_budget !== 'number' || !Number.isFinite(total_budget)) {
    return NaN;
  }
  if (min <= 0) return Infinity;
  return total_budget / min;
}

/**
 * Does this budget fund at least one FLW? `false` for a malformed input, which
 * is the whole point: the naive `numberOfUsers(...) < 1` reads `NaN` as "fine".
 */
export function fundsAtLeastOneUser(
  total_budget: number,
  paymentUnits: CapacityPaymentUnit[],
): boolean {
  if (paymentUnits.length === 0) return true; // nothing to fund yet
  const users = numberOfUsers(total_budget, paymentUnits);
  if (Number.isNaN(users)) return false;
  return users >= 1;
}

/** The CommCare HQ clusters ACE talks to. Values mirror `KNOWN_HQ_BASE_URLS`. */
export const HQ_BASE_URLS: Record<string, string> = {
  us: 'https://www.commcarehq.org',
  eu: 'https://eu.commcarehq.org',
  india: 'https://india.commcarehq.org',
};
