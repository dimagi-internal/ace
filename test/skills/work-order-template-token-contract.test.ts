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
