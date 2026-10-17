// Code-enforced "is_test opportunity names MUST carry a run-id front prefix"
// guard.
//
// Phase 6 mobile recipes (connect-claim-opp.yaml / connect-resume-opp.yaml)
// anchor their opp-tile match on `text: ".*${OPP_RUN_ID}.*"`. The ACE test
// user accumulates dozens of near-identical opp invites across dogfood runs,
// so the run-id is the only token that disambiguates THIS run's opp — and it
// must lead the name (front prefix) so it lands on the tile's first,
// never-clipped line. Contract: skills/connect-opp-setup/SKILL.md § name.
//
// The contract lived as SKILL.md prose only and failed live on
// bednet-spot-check/20260612-1220: Phase 4 created the opp as plain
// "Bednet Spot-Check" (no prefix) and BOTH Phase 6 legs failed
// deterministically with `No visible element found: ".*20260612-1220.*"`.
// A prior run (20260609-0909) followed the prose correctly — i.e. this is
// nondeterministic LLM instruction-following, the class ACE fixes with code
// enforcement at the MCP boundary (CLAUDE.md "class-level preventers >
// instance-level fixes"; precedent: the #731 funds-≥1-FLW capacity guard in
// opportunity-capacity.ts). See jjackson/ace#755.
//
// Scope: only `is_test: true` opportunities — those are the ACE dogfood runs
// the Phase 6 tile matchers drive. Real (non-test) opportunities keep
// human-facing names.
import { ConnectError } from './errors.js';

/**
 * Run-id front prefix: `YYYYMMDD-HHMM ` + U+00B7 middot + ` ` (e.g.
 * `"20260609-0909 · Bednet Spot-Check"`). The separator is the MIDDLE DOT
 * (U+00B7), not a hyphen or ASCII period.
 */
export const OPP_NAME_RUN_ID_PREFIX_RE = /^\d{8}-\d{4} · /u;

export class InvalidOppNamePrefixError extends ConnectError {
  retryable = false;
  constructor(public oppName: string) {
    super(
      'INVALID_OPP_NAME_PREFIX: is_test opportunities must be named ' +
        '"<run_id> · <display name>" (run-id YYYYMMDD-HHMM front prefix, ' +
        'U+00B7 separator) so Phase 6 tile matchers can find the opp — got: ' +
        `"${oppName}". See skills/connect-opp-setup/SKILL.md § name and ` +
        'jjackson/ace#755.',
    );
  }

  toJSON(): { error: 'invalid_opp_name_prefix'; message: string; name: string } {
    return { error: 'invalid_opp_name_prefix', message: this.message, name: this.oppName };
  }
}

/**
 * Throw `InvalidOppNamePrefixError` when an `is_test: true` opportunity name
 * lacks the `"<run_id> · "` front prefix. No-op when `is_test` is false or
 * absent (real opportunities keep human-facing names). Call BEFORE any
 * network round-trip so the boundary rejects the bad name without creating
 * an opp that Phase 6 can never find.
 */
export function assertRunIdNamePrefix(name: string, is_test: boolean | undefined): void {
  if (is_test !== true) return;
  if (!OPP_NAME_RUN_ID_PREFIX_RE.test(name)) {
    throw new InvalidOppNamePrefixError(name);
  }
}

// ── Never mint a second opportunity for the same run (ace#2083 / ace#2412) ──
//
// An `is_test` opportunity's name is deterministic per run
// (`"<run_id> · <PDD display name>"`), so an opportunity that already carries
// the exact name is this run's own — created by an earlier dispatch that died
// before payment units (Step 6), which leaves it permanently
// `setup_incomplete`. Creating again strands that one for good: Connect has no
// opportunity-delete route, and its only purge (`delete_stale_opportunities`)
// takes visit-free opportunities at SIX MONTHS. Each orphan meanwhile costs one
// `EXPECTED_OPP_BUDGET` in every program-ceiling sum on the org (11 of 71 rows
// on the shared PM org, 2026-09-06). The skill's Step 4.0 decides adopt-vs-create
// (`lib/connect-opp-resume.ts`); this is the boundary rail for when it is
// skipped.

