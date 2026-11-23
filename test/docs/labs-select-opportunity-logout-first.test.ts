import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A person's labs report said "Please select an opportunity from the labs
 * context" and dropped `&opportunity_id=` from the link. ACE answered with the
 * /labs/synthetic/ toggle (2026-11-18) and then a domain allowlist (2026-11-20).
 * The fix was logging out of labs and back in, found on 2026-11-19 in a Slack
 * thread and a teammate's own session. The daily turn read only the email
 * thread and the board card, so it never saw that.
 *
 * Pinned: the labs playbook's Troubleshooting opens with log-out-first, and
 * inbox-triage both leads with it and reads the work's other sessions before
 * replying. Thread 1a1691a41973d718, ace#3452.
 */

const ROOT = join(__dirname, '..', '..');
const flat = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');

describe('labs "select an opportunity": log out and back in first', () => {
  it('the labs playbook Troubleshooting section opens with the log-out-first fix', () => {
    const doc = flat('playbook/integrations/connect-labs.md');
    const section = doc.slice(doc.indexOf('## Troubleshooting'));
    const first = section.slice(0, section.indexOf('**`401 Unauthorized`'));
    expect(first).toContain('Please select an opportunity from the labs context');
    expect(first).toContain('log out of labs and log back in');
    expect(first).toContain('first, before any other diagnosis');
  });

  it('inbox-triage leads with it and reads the work\'s other sessions before replying', () => {
    const doc = flat('skills/inbox-triage/SKILL.md');
    expect(doc).toContain('the first remedy is to log out of labs and back in');
    expect(doc).toContain('read what happened on this work OUTSIDE the thread');
    expect(doc).toContain('`search_sessions`');
  });
});
