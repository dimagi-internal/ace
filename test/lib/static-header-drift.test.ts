/**
 * dimagi-internal/ace#2159 — a user-scope MCP entry pinning a ROTATED
 * `Authorization` header must be named, for every server, not just nova.
 *
 * The four cases the issue names are the four that matter, and the fourth is
 * the one that is easy to get wrong: with no configured key to compare
 * against, the answer must be `null`/`skip` — NEVER `true`/`pass`. A probe that
 * reports "fine" when it could not look is the defect it exists to prevent
 * (same rule as `lib/nova-header-readiness.ts`'s env CONTROL).
 *
 * `test/scripts/doctor-static-header-drift.test.ts` proves it RUNS.
 */
import { describe, it, expect } from 'vitest';
import {
  STATIC_HEADER_SERVERS,
  classifyAllStaticHeaderDrift,
  classifyStaticHeaderDrift,
  hasStaticAuthHeader,
  remediationForStaticHeaderDrift,
  staticAuthBearer,
  staticHeaderMatchesConfiguredKey,
} from '../../lib/static-header-drift';

const CURRENT = 'fw4n2b3RTlrTxYcurrent';
const ROTATED_AWAY = '-XymInnOldTokenValue';

describe('staticAuthBearer', () => {
  it('reads the token case-insensitively and strips the Bearer prefix', () => {
    expect(staticAuthBearer({ Authorization: `Bearer ${CURRENT}` })).toBe(CURRENT);
    expect(staticAuthBearer({ authorization: `bearer ${CURRENT}` })).toBe(CURRENT);
  });

  it('is empty for no headers, no Authorization, or a blank value', () => {
    expect(staticAuthBearer(null)).toBe('');
    expect(staticAuthBearer({})).toBe('');
    expect(staticAuthBearer({ 'X-Api-Key': 'nope' })).toBe('');
    expect(staticAuthBearer({ Authorization: '   ' })).toBe('');
    expect(hasStaticAuthHeader({ Authorization: '   ' })).toBe(false);
  });
});

describe('staticHeaderMatchesConfiguredKey never guesses', () => {
  it('compares when both sides exist', () => {
    expect(staticHeaderMatchesConfiguredKey({ Authorization: `Bearer ${CURRENT}` }, CURRENT)).toBe(true);
    expect(staticHeaderMatchesConfiguredKey({ Authorization: `Bearer ${ROTATED_AWAY}` }, CURRENT)).toBe(false);
  });

  it('returns null — not true — when either side is missing', () => {
    expect(staticHeaderMatchesConfiguredKey(null, CURRENT)).toBeNull();
    expect(staticHeaderMatchesConfiguredKey({ Authorization: `Bearer ${CURRENT}` }, '')).toBeNull();
    expect(staticHeaderMatchesConfiguredKey(null, '')).toBeNull();
  });
});

describe('classifyStaticHeaderDrift — the four cases from ace#2159', () => {
  it('DRIFTED: a rotated connect_labs token fails and is auto-healable', () => {
    const v = classifyStaticHeaderDrift({
      serverName: 'connect_labs',
      headers: { Authorization: `Bearer ${ROTATED_AWAY}` },
      configuredKey: CURRENT,
    });
    expect(v.status).toBe('fail');
    expect(v.reason).toBe('drifted');
    expect(v.matches).toBe(false);
    expect(v.autoHealable).toBe(true);
    expect(v.envKey).toBe('LABS_MCP_TOKEN');
    // The summary is printed verbatim into doctor output — it must never leak a token.
    expect(v.summary).not.toContain(ROTATED_AWAY);
    expect(v.summary).not.toContain(CURRENT);
  });

  it('MATCHING: the pinned token IS the configured one', () => {
    const v = classifyStaticHeaderDrift({
      serverName: 'connect_labs',
      headers: { Authorization: `Bearer ${CURRENT}` },
      configuredKey: CURRENT,
    });
    expect(v.status).toBe('pass');
    expect(v.reason).toBe('matches');
    expect(v.matches).toBe(true);
    expect(v.autoHealable).toBe(false);
  });

  it('ABSENT OVERRIDE: nothing pinned is a skip, and nothing to heal', () => {
    const v = classifyStaticHeaderDrift({
      serverName: 'connect_labs',
      headers: null,
      configuredKey: CURRENT,
    });
    expect(v.status).toBe('skip');
    expect(v.reason).toBe('no-override');
    expect(v.matches).toBeNull();
    expect(v.autoHealable).toBe(false);
  });

  it('NO CONFIGURED KEY: must return null, never true', () => {
    const v = classifyStaticHeaderDrift({
      serverName: 'connect_labs',
      headers: { Authorization: `Bearer ${ROTATED_AWAY}` },
      configuredKey: '',
    });
    expect(v.matches).toBeNull();
    expect(v.matches).not.toBe(true);
    expect(v.status).toBe('skip');
    expect(v.reason).toBe('no-configured-key');
    expect(v.autoHealable).toBe(false);
  });

  it('an unregistered server with a pinned header is unjudgeable, not clean', () => {
    const v = classifyStaticHeaderDrift({
      serverName: 'some-third-party',
      headers: { Authorization: 'Bearer whatever' },
      configuredKey: '',
    });
    expect(v.status).toBe('skip');
    expect(v.reason).toBe('not-registered');
    expect(v.matches).toBeNull();
    expect(v.envKey).toBeNull();
  });
});

