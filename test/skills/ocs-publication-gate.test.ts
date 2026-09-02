import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * dimagi-internal/ace#1905 — Step 11.5 proved the chatbot was LIVE but never
 * that it was PUBLISHED.
 *
 * ## What was actually wrong
 *
 * `ocs-agent-setup` § Step 11.5 is the hard round-trip gate standing between
 * Phase 5's work and the `run_state` write-back. It asserted two identities
 * (`public_id`, `embed_key` round-trip) and one liveness fact (the `public_id`
 * resolves to a real chatbot). It asserted nothing about publication — while
 * reading a payload that carries it:
 *
 *     $ grep -n "is_published_version" skills/ocs-agent-setup/SKILL.md
 *     (exit 1 — zero hits)
 *
 *     $ grep -n "is_published_version\|is_unreleased" mcp/ocs/types.ts
 *     224:  is_unreleased: boolean;
 *     225:  is_published_version: boolean;
 *
 * Step 9 publishes; Step 11.5 is the only thing between that publish and
 * durable state. A gate one field short of its own purpose is worth closing.
 *
 * ## What is deliberately NOT claimed
 *
 * No silently-failing publish that passes this gate has been observed, and
 * none is asserted to be reachable — `ocs_publish_chatbot_version` does throw
 * on the form-re-render path. The claim this test pins is narrower and stands
 * on its own: the gate must assert the property it exists to guarantee.
 *
 * ## The two traps the assertion has to avoid
 *
 * 1. **Read the DEFAULT version, not the working one.** `ocs_inspect_chatbot`
 *    with `version` omitted returns the working/draft version, on which
 *    `is_published_version` is FALSE on a perfectly-published bot —
 *    `test/mcp/ocs/fixtures/chatbot-inspect.json` records exactly that shape.
 *    Asserting on the un-versioned read would fail every healthy run. The
 *    same read's top-level `version_number` is the working/next counter and
 *    runs ahead of the published one (ace#891).
 *
 * 2. **Equality against Step 9's number is only meaningful when Step 9's
 *    number came from the API.** ace#1828 / PR #1895 made
 *    `ocs_publish_chatbot_version` read the post-publish default back and
 *    report `source`. `source: 'api'` is authoritative; `source:
 *    'home-page-badge'` is a page scrape the atom's own contract calls
 *    "known to lag the publish it describes". Halting on a mismatch against a
 *    known-lagging scrape would turn a documented weak read into a Phase 5
 *    deadlock, so the branch is required, not decoration.
 */

const SKILL = readFileSync(
  join(process.cwd(), 'skills', 'ocs-agent-setup', 'SKILL.md'),
  'utf8',
);

/** Step 11.5 through the start of Step 12 — the gate, and nothing else. */
function step115(): string {
  const start = SKILL.indexOf('11.5.');
  expect(start, 'Step 11.5 not found in ocs-agent-setup/SKILL.md').toBeGreaterThan(-1);
  const end = SKILL.indexOf('\n12. ', start);
  expect(end, 'Step 12 not found after Step 11.5').toBeGreaterThan(start);
  return SKILL.slice(start, end);
}

describe('ocs-agent-setup Step 11.5 asserts PUBLICATION, not only liveness (#1905)', () => {
  it('asserts is_published_version', () => {
    expect(step115()).toContain('is_published_version');
  });

  it('reads the DEFAULT version — the working version reports is_published_version: false', () => {
    // Not a stylistic preference. See trap 1 in the header: the fixture below
    // is the shape of a normal working version.
    expect(step115()).toMatch(/version:\s*'default'/);
  });

  it("CONTROL: the fixture proves the un-versioned read is the wrong one to assert on", () => {
    // Untouched by this change — it is the evidence that trap 1 is real, and
    // it is what makes the `version: 'default'` requirement above load-bearing
    // rather than arbitrary.
    const fixture = JSON.parse(
      readFileSync(
        join(process.cwd(), 'test', 'mcp', 'ocs', 'fixtures', 'chatbot-inspect.json'),
        'utf8',
      ),
    );
    expect(fixture.is_published_version).toBe(false);
    expect(fixture.is_unreleased).toBe(true);
  });

  it('cross-checks the published version number against what Step 11 wrote', () => {
    const s = step115();
    expect(s).toMatch(/version_number/);
    // The comparison must be against the DEFAULT version's number, so the
    // step has to say which number it is comparing.
    expect(s).toMatch(/Step 9|Step 11/);
  });

  it('branches the equality check on the publish read\'s `source` (ace#1828 / #1895)', () => {
    const s = step115();
    expect(s).toContain('home-page-badge');
    expect(s).toMatch(/source/);
  });

  it('still keeps the identity + liveness assertions it already had (#585, #1561)', () => {
    const s = step115();
    expect(s).toContain('ocs_get_chatbot_embed_info');
    expect(s).toContain('embed_key');
    expect(s).toContain('ocs_inspect_chatbot');
    // ace#1561: the liveness read must not regress to the scrape-backed atom.
    expect(s).not.toMatch(/liveness read.*ocs_get_chatbot\b/);
  });

  it('records the publication facts in the state file, so the gate leaves a trail', () => {
    // Step 11 owns the state file's field list; a pass/fail that writes nothing
    // is unauditable after the fact.
    const step11Start = SKILL.indexOf('11. **Write state file:**');
    expect(step11Start).toBeGreaterThan(-1);
    const step11 = SKILL.slice(step11Start, SKILL.indexOf('11.5.', step11Start));
    expect(step11).toContain('published_version_number');
  });
});
