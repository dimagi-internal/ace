/**
 * The work-order template and its two token contracts must not drift
 * (dimagi-internal/ace#1521).
 *
 * `templates/work-order-template.md` is not documentation — it is the CANONICAL
 * CONTENT that `scripts/bootstrap-work-order-template.ts` uploads to become the
 * live `WORK_ORDER_TEMPLATE_ID` gdoc that every rendered Work Order is copied
 * from (`playbook/integrations/work-order-template.md § Refresh`). Two other
 * files declare what tokens that template carries:
 *
 *   - `skills/pdd-to-work-order/SKILL.md § Process` step 5 — what the PRODUCER
 *     emits a value for.
 *   - `playbook/integrations/work-order-template.md § Token contract` — the
 *     integration reference.
 *
 * All three have to agree, and nothing made them. ace#1004 is what that costs:
 * § 6.2 ended in a hardcoded renderer instruction ("…at the per-visit (or
 * per-session, per archetype) rate…") that shipped verbatim into a signed
 * contract, telling a partner their payment unit depended on an "archetype"
 * defined nowhere in the document. PR #1371 fixed it by adding
 * `{{payment_unit_closing}}` to SKILL.md and hand-editing the LIVE GDOC — the
 * repo template and the playbook contract were never touched. So the defect sat
 * dormant in the regeneration source for five days: re-running the bootstrap
 * would have reintroduced a closed `blocks-partner-trust` defect into a
 * contractual artifact, and `pdd-to-work-order-qa`'s `no_renderer_instructions`
 * check would only have caught it AFTER a partner-facing document was rendered.
 *
 * Both existing preventers are structurally blind to this: the ace#819
 * token-coverage scan and `no_scaffolding_markers` both run against the RENDERED
 * doc, so neither can see a template that is missing a token the skill intends
 * to fill. This test runs against the repo, before anything renders.
 *
 * SCOPE: this asserts consistency among the three files IN THE REPO. It
 * deliberately does not read the live gdoc — that would need Drive credentials
 * and make CI flaky. The repo template is the bootstrap source, so keeping it
 * correct is what keeps a regenerated gdoc correct; a live gdoc hand-edited out
 * from under the repo is a separate class, and the fix for it is to stop
 * hand-editing and re-bootstrap.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkNoScaffoldingMarkers,
  checkNoRendererInstructions,
} from '../../skills/pdd-to-work-order-qa/checks.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const TEMPLATE = 'templates/work-order-template.md';
const SKILL = 'skills/pdd-to-work-order/SKILL.md';
const PLAYBOOK = 'playbook/integrations/work-order-template.md';

/**
 * Meta-placeholders — these name the token SHAPE, not a real token.
 * `{{snake_case}}` appears in "Tokens use `{{...}}` snake_case"; `{{token}}`
 * in prose about what is and isn't a token.
 */
const META = new Set(['snake_case', 'token']);

/**
 * Tokens the docs mention in order to say the template does NOT have them.
 * SKILL.md: "There is NO single `{{scope_body}}` token in the live template."
 * That warning is load-bearing (ace#819) and must not be read as a declaration.
 */
const DOCUMENTED_NEGATIVES = new Set(['scope_body']);

/**
 * The template enumerates repeated table rows (`{{week_3_dates}}`,
 * `{{raci_11_partner}}`); the docs write the family once (`{{week_N_dates}}`).
 * Collapse both sides to the family so the comparison is about WHICH tokens
 * exist, not how many rows the table happens to have.
 */
function normalize(token: string): string {
  return token.replace(/^(week|raci)_\d+_/, '$1_N_');
}

function tokensIn(rel: string): Set<string> {
  const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  const found = text.match(/\{\{([a-zA-Z0-9_]+)\}\}/g) ?? [];
  const out = new Set<string>();
  for (const raw of found) {
    const name = raw.slice(2, -2);
    if (META.has(name) || DOCUMENTED_NEGATIVES.has(name)) continue;
    out.add(normalize(name));
  }
  return out;
}

const sorted = (s: Set<string>) => [...s].sort();
const missing = (from: Set<string>, present: Set<string>) =>
  sorted(from).filter((t) => !present.has(t));

describe('work-order template token contract', () => {
  it('every token the producer skill emits exists in the repo template', () => {
    // The ace#1521 direction: SKILL.md gained {{payment_unit_closing}} in
    // PR #1371 and the template never got it.
    expect(missing(tokensIn(SKILL), tokensIn(TEMPLATE))).toEqual([]);
  });

  it('every token in the repo template is documented in the producer skill', () => {
    // The opposite drift: a template token no skill fills renders as a literal
    // `{{...}}` into a contract (the ace#819 failure).
    expect(missing(tokensIn(TEMPLATE), tokensIn(SKILL))).toEqual([]);
  });

  it('the playbook token contract matches the repo template exactly', () => {
    expect(sorted(tokensIn(PLAYBOOK))).toEqual(sorted(tokensIn(TEMPLATE)));
  });

  it('the template carries no hardcoded archetype-branching renderer instruction', () => {
    // The literal ace#1004 defect, pinned so a future edit cannot reintroduce
    // the exact sentence. `pdd-to-work-order-qa § no_renderer_instructions`
    // owns the general rule against the RENDERED doc; this guards the source.
    const text = fs.readFileSync(path.join(REPO_ROOT, TEMPLATE), 'utf8');
    expect(text).not.toMatch(/per archetype/i);
    expect(text).not.toMatch(/\(or per-session/i);
  });
});

/**
 * A Work Order is a CONTRACTUAL document a partner reads (dimagi-internal/ace#1542).
 * Internal Dimagi/Connect acronyms are not defined anywhere in it, and
 * `pdd-to-work-order-eval`'s `writing_style` dimension grades their presence —
 * so an unexpanded acronym baked into the TEMPLATE ships into every rendered
 * Work Order, not just one.
 *
 * `FLW` sat in § 6.1 and § 8.3 as a template literal (not a `{{token}}`), so no
 * producer-side check could ever see it: the token-coverage scan above only
 * compares `{{...}}` names, and `pdd-to-work-order-qa` runs against the RENDERED
 * doc after a partner-facing artifact already exists.
 *
 * SCOPE: this is a deliberate allow-nothing check on a SPECIFIC acronym list,
 * not an English-prose linter. Add an entry only when it is (a) internal jargon
 * and (b) undefined in the document.
 */
const INTERNAL_ACRONYMS = [
  // Front-Line Worker — expand to "field worker(s)" in partner-facing prose.
  /\bFLWs?\b/,
];

describe('work-order template partner-facing language', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, TEMPLATE), 'utf8');

  for (const pattern of INTERNAL_ACRONYMS) {
    it(`carries no unexpanded internal acronym matching ${pattern}`, () => {
      const offending = text
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => pattern.test(line))
        .map(([n, line]) => `${TEMPLATE}:${n}: ${line.trim()}`);
      expect(offending).toEqual([]);
    });
  }
});

