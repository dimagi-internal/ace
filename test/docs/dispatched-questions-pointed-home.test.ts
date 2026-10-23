import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A teammate's own Claude Code asks ACE questions with `canopy agent dispatch`,
 * and that is the wrong place for a question ACE adds nothing to.
 *
 * On 2026-10-23 two `connect` editors sent 17 read-only questions (PR reviews,
 * Labs data, a summary doc) that way. Each dispatch started a fresh cloud
 * session. 12 of the replies were cut at exactly 2,000 characters in the
 * turn's result_note. The follow-ups ("LABS-0012b", "retry 1", "c") each began
 * in another new session and redid the review, because a dispatch cannot reach
 * an earlier session. Neither person held an ACE licence, so neither had ever
 * run `canopy agent use ace`, the setup that puts ACE in their own session.
 *
 * Pinned: explain-ace tells people when to use their own session and when to
 * dispatch, and CLAUDE.md tells a dispatched session to answer and point them
 * home, keeping inside the reply limit.
 *
 * ace#3279.
 */

const ROOT = join(__dirname, '..', '..');
const flat = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');

describe('dispatched questions are pointed home', () => {
  it('explain-ace § 3 separates your own Claude Code from a dispatch', () => {
    const doc = flat('skills/explain-ace/SKILL.md');
    expect(doc).toContain('`canopy agent use ace`');
    expect(doc).toContain('`canopy agent dispatch --slug ace` is for work that needs ACE itself');
    expect(doc).toMatch(/cut at 2,000 characters/);
    expect(doc).toMatch(/ACE's access, not theirs/);
  });

  it("CLAUDE.md tells a dispatched session to answer, then point the sender to their own session", () => {
    const doc = flat('CLAUDE.md');
    expect(doc).toContain('A dispatched question that needs nothing of ACE\'s own is answered, then pointed home.');
    expect(doc).toContain('`canopy agent use ace`');
    expect(doc).toMatch(/Keep to any length the brief states/);
  });
});
