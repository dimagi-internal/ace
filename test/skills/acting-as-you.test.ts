import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "As me": how a person gets ACE to write Connect Labs as themselves.
 *
 * ## The failure class
 *
 * A member's ACE on their own laptop (2026-10-27) held two labs connections and reported
 * both as the member. That was only because ACE's vault had not loaded there: the plugin's
 * connection signs in with ACE's `LABS_MCP_TOKEN` (ace@dimagi-ai.com) the moment it does,
 * and nothing would have said so. On the owner's machine the claude.ai connector, which
 * looks like "the person's", was signed in as ace@dimagi-ai.com. Neither connection's
 * identity follows from its name, so a write "as me" could land as ACE with no signal.
 *
 * ## The rule
 *
 * One phrase ("as me"), one identity check (`labs_context` returns `user.email`), no
 * fallback to another account, and every labs write names its account first. The skills a
 * person reaches for to change a live labs object link the rule.
 *
 * Observed: the member's laptop could not load ACE's vault because its TPM device key had
 * no ECDH key, fixed by dimagi-internal/canopy#1081; the flip to ace@ follows that fix.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), 'utf8');
const RULE = read('skills', '_acting-as-you.md');

describe('acting as you ("as me")', () => {
  it('the rule names the phrase, the identity check and the no-fallback stop', () => {
    expect(RULE).toMatch(/\*\*"as me"\*\*/);
    expect(RULE).toMatch(/labs_context\(\{search: "zzzz-no-match"\}\)/);
    expect(RULE).toMatch(/user: \{username, email\}/);
    expect(RULE).toMatch(/None matches → \*\*stop\*\*/);
    expect(RULE).toMatch(/Never fall back/);
    expect(RULE).toMatch(/Before any labs write, say who it will be as/);
  });

  it('says identity is read, never inferred from the tool name', () => {
    expect(RULE).toMatch(/mcp__plugin_ace_connect-labs__\*/);
    expect(RULE).toMatch(/mcp__connect_labs__\*/);
    expect(RULE).toMatch(/never assume it from the name/);
  });

  it('is honest that only labs can be "as me"', () => {
    expect(RULE).toMatch(/Only labs can be "as me" today/);
  });

  it('tells people not to put their own token in LABS_MCP_TOKEN', () => {
    expect(RULE).toMatch(/Never put your own labs token into `LABS_MCP_TOKEN`/);
  });

  // The skills a person uses to change a live labs object, plus the explainer.
  const LINKERS = [
    ['skills', 'explain-ace', 'SKILL.md'],
    ['skills', 'partner-on-connect-program', 'SKILL.md'],
    ['skills', 'labs-workflow-repoint', 'SKILL.md'],
    ['skills', 'semantic-registry-author', 'SKILL.md'],
    ['skills', '_labs-on-a-page.md'],
  ];
  it.each(LINKERS)('%s/%s links the rule', (...p) => {
    expect(read(...p)).toContain('_acting-as-you.md');
  });

  it('CLAUDE.md states it', () => {
    expect(read('CLAUDE.md')).toMatch(/a person gets ACE to write labs as themselves by saying "as me"/);
  });
});
