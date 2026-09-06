import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyLine, extractRefs, ACK_WINDOW_LINES } from '../../lib/upstream-asks.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * ace#1798. `_app-component-library.md` Table A is titled "closed at the
 * platform surface" and its rows open "Closed on all three surfaces" — where
 * "closed" means the CONSTRAINT is permanent, i.e. maximally live. A bare
 * /\bclosed\b/i historical marker therefore suppressed every row in the one
 * table this probe most needs to read, and the probe reported a clean repo
 * while a retired upstream closure sat in Table A steering builds wrong.
 */
describe('classifyLine — Table A must not be suppressed by its own vocabulary', () => {
  it('flags a Table A row that asserts a permanent platform closure', () => {
    const row =
      "| **Reading a case property into a followup form's field** | Closed on all " +
      'three surfaces, each proven live on this Nova instance. (1) `case-ref` parts ' +
      'are REJECTED app-wide (voidcraft-labs/commcare-nova#458). (2) `caseWrite` is ' +
      'WRITE-ONLY. |';
    expect(classifyLine(row, row)).toBe(true);
  });

  it('still treats a genuine issue-closure note as history', () => {
    for (const line of [
      'voidcraft-labs/commcare-nova#458 closed COMPLETED on 2026-08-15.',
      'voidcraft-labs/nova-plugin#8 closed 2026-06-03, so the workaround is gone.',
      'That upstream closed, so ACE no longer needs the shim (voidcraft-labs/nova-plugin#8).',
      'This was fixed upstream in voidcraft-labs/nova-plugin#12.',
    ]) {
      expect(classifyLine(line, line), line).toBe(false);
    }
  });

  it('still flags an ordinary live-constraint citation', () => {
    const line = 'Blocked on voidcraft-labs/nova-plugin#52 — no static-header helper yet.';
    expect(classifyLine(line, line)).toBe(true);
  });
});

/**
 * ace#2050. A bare `commcare-nova#458` does not match REF_RE (`owner/repo#n`),
 * so the probe drops it silently — **invisible, not merely unflagged**. That is
 * strictly worse than a misclassified citation, because no amount of
 * classifier tuning can ever reach it.
 *
 * This is a RATCHET, not a clean bill of health. `GUARDED` is the set of files
 * proven clean; the rest of the repo still carries owner-less refs and is a
 * ledger to pay down (see the second test). Add files to `GUARDED` as they are
 * normalised — never remove one.
 *
 * CLAUDE.md joined the set because it is where the cost was actually measured:
 * it opened with "ONE open Nova upstream bug — commcare-nova#545" for four days
 * after that issue closed COMPLETED, and `probe-upstream-asks.ts` — which exists
 * precisely to catch a closed issue still cited as live — reported a clean repo,
 * because both of that line's #545 citations were owner-less. ace#2050 was filed
 * against `classifyLine`'s acknowledgement window; measured, `classifyLine` was
 * never consulted for that line at all.
 */
const GUARDED = ['CLAUDE.md', 'skills/_app-component-library.md'] as const;

/** Repos ACE cites without an owner often enough to be worth catching. */
const BARE_REF =
  /(^|[^/\w-])(commcare-nova|nova-plugin|nova-marketplace|commcare-connect|open-chat-studio)#(\d+)/g;

describe('citations in scanned docs carry an owner prefix', () => {
  for (const rel of GUARDED) {
    it(`${rel} has no owner-less upstream refs`, () => {
      const content = readFileSync(join(REPO, rel), 'utf8');
      const bare = [...content.matchAll(BARE_REF)];
      expect(
        bare.map((m) => `${m[2]}#${m[3]}`),
        `owner-less upstream refs in ${rel} are INVISIBLE to probe-upstream-asks — ` +
          'REF_RE requires owner/repo#n, so these are never classified at all. ' +
          'Write the full slug (e.g. voidcraft-labs/commcare-nova#545).',
      ).toEqual([]);
    });
  }

  /**
   * The ledger. Not a failure — a count that must not grow. Pinning it makes a
   * new offender visible in a diff, and shrinking it is a one-line edit here.
   */
  it('the un-normalised backlog outside GUARDED does not grow (ace#2050)', () => {
    const tracked = execFileSync(
      'git',
      ['ls-files', 'skills', 'lib', 'agents', 'docs', 'playbook', 'commands', 'scripts', 'templates'],
      { cwd: REPO, encoding: 'utf8' },
    )
      .split('\n')
      .filter((f) => /\.(md|ts)$/.test(f))
      .filter((f) => !(GUARDED as readonly string[]).includes(f));

    const offenders = tracked.filter((f) =>
      new RegExp(BARE_REF.source).test(readFileSync(join(REPO, f), 'utf8')),
    );

    expect(
      offenders.length,
      `files with owner-less upstream refs (was 12 at ace#2050; add normalised files to ` +
        `GUARDED and lower this number — never raise it):\n  ${offenders.join('\n  ')}`,
    ).toBeLessThanOrEqual(12);
  });

  it('extractRefs sees the retired case-ref row citation', () => {
    const file = join(REPO, 'skills', '_app-component-library.md');
    const refs = extractRefs(file, readFileSync(file, 'utf8'));
    expect(refs.some((r) => r.slug === 'voidcraft-labs/commcare-nova#458')).toBe(true);
  });
});

describe('the retired row is cited as history', () => {
  it('Table A no longer asserts the case-ref closure as live', () => {
    const file = join(REPO, 'skills', '_app-component-library.md');
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    const i = lines.findIndex((l) => l.includes('Reading a case property into a followup'));
    expect(i, 'case-ref row not found').toBeGreaterThan(-1);
    const ctx = lines.slice(i, i + 1 + ACK_WINDOW_LINES).join('\n');
    expect(classifyLine(lines[i], ctx)).toBe(false);
  });
});