describe('heal ownership', () => {
  it('nova drift is reported but NOT auto-healed here — nova_header_readiness owns it', () => {
    const v = classifyStaticHeaderDrift({
      serverName: 'nova',
      headers: { Authorization: `Bearer ${ROTATED_AWAY}` },
      configuredKey: CURRENT,
    });
    expect(v.status).toBe('fail');
    expect(v.reason).toBe('drifted');
    // Two probes writing ~/.claude.json in one doctor run is how you get
    // contradictory output about the same entry.
    expect(v.autoHealable).toBe(false);
    expect(v.healOwner).toBe('nova_header_readiness');
    expect(remediationForStaticHeaderDrift(v)).toContain('nova_header_readiness');
  });

  it('connect_labs is registered against LABS_MCP_TOKEN and owned here', () => {
    const spec = STATIC_HEADER_SERVERS.find((s) => s.server === 'connect_labs');
    expect(spec?.envKey).toBe('LABS_MCP_TOKEN');
    expect(spec?.healOwner).toBeUndefined();
  });
});

describe('classifyAllStaticHeaderDrift walks every entry', () => {
  it('fails the whole probe when ANY entry drifted, and names it', () => {
    const r = classifyAllStaticHeaderDrift({
      entries: [
        { serverName: 'nova', headers: { Authorization: `Bearer ${CURRENT}` }, configuredKey: CURRENT },
        {
          serverName: 'connect_labs',
          headers: { Authorization: `Bearer ${ROTATED_AWAY}` },
          configuredKey: CURRENT,
        },
      ],
    });
    expect(r.verdict).toBe('fail');
    expect(r.drifted.map((d) => d.server)).toEqual(['connect_labs']);
    expect(r.reason).toContain('connect_labs');
    expect(r.reason).toContain('LABS_MCP_TOKEN');
  });

  it('passes only when something was actually compared and agreed', () => {
    const r = classifyAllStaticHeaderDrift({
      entries: [
        { serverName: 'connect_labs', headers: { Authorization: `Bearer ${CURRENT}` }, configuredKey: CURRENT },
      ],
    });
    expect(r.verdict).toBe('pass');
  });

  it('skips — never passes — when nothing could be judged', () => {
    const r = classifyAllStaticHeaderDrift({
      entries: [{ serverName: 'atlassian', headers: null, configuredKey: '' }],
    });
    expect(r.verdict).toBe('skip');
    expect(r.verdict).not.toBe('pass');
  });

  it('skips — never passes — when ~/.claude.json is unreadable', () => {
    const r = classifyAllStaticHeaderDrift({ entries: [], configReadable: false });
    expect(r.verdict).toBe('skip');
    expect(r.reason).toContain('~/.claude.json');
  });
});

describe('remediation', () => {
  it('tells the operator to restart, because the header binds at connection time', () => {
    const v = classifyStaticHeaderDrift({
      serverName: 'connect_labs',
      headers: { Authorization: `Bearer ${ROTATED_AWAY}` },
      configuredKey: CURRENT,
    });
    const healed = remediationForStaticHeaderDrift(v, { autoHealed: true });
    expect(healed).toMatch(/Cmd-Q/);
    expect(healed).toMatch(/reload-plugins/);
    const unhealed = remediationForStaticHeaderDrift(v);
    expect(unhealed).toContain('claude mcp add');
    expect(unhealed).toContain('connect_labs');
  });

  it('is empty when there is nothing to do', () => {
    const ok = classifyStaticHeaderDrift({
      serverName: 'connect_labs',
      headers: { Authorization: `Bearer ${CURRENT}` },
      configuredKey: CURRENT,
    });
    expect(remediationForStaticHeaderDrift(ok)).toBe('');
  });
});
