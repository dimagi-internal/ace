/**
 * ace#2174 — the regression of ace#892 — at the pure layer.
 *
 * ace#892 closed COMPLETED (commit `039c0bdd`, 2026-07-25) having shipped a
 * paragraph of prose in `agents/commcare-setup.md` and two `required: true`
 * rows in `lib/artifact-manifest.ts`. The one test it landed added `'recipes'`
 * to `STRUCTURAL_SUB_FOLDERS` so those new rows would pass MANIFEST LINT — it
 * asserts nothing about enforcement, which is why the class came back six weeks
 * later on `poverty-graduation/20260905-1345` with Phase 3 writing
 * `status: done` / `verdict: pass` over 9 of 10 absent required artifacts.
 *
 * These tests are the ratchet ace#892 never had.
 */
import { describe, it, expect } from 'vitest';
import {
  TERMINAL_COMPLETE_PHASE_STATUSES,
  terminalPhaseWritesIn,
  phaseModeFromMerged,
  formatIncompleteTerminalWriteBack,
} from '../../lib/terminal-phase-writeback.js';
import { diffArtifacts, computeExpectedRequiredArtifacts } from '../../lib/phase-closeout.js';
import { PHASE_STATUS_VALUES } from '../../lib/run-state-validator.js';

describe('terminalPhaseWritesIn', () => {
  it('flags the ace#2174 write verbatim: commcare-setup done, and resolves the manifest key', () => {
    // The patch shape from poverty-graduation/20260905-1345's Phase 3 close.
    const writes = terminalPhaseWritesIn({
      phases: {
        'commcare-setup': {
          status: 'done',
          verdict: 'pass',
          completed_at: '2026-09-07T13:35:00Z',
          summary_artifact: '3-commcare/pdd-to-deliver-app_summary.md',
        },
      },
    });
    expect(writes).toEqual([
      { phaseName: 'commcare-setup', phaseKey: 'commcare', status: 'done' },
    ]);
  });

  it('covers the legacy synonym `complete` — the validator tolerates it, so a guard that missed it would be bypassable by spelling', () => {
    const writes = terminalPhaseWritesIn({
      phases: { 'commcare-setup': { status: 'complete' } },
    });
    expect(writes.map((w) => w.status)).toEqual(['complete']);
  });

  it('`partial` is NOT guarded — it is the escape hatch the refusal points at', () => {
    expect(TERMINAL_COMPLETE_PHASE_STATUSES.has('partial')).toBe(false);
    expect(
      terminalPhaseWritesIn({
        phases: {
          'commcare-setup': { status: 'partial', verdict: 'partial-producer-deferred' },
        },
      }),
    ).toEqual([]);
  });

  it('no other phase status is guarded — a guard on any of them would have no legal terminal write left', () => {
    const guarded = PHASE_STATUS_VALUES.filter((s) =>
      terminalPhaseWritesIn({ phases: { 'commcare-setup': { status: s } } }).length > 0,
    );
    expect(guarded.sort()).toEqual(['complete', 'done']);
  });

  it('accepts the short manifest key-space too (both spellings reach the same fence)', () => {
    expect(terminalPhaseWritesIn({ phases: { commcare: { status: 'done' } } })).toEqual([
      { phaseName: 'commcare', phaseKey: 'commcare', status: 'done' },
    ]);
  });

  it('is merge-mode agnostic: a bare {status} deep-patch is caught exactly like a whole-block write', () => {
    expect(terminalPhaseWritesIn({ phases: { 'ocs-setup': { status: 'done' } } })).toHaveLength(1);
  });

  it('costs nothing on a non-phase write — opp.yaml, decisions.yaml, iterate state', () => {
    expect(terminalPhaseWritesIn({ connect: { program: { id: 4 } } })).toEqual([]);
    expect(terminalPhaseWritesIn({ iterations: [{ verdict: 'clean' }] })).toEqual([]);
    expect(terminalPhaseWritesIn(null)).toEqual([]);
    expect(terminalPhaseWritesIn('nope')).toEqual([]);
    expect(terminalPhaseWritesIn({ phases: 'nope' })).toEqual([]);
  });

  it('skips a phase name in neither key-space rather than rejecting it — naming is the status-enum guard\'s contract, not this one\'s', () => {
    expect(terminalPhaseWritesIn({ phases: { 'not-a-phase': { status: 'done' } } })).toEqual([]);
  });

  it('flags every terminal phase in a multi-phase patch', () => {
    const writes = terminalPhaseWritesIn({
      phases: {
        'idea-to-design': { status: 'done' },
        'commcare-setup': { status: 'done' },
        'connect-setup': { status: 'in_progress' },
      },
    });
    expect(writes.map((w) => w.phaseKey).sort()).toEqual(['commcare', 'design']);
  });
});

