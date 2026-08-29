import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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

describe('citations in scanned docs carry an owner prefix', () => {
  // A bare `commcare-nova#458` does not match REF_RE (`owner/repo#n`), so the
  // probe drops it silently — invisible, not merely unflagged.
  it('_app-component-library.md has no owner-less upstream refs', () => {
    const file = join(REPO, 'skills', '_app-component-library.md');
    const content = readFileSync(file, 'utf8');
    const bare = [...content.matchAll(/(^|[^/\w-])(commcare-nova|nova-plugin)#(\d+)/g)];
    expect(
      bare.map((m) => `${m[2]}#${m[3]}`),
      'owner-less upstream refs are invisible to probe-upstream-asks',
    ).toEqual([]);
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
