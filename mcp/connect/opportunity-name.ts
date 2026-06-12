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
