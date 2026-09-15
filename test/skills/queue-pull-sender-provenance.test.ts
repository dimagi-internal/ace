/**
 * The inbox queue pull must not be trusted for the SENDER (dimagi-internal/ace#2399).
 *
 * `gog gmail search ... -j` returns one row per thread whose `date` comes from the
 * thread's NEWEST message and whose `from` comes from its OLDEST. Nothing in the row
 * says so. Measured 2026-09-15 on thread 19f86579142e6ba5:
 *
 *   row:  { date: "2026-09-14 12:26", from: "Neal Lesh <nlesh@dimagi.com>", messageCount: 33 }
 *   read: messages[0]  = 21 Jul 2026, Neal Lesh
 *         messages[-1] = 14 Sep 2026, Sophie Feintuch
 *
 * Both `skills/turn` and `skills/inbox-triage` name that search as the inbox queue
 * pull, and inbox-triage § 1 then applies the standing noise table and presents a
 * "sender" — from a field describing a message 33 messages back. Two failures follow,
 * and the § 2c tier resolution can only save you from the first:
 *
 *   1. A thread STARTED by an internal @dimagi.com colleague and last replied to by an
 *      external party presents on the row as ACT tier — the tier that may steer runs.
 *   2. A thread whose FIRST message came from an auto-dismiss sender but whose newest
 *      message is a real human reply is dropped as noise at § 1 and never reaches § 2.
 *
 * So the caveat has to live where the pull is named, in both files. This test is the
 * ratchet: delete the warning from either skill and CI goes red.
 *
 * SCOPE: a doc-contract test, deterministic and offline — same shape as
 * connect-terminology.test.ts. It asserts the two skills CARRY the caveat; it cannot
 * assert a turn obeyed it.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every skill that names the Gmail search as the turn's inbox queue pull. */
const QUEUE_PULL_SKILLS = [
  'skills/turn/SKILL.md',
  'skills/inbox-triage/SKILL.md',
];

/** The structured read is the only sanctioned source for the current counterpart. */
const STRUCTURED_READ = /canopy email read/;

/** The row's `from` must be named as the FIRST/OLDEST message's sender. */
const PROVENANCE_CLAIM = /\bfrom\b[^.\n]{0,120}\b(first|oldest)\b|\b(first|oldest)\b[^.\n]{0,120}\bfrom\b/i;

/** The citation that ties the caveat to its measured repro. */
const ISSUE_CITATION = /ace#2399/;

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('inbox queue pull — sender provenance caveat', () => {
  it.each(QUEUE_PULL_SKILLS)('%s names the search row\'s `from` as the FIRST sender', (rel) => {
    expect(PROVENANCE_CLAIM.test(read(rel))).toBe(true);
  });

  it.each(QUEUE_PULL_SKILLS)('%s points at the structured read for the real sender', (rel) => {
    expect(read(rel)).toMatch(STRUCTURED_READ);
  });

  it.each(QUEUE_PULL_SKILLS)('%s cites the measured repro', (rel) => {
    expect(read(rel)).toMatch(ISSUE_CITATION);
  });

  it('inbox-triage forbids tiering and noise-classifying off the row', () => {
    const body = read('skills/inbox-triage/SKILL.md');
    // The two failure shapes must both be named where the disposal decision is made,
    // because §2c runs after the noise table and cannot undo an auto-dismiss.
    expect(body).toMatch(/never tier/i);
    expect(body).toMatch(/noise[- ]classif/i);
  });

  it('the caveat sits at the queue pull, not buried at the end of the file', () => {
    // Regression control: a warning the reader meets AFTER already applying the noise
    // table is the same as no warning. Require it within the queue-pull section.
    const body = read('skills/inbox-triage/SKILL.md');
    const pullIdx = body.indexOf('### 1. Pull the queue');
    const nextSection = body.indexOf('### 2.', pullIdx);
    expect(pullIdx).toBeGreaterThan(-1);
    expect(nextSection).toBeGreaterThan(pullIdx);
    const section = body.slice(pullIdx, nextSection);
    expect(PROVENANCE_CLAIM.test(section)).toBe(true);
    expect(section).toMatch(STRUCTURED_READ);
  });

  it('NEGATIVE CONTROL: the assertions fail on text that lacks the caveat', () => {
    const naive = [
      '### 1. Pull the queue (read-only, safe)',
      'Via `email-communicator` (search): `in:inbox is:unread`.',
      'Apply the noise table, then present the remaining queue (sender, subject, date).',
    ].join('\n');
    expect(PROVENANCE_CLAIM.test(naive)).toBe(false);
    expect(STRUCTURED_READ.test(naive)).toBe(false);
    expect(ISSUE_CITATION.test(naive)).toBe(false);
  });
});
