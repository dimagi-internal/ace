import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ace-web is the human surface for a run; Google Drive is ACE's storage
 * (dimagi-internal/ace#2378).
 *
 * The default had quietly been the other way round. From 2026-09-02 ACE's
 * replies to the poverty-graduation design author (thread 19f86579142e6ba5)
 * linked Google Docs and HQ app pages, never the run's ace-web page — which
 * existed the whole time as `run_state.yaml`'s `ace_web_summary_url`. Nothing
 * a session reads at start said otherwise: CLAUDE.md named ace-web only as a
 * sibling repo, a PAT and a sweep target.
 *
 * The send path is enforced in code (`bin/ace-email`, pinned by
 * `test/hooks/email-shims.test.ts`). This file pins the half that code cannot
 * reach: the principle is stated in the three places a reply is shaped — the
 * guide every session reads, the triage step that drafts, and the review
 * that gates the draft — and each one points at the rail. Delete a statement
 * and the reply rules drift back to Drive with nothing to say so.
 */

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('the principle is stated where a reply is shaped (ace#2378)', () => {
  it('CLAUDE.md states it as a Convention, with the enforcing test named', () => {
    const doc = read('CLAUDE.md');
    const conventions = doc.slice(doc.indexOf('## Conventions'), doc.indexOf('## Phase preconditions'));
    const bullet = conventions.split('\n').find((l) => l.includes('ace-web is the human surface for a run')) ?? '';
    expect(bullet, 'Conventions bullet missing').not.toBe('');
    expect(bullet).toContain('Google Drive is ACE');
    expect(bullet).toContain('ace_web_summary_url');
    expect(bullet).toContain('bin/ace-email');
    expect(bullet).toContain('--no-run-page');
    expect(bullet).toContain('test/hooks/email-shims.test.ts');
  });

  it('CLAUDE.md says what ace-web is FOR, not only that it is a sibling repo', () => {
    const line = read('CLAUDE.md').split('\n').find((l) => l.startsWith('**Sibling repo:**')) ?? '';
    expect(line).toMatch(/where humans review a run/);
  });

  it('inbox-triage step 2d: a reply about a run leads with its ace-web page', () => {
    const doc = read('skills/inbox-triage/SKILL.md');
    const step2d = doc.slice(doc.indexOf('d. **Decide the intent'), doc.indexOf('e. **Approval step'));
    expect(step2d).toContain("A reply about a run leads with that run's ace-web page");
    expect(step2d).toContain('ace_web_summary_url');
    expect(step2d).toContain('--no-run-page');
    expect(step2d).toContain('ace#2378');
  });

  it("agent-turn-review §F checks the draft's first link", () => {
    const doc = read('skills/agent-turn-review/SKILL.md');
    const f = doc.slice(doc.indexOf('## F. ACE specifics'));
    expect(f).toContain("A reply about a run leads with the run's ace-web page");
    expect(f).toContain('ace_web_summary_url');
    expect(f).toContain("draft's FIRST link");
    expect(f).toContain('ace#2378');
  });
});
