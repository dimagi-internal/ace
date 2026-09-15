/**
 * `inbox-triage` authors claims when an act-tier counterpart DECIDES
 * something that changes what the next run must build.
 *
 * The write-side convention is the whole mechanism's dependency: no
 * claims authored, nothing to validate, and the omission stays silent.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL = readFileSync(join(process.cwd(), 'skills/inbox-triage/SKILL.md'), 'utf8');

describe('inbox-triage authors claims for an act-tier decision', () => {
  it('names the pending claims file', () => {
    expect(SKILL).toMatch(/pending-claims\.yaml/);
  });

  it('states the one-claim-per-artifact granularity rule', () => {
    expect(SKILL).toMatch(/one claim per artifact/i);
  });

  it("requires the counterpart's own acceptance criteria to be carried verbatim", () => {
    expect(SKILL).toMatch(/verbatim/i);
    expect(SKILL).toMatch(/authored_by/);
  });

  it('forbids writing claims into the decisions log', () => {
    expect(SKILL).toMatch(/decisions\.yaml/);
    expect(SKILL).toMatch(/not a decision|NOT a decision/);
  });
});
