/**
 * Tests for `lib/run-readme.ts::generateRunReadme`.
 *
 * Regression coverage for jjackson/ace#637: the `render_run_readme`
 * atom documents LONG phase-agent-file keys (`idea-to-design`,
 * `commcare-setup`, `connect-setup`, `ocs-setup`, …) but the manifest
 * (and thus the row lookup) uses SHORT `Phase` keys (`design`,
 * `commcare`, `connect`, `ocs`, …). Before the fix, passing the long
 * keys silently no-opped for the four mismatched pairs — their rows
 * stayed `pending` while `scenarios-and-acceptance` / `qa-and-training`
 * / `synthetic-data-and-workflows` / `solicitation-management` (where
 * long==short) flipped to `done`. The mapping must be TOTAL over both
 * key-spaces.
 */

import { describe, it, expect } from 'vitest';
import { generateRunReadme, phaseStatusFromRunState } from '../../lib/run-readme.js';

/** Extract the Status cell for the first row whose path starts with `folderPrefix`. */
function statusFor(markdown: string, folderPrefix: string): string | undefined {
  for (const line of markdown.split('\n')) {
    // table rows look like: | 1-design | idea-to-pdd.md | idea-to-pdd | done |
    const m = line.match(/^\|\s*([^|]+?)\s*\|[^|]*\|[^|]*\|\s*([^|]+?)\s*\|$/);
    if (m && m[1].startsWith(folderPrefix)) return m[2];
  }
  return undefined;
}

// long agent-file key → the N-folder prefix whose rows it should flip
const LONG_KEY_TO_FOLDER: Record<string, string> = {
  'idea-to-design': '1-design',
  'scenarios-and-acceptance': '2-scenarios',
  'commcare-setup': '3-commcare',
  'connect-setup': '4-connect',
  'ocs-setup': '5-ocs',
  'qa-and-training': '6-qa-and-training',
  'synthetic-data-and-workflows': '7-synthetic',
  'solicitation-management': '8-solicitation-management',
  'execution-manager': '9-execution-manager',
  'closeout': '10-closeout',
};

// short Phase key → the N-folder prefix (the four that historically differed)
const SHORT_KEY_TO_FOLDER: Record<string, string> = {
  design: '1-design',
  commcare: '3-commcare',
  connect: '4-connect',
  ocs: '5-ocs',
  'execution-management': '9-execution-manager',
};

describe('generateRunReadme phaseStatus key mapping (#637)', () => {
  it('flips rows for EVERY long phase-agent-file key (none silently stay pending)', () => {
    const allDone = Object.fromEntries(
      Object.keys(LONG_KEY_TO_FOLDER).map((k) => [k, 'done' as const]),
    );
    const md = generateRunReadme('20260601-0651', allDone);
    for (const [key, folder] of Object.entries(LONG_KEY_TO_FOLDER)) {
      expect(statusFor(md, folder), `${key} → ${folder} should be done`).toBe('done');
    }
  });

  it('still accepts internal short Phase keys', () => {
    const md = generateRunReadme('20260601-0651', {
      design: 'done',
      commcare: 'in-progress',
      connect: 'skipped',
      ocs: 'done',
    });
    expect(statusFor(md, '1-design')).toBe('done');
    expect(statusFor(md, '3-commcare')).toBe('in-progress');
    expect(statusFor(md, '4-connect')).toBe('skipped');
    expect(statusFor(md, '5-ocs')).toBe('done');
  });

  it('the four historically-broken pairs (#637) map identically from long and short keys', () => {
    for (const [shortKey, folder] of Object.entries(SHORT_KEY_TO_FOLDER)) {
      const longKey = Object.entries(LONG_KEY_TO_FOLDER).find(
        ([, f]) => f === folder,
      )![0];
      const fromLong = statusFor(generateRunReadme('r', { [longKey]: 'done' }), folder);
      const fromShort = statusFor(generateRunReadme('r', { [shortKey]: 'done' }), folder);
      expect(fromLong, `${longKey} → ${folder}`).toBe('done');
      expect(fromShort, `${shortKey} → ${folder}`).toBe('done');
      expect(fromLong).toBe(fromShort);
    }
  });

  it('defaults unspecified phases to pending and ignores unknown keys', () => {
    const md = generateRunReadme('r', { 'not-a-real-phase': 'done' } as any);
    expect(statusFor(md, '1-design')).toBe('pending');
    expect(statusFor(md, '8-solicitation-management')).toBe('pending');
  });
});