/**
 * The document names a party it never introduces (dimagi-internal/ace#2126).
 *
 * `pdd-to-work-order-eval § writing_style` requires that the first reference
 * define `[Partner Name] (henceforth, referred to as "partner")` and that every
 * later mention be lowercase `the partner`. The template gave that definition
 * nowhere to land: the three `partner_*` tokens all sit in the SIGNATURE block,
 * and § 1 Background was a bare `{{background_body}}` with no lead-in. So every
 * rendered Work Order used `the partner` — thirteen times on
 * `spark-facilitator/20260906-2233` — with no antecedent anywhere in the
 * document, and `writing_style` (weight 0.15, bands 0/1-3/4+) took one
 * guaranteed strike on every run the pipeline has ever produced.
 *
 * The strike is the cheap half. A signed agreement that obliges "the partner"
 * thirteen times without defining who that is leaves the reader to infer the
 * antecedent from the *Subcontractor* signature block.
 *
 * This is the same class as the `FLW` check above and is fixed the same way —
 * in the bootstrap SOURCE rather than in one rendered artifact. The Phase 1
 * operator patched the rendered gdoc by hand this run, which does nothing for
 * the next one.
 *
 * The three-way token-sync tests above already force the new token into
 * SKILL.md and the playbook contract. What they cannot see is whether the
 * CONVENTION landed — a token named `partner_first_reference` that the producer
 * fills with a bare org name would satisfy every one of them and still take the
 * strike. Hence the two assertions here: the slot is positioned to be the first
 * reference, and the producer is told what shape to put in it.
 */
describe('work-order template defines the partner on first reference (#2126)', () => {
  const template = fs.readFileSync(path.join(REPO_ROOT, TEMPLATE), 'utf8');
  const skill = fs.readFileSync(path.join(REPO_ROOT, SKILL), 'utf8');

  const backgroundSection = template.match(/^## 1\. Background$[\s\S]*?(?=^## 2\.)/m)?.[0];

  it('§ 1 Background carries the first-reference slot AHEAD of the background body', () => {
    // Position is the whole point: a definition that lands after the first use
    // is not a first reference. § 1 is the first prose in the document.
    expect(backgroundSection, 'the § 1 Background section moved or was renamed').toBeDefined();

    const slot = backgroundSection!.indexOf('{{partner_first_reference}}');
    const body = backgroundSection!.indexOf('{{background_body}}');

    expect(slot, '§ 1 Background has no {{partner_first_reference}} slot').toBeGreaterThanOrEqual(0);
    expect(body).toBeGreaterThanOrEqual(0);
    expect(slot, '{{partner_first_reference}} must precede {{background_body}}').toBeLessThan(body);
  });

  it('the producer skill states the convention and the unnamed-partner default', () => {
    // Without this the token exists and gets filled with something arbitrary.
    // Anchor on the TOKEN-SPEC bullet, not on the first mention anywhere in
    // the file. Prose elsewhere in SKILL.md legitimately names the token — the
    // ace#2126 unmatched-key rule in the render step does — and `indexOf` then
    // slices 800 chars from THAT mention and reports the convention missing.
    // A false positive about a convention that never moved is worse than no
    // check: it sends the reader to the wrong line.
    const at = skill.indexOf('`{{partner_first_reference}}` —');
    expect(at, `${SKILL} does not document {{partner_first_reference}}`).toBeGreaterThanOrEqual(0);

    const spec = skill.slice(at, at + 800);
    expect(spec, 'the henceforth convention is not stated').toMatch(
      /henceforth, referred to as/i,
    );
    expect(spec, 'the unnamed-partner bracket default is not stated').toMatch(
      /\[Partner Name\]/,
    );
  });

  it('the rendered first reference does not trip the QA scaffolding or renderer checks', () => {
    // The remedy, executed rather than assumed. `[Partner Name]` is the
    // sanctioned pre-partner form (SKILL.md § Process step 3(c)) and a Work
    // Order drafted before a partner is selected is the NORMAL Phase 1 case, so
    // the unnamed variant is the one that has to be clean.
    const lead = backgroundSection!.replace(
      '{{partner_first_reference}}',
      '[Partner Name] (henceforth, referred to as "partner")',
    ).replace('{{background_body}}', 'Background prose.');

    expect(checkNoScaffoldingMarkers(lead).pass, JSON.stringify(checkNoScaffoldingMarkers(lead)))
      .toBe(true);
    expect(checkNoRendererInstructions(lead).pass, JSON.stringify(checkNoRendererInstructions(lead)))
      .toBe(true);
  });
});
