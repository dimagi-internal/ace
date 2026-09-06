import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  handoffNamesNovaAuthHalt,
  routeNovaCacheRemediation,
  unroutedRemediation,
} from '../../lib/nova-cache-routing.js';
import type { SessionHandoff } from '../../lib/session-handoff.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CTX = { cacheFile: '/Users/x/.claude/mcp-needs-auth-cache.json', clearResult: 'cleared' };

function handoff(over: Partial<SessionHandoff> = {}): SessionHandoff {
  return {
    written_at: new Date().toISOString(),
    reason: 'Phase 3 halted; resume after restart.',
    established: [],
    ...over,
  };
}

/**
 * The real handoff quoted in ace#1769's body, written by the session that
 * halted 14 minutes before the one that then re-ran the restart it had already
 * proved useless.
 */
const REAL_HANDOFF_REASON =
  'Nova MCP bound the WRONG PRINCIPAL — list_apps returned June apps from another project. ' +
  'A plain restart does NOT clear this. Remedy: /mcp -> nova -> "Clear authentication", then Cmd-Q.';

describe('handoffNamesNovaAuthHalt — the correlation itself', () => {
  it('recognises the real handoff from the filed repro', () => {
    expect(handoffNamesNovaAuthHalt(handoff({ reason: REAL_HANDOFF_REASON }))).toBe(true);
  });

  it.each([
    'plugin:nova:nova stuck in the needs-auth cache; restart required.',
    'nova exposes only authenticate/complete_authentication.',
    'Halted on nova_header_readiness fail — no Authorization header reaching Nova.',
    'nova headersHelper returned {}; OAuth token lacks nova.hq.read.',
    'Nova MCP returned scope_missing on every call.',
  ])('recognises: %s', (reason) => {
    expect(handoffNamesNovaAuthHalt(handoff({ reason }))).toBe(true);
  });

  it('reads the established facts too, not only the reason', () => {
    expect(
      handoffNamesNovaAuthHalt(
        handoff({
          reason: 'Usage limit reached mid-phase.',
          established: ['run resolved', 'nova is stuck in the needs-auth cache'],
        }),
      ),
    ).toBe(true);
  });

  /**
   * The failure mode that matters most: a handoff about Nova that has NOTHING
   * to do with auth must not route a cache verdict, because routing it would
   * send a genuine first occurrence away from the restart that fixes it.
   */
  it.each([
    'Nova finished the Deliver app; resuming at Phase 4.',
    'Nova build succeeded, app_id 6f997f65. Next: app-deploy.',
    'Halted on usage limit during nova autobuild; nothing is wrong with the app.',
  ])('does NOT fire on a non-auth Nova handoff: %s', (reason) => {
    expect(handoffNamesNovaAuthHalt(handoff({ reason }))).toBe(false);
  });

  it.each([
    'Connect session expired; re-run /ace:connect-login. Clear authentication in the browser.',
    'OCS needs auth — run /ace:ocs-login.',
  ])('does NOT fire when the auth halt is not Nova: %s', (reason) => {
    expect(handoffNamesNovaAuthHalt(handoff({ reason }))).toBe(false);
  });

  it('does not fire on no handoff at all', () => {
    expect(handoffNamesNovaAuthHalt(null)).toBe(false);
    expect(handoffNamesNovaAuthHalt(undefined)).toBe(false);
  });
});

describe('routeNovaCacheRemediation — one branch, not two', () => {
  /** The defect, stated as a test: the branch the handoff refutes is GONE. */
  it('drops the FIRST-occurrence restart entirely once a handoff confirms recurrence', () => {
    const r = routeNovaCacheRemediation({
      cleared: true,
      ...CTX,
      handoff: handoff({ reason: REAL_HANDOFF_REASON }),
      handoffAgeMs: 14 * 60 * 1000,
    });
    expect(r.routing).toBe('recurrence');
    expect(r.recurrence).toBe('confirmed-by-handoff');
    expect(r.remediation).not.toMatch(/FIRST occurrence/i);
    expect(r.remediation).toMatch(/^RECURRENCE —/);
  });

  it('quotes the handoff age, so the routing is auditable rather than implicit', () => {
    const r = routeNovaCacheRemediation({
      cleared: true,
      ...CTX,
      handoff: handoff({ reason: REAL_HANDOFF_REASON }),
      handoffAgeMs: 14 * 60 * 1000,
    });
    expect(r.remediation).toContain('handoff written 14m ago');
  });

  it('routes to nova_header_readiness, the probe that actually self-heals', () => {
    const r = routeNovaCacheRemediation({
      cleared: true,
      ...CTX,
      handoff: handoff({ reason: REAL_HANDOFF_REASON }),
    });
    expect(r.remediation).toContain('nova_header_readiness');
    expect(r.remediation).toMatch(/Do NOT go to \/mcp/);
  });

  it('routes on the auto-clear-failed path too, not just the cleared one', () => {
    const r = routeNovaCacheRemediation({
      cleared: false,
      cacheFile: CTX.cacheFile,
      clearResult: 'helper not present; run /ace:update',
      handoff: handoff({ reason: REAL_HANDOFF_REASON }),
    });
    expect(r.routing).toBe('recurrence');
    expect(r.remediation).not.toMatch(/FIRST occurrence/i);
    expect(r.remediation).toContain('helper not present');
  });

  /**
   * Absence of a handoff is NOT evidence of a first occurrence — a session can
   * die without writing one. So the un-evidenced case is left exactly as it
   * shipped, and says so.
   */
  it.each([
    ['no handoff', null],
    ['a handoff about something else', handoff({ reason: 'Usage limit; resume Phase 6.' })],
  ])('stays unrouted with %s', (_label, h) => {
    const r = routeNovaCacheRemediation({ cleared: true, ...CTX, handoff: h as SessionHandoff | null });
    expect(r.routing).toBe('unrouted');
    expect(r.recurrence).toBe('not-established');
    expect(r.remediation).toMatch(/FIRST occurrence/);
  });
});

