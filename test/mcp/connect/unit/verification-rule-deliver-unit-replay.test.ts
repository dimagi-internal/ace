/**
 * dimagi-internal/ace#2863 — `connect_set_verification_flags` replayed every
 * existing `form_json` rule onto the LAST deliver unit on the page.
 *
 * Connect renders a rule's `deliver_unit` as a CHECKBOX GROUP: one
 * `<input type="checkbox" name="form_json-N-deliver_unit">` per deliver unit,
 * the chosen one `checked="checked"`. `extractFormFieldValues` used to record
 * `value` for every `<input>` regardless of type or `checked`, so every row
 * read as the last box (7200 below). The atom re-posts every existing rule on
 * each call, so ANY second call silently moved every payment rule onto one
 * deliver unit — the once-only `paid_slot` stops came off 10 of 11 units.
 *
 * Fixture: the row-0 markup is verbatim from the live page of
 * smallholder-seasonal/20261012-1549 (opp c0aabb25-…, `ace-pm-org`), as quoted
 * in the issue; the 11-rule page repeats that exact tag shape per rule. No live
 * write was made — a second call against that opportunity is the bug itself.
 */
import { describe, it, expect } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import {
  extractFormFieldValues,
  extractFormFieldValueLists,
  parseFormJsonRules,
} from '../../../../mcp/connect/backends/html-scrape.js';
import {
  PlaywrightBackend,
  deliverUnitMoves,
  postedFormJsonRules,
  toPostForm,
} from '../../../../mcp/connect/backends/playwright.js';
import { VerificationRuleDeliverUnitChangedError } from '../../../../mcp/connect/errors.js';

// Deliver units 7189..7200 — 12 boxes per rule, in page order.
const DUS = Array.from({ length: 12 }, (_, i) => String(7189 + i));
const DU_LABELS: Record<string, string> = { '7189': 'Community walk', '7194': 'Census and PPI survey', '7200': 'Targeted home visit' };

/** One rule's checkbox group, in the live tag shape (`class=""`, `checked="checked"` before `name`). */
function duGroup(i: number, checked: string[]): string {
  return DUS.map((du, j) => {
    const c = checked.includes(du) ? ' checked="checked"' : '';
    return `<label><input type="checkbox" class=""${c} name="form_json-${i}-deliver_unit" id="id_form_json-${i}-deliver_unit_${j + 1}" value="${du}" >  ${DU_LABELS[du] ?? `Unit ${du}`}</label>`;
  }).join('\n');
}

// Rule i -> 7194+i, wrapping — so rule 0 is 7194 (as live) and NO rule is on
// the last box except the one that genuinely is.
const RULE_DU = (i: number) => DUS[(5 + i) % DUS.length];
const ELEVEN = Array.from({ length: 11 }, (_, i) => ({
  id: String(900 + i),
  name: `paid_slot u${i}`,
  path: `form.paid_slot_${i}`,
  value: 'yes',
  du: [RULE_DU(i)],
}));

function verificationPage(rules: Array<{ id: string; name: string; path: string; value: string; du: string[] }>): string {
  const rows = rules
    .map((r, i) => `
      <input type="text" name="form_json-${i}-name" value="${r.name}" maxlength="25">
      <input type="text" name="form_json-${i}-question_path" value="${r.path}">
      <input type="text" name="form_json-${i}-question_value" value="${r.value}">
      ${duGroup(i, r.du)}
      <input type="hidden" name="form_json-${i}-id" value="${r.id}">`)
    .join('\n');
  return `<html><body><form method="post">
    <input type="hidden" name="csrfmiddlewaretoken" value="CSRF123">
    <input type="time" name="form_submission_start" value="">
    <input type="time" name="form_submission_end" value="">
    <input type="hidden" name="deliver_unit-TOTAL_FORMS" value="1">
    <input type="hidden" name="deliver_unit-INITIAL_FORMS" value="0">
    <input type="hidden" name="deliver_unit-MIN_NUM_FORMS" value="0">
    <input type="hidden" name="deliver_unit-MAX_NUM_FORMS" value="1">
    <select name="deliver_unit-0-deliver_unit"><option value="7194" selected>Census and PPI survey</option></select>
    <input type="number" name="deliver_unit-0-duration" value="0">
    <input type="hidden" name="deliver_unit-0-id" value="">
    <input type="hidden" name="form_json-TOTAL_FORMS" value="${rules.length + 1}">
    <input type="hidden" name="form_json-INITIAL_FORMS" value="${rules.length}">
    <input type="hidden" name="form_json-MIN_NUM_FORMS" value="0">
    <input type="hidden" name="form_json-MAX_NUM_FORMS" value="1000">
    <input type="text" name="form_json-__prefix__-name" value="">
    <input type="text" name="form_json-__prefix__-question_path" value="">
    <input type="text" name="form_json-__prefix__-question_value" value="">
    ${DUS.map((d) => `<input type="checkbox" class="" name="form_json-__prefix__-deliver_unit" value="${d}">`).join('\n')}
    <input type="hidden" name="form_json-__prefix__-id" value="">
    ${rows}
  </form></body></html>`;
}

