/**
 * dimagi-internal/ace#3330 — the fence atoms surface a pending
 * `operator_stop_after_phase` directive in their own results, so a repair
 * branch that re-runs ONE check still sees it.
 *
 * Behaviour is pinned on the pure helper; the wiring half (both atoms spread
 * it into their result) is pinned structurally against the server source,
 * because the atoms are inline `server.tool` closures with no exported handler.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { operatorStopFor, withOperatorStop } from '../../lib/operator-stop.js';
import { classifyPhaseProducts, validatePhaseProductsFragment } from '../../lib/phase-products-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '../../mcp/google-drive-server.ts'), 'utf8');

const armed = (phase: string, status = 'pending') => ({
  operator_stop_after_phase: {
    phase,
    status,
    requested_at: '2026-10-28T21:35:00Z',
    requested_by: 'jjackson@dimagi.com',
  },
  phases: { 'commcare-setup': { status: 'done' } },
});

describe('operatorStopFor (ace#3330)', () => {
  it('fires_now when pending AND naming the checked phase (the smallholder-seasonal/20261028-1636 shape)', () => {
    const s = operatorStopFor(armed('commcare-setup'), 'commcare-setup');
    expect(s).toMatchObject({ phase: 'commcare-setup', status: 'pending', fires_now: true });
    expect(s!.note).toMatch(/Do NOT dispatch the next phase/);
    expect(s!.note).toMatch(/repair branches included/);
  });

  it('is reported but does not fire at a different phase boundary', () => {
    const s = operatorStopFor(armed('connect-setup'), 'commcare-setup');
    expect(s).toMatchObject({ phase: 'connect-setup', status: 'pending', fires_now: false });
  });

  it('does not fire once it has fired', () => {
    const s = operatorStopFor(armed('commcare-setup', 'fired'), 'commcare-setup');
    expect(s).toMatchObject({ status: 'fired', fires_now: false });
  });

  it('REGRESSION CONTROL: absent block → undefined, and the spread adds no key', () => {
    const rs = { phases: { 'commcare-setup': { status: 'done' } } };
    expect(operatorStopFor(rs, 'commcare-setup')).toBeUndefined();
    expect(withOperatorStop(rs, 'commcare-setup')).toEqual({});
    expect(withOperatorStop(null, 'commcare-setup')).toEqual({});
  });

  it('a malformed block is surfaced (never silently dropped) without firing', () => {
    const s = operatorStopFor({ operator_stop_after_phase: 'commcare-setup' }, 'commcare-setup');
    expect(s).toMatchObject({ phase: null, status: null, fires_now: false });
  });
});

describe('the fence atoms return it (wiring)', () => {
  it('imports the helper', () => {
    expect(SERVER_SRC).toMatch(/import \{ withOperatorStop \} from '\.\.\/lib\/operator-stop\.js'/);
  });

  it('classify_phase_writeback spreads it into its result', () => {
    expect(SERVER_SRC).toMatch(
      /return result\(\{ phase: phaseName, status, \.\.\.withOperatorStop\(parsed, phaseName\) \}\)/,
    );
  });

  it('verify_phase_products spreads it into its result', () => {
    expect(SERVER_SRC).toMatch(
      /return result\(\{ \.\.\.classifyPhaseProducts\(parsed, phase\), \.\.\.withOperatorStop\(parsed, phase\) \}\)/,
    );
  });

  it('both atom descriptions name the field so the model knows to read it', () => {
    for (const atom of ['classify_phase_writeback', 'verify_phase_products']) {
      const i = SERVER_SRC.indexOf(`'${atom}',`);
      expect(i).toBeGreaterThan(-1);
      expect(SERVER_SRC.slice(i, i + 4000)).toMatch(/operator_stop: \{phase, status, fires_now, note\}/);
    }
  });

  it('the composed verify_phase_products result carries operator_stop alongside ok', () => {
    const rs = armed('commcare-setup');
    const r = { ...classifyPhaseProducts(rs, 'commcare-setup'), ...withOperatorStop(rs, 'commcare-setup') };
    expect(r.operator_stop?.fires_now).toBe(true);
    expect(r).toHaveProperty('ok');
  });
});

describe("build_status accepts 'released' (ace#3330 secondary)", () => {
  it('a Phase 3 apps block with build_status: released validates', () => {
    const res = validatePhaseProductsFragment('commcare-setup', {
      apps: {
        learn: { hq_app_id: 'abc', build_status: 'released' },
        deliver: { hq_app_id: 'def', build_status: 'released' },
      },
    });
    expect(res.valid).toBe(true);
  });

  it('an unknown value is still rejected', () => {
    const res = validatePhaseProductsFragment('commcare-setup', {
      apps: { learn: { hq_app_id: 'abc', build_status: 'shipped' } },
    });
    expect(res.valid).toBe(false);
  });
});