/**
 * The un-evidenced path must be provably untouched. These compare the string
 * this module emits against the one literally embedded in `bin/ace-doctor`
 * before this change, so a future edit to either side that forgets the other
 * fails here rather than silently forking the operator's instructions.
 */
describe('the unrouted string is byte-identical to what ace-doctor ships', () => {
  const doctor = readFileSync(join(REPO, 'bin', 'ace-doctor'), 'utf8');

  function shipped(marker: string): string {
    const line = doctor
      .split('\n')
      .find((l) => l.includes('PF_NOVA_CACHE_REMEDIATION="') && l.includes(marker));
    expect(line, `no ace-doctor line carrying ${marker}`).toBeTruthy();
    return line!.slice(line!.indexOf('"') + 1, line!.lastIndexOf('"'));
  }

  it('matches the auto-cleared branch', () => {
    const expected = shipped('has been CLEARED automatically')
      .replace(/\$PF_NOVA_CACHE_FILE/g, CTX.cacheFile)
      .replace(/\$PF_NOVA_CACHE_CLEAR_RESULT/g, CTX.clearResult);
    expect(unroutedRemediation(true, CTX)).toBe(expected);
  });

  it('matches the auto-clear-failed branch', () => {
    const ctx = { cacheFile: CTX.cacheFile, clearResult: 'helper not present; run /ace:update' };
    const expected = shipped('auto-clear did not apply')
      .replace(/\$PF_NOVA_CACHE_FILE/g, ctx.cacheFile)
      .replace(/\$PF_NOVA_CACHE_CLEAR_RESULT/g, ctx.clearResult);
    expect(unroutedRemediation(false, ctx)).toBe(expected);
  });
});

/**
 * Structural wiring. The logic above is pure and well covered, but the defect in
 * ace#1769 was never inside a function — it was that NOTHING CALLED one. These
 * pin the two call sites and their fallbacks so a future edit to `bin/ace-doctor`
 * cannot quietly return it to printing both branches.
 */
describe('bin/ace-doctor calls the router, in both places that print this remedy', () => {
  const doctor = readFileSync(join(REPO, 'bin', 'ace-doctor'), 'utf8');

  it('invokes scripts/nova-cache-route.ts twice — preflight and the full doctor', () => {
    expect(doctor.match(/scripts\/nova-cache-route\.ts/g) ?? []).toHaveLength(2);
  });

  it('preflight emits the recurrence field, so the routing is visible not implicit', () => {
    expect(doctor).toContain('recurrence: ${PF_NOVA_CACHE_RECURRENCE}');
    expect(doctor).toContain('PF_NOVA_CACHE_RECURRENCE="not-established"');
  });

  /**
   * The router must never be able to make things worse. Both call sites are
   * guarded on tsx being present and on a non-empty parse, so a missing
   * dependency or a helper crash leaves the shipped strings untouched — which is
   * exactly what happened the first time these controls ran, in a worktree with
   * no `npm ci`.
   */
  it('guards both call sites on tsx being executable', () => {
    expect(doctor).toContain('if [ -x "$PF_TSX_BIN" ]; then');
    expect(doctor).toContain('if [ -x "$DOC_TSX_BIN" ]; then');
  });

  it('preflight only overrides when BOTH fields came back non-empty', () => {
    expect(doctor).toContain(
      'if [ -n "$PF_NOVA_CACHE_ROUTE_REC" ] && [ -n "$PF_NOVA_CACHE_ROUTE_REM" ]; then',
    );
  });

  it('the full-doctor banner is placed ahead of the FIRST-occurrence branch', () => {
    const i = doctor.indexOf('${NOVA_CACHE_RECURRENCE_BANNER}');
    const j = doctor.indexOf('FIRST occurrence: Cmd-Q Claude Code and reopen');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
  });
});
