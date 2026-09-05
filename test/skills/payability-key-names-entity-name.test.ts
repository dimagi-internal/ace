/**
 * Class-level preventer for dimagi-internal/ace#1958.
 *
 * `_app-component-library § payability-scoped-key` is exhaustive about
 * `entity_id` — the discriminator, `concat` placement, the no-free-text rule,
 * the ace#1434 precedence override, the required Phase-4 predicate, the scope
 * limit. Until this test it said NOTHING about `entity_name`, while
 * `pdd-to-deliver-app` independently defines `entity_name` as "the
 * human-readable label field" that "follows the same construction over the
 * human-readable fields" — with no discriminator in it.
 *
 * So a build that followed BOTH contracts exactly scoped the key and left the
 * display name identity-only, by construction. Observed live on
 * `bednet-check-2-visit/20260902-1555` (Deliver app
 * `aad54896-eeb0-4f37-b421-74e618831484`):
 *
 *   entity_key   = concat(#user/username, ' - ', #form/encounter_date, ' - ', #form/consent_confirmed)
 *   entity_label = concat(#user/username, ' - ', #form/encounter_date)
 *
 * On a worker-day carrying both a re-affirmed follow-up (payable) and a
 * withdrawn one (rejected by the required Phase-4 predicate), Connect mints
 * two entities whose display names are byte-identical. The worker reads two
 * indistinguishable rows on their completed-work / invoice view, one approved
 * and one rejected, with nothing on either saying which encounter it was.
 * The key is correct; the payment record is illegible.
 *
 * The rail is a CONSISTENCY requirement, not a format: whatever `entity_id`
 * is required to discriminate, `entity_name` must distinguish too. The exact
 * display string stays the author's call — the component already delegates
 * which "human-readable fields" to use, and this test must not be read as
 * mandating one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LIBRARY = fileURLToPath(
  new URL('../../skills/_app-component-library.md', import.meta.url),
);
const EVAL = fileURLToPath(
  new URL('../../skills/pdd-to-deliver-app-eval/SKILL.md', import.meta.url),
);

/** The `### payability-scoped-key` section of the component library. */
function component(): string {
  const library = readFileSync(LIBRARY, 'utf8');
  const parts = library.split(/\n(?=### )/);
  const found = parts.find((p) =>
    /^### payability-scoped-key\s*$/m.test(p.split('\n')[0]),
  );
  if (!found) throw new Error('component payability-scoped-key not found');
  return found;
}

/**
 * The verbatim brief paragraph — the blockquote under
 * `**Brief paragraph (verbatim):**`, which is what is copied into the Nova
 * brief. Guarding the whole section would let a fix that lives only in the
 * rationale prose pass while the briefed text stayed silent on the display
 * name, which is exactly the shape of the defect.
 */
function briefParagraph(): string {
  const section = component();
  const idx = section.indexOf('**Brief paragraph (verbatim):**');
  expect(idx, 'component must carry a verbatim brief paragraph').toBeGreaterThan(-1);
  return section
    .slice(idx)
    .split('\n')
    .filter((l) => l.startsWith('>'))
    .map((l) => l.replace(/^>\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('payability-scoped-key brief — the display name too (ace#1958)', () => {
  it('names entity_id, the slot it has always covered', () => {
    expect(briefParagraph()).toMatch(/entity_id/);
  });

  it('names entity_name — the briefed text, not only the rationale prose', () => {
    // The exact grep the filing ran against main: zero hits, whole file.
    expect(briefParagraph()).toMatch(/entity_name/);
  });

  it('REQUIRES the display name to distinguish the non-payable branch', () => {
    const brief = briefParagraph();
    // One sentence must both name the slot and carry the obligation — a
    // passing mention of entity_name elsewhere in the brief is not the rail.
    const sentences = brief.split(/(?<=[.:])\s+/);
    const obligation = sentences.filter(
      (s) => /entity_name/.test(s) && /\bMUST\b/.test(s) && /distinguish/i.test(s),
    );
    expect(
      obligation.length,
      'brief must state that entity_name MUST distinguish the non-payable branch',
    ).toBeGreaterThan(0);
  });

  it('leaves the display string to the author rather than mandating a format', () => {
    // The scope-discipline half of ace#1958: the requirement ships, the
    // product call does not. If someone later hardcodes one string, this
    // fails and the taste decision goes back to a human.
    expect(briefParagraph()).toMatch(/not a mandated format|author's call|distinguish-and-disclose/i);
  });
});

describe('pdd-to-deliver-app-eval grades the display name (ace#1958)', () => {
  it('(b2) reads entity_name, not entity_id alone', () => {
    const rubric = readFileSync(EVAL, 'utf8');
    const b2 = rubric
      .split('\n')
      .filter((l) => /\(b2\)\s*PAYABILITY/.test(l))
      .join(' ');
    expect(b2, 'rubric must carry a (b2) PAYABILITY clause').not.toBe('');
    expect(
      b2,
      'a build that scopes entity_id but not entity_name must be gradeable under (b2)',
    ).toMatch(/entity_name/);
  });
});
