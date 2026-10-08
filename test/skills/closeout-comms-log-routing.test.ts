/**
 * The orchestrator's close-out reply must be routable by thread_id (ace#2823).
 *
 * `ace-orchestrator` drafts a close-out reply when a run was triggered from a
 * thread, and said only "write the draft into the run's comms-log". The
 * session that ran group-payment-test/20261007-1700 (2026-10-08) chose
 * `comms-log/run-closeout_comms-log.md` — the subfolder that holds
 * `observations.md` and `dry-run-*.md`, which `inbox-triage` §b.1 does not
 * search. Three sends to the requester's thread were therefore invisible to
 * thread_id routing; the thread routed only via canopy and the subject line.
 *
 * Pinned: the writer names the file and the run root, and both routing
 * contracts name it and exclude the subfolder.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('close-out comms-log: written at the run root, read by triage routing', () => {
  it('the orchestrator names run-closeout_comms-log.md at the run root for the close-out draft', () => {
    const orch = read('agents/ace-orchestrator.md');
    const step = orch.slice(orch.indexOf('draft the\n     close-out reply'), orch.indexOf('Three rules:'));
    expect(step).toContain('run-closeout_comms-log.md');
    expect(step).toMatch(/run root/);
    expect(step).toMatch(/never the `comms-log\/` subfolder/);
  });

  it("inbox-triage §b.1's thread_id match names run-closeout_comms-log.md and excludes the subfolder", () => {
    const triage = read('skills/inbox-triage/SKILL.md');
    const b1 = /1\. Match the Gmail `thread_id`[\s\S]*?\n\s+2\. /.exec(triage)?.[0] ?? '';
    expect(b1).toContain('run-closeout_comms-log.md');
    expect(b1).toMatch(/`comms-log\/` subfolder holds no send records/);
  });

  it("email-communicator's routing contract forbids send records under comms-log/", () => {
    const ec = read('skills/email-communicator/SKILL.md');
    expect(ec).toContain('run-closeout_comms-log.md');
    expect(ec).toMatch(/Never log a send under the run's `comms-log\/` subfolder/);
  });
});
