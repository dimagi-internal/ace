/**
 * Class-level preventer for dimagi-internal/ace#1652.
 *
 * `connect-supported-capabilities-only` has trigger **always**, so its
 * verbatim Brief paragraph goes into the `/nova:autobuild` brief on EVERY
 * Learn and Deliver build. That paragraph correctly bans case SEARCH (two
 * `TAG_FROZEN` HQ flags, ace#1195) — and then, in the same breath, told the
 * architect to "give each menu a plain case list with useful columns
 * instead."
 *
 * The second half is only correct for a menu a worker navigates THROUGH to
 * reach an existing record. On a registration-only module the entry's only
 * session datum is `function="uuid()"`, so CommCare pushes no
 * entity-selection screen and the authored columns are unreachable by
 * construction — `app-release-qa` Step 2.8 raises
 * `[BLOCKER] case-list-unreachable` on exactly that shape (ace#977).
 *
 * ace#1281 fixed this class at the OTHER producer (`pdd-to-deliver-app`
 * § 4d's case-list *heal*, which now declines on a registration-only
 * module). But § 4d only ever fires on a module whose `caseListConfig.columns`
 * is EMPTY, and this brief had already populated it — so the guard never saw
 * anything to decline. Same class, different door. Observed live on
 * `hh-poverty-targeting/20260824-1404`, and unhealable after the fact: Nova
 * refuses to remove the last visible Results column from a module that
 * declares a case type.
 *
 * The rail: the always-on brief may not instruct case-list authoring
 * unconditionally — it must carry the registration-only carve-out, so the
 * clause cannot silently revert.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LIBRARY = fileURLToPath(
  new URL('../../skills/_app-component-library.md', import.meta.url),
);
const library = readFileSync(LIBRARY, 'utf8');

/** The `### connect-supported-capabilities-only` section. */
function component(): string {
  const parts = library.split(/\n(?=### )/);
  const found = parts.find((p) =>
    /^### connect-supported-capabilities-only\s*$/m.test(p.split('\n')[0]),
  );
  if (!found) throw new Error('component connect-supported-capabilities-only not found');
  return found;
}

/**
 * The verbatim brief paragraph — the blockquote under
 * `**Brief paragraph (verbatim):**`, which is what is copied into the
 * Nova brief. Guarding the whole section would let a fix that lives only in
 * the rationale prose pass while the briefed text stayed unconditional.
 */
function briefParagraph(): string {
  const section = component();
  const idx = section.indexOf('**Brief paragraph (verbatim):**');
  expect(idx, 'component must carry a verbatim brief paragraph').toBeGreaterThan(-1);
  return section
    .slice(idx)
    .split('\n')
    .filter((l) => l.startsWith('>'))
    // Unwrap: the blockquote is hard-wrapped, so a phrase the brief states as
    // one sentence spans several lines. Normalise to a single line before
    // matching, otherwise the assertions test line-wrapping, not wording.
    .map((l) => l.replace(/^>\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('connect-supported-capabilities-only brief — case-list scoping (ace#1652)', () => {
  it('is an always-on component, so its brief ships in every build', () => {
    expect(component()).toMatch(/\*\*Trigger:\*\*\s*always/i);
  });

  it('does not instruct case-list authoring unconditionally', () => {
    const brief = briefParagraph();
    // The exact clause that shipped the defect. Its scoped replacement adds
    // "that a worker navigates THROUGH ..." between "menu" and "a plain case
    // list", so this literal must no longer appear.
    expect(brief).not.toMatch(/give each menu a plain case list/i);
  });

  it('scopes the case-list instruction to navigate-through menus', () => {
    const brief = briefParagraph();
    expect(brief).toMatch(/give each menu[\s\S]{0,160}?navigate/i);
    expect(brief).toMatch(/existing record/i);
  });

  it('states the registration-only carve-out explicitly', () => {
    const brief = briefParagraph();
    expect(brief).toMatch(/registration-only/i);
    expect(brief).toMatch(/must NOT be given case-list columns/i);
    // The mechanism, so the carve-out is not merely an assertion the
    // architect has to take on faith.
    expect(brief).toMatch(/uuid\(\)/);
  });

  it('names the downstream gate the violation trips', () => {
    const brief = briefParagraph();
    expect(brief).toMatch(/app-release-qa/);
    expect(brief).toMatch(/case-list-unreachable/);
    expect(brief).toMatch(/BLOCKER/);
  });

  it('cites the issues that established the class', () => {
    const brief = briefParagraph();
    for (const n of ['977', '1281', '1652']) {
      expect(brief, `brief should cite ace#${n}`).toContain(`#${n}`);
    }
  });
});
