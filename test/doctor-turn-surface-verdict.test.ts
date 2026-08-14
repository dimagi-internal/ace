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
      /warn_turn "gog_auth: GOG token for \$GMAIL_ACCT cannot call Gmail/,
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