// ---- harness (mirrors playwright-verification-form-field-rules.test.ts) ----
interface Captured { method: 'GET' | 'POST'; url: string; body?: Record<string, string | number | boolean> | FormData }
function makeRequest(scripted: Array<{ status: number; body: string }>, captured: Captured[]): APIRequestContext {
  let i = 0;
  const respond = (n: { status: number; body: string }) =>
    ({ status: () => n.status, headers: () => ({}), text: async () => n.body }) as unknown as APIResponse;
  return {
    get: async (url: string) => {
      captured.push({ method: 'GET', url });
      return respond(scripted[i++]);
    },
    post: async (url: string, init?: { form?: Record<string, string> | FormData }) => {
      captured.push({ method: 'POST', url, body: init?.form });
      return respond(scripted[i++]);
    },
  } as unknown as APIRequestContext;
}
const backend = (request: APIRequestContext) =>
  new PlaywrightBackend({ baseUrl: 'https://connect.example', csrfToken: 'CSRF123', request });
const ORG = 'ace-pm-org';
const OPP = 'c0aabb25-bbc6-4de5-96e8-884bdd38cb9a';

describe('form scrape respects input semantics (ace#2863)', () => {
  const page = verificationPage(ELEVEN);

  it('reads a rule\'s deliver_unit from the CHECKED box, not the last box', () => {
    expect(extractFormFieldValues(page)['form_json-0-deliver_unit']).toBe('7194');
    expect(extractFormFieldValueLists(page)['form_json-0-deliver_unit']).toEqual(['7194']);
    // The value the old scrape produced for EVERY row:
    expect(extractFormFieldValues(page)['form_json-0-deliver_unit']).not.toBe('7200');
  });

  it('parses all 11 persisted rules with their own deliver units', () => {
    const rules = parseFormJsonRules(page);
    expect(rules).toHaveLength(11);
    rules.forEach((r, i) => {
      expect(r.id).toBe(String(900 + i));
      expect(r.deliver_unit_ids).toEqual([RULE_DU(i)]);
    });
    // Distinct units — not all collapsed onto one.
    expect(new Set(rules.map((r) => r.deliver_unit_ids[0])).size).toBe(11);
  });

  it('omits unchecked checkboxes and the __prefix__ template', () => {
    const v = extractFormFieldValueLists(page);
    expect(v['form_json-__prefix__-deliver_unit']).toBeUndefined();
    expect(extractFormFieldValues('<input type="checkbox" name="x" value="1">')).toEqual({});
  });

  it('a checkbox group with several checked boxes yields every checked value', () => {
    const html = duGroup(0, ['7190', '7194']);
    expect(extractFormFieldValueLists(html)['form_json-0-deliver_unit']).toEqual(['7190', '7194']);
  });

  it('radio: only the checked one; checked valueless checkbox reads "on"', () => {
    const html = `
      <input type="radio" name="r" value="a">
      <input type="radio" name="r" value="b" checked>
      <input type="radio" name="r" value="c">
      <input type="checkbox" name="flag" checked>`;
    expect(extractFormFieldValues(html)).toEqual({ r: 'b', flag: 'on' });
  });

  it('`checked` inside a name or value does not count as the attribute', () => {
    const html = '<input type="checkbox" name="unchecked_items" value="checked">';
    expect(extractFormFieldValues(html)).toEqual({});
  });

  it('select: selected option in any attribute order; multi-select yields a list', () => {
    expect(extractFormFieldValues('<select name="s"><option value="1">A</option><option selected value="2">B</option></select>'))
      .toEqual({ s: '2' });
    expect(extractFormFieldValueLists('<select name="m" multiple><option value="1" selected>A</option><option value="2">B</option><option value="3" selected>C</option></select>'))
      .toEqual({ m: ['1', '3'] });
  });
});

