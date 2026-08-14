/**
 * dimagi-internal/ace#1189 — `/ace:doctor` reported
 *
 *   PASS: 53   WARN: 10   FAIL: 0
 *   Verdict: HEALTHY — ACE works; warnings below are non-fatal
 *
 * on a machine whose Gmail refresh token was revoked server-side. Every
 * inbound and outbound email path was dead: the turn could not read the inbox,
 * could not find the thread it was dispatched for, and could not send. The
 * verdict still said ACE works, and called the warnings non-fatal.
 *
 * Flipping gog_auth to FAIL wholesale would be wrong — `FAIL` renders
 * "BROKEN — ACE will not function", and a Gmail-less machine still runs most
 * of `/ace:run` (Nova build, Connect setup, Drive artifacts). Turns die; runs
 * mostly don't. So the verdict is SURFACE-SCOPED instead, and the checks that
 * kill the mailbox are tagged.
 *
 * Guard-style test (same shape as test/skills/selector-map-heal.test.ts): the
 * doctor is a bash script, so this asserts the contract is present in it
 * rather than executing it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const DOCTOR = new URL('../bin/ace-doctor', import.meta.url);
const src = () => readFileSync(DOCTOR, 'utf-8');

describe('ace-doctor turn-surface verdict (#1189)', () => {
  it('defines a turn-blocking warn helper', () => {
    expect(src()).toMatch(/warn_turn\(\)/);
  });

  it('tags every gog_auth branch that kills the mailbox', () => {
    const body = src();
    // The four states in which ACE cannot read or send mail at all. Each must
    // be turn-blocking; a plain warn is what produced the false HEALTHY.
    const mustBeTurnBlocking = [
      /warn_turn "gog_auth: GOG CLI not installed/,
      /warn_turn "gog_auth: ACE_GMAIL_ACCOUNT/,
      /warn_turn "gog_auth: no stored GOG credentials/,
      // Wording widened in ace#1338 to carry canopy preflight's own message.
      /warn_turn "gog_auth: GOG token for \$GMAIL_ACCT[^"]*cannot call Gmail/,
    ];
    for (const re of mustBeTurnBlocking) {
      expect(body, `expected a turn-blocking warn matching ${re}`).toMatch(re);
    }
  });

  it('does NOT mark the too-narrow-scope branch turn-blocking (gmail still works there)', () => {
    // Drive/Calendar scopes missing degrades other ops but the mailbox is
    // live, so a turn can still run. Over-tagging would recreate the
    // always-fires-blocker class (#1026).
    expect(src()).toMatch(/warn "gog_auth: GOG token for \$GMAIL_ACCT is too narrow/);
  });

  it('tags the canopy email engine absence — every send goes through it', () => {
    expect(src()).toMatch(/warn_turn "canopy_email_engine: canopy CLI not on PATH/);
  });

  it('counts turn blockers and renders a surface-scoped verdict', () => {
    const body = src();
    expect(body).toMatch(/_DOCTOR_TURNBLOCK=/);
    // The verdict must be able to say runs are fine while turns are not —
    // one aggregate word cannot describe both surfaces.
    expect(body).toMatch(/HEALTHY for runs/);
    expect(body).toMatch(/BROKEN for turns/);
  });

  it('still reports plain HEALTHY when nothing is turn-blocking', () => {
    // The scoped verdict must not leak into the ordinary case.
    expect(src()).toMatch(/HEALTHY — all checks passed/);
  });
});

/**
 * dimagi-internal/ace#1338 — the mechanism #1189 shipped could not fire in
 * the state that matters most.
 *
 * `/ace:turn` preflight printed `PASS gog_auth: … live scopes OK` and
 * `Verdict: HEALTHY` on a machine whose mailbox could not make a single Gmail
 * call. Six threads aged 9–22 days — including an external partner's answers
 * to our own scoping questions — sat unread because the inbox was silently
 * unreachable.
 *
 * `_gog_probe` classified FAILURE with a denylist of error substrings
 * (`insufficientPermissions`, `invalid_grant`, `token expired|revoked`,
 * `unauthorized`). With NO token for the configured client, gog emits none of
 * them — it emits `No auth for gmail <mailbox>.` No match → classified OK, on
 * all three probes, so GOG_MISSING stayed empty and the pass branch fired.
 *
 * Two things were wrong, and the second is the general one:
 *
 *  1. ACE re-derived a check canopy already owns. `canopy email preflight`
 *     returns a real exit code and the exact remediation; ACE hand-rolled a
 *     grep over another system's error vocabulary. CLAUDE.md § "don't locally
 *     reimplement what the shared engine already provides — diagnostics
 *     included" now names this as its canonical case.
 *  2. A denylist asks "does this look like a known error?" The authoritative
 *     signal is the SUCCESS shape: a `--json` probe must parse as JSON.
 *     Anything else is a failure, whatever it says — so gog can add error
 *     strings without silently un-arming the probe.
 */
describe('gog_auth probes the success shape, not an error denylist (#1338)', () => {
  it('calls canopy email preflight rather than grepping gog stderr', () => {
    expect(src(), 'the Gmail leg must defer to the shared engine').toMatch(
      /canopy email preflight/,
    );
  });

  it('no longer classifies failure by an error-substring denylist', () => {
    const body = src();
    for (const retired of [
      /insufficient\(Permissions/,
      /ACCESS_TOKEN_SCOPE_INSUFFICIENT/,
      /invalid_grant\|token \(expired\|revoked\)/,
    ]) {
      expect(body, `retired denylist fragment still present: ${retired}`).not.toMatch(retired);
    }
  });

  it('classifies a --json probe by whether it parses as JSON', () => {
    expect(src()).toMatch(/_gog_json_ok\(\)/);
  });

  it('surfaces the gmail_config vs gog_auth client mismatch', () => {
    // Same run printed `client=ace` (from .env ACE_GMAIL_CLIENT) and
    // `client=canopy` (from config/agent.json), both PASS, with nothing
    // reconciling them — the #1147 residual.
    expect(src()).toMatch(/gmail_client_mismatch/);
  });
});
