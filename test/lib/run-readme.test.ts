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
import { generateRunReadme } from '../../lib/run-readme.js';

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
