/**
 * A release's reviewer emails must be routable by thread_id (ace#2780).
 *
 * `email-communicator` step 7 requires every send to log its `thread_id` in a
 * `<skill>_comms-log.md`, and `inbox-triage` §b.1 routes an inbound reply by
 * matching that id. `/ace:release` sent one email per reviewer and logged none
 * — and a release belongs to no phase, so even a log would have sat outside the
 * `<N>-<phase>/` folders that §b.1 searched. Live case: the 7 reviewer emails of
 * spark/spark-facilitator/20261004-1706 (2026-10-07) were routable only by URLs
 * in the quoted body until `release-run_comms-log.md` was written by hand at
 * the run root.
 *
 * Both halves are pinned: the writer names the file at the run root, and the
 * reader looks there.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('release comms-log: written at the run root, read by triage routing', () => {
  it('release-run writes release-run_comms-log.md at the run root, one row per sent email', () => {
    const skill = read('skills/release-run/SKILL.md');
    const step4 = skill.slice(skill.indexOf('## Step 4'), skill.indexOf('## Report'));
    expect(step4).toContain('release-run_comms-log.md');
    expect(step4).toMatch(/run root/);
    expect(step4).toMatch(/thread_id/);
    expect(step4).toMatch(/message_id/);
    expect(step4).toMatch(/never the body/);
  });

  it("inbox-triage §b.1's thread_id match covers the run root, naming release-run_comms-log.md", () => {
    const triage = read('skills/inbox-triage/SKILL.md');
    const b1 = /1\. Match the Gmail `thread_id`[\s\S]*?\n\s+2\. /.exec(triage)?.[0] ?? '';
    expect(b1).not.toBe('');
    expect(b1).toContain('<N>-<phase>/');
    expect(b1).toMatch(/run root/);
    expect(b1).toContain('release-run_comms-log.md');
  });

  it("email-communicator's routing contract names the run-root exception", () => {
    expect(read('skills/email-communicator/SKILL.md')).toContain('release-run_comms-log.md');
  });
});
