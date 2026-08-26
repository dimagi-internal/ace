/**
 * A rubric may not forbid what a sibling dimension of the SAME rubric requires
 * (dimagi-internal/ace#1680).
 *
 * `skills/ocs-widget-handoff-eval` graded the Phase 5 widget handoff on four
 * dimensions, two of which disagreed with each other:
 *
 *   - `widget_url_resolves` (25%) REQUIRES the bot's public chat URL,
 *     `https://www.openchatstudio.com/a/<team_slug>/chatbots/<public_id>/start/`.
 *     The OCS route is team-scoped (`apps/chatbots/urls.py:80` mounted under
 *     `config/urls.py:88`), so the team slug is structurally unavoidable in it —
 *     that is the whole point of ace#1021.
 *   - `credential_hygiene` (25%) listed `OCS_TEAM_SLUG` among the "global
 *     secrets" that must never appear in an LLO-facing artifact — and that
 *     dimension is not advisory: a leak is an explicit auto-fail security guard
 *     and a `[BLOCKER]`.
 *
 * So a CORRECT handoff — one carrying exactly the URL the rubric mandates — was
 * reachable on a literal reading as a `fail` on a security guard. The Phase 5
 * judge on spark-facilitator/20260820-0817 graded it a pass with an explanatory
 * INFO, which is the right call, but nothing in the rubric compelled it. A
 * written rubric whose verdict depends on which way the judge leans is the
 * defect, independent of how any one run came out.
 *
 * Two invariants, both cheap and offline:
 *
 *   1. NO INTERSECTION — no value the mandated URL template interpolates may
 *      appear on the hygiene deny-list. This is the assertion that would have
 *      failed on the shipped text: `<team_slug>` in the URL vs `OCS_TEAM_SLUG`
 *      on the deny-list.
 *   2. EXPLICIT EXEMPTION — the hygiene row must still NAME each URL
 *      placeholder as public-by-construction. Deleting the offending env var
 *      alone leaves the next judge to re-derive the exemption from scratch;
 *      the rubric has to say it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL = join(__dirname, '..', '..', 'skills/ocs-widget-handoff-eval/SKILL.md');

/** A markdown table row whose first cell is the bolded dimension name. */
function rubricRow(text: string, dimensionLabel: string): string {
  const row = text
    .split('\n')
    .find((l) => l.trimStart().startsWith(`| **${dimensionLabel}**`));
  if (!row) throw new Error(`rubric row not found: **${dimensionLabel}**`);
  return row;
}

/** `<team_slug>` / `<public_id>` — the values the mandated URL interpolates. */
function urlPlaceholders(row: string): string[] {
  const urls = row.match(/https?:\/\/[^\s`|]+/g) ?? [];
  const found = new Set<string>();
  for (const u of urls) {
    for (const m of u.matchAll(/<([a-z][a-z0-9_]*)>/g)) found.add(m[1]);
  }
  return [...found];
}

/**
 * Env-var-shaped tokens on the hygiene row: `OCS_API_TOKEN`, `LABS_MCP_TOKEN`.
 * The underscore is required so prose words in caps (NEVER, REQUIRES) and bare
 * acronyms (OCS, LLO, HQ) are not mistaken for deny-list entries.
 */
function denyList(row: string): string[] {
  return [...new Set(row.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])];
}

describe('ocs-widget-handoff-eval: credential_hygiene vs widget_url_resolves', () => {
  const text = readFileSync(SKILL, 'utf8');
  const urlRow = rubricRow(text, 'Widget URL resolves');
  const hygieneRow = rubricRow(text, 'Credential hygiene');

  const placeholders = urlPlaceholders(urlRow);
  const denied = denyList(hygieneRow);

  it('the mandated widget URL actually interpolates values (guards the fixture)', () => {
    expect(placeholders).toContain('team_slug');
    expect(placeholders).toContain('public_id');
  });

  it('the hygiene guard still denies real cross-opportunity credentials', () => {
    // If this list empties out, the security guard has been gutted rather than
    // corrected — which is the opposite failure from ace#1680.
    expect(denied).toContain('OCS_API_TOKEN');
    expect(denied.length).toBeGreaterThanOrEqual(3);
  });

  it('denies nothing the mandated URL requires (ace#1680)', () => {
    for (const ph of placeholders) {
      const needle = ph.toUpperCase(); // team_slug -> TEAM_SLUG
      const collisions = denied.filter((d) => d === needle || d.endsWith(`_${needle}`));
      expect(
        collisions,
        `credential_hygiene denies ${collisions.join(', ')}, but widget_url_resolves ` +
          `REQUIRES a URL containing <${ph}>. A correct handoff would auto-fail the ` +
          `security guard. Drop it from the deny-list — see ace#1680.`,
      ).toEqual([]);
    }
  });

  it('names each URL placeholder as public-by-construction', () => {
    for (const ph of placeholders) {
      expect(
        hygieneRow,
        `credential_hygiene must state that \`${ph}\` is never a hygiene finding, ` +
          `not merely omit it from the deny-list — otherwise the next judge ` +
          `re-derives the exemption and may lean the other way (ace#1680).`,
      ).toContain(ph);
    }
    expect(hygieneRow.toLowerCase()).toMatch(/public-by-construction|never a hygiene finding/);
  });
});
