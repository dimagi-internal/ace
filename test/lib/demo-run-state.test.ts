/**
 * Tests for `lib/demo-run-state.ts` — the minimal structural run-state a
 * standalone `/ace:demo` run scaffolds. Asserts the emitted shape satisfies
 * the Phase Write-Back Contract (via `classifyPhaseWriteBack`) with exactly
 * one live phase and every other pipeline phase `skipped`.
 */

import { describe, it, expect } from 'vitest';
import { buildDemoRunState, DEMO_LIVE_PHASE } from '../../lib/demo-run-state.js';
import { classifyPhaseWriteBack } from '../../lib/run-state-validator.js';

describe('buildDemoRunState', () => {
  const rs = buildDemoRunState({
    demoName: 'op-ensorvation-nutrition',
    runId: 'demo-20260720-1200',
    source: 'denovo',
    createdAt: '2026-07-20T12:00:00Z',
  });

  it('marks only the synthetic phase live; all others skipped', () => {
    expect(rs.phases[DEMO_LIVE_PHASE].status).toBe('in_progress');
    expect(rs.phases['connect-setup'].status).toBe('skipped');
    expect(rs.phases['idea-to-design'].status).toBe('skipped');
  });

  it('records demo run_type and the source provider on the live phase', () => {
    expect(rs.run_type).toBe('demo');
    const provider = (rs.phases[DEMO_LIVE_PHASE].products as
      | { synthetic?: { source?: { provider?: string } } }
      | undefined)?.synthetic?.source?.provider;
    expect(provider).toBe('denovo');
  });

  it('the live phase passes the write-back classifier (not malformed)', () => {
    expect(classifyPhaseWriteBack(rs, DEMO_LIVE_PHASE)).toBe('in_progress');
  });

  it('every non-live pipeline phase is a valid skipped block', () => {
    for (const name of Object.keys(rs.phases)) {
      if (name === DEMO_LIVE_PHASE) continue;
      expect(rs.phases[name].status).toBe('skipped');
      expect(classifyPhaseWriteBack(rs, name)).toBe('skipped');
    }
  });

  it('does not include partnership-video phases (ordinals > 10)', () => {
    expect(rs.phases['partnership-research']).toBeUndefined();
    expect(rs.phases['closeout']).toBeDefined();
  });
});