describe('setVerificationFlags second call leaves existing rules on their units (ace#2863)', () => {
  it('a duration-only second call replays every rule on its own deliver unit', async () => {
    const page = verificationPage(ELEVEN);
    const captured: Captured[] = [];
    const req = makeRequest([{ status: 200, body: page }, { status: 302, body: '' }, { status: 200, body: page }], captured);
    const res = await backend(req).setVerificationFlags({
      organization_slug: ORG, opportunity_id: OPP,
      flags: { deliver_unit_checks: [{ deliver_unit_id: 7194, duration_minutes: 6 }] },
    });
    const body = captured.find((c) => c.method === 'POST')!.body as Record<string, string>;
    for (let i = 0; i < 11; i++) expect(body[`form_json-${i}-deliver_unit`]).toBe(RULE_DU(i));
    expect(res.form_field_rules?.map((r) => r.deliver_unit_ids[0])).toEqual(ELEVEN.map((r) => r.du[0]));
  });

  it('adding one more rule keeps all 11 existing rules on their units and appends the 12th', async () => {
    const page = verificationPage(ELEVEN);
    const after = verificationPage([...ELEVEN, { id: '911', name: 'paid_slot u11', path: 'form.paid_slot_11', value: 'yes', du: ['7200'] }]);
    const captured: Captured[] = [];
    const req = makeRequest([{ status: 200, body: page }, { status: 302, body: '' }, { status: 200, body: after }], captured);
    const res = await backend(req).setVerificationFlags({
      organization_slug: ORG, opportunity_id: OPP,
      flags: { form_field_rules: [{ name: 'paid_slot u11', question_path: 'form.paid_slot_11', question_value: 'yes', deliver_unit_id: 7200 }] },
    });
    const body = captured.find((c) => c.method === 'POST')!.body as Record<string, string>;
    for (let i = 0; i < 11; i++) {
      expect(body[`form_json-${i}-id`]).toBe(String(900 + i));
      expect(body[`form_json-${i}-deliver_unit`]).toBe(RULE_DU(i));
    }
    expect(body['form_json-11-deliver_unit']).toBe('7200');
    expect(body['form_json-TOTAL_FORMS']).toBe('12');
    expect(res.form_field_rules).toHaveLength(12);
  });

  it('re-sending the same 11 rules is a no-op for their units (dedup on the CHECKED unit)', async () => {
    const page = verificationPage(ELEVEN);
    const captured: Captured[] = [];
    const req = makeRequest([{ status: 200, body: page }, { status: 302, body: '' }, { status: 200, body: page }], captured);
    await backend(req).setVerificationFlags({
      organization_slug: ORG, opportunity_id: OPP,
      flags: {
        form_field_rules: ELEVEN.map((r) => ({
          name: r.name, question_path: r.path, question_value: r.value, deliver_unit_id: Number(r.du[0]),
        })),
      },
    });
    const body = captured.find((c) => c.method === 'POST')!.body as Record<string, string>;
    expect(body['form_json-TOTAL_FORMS']).toBe('11');
    for (let i = 0; i < 11; i++) expect(body[`form_json-${i}-deliver_unit`]).toBe(RULE_DU(i));
  });

  it('a multi-unit rule is replayed with every checked unit (FormData, repeated keys)', async () => {
    const rules = [{ ...ELEVEN[0], du: ['7190', '7194'] }];
    const page = verificationPage(rules);
    const captured: Captured[] = [];
    const req = makeRequest([{ status: 200, body: page }, { status: 302, body: '' }, { status: 200, body: page }], captured);
    await backend(req).setVerificationFlags({
      organization_slug: ORG, opportunity_id: OPP, flags: { form_submission_start: '08:00' },
    });
    const body = captured.find((c) => c.method === 'POST')!.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.getAll('form_json-0-deliver_unit')).toEqual(['7190', '7194']);
  });

  it('fails LOUD when the fresh read-back shows an existing rule moved', async () => {
    const page = verificationPage(ELEVEN);
    const corrupted = verificationPage(ELEVEN.map((r) => ({ ...r, du: ['7200'] })));
    const captured: Captured[] = [];
    const req = makeRequest([{ status: 200, body: page }, { status: 302, body: '' }, { status: 200, body: corrupted }], captured);
    const err = await backend(req)
      .setVerificationFlags({ organization_slug: ORG, opportunity_id: OPP, flags: { form_submission_start: '08:00' } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(VerificationRuleDeliverUnitChangedError);
    expect(err.toJSON()).toMatchObject({ error: 'verification_rule_deliver_unit_changed', phase: 'post_write' });
    // Rule 6 was genuinely on 7200 already; the other 10 moved.
    expect(err.changed).toHaveLength(10);
  });
});

describe('replay guard helpers (ace#2863)', () => {
  it('postedFormJsonRules + deliverUnitMoves name a row whose unit would change', () => {
    const before = parseFormJsonRules(verificationPage(ELEVEN.slice(0, 2)));
    const posted = postedFormJsonRules({
      'form_json-0-id': '900', 'form_json-0-name': 'paid_slot u0', 'form_json-0-deliver_unit': '7200',
      'form_json-1-id': '901', 'form_json-1-name': 'paid_slot u1', 'form_json-1-deliver_unit': RULE_DU(1),
    });
    expect(deliverUnitMoves(before, posted)).toEqual([
      { id: '900', name: 'paid_slot u0', before: ['7194'], after: ['7200'] },
    ]);
  });

  it('toPostForm keeps a plain record unless a key repeats', () => {
    expect(toPostForm({ a: '1' })).toEqual({ a: '1' });
    const fd = toPostForm({ a: ['1', '2'], b: '3' }) as FormData;
    expect(fd.getAll('a')).toEqual(['1', '2']);
    expect(fd.get('b')).toBe('3');
  });
});
