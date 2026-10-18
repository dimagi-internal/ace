/**
 * dimagi-internal/ace#3161: there was no read-only atom for an opportunity's
 * verification config, so modify flows (app-modify, connect-opp-modify,
 * app-release-qa Step 4.7) could take a before-read only through the setter,
 * which is a write path.
 *
 * The fixture uses the live tag shapes the setter's own tests pin: a rule's
 * deliver unit is a CHECKBOX GROUP (ace#2863, smallholder-seasonal/20261012-1549)
 * and a deliver_unit row is a DISABLED select with one `selected` option
 * (ace#2945, smallholder-seasonal/20261014-0859).
 */
import { describe, it, expect } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';
import { VerificationPagePmOnlyError } from '../../../../mcp/connect/errors.js';

const DUS = ['7189', '7190', '7191'];

function duGroup(i: number, checked: string): string {
  return DUS.map((du, j) => {
    const c = du === checked ? ' checked="checked"' : '';
    return `<label><input type="checkbox" class=""${c} name="form_json-${i}-deliver_unit" id="id_form_json-${i}-deliver_unit_${j + 1}" value="${du}" > Unit ${du}</label>`;
  }).join('\n');
}

function duRow(i: number, du: string, duration: string): string {
  const options = DUS.map((d) => `<option value="${d}"${d === du ? ' selected' : ''}>Unit ${d}</option>`).join('');
  return `
    <select name="deliver_unit-${i}-deliver_unit" class="select form-select" disabled id="id_deliver_unit-${i}-deliver_unit">
      <option value="">---------</option>${options}
    </select>
    <input type="number" name="deliver_unit-${i}-duration" value="${duration}" class="numberinput form-control">
    <input type="hidden" name="deliver_unit-${i}-id" value="${5000 + i}">`;
}

const PAGE = `<html><body><form method="post">
  <input type="hidden" name="csrfmiddlewaretoken" value="CSRF123">
  <input type="time" name="form_submission_start" value="07:00">
  <input type="time" name="form_submission_end" value="">
  <input type="hidden" name="deliver_unit-TOTAL_FORMS" value="3">
  <input type="hidden" name="deliver_unit-INITIAL_FORMS" value="3">
  ${duRow(0, '7189', '6')}
  ${duRow(1, '7190', '0')}
  ${duRow(2, '7191', '')}
  <input type="hidden" name="form_json-TOTAL_FORMS" value="3">
  <input type="hidden" name="form_json-INITIAL_FORMS" value="2">
  <input type="text" name="form_json-0-name" value="paid slot" maxlength="25">
  <input type="text" name="form_json-0-question_path" value="form.paid_slot">
  <input type="text" name="form_json-0-question_value" value="yes">
  ${duGroup(0, '7190')}
  <input type="hidden" name="form_json-0-id" value="901">
  <input type="text" name="form_json-1-name" value="consent" maxlength="25">
  <input type="text" name="form_json-1-question_path" value="form.consent">
  <input type="text" name="form_json-1-question_value" value="agree">
  ${duGroup(1, '7189')}
  <input type="hidden" name="form_json-1-id" value="902">
  <input type="text" name="form_json-2-name" value="">
  <input type="text" name="form_json-2-question_path" value="">
  <input type="text" name="form_json-2-question_value" value="">
  ${duGroup(2, '')}
  <input type="hidden" name="form_json-2-id" value="">
  <input type="text" name="form_json-__prefix__-question_path" value="">
</form></body></html>`;

interface Call { method: 'GET' | 'POST'; url: string; opts?: { maxRedirects?: number } }

function backend(responses: Array<{ status: number; body?: string; location?: string }>, calls: Call[]): PlaywrightBackend {
  let i = 0;
  const respond = (r: { status: number; body?: string; location?: string }): APIResponse =>
    ({
      status: () => r.status,
      headers: () => ({ 'content-type': 'text/html', ...(r.location ? { location: r.location } : {}) }),
      text: async () => r.body ?? '',
    }) as unknown as APIResponse;
  const request = {
    get: async (url: string, opts?: { maxRedirects?: number }) => {
      calls.push({ method: 'GET', url, opts });
      return respond(responses[i++]);
    },
    post: async (url: string) => {
      calls.push({ method: 'POST', url });
      return respond(responses[i++]);
    },
  } as unknown as APIRequestContext;
  return new PlaywrightBackend({ baseUrl: 'https://connect.example', csrfToken: 'c', request });
}

const OPP = 'c0aabb25-0000-0000-0000-000000000000';

describe('getVerificationFlags (ace#3161)', () => {
  it('reads rules, deliver-unit floors and window from the PM-only page, and never POSTs', async () => {
    const calls: Call[] = [];
    const out = await backend([{ status: 200, body: PAGE }], calls).getVerificationFlags({
      organization_slug: 'pm-org',
      opportunity_id: OPP,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `/a/pm-org/opportunity/${OPP}/verification_flags_config/` });
    expect(calls[0].opts?.maxRedirects).toBe(0);
    expect(out.form_field_rules_saved).toBe(2);
    // Each rule's unit is its CHECKED box, not the last box on the page (ace#2863).
    expect(out.form_field_rules.map((r) => [r.id, r.question_path, r.question_value, r.deliver_unit_ids])).toEqual([
      ['901', 'form.paid_slot', 'yes', ['7190']],
      ['902', 'form.consent', 'agree', ['7189']],
    ]);
    expect(out.deliver_unit_checks).toEqual([
      { deliver_unit_id: 7189, duration_minutes: 6 },
      { deliver_unit_id: 7190, duration_minutes: 0 },
      { deliver_unit_id: 7191, duration_minutes: 0 },
    ]);
    expect(out.form_submission_start).toBe('07:00');
    expect(out.form_submission_end).toBe('');
    expect(out.source_path).toBe(`/a/pm-org/opportunity/${OPP}/verification_flags_config/`);
  });

  it('throws VerificationPagePmOnlyError at the holding org instead of following the redirect (ace#2419)', async () => {
    const calls: Call[] = [];
    const err = await backend([{ status: 302, location: `/a/nm-org/opportunity/${OPP}/` }], calls)
      .getVerificationFlags({ organization_slug: 'nm-org', opportunity_id: OPP })
      .catch((e) => e);
    expect(err).toBeInstanceOf(VerificationPagePmOnlyError);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('refuses a 200 page with no verification formset rather than reporting "no rules"', async () => {
    const calls: Call[] = [];
    const err = await backend([{ status: 200, body: '<html><body>Sign in</body></html>' }], calls)
      .getVerificationFlags({ organization_slug: 'pm-org', opportunity_id: OPP })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/not the verification_flags_config page/);
  });
});
