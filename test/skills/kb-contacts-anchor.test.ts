/**
 * Seam test for dimagi-internal/ace#1665.
 *
 * `ocs-agent-setup` § Step 5's KB recipe (PDD + inputs + training + app
 * summaries) named no file carrying the program's contacts, so the escalation
 * address the composed system prompt tells the bot to hand out existed ONLY in
 * that prompt — with no retrievable anchor anywhere in the RAG collection. The
 * value was therefore reproduced from prompt recall alone and retrieval could
 * not correct a drift. Measured on `hh-poverty-targeting/20260824-1404`
 * (experiment 13014, collection 566): across a 73-prompt deep run the bot
 * emitted `ace@dimagi.com` twice and invented `pm@dimagi-ai.com` once, against
 * 27 correct emissions.
 *
 * A prompt-side guard cannot fix this class: the golden template
 * (`scripts/bootstrap-ocs-golden-template.ts`) already names the exact address
 * AND forbids the misspelling by name, and the drift happened anyway. So the
 * invariant is about the KB RECIPE, and it has two halves:
 *
 *   1. the recipe generates and indexes a contacts anchor, and
 *   2. the anchor is STRUCTURAL — the ACE address is read from the one
 *      authoritative in-repo source (`config/agent.json` `.email`), per-opp
 *      roles come from the run's own state, and a role with no published
 *      contact is written as such rather than filled with a plausible-looking
 *      address. Hard-coding an invented address would be the very defect.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const agentSetup = readFileSync(`${ROOT}skills/ocs-agent-setup/SKILL.md`, 'utf8');
const goldenTemplate = readFileSync(`${ROOT}scripts/bootstrap-ocs-golden-template.ts`, 'utf8');
const agentIdentity = JSON.parse(readFileSync(`${ROOT}config/agent.json`, 'utf8')) as {
  email: string;
};

const CONTACTS_FILE = '00-program-contacts.md';

/**
 * The Step-5 KB recipe: the "Files to gather" list `ocs-agent-setup` uploads
 * into the bot's collection. Narrow on purpose — the prohibition prose
 * elsewhere in Step 5 names an EXCLUDED file, and matching the whole step
 * would read that mention as an inclusion. Same helper shape as
 * `kb-instrument-contamination.test.ts`.
 */
function kbRecipeFileList(md: string): string {
  const start = md.indexOf('Files to gather:');
  expect(start, 'ocs-agent-setup Step 5 must still carry a "Files to gather:" list').toBeGreaterThan(
    -1,
  );
  const rest = md.slice(start);
  const end = rest.indexOf('For each file, base64-encode');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('ocs-agent-setup KB carries a contacts anchor (ace#1665)', () => {
  it('the Step-5 recipe indexes a contacts file', () => {
    expect(
      kbRecipeFileList(agentSetup).includes(CONTACTS_FILE),
      `ocs-agent-setup's "Files to gather" list must name ${CONTACTS_FILE}. ` +
        `Without it the per-opp collection carries no email address at all, so ` +
        `the escalation contact lives only in the composed prompt and retrieval ` +
        `cannot correct a drift (ace#1665).`,
    ).toBe(true);
  });

  it('the composition rule sources the ACE address from config/agent.json, not from memory', () => {
    expect(agentSetup).toMatch(/`\.email` in `config\/agent\.json`/);
    expect(agentSetup).toMatch(/never type it from memory/i);
  });

  it('the composition rule requires per-opp roles to come from the run\'s own state', () => {
    expect(agentSetup).toMatch(/come from the run's own state, not from you/i);
    expect(agentSetup).toMatch(/run_state\.yaml/);
  });

  it('the composition rule requires an explicit "no contact published" line rather than a plausible address', () => {
    // This is the half that keeps the fix from recreating the defect: an
    // anchor that invents an address is worse than no anchor.
    expect(agentSetup).toMatch(/no contact published/i);
    expect(agentSetup).toMatch(/do not supply a\s+plausible one/i);
  });

  it('the contacts anchor may not carry scoring or instrument content', () => {
    // Guards the anchor from becoming a smuggling route for the content the
    // collection deliberately excludes (point values, lookup rows, thresholds).
    expect(agentSetup).toMatch(/Contacts only — no scoring or instrument content/);
  });

  it('every dimagi-ai.com address named in the skill matches the authoritative identity', () => {
    const named = [...agentSetup.matchAll(/[a-z0-9._+-]+@dimagi-ai\.com/gi)]
      .map((m) => m[0].toLowerCase())
      // The skill quotes the observed WRONG values by name so the next reader
      // recognises them; those are documentation of the defect, not a claim.
      .filter((a) => !/^(ace@dimagi\.com|pm@dimagi-ai\.com)$/.test(a));
    expect(named.length, 'the skill should still name the escalation address').toBeGreaterThan(0);
    for (const address of named) {
      expect(
        address,
        `ocs-agent-setup names ${address}, but config/agent.json's .email is ` +
          `${agentIdentity.email}. The identity file is authoritative; a second, ` +
          `divergent copy in a skill is how the bot learns a wrong address.`,
      ).toBe(agentIdentity.email.toLowerCase());
    }
  });

  it('Step 7 points the composed prompt at the contacts file instead of only restating the address', () => {
    expect(agentSetup).toMatch(
      new RegExp(`point it at the\\s+\`${CONTACTS_FILE}\` file in its collection`),
    );
  });

  it('the golden template still names the same address (the prompt-side half of the pair)', () => {
    // Guards the test: if the fleet identity moves, the golden template and the
    // skill must move together — otherwise the anchor and the prompt disagree,
    // which is a worse failure than either being stale alone.
    expect(goldenTemplate).toContain(agentIdentity.email);
  });
});
