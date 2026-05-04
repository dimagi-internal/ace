/**
 * Unit tests for the cruft detector.
 *
 * Backs the `state-yaml-cruft` doctor sub-command introduced in 0.11.7.
 * Enforces the convention documented in `agents/ace-orchestrator.md`
 * § Cruft management — resolved entries should live under `archive:`,
 * not in the active `open_questions:` / `phase_X_backlog:` blocks.
 */
import { describe, it, expect } from 'vitest';
import { detectCruft, detectResolvedInBlock } from '../../scripts/lint-opp-cruft.js';

describe('detectResolvedInBlock', () => {
  it('returns empty for a non-array entries argument', () => {
    expect(detectResolvedInBlock('open_questions', undefined)).toEqual([]);
    expect(detectResolvedInBlock('open_questions', null)).toEqual([]);
    expect(detectResolvedInBlock('open_questions', 'string')).toEqual([]);
    expect(detectResolvedInBlock('open_questions', { id: 'foo' })).toEqual([]);
  });

  it('flags entries with resolution_phase: starting "resolved"', () => {
    const entries = [
      { id: 'a', resolution_phase: 'resolved-in-0.10.91' },
      { id: 'b', resolution_phase: 'Resolved 2026-05-03' },
      { id: 'c', resolution_phase: 'phase-3-connect-opp-setup' },
    ];
    const f = detectResolvedInBlock('open_questions', entries);
    expect(f.length).toBe(2);
    expect(f.map((x) => x.entry_id)).toEqual(['a', 'b']);
    expect(f.every((x) => x.reason === 'resolution_phase-starts-resolved')).toBe(true);
  });

  it('flags entries with default_in_use: starting "(resolved"', () => {
    const entries = [
      { id: 'a', default_in_use: '(resolved - assessment-removal patch class)' },
      { id: 'b', default_in_use: '(Resolved – ACE 0.10.67 isAuthenticated fix)' },
      { id: 'c', default_in_use: 'A. Flat $150 globally' },
    ];
    const f = detectResolvedInBlock('open_questions', entries);
    expect(f.length).toBe(2);
    expect(f.map((x) => x.entry_id)).toEqual(['a', 'b']);
    expect(f.every((x) => x.reason === 'default_in_use-resolved-marker')).toBe(true);
  });

  it('flags entries whose summary starts with "RESOLVED "', () => {
    const entries = [
      { id: 'a', summary: 'RESOLVED 2026-05-03 — root cause was…' },
      { id: 'b', summary: 'resolved 2026-05-02 by 0.10.67' },
      { id: 'c', summary: 'Stub program needs manual cleanup' },
    ];
    const f = detectResolvedInBlock('phase_3_backlog', entries);
    expect(f.length).toBe(2);
    expect(f.map((x) => x.entry_id)).toEqual(['a', 'b']);
    expect(f.every((x) => x.reason === 'summary-starts-resolved')).toBe(true);
  });

  it('flags entries whose summary contains "RESOLVED in <version>"', () => {
    const entries = [
      { id: 'a', summary: 'The thing was RESOLVED in 0.10.67 by the auth fix.' },
      { id: 'b', summary: 'Also resolved in 0.11.4 along the way.' },
      { id: 'c', summary: 'Open: needs manual verification before close.' },
    ];
    const f = detectResolvedInBlock('phase_4_backlog', entries);
    expect(f.length).toBe(2);
    expect(f.map((x) => x.entry_id)).toEqual(['a', 'b']);
    expect(f.every((x) => x.reason === 'summary-resolved-in-version')).toBe(true);
  });

  it('flags entries whose note: contains "RESOLVED in <version>"', () => {
    const entries = [
      {
        id: 'commcare-download-ccz-marker-counter-bug',
        summary: 'CCZ marker counter returns wrong values',
        note: 'RESOLVED in 0.10.60 (CCZ marker counter inflate fix). Verified.',
      },
      {
        id: 'still-open',
        summary: 'Stub LLO invite needs follow-up',
        note: 'pending operator action',
      },
    ];
    const f = detectResolvedInBlock('phase_2_backlog', entries);
    expect(f.length).toBe(1);
    expect(f[0].entry_id).toBe('commcare-download-ccz-marker-counter-bug');
    expect(f[0].reason).toBe('note-resolved-in-version');
  });

  it('uses <no-id> for an entry missing the id field', () => {
    const f = detectResolvedInBlock('open_questions', [
      { summary: 'RESOLVED 2026-05-03 — fixed' },
    ]);
    expect(f[0].entry_id).toBe('<no-id>');
  });

  it('only fires once per entry (first matching heuristic wins)', () => {
    // Entry has BOTH resolution_phase AND default_in_use markers.
    const entries = [
      {
        id: 'a',
        resolution_phase: 'resolved-in-0.10.91',
        default_in_use: '(resolved - assessment-removal)',
        summary: 'RESOLVED 2026-05-03 — also matches summary',
      },
    ];
    const f = detectResolvedInBlock('open_questions', entries);
    expect(f.length).toBe(1);
    expect(f[0].reason).toBe('resolution_phase-starts-resolved');
  });
});

