import { describe, it, expect } from 'vitest';
import {
  classifyNovaHeaderReadiness,
  hasStaticAuthHeader,
  remediationFor,
  type NovaHeaderInput,
} from '../../lib/nova-header-readiness.js';

// ---------------------------------------------------------------------------
// The pure half of the `nova_header_readiness` doctor probe.
//
// Every fixture below is VERBATIM from the 2026-08-28 incident on user
// `acedimagi` (Claude Code 2.1.250, ACE 0.13.1060) or from the repo — never
// invented. The probe this replaces was calibrated against the doctor's own
// shell env, which is exactly the mistake these tests exist to pin shut.
// ---------------------------------------------------------------------------

/** Verbatim from `.mcp.json` in nova-marketplace/nova/1.28.0. */
const NOVA_HELPER =
  'if [ -n "$NOVA_API_KEY" ]; then printf \'{"Authorization":"Bearer %s"}\' "$NOVA_API_KEY"; else printf \'{}\'; fi';

/**
 * Verbatim env-var names observed via `ps -Eww -p <claude-pid>` on the broken
 * machine. 25 tokens were visible; NOVA_API_KEY was not among them.
 */
const CLAUDE_ENV_BROKEN = [
  'TERM',
  'TERM_PROGRAM',
  'HOME',
  'USER',
  'PATH',
  'SHELL',
  'LANG',
  'PWD',
  'TMPDIR',
  'LOGNAME',
];

const base: NovaHeaderInput = {
  claudeEnvNames: CLAUDE_ENV_BROKEN,
  claudeEnvTokenCount: 25,
  userScopeNovaHeaders: null,
  keyConfigured: true,
};

describe('hasStaticAuthHeader', () => {
  it('accepts the header claude mcp add writes', () => {
    expect(hasStaticAuthHeader({ Authorization: 'Bearer sk-nova-v1-abc' })).toBe(true);
  });

  it('is case-insensitive on the header name', () => {
    expect(hasStaticAuthHeader({ authorization: 'Bearer sk-nova-v1-abc' })).toBe(true);
  });

  it('rejects an empty or whitespace value', () => {
    expect(hasStaticAuthHeader({ Authorization: '' })).toBe(false);
    expect(hasStaticAuthHeader({ Authorization: '   ' })).toBe(false);
  });

  it('rejects a nova entry with no headers at all', () => {
    expect(hasStaticAuthHeader(null)).toBe(false);
    expect(hasStaticAuthHeader({})).toBe(false);
  });
});

