/**
 * A rubric may not REQUIRE an operator instruction the platform cannot satisfy
 * (dimagi-internal/ace#1811).
 *
 * Sibling of `credential-hygiene-vs-widget-url.test.ts` (#1680), which asserts a
 * rubric may not FORBID what a sibling dimension REQUIRES. This one covers the
 * other direction: requiring something that does not exist at all.
 *
 * `skills/ocs-widget-handoff-eval` graded 30% of the Phase 5 widget handoff on
 * telling the LLO "where to paste (Connect opp config tab, specific field
 * name)", and called the Connect opportunity URL the one "the LLO needs to
 * paste INTO". There is no such field:
 *
 *   - `connect_update_opportunity` accepts only description / end_date /
 *     is_test / name / opportunity_id / organization_slug / short_description.
 *   - `mcp/connect/` contains no widget or embed surface at all.
 *   - Four sibling skills state "Connect has no per-opp widget field" verbatim.
 *
 * So a handoff that told the truth LOST points, and the handoff that shipped on
 * `hh-poverty-targeting/20260828-0702` sent an operator hunting for a UI element
 * three files in the same repo say is absent. The rubric did not merely miss the
 * defect — it rewarded it.
 *
 * The invariant is deliberately narrow. It does NOT ban the word "paste", which
 * legitimately appears when EXPLAINING that no paste target exists — banning the
 * bare word is the always-fires-blocker class (ace#1026). It bans the two
 * authoring shapes that send a reader to a nonexistent UI surface: naming a
 * Connect widget FIELD to paste into, and phrasing the opportunity URL as a
 * paste destination.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Files that author or grade the widget handoff. */
const AUTHORING_FILES = [
  'agents/ocs-setup.md',
  'skills/ocs-widget-handoff-eval/SKILL.md',
];

/**
 * Phrasings that direct a reader INTO a Connect widget field. Each is an
 * instruction, not a description — the negated forms ("there is nothing to paste
 * it into", "not a paste target") are what a correct file says instead, so the
 * patterns require an imperative/destination shape rather than the noun alone.
 */
const PHANTOM_PASTE_TARGET = [
  /paste\s+(?:them|it|the\s+\w+)?\s*into\s+the\s+Connect/i,
  /paste\s+INTO\b/,
  /where\s+to\s+paste\s*\(/i,
  /find\s+the\s+\*{0,2}support\s+chatbot\s*\/?\s*help\s+widget\*{0,2}\s+field\s+group/i,
  /Connect\s+opp\s+config\s+tab/i,
];

/** The claim the fix rests on, which must stay stated somewhere authoritative. */
const NO_FIELD_CLAIM = /no\s+per-opp(?:ortunity)?\s+widget\s+field/i;

describe('widget handoff does not send operators to a phantom paste target (ace#1811)', () => {
  for (const rel of AUTHORING_FILES) {
    it(`${rel} contains no instruction to paste into a Connect widget field`, () => {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      // The changelog records the retired phrasing verbatim; exclude it so the
      // history of the fix does not trip the guard the fix installed.
      const body = text.split(/^\|\s*Date\s*\|\s*Change\s*\|/m)[0];
      const hits = PHANTOM_PASTE_TARGET.filter((re) => re.test(body)).map(String);
      expect(hits, `${rel} instructs a paste-in that CCC-301 has not shipped`).toEqual([]);
    });
  }

  it('the rubric states plainly that no per-opportunity widget field exists', () => {
    const text = fs.readFileSync(
      path.join(REPO_ROOT, 'skills/ocs-widget-handoff-eval/SKILL.md'), 'utf8');
    expect(NO_FIELD_CLAIM.test(text) || /nothing to paste it into/i.test(text)).toBe(true);
  });

  it('the sibling skills that assert the field is absent still do so', () => {
    // If these ever stop saying it, the rubric's premise needs re-checking
    // rather than silently drifting.
    const siblings = [
      'skills/training-faq/SKILL.md',
      'skills/training-quick-reference/SKILL.md',
      'skills/training-flw-guide/SKILL.md',
      'skills/_training-template.md',
    ];
    const missing = siblings.filter((rel) => {
      const p = path.join(REPO_ROOT, rel);
      return !fs.existsSync(p) || !NO_FIELD_CLAIM.test(fs.readFileSync(p, 'utf8'));
    });
    expect(missing, 'a sibling stopped asserting Connect has no per-opp widget field').toEqual([]);
  });

  it('connect_update_opportunity still has no widget parameter', () => {
    const schemas = fs.readFileSync(path.join(REPO_ROOT, 'docs/atom-schemas.md'), 'utf8');
    const idx = schemas.indexOf('### `connect_update_opportunity`');
    expect(idx, 'connect_update_opportunity missing from atom schemas').toBeGreaterThan(-1);
    const section = schemas.slice(idx, idx + 2500);
    expect(/widget|embed_key/i.test(section),
      'connect_update_opportunity grew a widget parameter — CCC-301 may have shipped; revisit ace#1811',
    ).toBe(false);
  });
});