/** The run-id token an `is_test` name leads with, or null. */
export function runIdOfOppName(name: string): string | null {
  const m = /^(\d{8}-\d{4}) · /u.exec(name);
  return m ? m[1] : null;
}

export class OpportunityAlreadyExistsError extends ConnectError {
  retryable = false;
  constructor(
    public oppName: string,
    public existing: Array<{ id: string; dashboard_read?: string }>,
  ) {
    super(
      `OPPORTUNITY_ALREADY_EXISTS: ${existing.length} opportunit${existing.length === 1 ? 'y' : 'ies'} named ` +
        `"${oppName}" already exist${existing.length === 1 ? 's' : ''} (${existing.map((e) => e.id).join(', ')}). ` +
        'This run created it on an earlier dispatch. Adopt it and finish its setup ' +
        '(connect-opp-setup Step 4.0: record the id, then Steps 5–6.5 on THAT opportunity) — a second create ' +
        'strands the first as a permanent setup_incomplete orphan (no delete API; Connect purges visit-free ' +
        'opportunities only at 6 months — ace#2083). Pass allow_existing_name: true only for a deliberate ' +
        'replacement the operator approved.',
    );
  }

  toJSON() {
    return {
      error: 'opportunity_already_exists' as const,
      message: this.message,
      name: this.oppName,
      existing: this.existing,
      retryable: false as const,
    };
  }
}

export class OpportunityExistenceUnknownError extends ConnectError {
  retryable = false;
  constructor(public oppName: string, public detail: string) {
    super(
      `OPPORTUNITY_EXISTENCE_UNKNOWN: could not confirm that no opportunity named "${oppName}" already exists ` +
        `(${detail}). Refusing to create blind — a duplicate is a permanent orphan (ace#2083). Retry; pass ` +
        'allow_existing_name: true only if the operator accepts that risk.',
    );
  }

  toJSON() {
    return {
      error: 'opportunity_existence_unknown' as const,
      message: this.message,
      name: this.oppName,
      detail: this.detail,
      retryable: false as const,
    };
  }
}

/**
 * Refuse an `is_test` create whose exact name already exists in the org.
 * No-op for non-test opportunities (human names are not run-unique) and when
 * the caller explicitly allows it. `list` is `client.listOpportunities`.
 */
export async function assertNoExistingRunOpportunity(
  args: { organization_slug: string; name: string; is_test?: boolean; allow_existing_name?: boolean },
  list: (a: { organization_slug: string; name: string }) => Promise<{
    opportunities: Array<{ id?: unknown; name?: unknown; dashboard_read?: unknown }>;
    listing?: { complete?: unknown };
  }>,
): Promise<void> {
  if (args.is_test !== true || args.allow_existing_name === true) return;
  const runId = runIdOfOppName(args.name);
  if (!runId) return; // assertRunIdNamePrefix owns that refusal
  let res: Awaited<ReturnType<typeof list>>;
  try {
    res = await list({ organization_slug: args.organization_slug, name: runId });
  } catch (e) {
    throw new OpportunityExistenceUnknownError(args.name, `listing failed: ${(e as Error).message}`);
  }
  const want = args.name.trim();
  const existing = (res.opportunities ?? [])
    .filter((o) => typeof o.name === 'string' && o.name.trim() === want && typeof o.id === 'string')
    .map((o) => ({
      id: o.id as string,
      ...(typeof o.dashboard_read === 'string' ? { dashboard_read: o.dashboard_read } : {}),
    }));
  if (existing.length > 0) throw new OpportunityAlreadyExistsError(want, existing);
  if (res.listing && res.listing.complete !== true) {
    throw new OpportunityExistenceUnknownError(args.name, 'the opportunity listing was incomplete');
  }
}
