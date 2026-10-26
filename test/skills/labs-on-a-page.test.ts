import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * On a connect-labs page ACE reaches labs only as the person who sent.
 *
 * ## The failure class
 *
 * ACE's owner chatting with it on a KMC workflow run page ran in ACE's full profile,
 * where canopy's gateway refused it, so ACE fell back to its own labs login
 * (`LABS_MCP_TOKEN`, ace@dimagi-ai.com) and answered from opportunity 10061 — data the
 * page's person could not see (connect-labs `tools/data_chat_eval`, `outside-selection`).
 * Owner decision 2026-10-26: every turn on a labs page reads labs only through the
 * sender's act-as-you permission (canopy's `site_tools` / `site_call`), owners included.
 *
 * ## The rule
 *
 * A skill that can run on a labs page (it reads `current_page`, or names the agent /
 * canopy panel) links the shared rule `skills/_labs-on-a-page.md`. New ones are caught
 * by the scan, not by a list someone has to keep.
 *
 * Observed: connect-labs data_chat_eval outside-selection; fixed by dimagi-internal/canopy-web#2142.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const FRAGMENT = join(REPO_ROOT, 'skills', '_labs-on-a-page.md');
const RUNS_ON_A_PAGE = /current_page|agent panel|canopy panel/;

function skillDocs(): string[] {
  const root = join(REPO_ROOT, 'skills');
  return readdirSync(root)
    .map((d) => join(root, d, 'SKILL.md'))
    .filter((p) => existsSync(p));
}

describe('skills that run on a labs page', () => {
  it('the shared rule says gateway-only and never the native connect-labs MCP', () => {
    const text = readFileSync(FRAGMENT, 'utf8');
    expect(text).toMatch(/site_call/);
    expect(text).toMatch(/site_tools/);
    expect(text).toMatch(/Never call the native `connect-labs` MCP/);
    expect(text).toMatch(/owner and admins included/);
  });

  // Skills that mention the panel only to say it is NOT their way in.
  const NOT_ON_A_PAGE = new Set(['demo-data-setup', 'ocs-coach-setup']);

  it('each links skills/_labs-on-a-page.md', () => {
    const missing = skillDocs()
      .filter((p) => !NOT_ON_A_PAGE.has(p.split('/').slice(-2)[0]))
      .filter((p) => RUNS_ON_A_PAGE.test(readFileSync(p, 'utf8')))
      .filter((p) => !readFileSync(p, 'utf8').includes('_labs-on-a-page.md'));
    expect(missing).toEqual([]);
  });

  it('CLAUDE.md states the rule', () => {
    const text = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
    expect(text).toMatch(/On a connect-labs page ACE reaches labs only as the person who sent/);
  });
});
