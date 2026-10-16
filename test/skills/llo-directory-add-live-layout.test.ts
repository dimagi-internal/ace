// skills/llo-directory-add reads the LLO Directory's layout from connect-labs main
// at run time; it must never carry its own copy (dimagi-internal/ace#2920).
// Observed: the hand-run directory add on ace@ inbox thread 1a13cd3b541fd3ab
// (2026-10-14), which rediscovered the layout by hand and got a row off by one.
//
// connect-labs' parser is the directory's contract — it finds columns by header
// text and refuses a missing one — and the sheet is maintained by hand, so the
// columns move. A copy in ACE is a plausible guess that goes stale silently.
//
// NEGATIVE CONTROL: KNOWN_LAYOUT is the layout as it stood at connect-labs
// 6ecaf66. It exists only so this test can detect a pasted copy; nothing in
// production reads it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const SKILL = 'skills/llo-directory-add/SKILL.md';
const LIB = 'lib/llo-directory.ts';
const SCRIPT = 'scripts/llo-directory.ts';

const KNOWN_LAYOUT = {
  directoryId: '19sqU7xpSb_0VX6H_QZK2dcRz0RvXiQ1En9kvSZkEiY8',
  orgOnlyColumns: [
    'Has Used Connect',
    'Year of Establishment',
    'Org Team Size',
    'Countries of Operation',
    'Regions/States of Operation',
    'Office Address',
    'Latest MSA Link',
    'Latest Work Order Link',
  ],
};

describe('llo-directory-add reads the layout live', () => {
  const skill = read(SKILL);

  it('frontmatter name matches the directory and the skill is dispatchable', () => {
    expect(skill).toMatch(/^---\nname: llo-directory-add\n/);
    expect(skill).toMatch(/^disable-model-invocation: false$/m);
  });

  it('names every connect-labs source it depends on', () => {
    for (const ref of [
      'connect_labs/marketplace/directory.py',
      'connect_labs/marketplace/quality.py',
      'connect_labs/marketplace/management/commands/marketplace_import.py',
      'DIRECTORY_ID',
      'ORGANIZATIONS_TAB',
      'CONTACTS_TAB',
      'ORG_COLUMNS',
      'HQ_CITY',
      'CONTACT_COLUMNS',
      '_header_key',
      '_fold',
    ]) {
      expect(skill, `${SKILL} must reference ${ref}`).toContain(ref);
    }
  });

  it('the helper fetches those modules from connect-labs main, not a pinned sha', () => {
    const lib = read(LIB);
    const script = read(SCRIPT);
    expect(lib).toContain("CONNECT_LABS_REPO = 'dimagi-internal/connect-labs'");
    expect(script).toMatch(/contents\/\$\{file\}\?ref=main/);
    expect(script).toContain('assertUpstreamRulesUnchanged');
  });

  for (const file of [SKILL, LIB, SCRIPT]) {
    it(`${file} carries no copy of the sheet id or labs' org column list`, () => {
      const text = read(file);
      expect(text).not.toContain(KNOWN_LAYOUT.directoryId);
      const copied = KNOWN_LAYOUT.orgOnlyColumns.filter((h) => text.includes(h));
      expect(copied, `${file} names labs-required org columns: ${copied.join(', ')}`).toEqual([]);
    });
  }

  it('writes to an exact row with RAW input, never append', () => {
    const script = read(SCRIPT);
    expect(script).toContain("'sheets', 'update'");
    // Data is RAW; USER_ENTERED only for a copied formula cell (ace#2957). Behaviour: test/scripts/llo-directory-apply.test.ts.
    expect(read(LIB)).toContain("input: 'RAW'");
    expect(script).not.toMatch(/sheets', 'append|sheets_append/);
    expect(skill).toMatch(/never `append`/);
  });

  it('the skill writes through `apply`, never by running printed shell strings (ace#2956)', () => {
    expect(skill).toContain('scripts/llo-directory.ts" apply');
    expect(read(SCRIPT)).not.toMatch(/\.join\(' '\)/);
  });

  it('reads both rows back and tells the requester the import is what reaches labs', () => {
    expect(skill).toContain('scripts/llo-directory.ts" verify');
    expect(skill).toMatch(/labs does not see the org yet/);
    expect(skill).toMatch(/approval-gated/i);
  });
});
