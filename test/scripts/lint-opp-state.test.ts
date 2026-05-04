/**
 * Unit tests for the per-opp `run_state.yaml` lint function.
 *
 * Backs the `state-yaml-lint` doctor sub-command introduced in 0.11.6.
 * The lint enforces the convention documented in
 * `agents/ace-orchestrator.md` § Scope boundaries: per-opp
 * `run_state.yaml` is for opp state, not plugin-wide bug tracking.
 */
import { describe, it, expect } from 'vitest';
import { lintBacklogEntries } from '../../scripts/lint-opp-state.js';

describe('lintBacklogEntries', () => {
  it('returns empty for state with no phase_X_backlog keys', () => {
    expect(lintBacklogEntries({})).toEqual([]);
    expect(lintBacklogEntries({ phases: { foo: 'bar' } })).toEqual([]);
  });

  it('returns empty when backlog entries describe per-opp work', () => {
    const state = {
      phase_3_backlog: [
        {
          id: 'leep-stub-program-cleanup',
          summary: 'Stub program f3164651-... created accidentally during Phase 3 probing; manual web-UI cleanup needed.',
          location: 'ACE/leep-paint-collection/connect/',
        },
      ],
      phase_5_backlog: [
        {
          id: 'mobile-bootstrap-not-run',
          summary: '~/.ace/connect-app.apk absent; Phase 5 ran in STUB mode',
          location: '~/.ace/, ACE/leep-paint-collection/screenshots/',
        },
      ],
    };
    expect(lintBacklogEntries(state)).toEqual([]);
  });

  it('flags entries whose location starts with a plugin source path', () => {
    const state = {
      phase_3_backlog: [
        {
          id: 'connect-create-opportunity-fallback-fails',
          summary: 'connect_create_opportunity playwright fallback returns 500 for managed opps',
          location: 'mcp/connect/backends/playwright.ts',
        },
        {
          id: 'training-deck-renders-empty',
          summary: 'training-deck-build leaves the title slide empty when ACE_TRAINING_DECK_TEMPLATE_ID is unset',
          location: 'skills/training-deck-build/',
        },
      ],
    };
    const findings = lintBacklogEntries(state);
    expect(findings.length).toBe(2);
    expect(findings[0].entry_id).toBe('connect-create-opportunity-fallback-fails');
    expect(findings[0].reason).toBe('location-in-plugin-source');
    expect(findings[1].entry_id).toBe('training-deck-renders-empty');
  });

  it('flags entries whose summary uses plugin-wide language', () => {
    const state = {
      phase_2_backlog: [
        {
          id: 'commcare-download-ccz-marker-counter-bug',
          summary: 'mcp atom commcare_download_ccz returns wrong marker counts.',
          location: 'ACE/leep-paint-collection/notes/',  // location is fine, summary triggers
        },
        {
          id: 'nova-plugin-7-unwanted-wrappers',
          summary: 'See nova-plugin#7 — every Nova app emits unwanted commcareconnect wrappers.',
          // no location field at all
        },
        {
          id: 'all-opps-need-this',
          summary: 'All opps will need this fix once Connect deploys PR #1135.',
        },
      ],
    };
    const findings = lintBacklogEntries(state);
    expect(findings.length).toBe(3);
    expect(findings.every((f) => f.reason === 'summary-plugin-wide-language')).toBe(true);
    expect(findings.map((f) => f.entry_id).sort()).toEqual([
      'all-opps-need-this',
      'commcare-download-ccz-marker-counter-bug',
      'nova-plugin-7-unwanted-wrappers',
    ]);
  });

  it('does NOT flag location-only matches when the entry is also per-opp scoped', () => {
    // The location-prefix check is a strong signal — if location starts
    // with a plugin source path, that's enough to flag regardless of
    // summary content. This test confirms the prefix check is what fires.
    const state = {
      phase_4_backlog: [
        {
          id: 'leep-ocs-typo',
          summary: 'OCS bot wrote ace@dimagi.com once instead of ace@dimagi-ai.com (P24 in deep eval)',
          location: 'mcp/ocs/system-prompt-stencil.md',
        },
      ],
    };
    const findings = lintBacklogEntries(state);
    expect(findings.length).toBe(1);
    expect(findings[0].reason).toBe('location-in-plugin-source');
  });

  it('walks every phase_X_backlog key (phase_2, phase_3, phase_4, phase_5, ...)', () => {
    const state = {
      phase_2_backlog: [{ id: 'a', summary: 'see nova-plugin#5' }],
      phase_3_backlog: [{ id: 'b', summary: 'every connect app needs this' }],
      phase_4_backlog: [{ id: 'c', summary: 'mcp atom is broken' }],
      phase_5_backlog: [{ id: 'd', summary: 'all opps will hit this' }],
      phase_6_backlog: [{ id: 'e', summary: 'any future run needs the patch' }],
      // Decoy keys that should be ignored:
      backlog: [{ id: 'ignored', location: 'mcp/foo' }],
      phase_open: [{ id: 'ignored', location: 'mcp/foo' }],
    };
    const findings = lintBacklogEntries(state);
    expect(findings.map((f) => f.entry_id).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('skips entries that are not objects (defensive against malformed YAML)', () => {
    const state = {
      phase_3_backlog: [
        null,
        'a-string-entry',
        42,
        { id: 'real', summary: 'mcp atom broken' },
      ],
    };
    const findings = lintBacklogEntries(state);
    expect(findings.length).toBe(1);
    expect(findings[0].entry_id).toBe('real');
  });

  it('uses <no-id> when an entry has no id field', () => {
    const state = {
      phase_3_backlog: [
        { summary: 'mcp atom broken' },
      ],
    };
    const findings = lintBacklogEntries(state);
    expect(findings.length).toBe(1);
    expect(findings[0].entry_id).toBe('<no-id>');
  });
});