describe('detectCruft', () => {
  it('returns empty for non-object inputs', () => {
    expect(detectCruft(null)).toEqual([]);
    expect(detectCruft(undefined)).toEqual([]);
    expect(detectCruft('string')).toEqual([]);
    expect(detectCruft(42)).toEqual([]);
  });

  it('walks open_questions + every phase_*_backlog block', () => {
    const state = {
      open_questions: [{ id: 'oq', resolution_phase: 'resolved-in-0.10.67' }],
      phase_2_backlog: [{ id: 'p2', summary: 'RESOLVED 2026-04-01' }],
      phase_3_backlog: [{ id: 'p3', summary: 'still open' }],
      phase_4_backlog: [{ id: 'p4', default_in_use: '(resolved)' }],
      phase_5_backlog: [{ id: 'p5', note: 'RESOLVED in 0.11.4' }],
      // Decoy keys — should be ignored
      phase_status: 'whatever',
      backlog: [{ id: 'ignored', summary: 'RESOLVED' }],
    };
    const f = detectCruft(state);
    expect(f.map((x) => `${x.block}.${x.entry_id}`).sort()).toEqual([
      'open_questions.oq',
      'phase_2_backlog.p2',
      'phase_4_backlog.p4',
      'phase_5_backlog.p5',
    ]);
  });

  it('skips entries already living under archive:', () => {
    const state = {
      open_questions: [{ id: 'still-open', summary: 'TBD' }],
      archive: {
        open_questions: [
          { id: 'already-archived', summary: 'RESOLVED 2026-05-03', resolved_at: '2026-05-03T12:00Z' },
        ],
        phase_3_backlog: [
          { id: 'already-archived-p3', resolution_phase: 'resolved-in-0.10.91' },
        ],
      },
    };
    expect(detectCruft(state)).toEqual([]);
  });

  it('handles a real LEEP-style state (multiple resolved + open mixed)', () => {
    const state = {
      open_questions: [
        // Open
        { id: 'per-form-payment-rate', summary: 'TBD; default $12 FLW / $18 LLO' },
        // Resolved (via resolution_phase)
        { id: 'createOpportunity-mcp-backend',
          summary: 'RESOLVED 2026-05-03 — assessment-removal patch',
          resolution_phase: 'resolved-in-0.10.91',
          default_in_use: '(resolved - assessment-removal patch class)' },
        // Resolved (via default_in_use only)
        { id: 'ocs-playwright-session-auto-recovery',
          summary: 'isAuthenticated needed maxRedirects:0',
          default_in_use: '(resolved - no workaround needed)' },
        // Open
        { id: 'mobile-bootstrap-not-run', summary: '~/.ace/connect-app.apk absent' },
      ],
      phase_2_backlog: [
        { id: 'commcare-download-ccz-marker-counter-bug',
          summary: 'mcp atom returns wrong counts',
          note: 'RESOLVED in 0.10.60 — leaving entry for historical record' },
      ],
      phase_3_backlog: [
        { id: 'connect-create-opportunity-playwright-fallback-still-fails',
          summary: 'RESOLVED 2026-05-03 in ACE 0.10.91 — assessment-removal patch' },
      ],
    };
    const f = detectCruft(state);
    const ids = f.map((x) => x.entry_id).sort();
    // Should detect 4: createOpportunity-mcp-backend (resolution_phase),
    // ocs-playwright-session-auto-recovery (default_in_use),
    // commcare-download-ccz-marker-counter-bug (note),
    // connect-create-opportunity-playwright-fallback-still-fails (summary).
    expect(ids).toEqual([
      'commcare-download-ccz-marker-counter-bug',
      'connect-create-opportunity-playwright-fallback-still-fails',
      'createOpportunity-mcp-backend',
      'ocs-playwright-session-auto-recovery',
    ]);
  });
});
