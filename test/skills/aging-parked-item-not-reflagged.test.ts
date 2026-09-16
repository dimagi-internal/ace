/**
 * A deliberately-parked item is not escalated on AGE (Jon, 2026-09-16).
 *
 * `skills/inbox-triage` § 4 escalates any open thread older than 5 days "every turn,
 * until resolved". That rule was written for the thread nobody decided about — the
 * HENIKE case, where 23 days of silence was a genuine miss nothing else would surface.
 *
 * It says nothing about the thread someone decided to LEAVE, and as written it cannot
 * tell the two apart, because its only input is the date. So a turn that reads a board
 * card saying "parked, awaiting approval" and computes 53 days hands the elapsed time
 * back as a decision — re-raising something the operator already settled.
 *
 * Measured: the `spark-connect-program` card. Jon's correction was
 *   "we are aware its been a long time and that in and of itself shouldn't be flagged
 *    going forward."
 *
 * The discriminator is whether a DECISION IS RECORDED, not whether the thread feels old:
 *   - no recorded decision  → § 4 applies unchanged, age escalates
 *   - recorded decision     → report as parked; escalate only on a CHANGE (the gating
 *                             condition clearing, the counterpart writing, the work
 *                             completing)
 *
 * This test is the ratchet. Per CLAUDE.md § "behavioral feedback goes in that skill's
 * procedure, THIS turn — a memory note is NOT a substitute": the board note covers one
 * card, the skill edit covers the behavior, and this pins the skill edit.
 *
 * SCOPE: a doc-contract test, deterministic and offline. It asserts the exception is
 * PRESENT and correctly SCOPED; it cannot assert a turn obeyed it.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL = path.join(REPO_ROOT, 'skills/inbox-triage/SKILL.md');

function body(): string {
  return fs.readFileSync(SKILL, 'utf8');
}

/** The § 4 aging section, up to where § 4b begins. */
function agingSection(): string {
  const b = body();
  const start = b.indexOf('### 4. Open-thread aging');
  const end = b.indexOf('### 4b.', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return b.slice(start, end);
}

describe('inbox-triage § 4 — a parked item is not escalated on age', () => {
  it('the exception lives INSIDE § 4, next to the rule it qualifies', () => {
    // Placement matters the same way it does for the queue-pull caveat: an exception
    // the reader meets after they have already escalated is not an exception.
    expect(agingSection()).toMatch(/park/i);
  });

  it('§ 4 still carries the original escalation rule it qualifies', () => {
    // Regression control in the other direction: the exception must NARROW the rule,
    // never delete it. The HENIKE case is what § 4 exists for.
    const s = agingSection();
    expect(s).toMatch(/older than 5 days/i);
    expect(s).toMatch(/escalat/i);
  });

  it('the discriminator is a RECORDED DECISION, not age or importance', () => {
    const s = agingSection();
    expect(s).toMatch(/recorded/i);
    expect(s).toMatch(/decision/i);
  });

  it('escalation on a CHANGE is preserved as the live trigger', () => {
    // The exception must not park an item permanently: something that actually moves
    // still escalates.
    expect(agingSection()).toMatch(/chang/i);
  });

  it('the correction is attributed and dated, so a later reader can weigh it', () => {
    expect(agingSection()).toMatch(/2026-09-16/);
  });

  it('NEGATIVE CONTROL: the assertions fail on the pre-fix § 4 text', () => {
    const preFix = [
      '### 4. Open-thread aging (standing state, every turn — jjackson/ace#818)',
      'An unanswered external counterpart is **state, not an event**. Every turn:',
      '- List ALL open correspond-tier threads with **age in days**.',
      '- Any thread **older than 5 days** is escalated explicitly to the routed run\'s',
      '  operator in the close-out, every turn, until resolved — not just listed.',
    ].join('\n');
    expect(/park/i.test(preFix)).toBe(false);
    expect(/recorded/i.test(preFix)).toBe(false);
    expect(/2026-09-16/.test(preFix)).toBe(false);
    // ...while the rule the exception qualifies is present in BOTH, which is why the
    // control above cannot be satisfied by the escalation assertions alone.
    expect(/older than 5 days/i.test(preFix)).toBe(true);
  });
});
