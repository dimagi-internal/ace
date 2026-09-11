import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A GitHub issue or PR is not a deliverable to a programme counterpart
 * (dimagi-internal/ace#2386).
 *
 * ACE's replies to the poverty-graduation design author cited issues and PRs
 * as the record of the turn's work — seven links in the 2026-09-11 draft on
 * thread 19f86579142e6ba5, three in the 2026-09-10 reply — and once answered a
 * question that was hers to settle with an issue number instead of asking it.
 * She cannot open the tracker.
 *
 * Jon, 2026-09-11: "Why would Sophie be able to do anything with a github
 * issue, generally, sharing that you create an issue is an anti-pattern,
 * because what would the end user do about it?"
 *
 * Nothing in ACE said otherwise, and the fleet rule pulled the other way:
 * canopy's `agent-core/turn.md` REQUIRES "EXACT LINKS … the changed skill(s)
 * and the PR(s)" for internal stakeholders and exempts only
 * "external-counterpart comms", so a dimagi-associate.com design author who
 * steers the build reads as neither. The test is not internal-vs-external, it
 * is whether the recipient can act on the link.
 *
 * This file pins the rule in the two places a reply is shaped — the triage
 * step that drafts it and the review that gates it. The sibling ace#2378 test
 * pins WHICH link leads; this one pins which links belong at all.
 */

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Both files are prose wrapped at ~100 columns, so a pinned phrase can straddle
 *  a line break. Assert against a whitespace-flattened view — the rule is what
 *  the sentence says, not where the margin happened to fall. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('a tracker link is never a counterpart deliverable (ace#2386)', () => {
  it('agent-turn-review §F bans citing an issue/PR as a deliverable or receipt', () => {
    const doc = read('skills/agent-turn-review/SKILL.md');
    const f = flat(doc.slice(doc.indexOf('## F. ACE specifics')));
    expect(f, '§F not found').not.toBe('');
    expect(f).toContain('Never cite a GitHub issue or PR to a programme counterpart');
    expect(f).toMatch(/deliverable or a receipt of work/);
    expect(f).toContain('SEE or DO differently');
    expect(f).toContain('ace#2386');
  });

  it('agent-turn-review §F states the act-on-it test, not internal-vs-external', () => {
    const f = flat(read('skills/agent-turn-review/SKILL.md'));
    expect(f).toMatch(/not internal-vs-external/i);
    expect(f).toMatch(/whether the recipient can act on/i);
  });

  it('agent-turn-review §F scopes the improvement section to the operator', () => {
    const f = flat(read('skills/agent-turn-review/SKILL.md'));
    expect(f).toContain('how I improved this turn');
    expect(f).toMatch(/whatever their email domain/);
  });

  it('agent-turn-review §F keeps the asked-for-by-number exception narrow', () => {
    const f = flat(read('skills/agent-turn-review/SKILL.md'));
    expect(f).toMatch(/asked for BY NUMBER/);
    expect(f).toMatch(/never as evidence of activity/);
  });

  it('inbox-triage step 2d: a defect that is a question gets ASKED, not filed at them', () => {
    const doc = read('skills/inbox-triage/SKILL.md');
    const step2d = flat(
      doc.slice(doc.indexOf('d. **Decide the intent'), doc.indexOf('e. **Approval step')),
    );
    expect(step2d, 'step 2d not found').not.toBe('');
    expect(step2d).toContain('Never cite a GitHub issue or PR');
    expect(step2d).toMatch(/is ASKED as a question/);
    expect(step2d).toMatch(/asked for BY NUMBER/);
    expect(step2d).toContain('ace#2386');
  });
});
