/**
 * Nothing goes to a person until you have opened it yourself.
 *
 * ## The failure class
 *
 * ace#3426. On thread `1a1691a41973d718` (2026-11-02 → 2026-11-13) ACE sent a programme
 * partner four Labs report links. None of them worked, and it was not the first time:
 *
 *   "All the labs URLs you share lead me to this page […] This is the fourth time you sent
 *    me urls that lead to pages not containing the information I wanted. Can you please be
 *    more careful?"
 *
 * Three things make this a class rather than an incident, and each is why a test exists
 * instead of another paragraph:
 *
 *  1. **The correct form was already documented.** `skills/demo-data-setup-qa/SKILL.md`
 *     recorded `/run/?opportunity_id=` with no `run_id` → workflow LIST as a verified-live
 *     trap, months earlier, from a previous occurrence.
 *  2. **The sending turn had already disproved its own check.** It ran an HTTP probe, saw a
 *     deliberately-bogus id return the same result, wrote "that proves nothing" in its own
 *     close-out — and sent anyway.
 *  3. **The apology repeated the error.** The corrected reply claimed "checked that each one
 *     shows the data" when only one of four had been checked at data level.
 *
 * Knowing was never the gap. Nothing stood between knowing and sending. These tests pin the
 * thing that now stands there: the contract (`skills/_verify-before-send.md`), its reach
 * into every skill that sends, and the clauses a future edit must not quietly drop.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTRACT = 'skills/_verify-before-send.md';

/**
 * Skills that put a link, an instruction or a claim in front of a human — by mail, by a
 * shared doc, or by an answer they act on. Each must LINK the contract, because a rule the
 * writer never sees is a rule that fails at exactly the moment it matters.
 */
const SEND_BOUND = [
  'skills/email-communicator/SKILL.md',
  'skills/inbox-triage/SKILL.md',
  'skills/turn/SKILL.md',
  'skills/agent-turn-review/SKILL.md',
  'skills/gdoc-email-drafts/SKILL.md',
  'skills/share-run-access/SKILL.md',
  'skills/partner-on-connect-program/SKILL.md',
  'skills/answer-caller/SKILL.md',
  'skills/explain-ace/SKILL.md',
  'skills/llo-onboarding/SKILL.md',
  'skills/llo-launch/SKILL.md',
  'skills/llo-uat/SKILL.md',
  'skills/llo-feedback/SKILL.md',
  'skills/llo-invite/SKILL.md',
  'skills/solicitation-review/SKILL.md',
  'skills/marketplace-outreach-doc/SKILL.md',
];

describe('verify before you send', () => {
  it('the contract exists', () => {
    expect(existsSync(join(REPO_ROOT, CONTRACT)), `${CONTRACT} is missing`).toBe(true);
  });

  it('every skill that puts something in front of a human links the contract', () => {
    const missing = SEND_BOUND.filter((rel) => {
      const path = join(REPO_ROOT, rel);
      if (!existsSync(path)) return false; // a renamed skill is its own test's problem
      return !readFileSync(path, 'utf8').includes('_verify-before-send.md');
    });

    expect(
      missing,
      `These put a link, an instruction or a claim in front of a person and do not link\n` +
        `the verify-before-send contract, so the writer never sees the rule:\n\n` +
        missing.map((m) => `  ${m}`).join('\n') +
        `\n\nAdd a pointer to skills/_verify-before-send.md.\n` +
        `The miss that prompted this test was an outbound email — not a file in this repo —\n` +
        `so enforcing it on producers alone would not have caught it.`,
    ).toEqual([]);
  });

  /**
   * Each clause below is one of the distinct mistakes made on that thread. A future edit
   * may rewrite the prose freely; it may not drop the rule.
   */
  const REQUIRED_CLAUSES: Array<[string, RegExp]> = [
    ['a 200 is not evidence', /`?200`? is not evidence/i],
    ['a redirect is a failure', /redirect is a failure/i],
    ['name the expected content before fetching', /expect to SEE|name what you expect/i],
    ['verify as the recipient, not as yourself', /as the RECIPIENT, not as yourself/i],
    ['a link that depends on reader state is broken', /depends on the reader's session state is a broken link/i],
    ['state the access basis', /State the basis/i],
    ['never "just try it and let me know"', /just try it and let me know/i],
    ['never ask for something they cannot do', /confirmed they can do/i],
    ['never remove a surface without a replacement', /without naming the one that replaces it/i],
    ['an inherited claim is unverified', /inherited claim is an unverified claim/i],
    ['a correction is held to a higher bar', /higher bar than the thing it corrects/i],
    ['no internal plumbing in a counterpart message', /internal plumbing in a counterpart/i],
  ];

  for (const [name, pattern] of REQUIRED_CLAUSES) {
    it(`the contract still states: ${name}`, () => {
      // Whitespace-normalised: a clause may wrap across lines and still be the rule.
      const body = readFileSync(join(REPO_ROOT, CONTRACT), 'utf8').replace(/\s+/g, ' ');
      expect(pattern.test(body), `${CONTRACT} no longer states "${name}"`).toBe(true);
    });
  }

  it('the contract names the rail that enforces it, and the gaps it does not cover', () => {
    const body = readFileSync(join(REPO_ROOT, CONTRACT), 'utf8');
    expect(body).toContain('ace-verify-links');
    expect(body).toContain('bin/ace-email');
    // An honest contract says what it does NOT check; the Drive gap is real and named.
    expect(body).toMatch(/What the rail cannot check/i);
  });

  it('the rail is wired into the send path, not merely described', () => {
    const shim = readFileSync(join(REPO_ROOT, 'bin/ace-email'), 'utf8');
    expect(shim).toContain('_check_links_verified');
    expect(shim).toContain('_check_no_internal_plumbing');
    // Wired into the actual call sequence, not just defined.
    expect(shim).toMatch(/^_check_links_verified\(ARGS\)$/m);
    expect(shim).toMatch(/^_check_no_internal_plumbing\(ARGS\)$/m);
  });
});
