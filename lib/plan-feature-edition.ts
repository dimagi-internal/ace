/**
 * Is a CommCare HQ software-plan edition named in a Nova `plan-feature`
 * confirmation's `plans` string? (dimagi-internal/ace#3206)
 *
 * `upload_app_to_hq` refuses with `hq_confirmation_needed` for every plan
 * feature an app uses (lookup tables, child cases, advanced case actions, data
 * forwarding, …) and gives each entry a human-readable `plans` list of the
 * editions that include it — e.g. `"Pro, Advanced and Enterprise"`.
 * `skills/app-deploy` § Handle `hq_confirmation_needed` verifies each one by
 * reading the space's `edition` via `commcare_get_subscription({domain})` and
 * confirming only when that edition is named here.
 *
 * Matching is case-insensitive and whole-item: the string is split on commas
 * and the word "and", so "Pro" never matches inside another word and a
 * missing/empty input is never a match (never confirm blind).
 */
export function planIncludesEdition(plans: string, edition: string): boolean {
  if (typeof plans !== 'string' || typeof edition !== 'string') return false;
  const want = edition.trim().toLowerCase();
  if (!want) return false;
  return plans
    .split(/,|\band\b|&/i)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .includes(want);
}
