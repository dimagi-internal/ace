/**
 * dimagi-internal/ace#1276 item 3 — `iterate-state.yaml.runner` silently
 * overrode the documented default.
 *
 * `commands/iterate.md` documents `--runner web|local` as **"default `web`;
 * the observable runner"**, and `iterate-loop.md` prefers web for the same
 * reason. But a resumed campaign reads `runner` out of `iterate-state.yaml`,
 * so an inherited `runner: local` — carried in from an ARCHIVED campaign —
 * silently selects the failure-prone path with no warning, even on a fresh
 * `--new-golden` lock.
 *
 * The runner documented as *the* observable one is the one you don't get. On
 * the bednet campaign (2026-08-14, plugin 0.13.790) that cost two dead
 * iteration attempts and ~50 min of Nova/HQ work stranded: one 41-minute run
 * whose entire log was the 15 bytes `Execution error`, and one killed by the
 * operator's session limit after 9 minutes of real work with artifacts already
 * written to Drive.
 *
 * Items 1, 2 and 4 of that issue are already shipped — `bin/ace-run-supervise`
 * (stream-json + recorded session id), the pre-dispatch runner preflight, and
 * the `aborted-infra` disposition. This is the remaining one.
 */
import { describe, it, expect } from 'vitest';
import { resolveRunner, DEFAULT_RUNNER } from '../../lib/iterate-runner-precedence.js';

describe('resolveRunner (#1276 item 3)', () => {
  it('documents web as the default', () => {
    expect(DEFAULT_RUNNER).toBe('web');
  });

  it('uses the default when nothing is specified', () => {
    const r = resolveRunner({});
    expect(r.runner).toBe('web');
    expect(r.warning).toBeUndefined();
  });

  it('an explicit --runner always wins, with no warning', () => {
    const r = resolveRunner({ cliRunner: 'local', stateRunner: 'web' });
    expect(r.runner).toBe('local');
    expect(r.warning).toBeUndefined();
  });

  it('honours an inherited state runner but WARNS that it diverges from the default', () => {
    const r = resolveRunner({ stateRunner: 'local' });
    expect(r.runner).toBe('local');
    expect(r.warning).toMatch(/iterate-state\.yaml/);
    expect(r.warning).toMatch(/observable/i);
  });

  it('does not warn when the state runner agrees with the default', () => {
    expect(resolveRunner({ stateRunner: 'web' }).warning).toBeUndefined();
  });

  it('--new-golden takes the DEFAULT, never the archived value', () => {
    const r = resolveRunner({ stateRunner: 'local', isNewGolden: true });
    expect(r.runner).toBe('web');
    expect(r.warning).toMatch(/archiv/i);
  });

  it('--new-golden still respects an explicit --runner', () => {
    const r = resolveRunner({ cliRunner: 'local', stateRunner: 'local', isNewGolden: true });
    expect(r.runner).toBe('local');
    expect(r.warning).toBeUndefined();
  });

  it('rejects an unknown runner rather than falling through to a default', () => {
    expect(() => resolveRunner({ cliRunner: 'cloud' as any })).toThrow(/cloud/);
  });

  it('names the source of the decision, so a campaign log can be audited', () => {
    expect(resolveRunner({ cliRunner: 'local' }).source).toBe('cli');
    expect(resolveRunner({ stateRunner: 'local' }).source).toBe('iterate-state');
    expect(resolveRunner({}).source).toBe('default');
    expect(resolveRunner({ stateRunner: 'local', isNewGolden: true }).source).toBe('default');
  });
});