/**
 * `phaseStatusFromRunState` — the derivation that makes the README refresh
 * STRUCTURAL instead of remembered.
 *
 * The old contract asked the orchestrator to (a) remember to call
 * `render_run_readme` at every phase boundary and (b) hand-assemble the phase
 * status map. On `spark-facilitator/20260813-2126` neither happened: the run
 * completed 8 phases and shipped a 96-row README with every row `pending`.
 * `verify_phase_artifacts` — already unconditional at every boundary, already
 * holding `runFolderId`, already reading `run_state.yaml` — now derives the map
 * with this function and rewrites the README itself. These tests pin the
 * derivation; the round-trip into rendered rows is pinned below it.
 */
describe('phaseStatusFromRunState', () => {
  it('derives the status map straight from a run_state phases block', () => {
    expect(
      phaseStatusFromRunState({
        phases: {
          'idea-to-design': { status: 'done' },
          'scenarios-and-acceptance': { status: 'done' },
          'commcare-setup': { status: 'in_progress' },
          'connect-setup': { status: 'pending' },
        },
      }),
    ).toEqual({
      'idea-to-design': 'done',
      'scenarios-and-acceptance': 'done',
      'commcare-setup': 'in-progress',
      'connect-setup': 'pending',
    });
  });

  it('maps every run_state phase status onto a README status', () => {
    const m = phaseStatusFromRunState({
      phases: {
        'idea-to-design': { status: 'complete' }, // legacy synonym for done
        'commcare-setup': { status: 'partial' },
        'connect-setup': { status: 'blocked' },
        'ocs-setup': { status: 'error' },
        'qa-and-training': { status: 'skipped' },
        'closeout': { status: 'deferred' },
      },
    });
    expect(m).toEqual({
      'idea-to-design': 'done',
      'commcare-setup': 'partial',
      'connect-setup': 'blocked',
      'ocs-setup': 'error',
      'qa-and-training': 'skipped',
      closeout: 'skipped',
    });
  });

  it('is total and non-throwing on junk — a README is an index, not a gate', () => {
    expect(phaseStatusFromRunState(undefined)).toEqual({});
    expect(phaseStatusFromRunState({})).toEqual({});
    expect(phaseStatusFromRunState({ phases: 'nope' })).toEqual({});
    expect(phaseStatusFromRunState({ phases: [] })).toEqual({});
    expect(phaseStatusFromRunState({ phases: { 'idea-to-design': {} } })).toEqual({});
    expect(phaseStatusFromRunState({ phases: { 'idea-to-design': { status: 'weird' } } })).toEqual({});
  });

  it('round-trips into rendered rows: a finished run never renders all-pending', () => {
    const runState = {
      phases: {
        'idea-to-design': { status: 'done' },
        'scenarios-and-acceptance': { status: 'done' },
        'commcare-setup': { status: 'done' },
        'connect-setup': { status: 'done' },
        'ocs-setup': { status: 'done' },
        'qa-and-training': { status: 'done' },
        'synthetic-data-and-workflows': { status: 'done' },
        'solicitation-management': { status: 'done' },
      },
    };
    const md = generateRunReadme('20260813-2126', phaseStatusFromRunState(runState));
    for (const folder of [
      '1-design',
      '2-scenarios',
      '3-commcare',
      '4-connect',
      '5-ocs',
      '6-qa-and-training',
      '7-synthetic',
      '8-solicitation-management',
    ]) {
      expect(statusFor(md, folder), folder).toBe('done');
    }
    // …and the phases that did NOT run stay pending.
    expect(statusFor(md, '10-closeout')).toBe('pending');
  });
});
