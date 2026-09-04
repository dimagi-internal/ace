import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * inbox-triage's open-thread aging sweep (§4) must stay REACHABLE.
 *
 * ## The failure class
 *
 * §4 exists because "an unanswered external counterpart is state, not an event"
 * — it catches threads where the ball is on ACE. Such a thread produces no new
 * inbound BY DEFINITION, so the inbox goes quiet precisely when §4 is needed.
 *
 * §1 pulls `in:inbox is:unread` and, until 2026-09-04, read:
 *
 *   "If none, report \"inbox clear\" and stop."
 *
 * The process is sequential and §1 sits ~95 lines above §4, so that `stop`
 * ended the turn before the aging sweep could run. §4 was therefore unreachable
 * in exactly the situation it was written for, and the quieter the inbox the
 * more certain the miss.
 *
 * Cost: the Spark thread (19f5ca720cd6a5ff) waited 42 days for a reply ACE
 * owed, while the PDD the counterpart was waiting on sat finished in Drive.
 * That is a regression of the fix for jjackson/ace#818, whose own rationale
 * ("HENIKE waited 23 days") is the identical failure — the rule was written
 * correctly and then placed where it could not execute.
 *
 * Prose did not hold this once already, which is why it is a test: §4 already
 * says "every turn" in its own heading and was skipped anyway.
 *
 * ace#1931.
 */
describe('inbox-triage §4 open-thread aging is reachable from §1', () => {
  const skill = readFileSync(
    join(__dirname, '../../skills/inbox-triage/SKILL.md'),
    'utf8',
  );

  const section = (heading: RegExp): string => {
    const start = skill.search(heading);
    expect(start, `section not found: ${heading}`).toBeGreaterThan(-1);
    const rest = skill.slice(start);
    const next = rest.slice(1).search(/^### /m);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };

  it('§1 does not end the turn on an empty unread queue', () => {
    const s1 = section(/^### 1\. Pull the queue/m);
    // The bare "and stop." is the defect: it terminates before §4.
    expect(
      /\band stop\.?(\s|$)/i.test(s1),
      '§1 still tells the turn to STOP on an empty unread queue, which makes ' +
        '§4 open-thread aging unreachable (ace#1931). Route to §4 instead.',
    ).toBe(false);
  });

  it('§1 explicitly routes an empty unread queue onward to §4', () => {
    const s1 = section(/^### 1\. Pull the queue/m);
    expect(
      /§4/.test(s1),
      '§1 must name §4 as where an "inbox clear" turn continues, so the ' +
        'aging sweep runs on inbox STATE rather than on inbound events.',
    ).toBe(true);
  });

  it('§4 asserts it runs regardless of what §1 found', () => {
    const s4 = section(/^### 4\. Open-thread aging/m);
    expect(
      /regardless|inbox clear/i.test(s4),
      '§4 must state that it runs even on a turn that reported "inbox clear" ' +
        '— its heading already says "every turn" and that was not enough.',
    ).toBe(true);
  });
});