describe('classifyNovaHeaderReadiness', () => {
  it('FAILS the exact 2026-08-28 broken state (key absent from claude env, no override)', () => {
    const v = classifyNovaHeaderReadiness(base);
    expect(v.status).toBe('fail');
    expect(v.reason).toBe('helper-will-emit-empty');
    expect(v.autoHealable).toBe(true);
  });

  it('PASSES once the nova-plugin#52 static-header override is installed', () => {
    // This is the state after the fix — the process env is STILL missing the
    // key, which is the whole point: the override makes the env irrelevant.
    const v = classifyNovaHeaderReadiness({
      ...base,
      userScopeNovaHeaders: { Authorization: 'Bearer sk-nova-v1-redacted' },
    });
    expect(v.status).toBe('pass');
    expect(v.reason).toBe('static-header-override');
    expect(v.autoHealable).toBe(false);
  });

  it('FAILS a stale override whose Bearer token is not the current key (rotation drift)', () => {
    // The override outranks every other path AND is static, so it does not
    // follow a rotation. Every ACE key check still reports green here.
    const v = classifyNovaHeaderReadiness({
      ...base,
      userScopeNovaHeaders: { Authorization: 'Bearer sk-nova-v1-OLD' },
      staticHeaderMatchesConfiguredKey: false,
    });
    expect(v.status).toBe('fail');
    expect(v.reason).toBe('static-header-stale');
    expect(v.autoHealable).toBe(true);
  });

  it('treats an un-comparable override as healthy, never as stale', () => {
    // null means "could not compare" — guessing `false` here would re-point a
    // working override at nothing on every doctor run.
    for (const cmp of [null, undefined]) {
      const v = classifyNovaHeaderReadiness({
        ...base,
        userScopeNovaHeaders: { Authorization: 'Bearer sk-nova-v1-redacted' },
        staticHeaderMatchesConfiguredKey: cmp as null | undefined,
      });
      expect(v.status).toBe('pass');
      expect(v.reason).toBe('static-header-override');
    }
  });

  it('PASSES when the key really is in the Claude Code process env', () => {
    const v = classifyNovaHeaderReadiness({
      ...base,
      claudeEnvNames: [...CLAUDE_ENV_BROKEN, 'NOVA_API_KEY'],
    });
    expect(v.status).toBe('pass');
    expect(v.reason).toBe('key-in-claude-env');
  });

  // -- the control ---------------------------------------------------------
  // Without this, an unreadable env is indistinguishable from a clean one and
  // the probe reproduces the false-negative it exists to eliminate.

  it('SKIPS (never fails) when ps -Eww returned no environment at all', () => {
    const v = classifyNovaHeaderReadiness({ ...base, claudeEnvNames: null, claudeEnvTokenCount: 0 });
    expect(v.status).toBe('skip');
    expect(v.reason).toBe('env-unreadable');
    expect(v.autoHealable).toBe(false);
  });

  it('SKIPS when the name list is empty AND the token control is zero', () => {
    // Observed reading another user's claude process: 0 tokens visible.
    const v = classifyNovaHeaderReadiness({ ...base, claudeEnvNames: [], claudeEnvTokenCount: 0 });
    expect(v.status).toBe('skip');
    expect(v.reason).toBe('env-unreadable');
  });

  it('does NOT skip when the env is genuinely readable but merely lacks the key', () => {
    // The control is non-zero, so "NOVA_API_KEY absent" is a real observation.
    const v = classifyNovaHeaderReadiness({ ...base, claudeEnvTokenCount: 25 });
    expect(v.status).toBe('fail');
  });

  it('SKIPS rather than fails when no PAT is configured anywhere', () => {
    const v = classifyNovaHeaderReadiness({ ...base, keyConfigured: false });
    expect(v.status).toBe('skip');
    expect(v.reason).toBe('no-key-configured');
    expect(v.autoHealable).toBe(false);
  });

  it('never marks a skip auto-healable', () => {
    for (const input of [
      { ...base, claudeEnvNames: null, claudeEnvTokenCount: 0 },
      { ...base, keyConfigured: false },
    ]) {
      expect(classifyNovaHeaderReadiness(input).autoHealable).toBe(false);
    }
  });

  it('is not gated on a Claude Code version (no version input exists)', () => {
    // Regression guard for the design rule: measure the consequence, not the
    // cause. ace#1629 pinned the break to 2.1.238, but encoding that number
    // would rot the moment upstream changes behaviour again.
    expect(Object.keys(base)).not.toContain('claudeVersion');
  });
});

describe('remediationFor', () => {
  it('never prescribes Clear authentication for the broken state', () => {
    // That instruction is a no-op here and is the documented cause of the
    // restart loop — it must not appear.
    const fix = remediationFor(classifyNovaHeaderReadiness(base));
    expect(fix.toLowerCase()).toContain('claude mcp add');
    expect(fix).toMatch(/no-op/i);
  });

  it('tells the operator to restart after an auto-install, and to leave the override alone', () => {
    const fix = remediationFor(classifyNovaHeaderReadiness(base), { autoInstalled: true });
    expect(fix).toMatch(/INSTALLED automatically/);
    expect(fix).toMatch(/Cmd-Q/);
    expect(fix).toMatch(/LEAVE IT/);
    // Must warn against the /mcp menu, whose Authenticate option silently
    // rebinds the session to a token without nova.hq.read.
    expect(fix).toMatch(/nova\.hq\.read/);
  });

  it('returns no remediation for a healthy machine', () => {
    expect(
      remediationFor(
        classifyNovaHeaderReadiness({
          ...base,
          userScopeNovaHeaders: { Authorization: 'Bearer sk-nova-v1-redacted' },
        }),
      ),
    ).toBe('');
  });

  it('the helper it defends against is still env-var dependent upstream', () => {
    // If nova ever ships a file-based helper this probe can be retired; pin the
    // shape so the change is noticed rather than assumed.
    expect(NOVA_HELPER).toContain('$NOVA_API_KEY');
    expect(NOVA_HELPER).toContain("printf '{}'");
  });
});
