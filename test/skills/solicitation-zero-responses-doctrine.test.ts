import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * dimagi-internal/ace#2171 — the zero-responses doctrine must live where the
 * numbers are computed.
 *
 * ## The failure class
 *
 * `skills/solicitation-create/SKILL.md` carries the doctrine that a published
 * solicitation showing `deadline in N days, 0 responses` is the CORRECT and
 * expected state and must not be escalated. It explicitly addresses a TURN
 * ("the same doctrine, in the shape a TURN meets it rather than a run").
 *
 * But a turn polling a solicitation loads `skills/solicitation-monitor` — the
 * skill whose Step 3 computes the response count and the time-to-deadline. That
 * file carried none of the doctrine, so the guidance was correct, durable, and
 * unreachable by the only reader that needed it. The escalation it warns about
 * then happened three times across two days on `hh-poverty-targeting`, ending in
 * Jon: "stop talking about the solicitation, this is all just test work and its
 * fine."
 *
 * ## Why not a test-run flag
 *
 * The obvious-looking fix — a run-scoped `is_test_run` — is wrong, and the tests
 * below pin its absence deliberately. Phase 8 is publish-only on EVERY run
 * (`llo-invite` no-ops without an explicit operator opt-in), so zero responses is
 * expected universally. Scoping the suppression to test runs would assert that
 * the same state IS escalation-worthy on a live run and put the noise back there.
 */

const ROOT = join(__dirname, '..', '..');
const MONITOR = readFileSync(join(ROOT, 'skills', 'solicitation-monitor', 'SKILL.md'), 'utf8');
const CREATE = readFileSync(join(ROOT, 'skills', 'solicitation-create', 'SKILL.md'), 'utf8');
const INVITE = readFileSync(join(ROOT, 'skills', 'llo-invite', 'SKILL.md'), 'utf8');

describe('ace#2171 — the reader of the numbers carries the doctrine', () => {
  it('solicitation-monitor says zero responses is expected, not escalation-worthy', () => {
    expect(
      /0 responses.*CORRECT and expected|CORRECT and expected/i.test(MONITOR),
      'skills/solicitation-monitor/SKILL.md no longer states that a zero-response ' +
        'solicitation is the expected state. This is the only skill that computes ' +
        'both the response count and the time-to-deadline, so it is the only place ' +
        'that can manufacture the urgency — and the doctrine living one file over ' +
        'in solicitation-create is what produced ace#2171.',
    ).toBe(true);
    expect(MONITOR).toMatch(/do NOT escalate it/i);
  });

  it('the doctrine sits at the Step 3 computation site, not in a footnote', () => {
    // Guidance a reader passes on the way to the thing it governs is guidance
    // that gets applied. Placement is the fix, not the wording.
    const step3 = MONITOR.indexOf('**Summarize inflow.**');
    const doctrine = MONITOR.search(/CORRECT and expected/i);
    const step4 = MONITOR.indexOf('**Append observation.**');
    expect(step3).toBeGreaterThan(-1);
    expect(step4).toBeGreaterThan(-1);
    expect(
      doctrine > step3 && doctrine < step4,
      'The zero-responses doctrine moved out of Step 3 (Summarize inflow). It has ' +
        'to sit between computing the numbers and writing the tick line, or a ' +
        'reader reaches the count without it.',
    ).toBe(true);
  });

  it('names the publish-only default as the REASON, not just the rule', () => {
    // Without the reason ("nobody was invited"), the rule reads as "suppress this
    // warning" and the next reader with a live-looking run will override it.
    expect(MONITOR).toMatch(/publish-only/i);
    expect(MONITOR).toMatch(/ACE_SOLICITATION_INVITE_CANDIDATES|--invite-candidates/);
  });
});

describe('ace#2171 — the discriminator is the file CONTENTS, not its presence', () => {
  it('records that llo-invite writes the invitations file on every path', () => {
    // The trap: llo-invite_invitations.md exists even when nothing was sent, so
    // "does the file exist" is a flag that does not mean what it looks like.
    expect(
      /PRESENCE tells you nothing|all \*\*three\*\* of its\s+paths|on \*\*all three\*\*/i.test(MONITOR),
      'solicitation-monitor no longer warns that llo-invite_invitations.md is ' +
        'written on the skip path too. Branching on the file\'s existence would ' +
        'read "nobody invited" as "invitations sent" on every default run.',
    ).toBe(true);
  });

  it('the premise holds: llo-invite really does write the file when it skips', () => {
    // Verify against the artifact rather than trusting the doc we just wrote.
    // If llo-invite ever stops writing on the skip path, the table above is
    // over-cautious rather than wrong — but we want to know.
    expect(INVITE).toMatch(/Status: skipped \(publish-only default/);
    expect(INVITE).toMatch(/Status: empty \(long-term solicitation flow/);
    expect(INVITE).toMatch(/llo-invite_invitations\.md/);
  });

  it('gives all three states an explicit action', () => {
    expect(MONITOR).toMatch(/Status: skipped/);
    expect(MONITOR).toMatch(/Status: empty/);
    expect(MONITOR).toMatch(/## Recipients/);
  });
});

describe('ace#2171 — a test-run flag is explicitly NOT the answer', () => {
  it('solicitation-monitor rules out "is this a test opp?" as the discriminator', () => {
    expect(
      /NOT the discriminator/i.test(MONITOR),
      'The carve-out against a test/demo-scoped discriminator is gone. It is load-' +
        'bearing: the publish-only default holds on every run, so scoping the ' +
        'suppression to test runs re-asserts that a live run with zero responses ' +
        'deserves an escalation — which is the noise this doctrine removes.',
    ).toBe(true);
  });

  it('no run-scoped test flag has been introduced anywhere in the doctrine', () => {
    // If someone later adds `is_test_run`, this should fail loudly and be argued
    // for on its merits rather than arriving as a side effect of this fix.
    expect(MONITOR).not.toMatch(/is_test_run/);
    expect(CREATE).not.toMatch(/is_test_run/);
  });
});

describe('ace#2171 — the two files stay pointed at each other', () => {
  it('solicitation-create still holds the canonical statement', () => {
    // solicitation-monitor defers to it for the wider doctrine (multiple open
    // solicitations per program). A dangling pointer would be worse than none.
    expect(CREATE).toMatch(/Zero responses is the CORRECT and expected state/i);
    expect(CREATE).toMatch(/audit trail, not a\s+procurement/i);
  });

  it('solicitation-monitor names solicitation-create as canonical', () => {
    expect(MONITOR).toMatch(/solicitation-create/);
  });

  it('both retain Jon\'s correction verbatim so the origin cannot be paraphrased away', () => {
    const quote = /stop talking about the\s+solicitation, this is all just test work and its fine/i;
    expect(quote.test(CREATE)).toBe(true);
    expect(quote.test(MONITOR)).toBe(true);
  });
});