describe('phaseModeFromMerged', () => {
  it('reads the mode off the MERGED doc — a bare {status: done} patch must still honour a mode written earlier', () => {
    const merged = {
      phases: { 'qa-and-training': { status: 'done', mode: 'app-QA-only' } },
    };
    expect(phaseModeFromMerged(merged, 'qa-and-training')).toBe('app-QA-only');
  });

  it('app-QA-only actually relaxes the required set — this is what makes reading the merged doc load-bearing (ace#1069)', () => {
    const full = computeExpectedRequiredArtifacts('qa-and-training').length;
    const relaxed = computeExpectedRequiredArtifacts('qa-and-training', {
      mode: 'app-QA-only',
    }).length;
    expect(relaxed).toBeLessThan(full);
  });

  it('returns undefined for an absent block or mode (the full required set then applies)', () => {
    expect(phaseModeFromMerged({}, 'commcare-setup')).toBeUndefined();
    expect(phaseModeFromMerged({ phases: {} }, 'commcare-setup')).toBeUndefined();
    expect(
      phaseModeFromMerged({ phases: { 'commcare-setup': { status: 'done' } } }, 'commcare-setup'),
    ).toBeUndefined();
  });
});

describe('formatIncompleteTerminalWriteBack', () => {
  const write = { phaseName: 'commcare-setup', phaseKey: 'commcare' as const, status: 'done' };

  it('reproduces the ace#2174 Drive state and names the Learn smoke recipe with its producer', () => {
    // Drive `3-commcare/` held exactly one file on that run.
    const report = diffArtifacts('commcare', ['3-commcare/pdd-to-deliver-app_summary.md']);
    expect(report.ok).toBe(false);

    const msg = formatIncompleteTerminalWriteBack(write, report);
    expect(msg).toContain('PHASE_ARTIFACTS_INCOMPLETE');
    expect(msg).toContain('phases.commcare-setup.status = "done"');
    expect(msg).toContain('3-commcare/recipes/journey-learn.yaml (producedBy: app-test-cases)');
    expect(msg).toContain('3-commcare/app-test-cases.yaml (producedBy: app-test-cases)');
    expect(msg).toContain('NO DRIVE WRITE HAPPENED');
  });

  it('names BOTH legal ways forward — an agent told only "refused" retries the identical write', () => {
    const report = diffArtifacts('commcare', []);
    const msg = formatIncompleteTerminalWriteBack(write, report);
    expect(msg).toContain('status: partial');
    expect(msg).toContain('partial-producer-deferred');
    expect(msg).toContain('producedBy');
    expect(msg).toContain('ace#2174');
    expect(msg).toContain('ace#892');
  });

  it('truncates a long missing list rather than emitting an unbounded error string', () => {
    const report = diffArtifacts('qa-and-training', []);
    expect(report.missing.length).toBeGreaterThan(12);
    const msg = formatIncompleteTerminalWriteBack(
      { phaseName: 'qa-and-training', phaseKey: 'qa-and-training', status: 'done' },
      report,
    );
    expect(msg).toMatch(/\+\d+ more/);
  });
});
