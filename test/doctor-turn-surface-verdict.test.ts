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
      // Renamed with the identity retirement: the missing thing is now a
      // config/agent.json field, not an env var (ace#1147 follow-up).
      /warn_turn "gog_auth: config\/agent\.json email or gog_client not set/,
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

  it('does not treat canopy preflight exit code as the Gmail verdict (ace#1741)', () => {
    const body = src();
    // `canopy email preflight` reports more than the mailbox and exits
    // non-zero for advisories that leave it perfectly usable — most often
    // "installed canopy engine lags the marketplace clone". Reading that
    // aggregate code as the Gmail leg declared a WORKING mailbox dead,
    // turn-blocking, while printing `OK: gog Gmail ready` as its evidence.
    //
    // On a non-zero exit the probe must settle it with the direct capability
    // check, not by parsing canopy prose.
    expect(body).toMatch(/GOG_PREFLIGHT_RC=\$\?/);
    expect(body).toMatch(/_gog_probe gmail gmail labels list/);
    // The old shape — bare `$?` straight into the gmail verdict — must be gone.
    expect(body).not.toMatch(/if \[ \$\? -eq 0 \]; then GOG_OK="\$GOG_OK gmail"/);
  });

  it('keeps a non-Gmail preflight advisory NON-blocking (ace#1741)', () => {
    const body = src();
    // The advisory must still be reported — losing it would be the opposite
    // over-correction — but it must not be turn-blocking, because the mailbox
    // works.
    expect(body).toMatch(/gog_preflight_advisory/);
    const line = body.split('\n').find((l) => l.includes('gog_preflight_advisory:'));
    expect(line, 'advisory line not found').toBeTruthy();
    expect(line!, 'the advisory must use warn, never warn_turn').not.toMatch(/warn_turn/);
  });

  it('classifies a --json probe by whether it parses as JSON', () => {
    expect(src()).toMatch(/_gog_json_ok\(\)/);
  });

  it('reads the gog identity from config/agent.json, never from .env', () => {
    // The mismatch this used to assert on is now unrepresentable: `.env.tpl`
    // no longer declares the identity keys, so there is one source, not two.
    // What must hold is that every probe reads THAT one.
    expect(src()).toMatch(/agent_json_field\(\)/);
    expect(src()).toMatch(/GMAIL_ACCT="\$\(agent_json_field email\)"/);
    expect(src()).toMatch(/GMAIL_CLIENT="\$\(agent_json_field gog_client\)"/);
    // and that no probe falls back to the retired env vars
    expect(src()).not.toMatch(/get_env ACE_GMAIL_CLIENT\)"\s*$/m);
  });

  it('still flags a retired identity key left behind in an installed .env', () => {
    // Nothing reads it any more, so it is not a failure — but a stale
    // `ACE_GMAIL_CLIENT=ace` line will mislead the next person who greps.
    expect(src()).toMatch(/gmail_identity_residual/);
  });
});
