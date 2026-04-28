import type { APIRequestContext, APIResponse } from 'playwright';
import type { ConnectClient } from '../client.js';
import type { Program, Opportunity, Invite, Invoice, DeliverUnit, PaymentUnit } from '../types.js';
import { HttpError, ConnectValidationError } from '../errors.js';
import {
  extractFormCsrfToken,
  extractFormFieldValues,
  extractUuidFromPath,
  parseDeliveryTypeOptions,
  parseProgramsList,
  parseOpportunitiesList,
  parseInvitesList,
  parseFormErrors,
  parseDeliverUnitTable,
  parsePaymentUnitTable,
} from './html-scrape.js';

export interface PlaywrightBackendOptions {
  baseUrl: string;
  csrfToken: string;
  request: APIRequestContext;
}

async function httpErrorFor(res: APIResponse, urlPath: string): Promise<HttpError> {
  let body = '';
  try { body = await res.text(); } catch { /* swallow */ }
  return new HttpError(res.status(), urlPath, body);
}

/**
 * Playwright HTTP-only Connect backend.
 *
 * For mutations: GET the form page → extract CSRF + prefilled values → POST
 * the merged set. Connect's edit and config pages use Knockout/Alpine for
 * presentation but post normal Django form data.
 *
 * For reads: GET the list/detail/table page → parse with helpers from
 * html-scrape.ts.
 *
 * Key URL conventions (confirmed live 2026-04-28 against march-demo
 * opportunity dea88661-1cd6-486b-ab25-48584bf61a8e):
 *   /a/<org>/program/                              — list
 *   /a/<org>/program/init/                         — create form (POST same URL)
 *   /a/<org>/program/<uuid>/edit                   — edit form
 *   /a/<org>/program/<uuid>/invite                 — invite an LLO org to a program
 *   /a/<org>/opportunity/                          — list
 *   /a/<org>/opportunity/init/                     — create form
 *   /a/<org>/opportunity/<uuid>/edit               — edit form (toggles active/is_test)
 *   /a/<org>/opportunity/<uuid>/verification_flags_config/  — verification toggles + formsets
 *   /a/<org>/opportunity/<uuid>/payment_unit/create         — payment-unit create form
 *   /a/<org>/opportunity/<uuid>/payment_unit_table/         — payment units list
 *   /a/<org>/opportunity/<uuid>/deliver_unit_table          — delivery units list (read-only)
 *
 * Concurrency: this class assumes the caller serializes calls (the MCP
 * server uses a promise-chain serializer) so CSRF rotation can't race.
 */
export class PlaywrightBackend implements ConnectClient {
  constructor(private opts: PlaywrightBackendOptions) {}

  // ── Programs ─────────────────────────────────────────────────────

  listPrograms: ConnectClient['listPrograms'] = async ({ organization_slug, name }) => {
    const path = `/a/${organization_slug}/program/`;
    const res = await this.opts.request.get(path);
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    let programs = parseProgramsList(await res.text()).map((p) => ({ ...p, organization_slug }));
    if (name) programs = programs.filter((p) => p.name === name);
    return { programs };
  };

  getProgram: ConnectClient['getProgram'] = async ({ organization_slug, program_id }) => {
    const list = await this.listPrograms({ organization_slug });
    const found = list.programs.find((p) => p.id === program_id);
    if (!found) {
      throw new HttpError(404, `/a/${organization_slug}/program/${program_id}/`, 'program not found in list');
    }
    return found;
  };

  listDeliveryTypes: ConnectClient['listDeliveryTypes'] = async ({ organization_slug }) => {
    const path = `/a/${organization_slug}/program/init/`;
    const res = await this.opts.request.get(path);
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    return { delivery_types: parseDeliveryTypeOptions(await res.text()) };
  };

  createProgram: ConnectClient['createProgram'] = async (args) => {
    const formPath = `/a/${args.organization_slug}/program/init/`;
    const formRes = await this.opts.request.get(formPath);
    if (formRes.status() !== 200) throw await httpErrorFor(formRes, formPath);
    const csrf = extractFormCsrfToken(await formRes.text()) ?? this.opts.csrfToken;

    const postRes = await this.opts.request.post(formPath, {
      form: {
        csrfmiddlewaretoken: csrf,
        name: args.name,
        description: args.description,
        delivery_type: String(args.delivery_type),
        budget: String(args.budget),
        currency: args.currency,
        country: args.country,
        start_date: args.start_date,
        end_date: args.end_date,
      },
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}/a/${args.organization_slug}/program/`,
        'X-CSRFToken': csrf,
      },
    });

    if (postRes.status() === 302) {
      const list = await this.listPrograms({ organization_slug: args.organization_slug, name: args.name });
      const created = list.programs[0];
      if (!created) throw new HttpError(500, formPath, `program create succeeded (302) but "${args.name}" not found`);
      return { ...created, ...args };
    }
    if (postRes.status() === 200) {
      const errs = parseFormErrors(await postRes.text());
      throw new ConnectValidationError(errs.length ? errs : ['form rejected; no errorlist found']);
    }
    throw await httpErrorFor(postRes, formPath);
  };

  updateProgram: ConnectClient['updateProgram'] = async (args) => {
    const editPath = `/a/${args.organization_slug}/program/${args.program_id}/edit`;
    const editRes = await this.opts.request.get(editPath);
    if (editRes.status() !== 200) throw await httpErrorFor(editRes, editPath);
    const editHtml = await editRes.text();
    const csrf = extractFormCsrfToken(editHtml) ?? this.opts.csrfToken;
    const current = extractFormFieldValues(editHtml);

    const postRes = await this.opts.request.post(editPath, {
      form: {
        csrfmiddlewaretoken: csrf,
        name: args.name ?? current['name'] ?? '',
        description: args.description ?? current['description'] ?? '',
        delivery_type: current['delivery_type'] ?? '',
        budget: args.budget != null ? String(args.budget) : (current['budget'] ?? ''),
        currency: current['currency'] ?? '',
        country: current['country'] ?? '',
        start_date: args.start_date ?? current['start_date'] ?? '',
        end_date: args.end_date ?? current['end_date'] ?? '',
      },
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}/a/${args.organization_slug}/program/`,
        'X-CSRFToken': csrf,
      },
    });

    if (postRes.status() === 302) {
      return await this.getProgram({ organization_slug: args.organization_slug, program_id: args.program_id });
    }
    if (postRes.status() === 200) {
      const errs = parseFormErrors(await postRes.text());
      throw new ConnectValidationError(errs.length ? errs : ['edit rejected; no errorlist found']);
    }
    throw await httpErrorFor(postRes, editPath);
  };

  // ── Opportunities ─────────────────────────────────────────────────

  listOpportunities: ConnectClient['listOpportunities'] = async ({ organization_slug, name }) => {
    const path = `/a/${organization_slug}/opportunity/`;
    const res = await this.opts.request.get(path);
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    const stubs = parseOpportunitiesList(await res.text());
    let opportunities: Opportunity[] = stubs.map((s) => ({
      id: s.id,
      name: s.name,
      short_description: s.short_description,
      description: '',
      currency: '',
      country: '',
      hq_server: '',
      api_key: '',
      learn_app_domain: '',
      learn_app: '',
      learn_app_passing_score: 0,
      deliver_app_domain: '',
      deliver_app: '',
      status: 'draft' as const,
      organization_slug,
    }));
    if (name) opportunities = opportunities.filter((o) => o.name === name);
    return { opportunities };
  };

  getOpportunity: ConnectClient['getOpportunity'] = async ({ organization_slug, opportunity_id }) => {
    // Hydrate from the edit form which has every field's current value.
    const editPath = `/a/${organization_slug}/opportunity/${opportunity_id}/edit`;
    const editRes = await this.opts.request.get(editPath);
    if (editRes.status() !== 200) throw await httpErrorFor(editRes, editPath);
    const v = extractFormFieldValues(await editRes.text());
    const isActive = v['active'] === 'on' || v['active'] === 'true' || v['active'] === '';  // checkbox `value=""` when no value attr but checked
    return {
      id: opportunity_id,
      name: v['name'] ?? '',
      short_description: v['short_description'] ?? '',
      description: v['description'] ?? '',
      currency: v['currency'] ?? '',
      country: v['country'] ?? '',
      hq_server: v['hq_server'] ?? '',
      api_key: v['api_key'] ?? '',
      learn_app_domain: v['learn_app_domain'] ?? '',
      learn_app: v['learn_app'] ?? '',
      learn_app_passing_score: Number(v['learn_app_passing_score'] ?? 0),
      deliver_app_domain: v['deliver_app_domain'] ?? '',
      deliver_app: v['deliver_app'] ?? '',
      status: isActive ? 'active' : 'draft',
      organization_slug,
    };
  };

  createOpportunity: ConnectClient['createOpportunity'] = async (args) => {
    const formPath = `/a/${args.organization_slug}/opportunity/init/`;
    const formRes = await this.opts.request.get(formPath);
    if (formRes.status() !== 200) throw await httpErrorFor(formRes, formPath);
    const csrf = extractFormCsrfToken(await formRes.text()) ?? this.opts.csrfToken;

    const formData: Record<string, string> = {
      csrfmiddlewaretoken: csrf,
      name: args.name,
      short_description: args.short_description,
      description: args.description,
      currency: args.currency,
      country: args.country,
      hq_server: args.hq_server,
      api_key: args.api_key,
      learn_app_domain: args.learn_app_domain,
      learn_app: args.learn_app,
      learn_app_passing_score: String(args.learn_app_passing_score),
      deliver_app_domain: args.deliver_app_domain,
      deliver_app: args.deliver_app,
    };
    if (args.learn_app_description) formData['learn_app_description'] = args.learn_app_description;
    if (args.program_id) formData['program'] = args.program_id;

    const postRes = await this.opts.request.post(formPath, {
      form: formData,
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}/a/${args.organization_slug}/opportunity/`,
        'X-CSRFToken': csrf,
      },
    });

    if (postRes.status() === 302) {
      const loc = postRes.headers()['location'] ?? '';
      const directId = extractUuidFromPath(loc, 'opportunity');
      if (directId) {
        return await this.getOpportunity({ organization_slug: args.organization_slug, opportunity_id: directId });
      }
      const list = await this.listOpportunities({ organization_slug: args.organization_slug, name: args.name });
      if (!list.opportunities[0]) {
        throw new HttpError(500, formPath, `opportunity create succeeded (302) but "${args.name}" not found in list`);
      }
      return list.opportunities[0];
    }
    if (postRes.status() === 200) {
      const errs = parseFormErrors(await postRes.text());
      throw new ConnectValidationError(errs.length ? errs : ['opportunity create rejected; no errorlist found']);
    }
    throw await httpErrorFor(postRes, formPath);
  };

  /**
   * Update an opportunity by re-POSTing the /edit form. Re-uses the form's
   * existing values and overrides only the fields the caller passes.
   *
   * `is_test` is a checkbox: send `is_test=on` to enable, OMIT the field to
   * disable.
   */
  updateOpportunity: ConnectClient['updateOpportunity'] = async (args) => {
    return this.postEditForm(args.organization_slug, args.opportunity_id, {
      name: args.name,
      short_description: args.short_description,
      description: args.description,
      end_date: args.end_date,
      is_test: args.is_test,
    });
  };

  /**
   * Activate an opportunity by re-POSTing the /edit form with `active=on`.
   * (Connect has no /activate/ URL — activation is a checkbox toggle.)
   */
  activateOpportunity: ConnectClient['activateOpportunity'] = async ({ organization_slug, opportunity_id }) => {
    await this.postEditForm(organization_slug, opportunity_id, { active: true });
    return { ok: true, status: 'active' as const };
  };

  /** Internal: re-POST the opportunity edit form with a partial override. */
  private async postEditForm(
    organization_slug: string,
    opportunity_id: string,
    overrides: {
      name?: string; short_description?: string; description?: string;
      end_date?: string; active?: boolean; is_test?: boolean;
    },
  ): Promise<Opportunity> {
    const editPath = `/a/${organization_slug}/opportunity/${opportunity_id}/edit`;
    const editRes = await this.opts.request.get(editPath);
    if (editRes.status() !== 200) throw await httpErrorFor(editRes, editPath);
    const editHtml = await editRes.text();
    const csrf = extractFormCsrfToken(editHtml) ?? this.opts.csrfToken;
    const current = extractFormFieldValues(editHtml);

    const form: Record<string, string> = {
      csrfmiddlewaretoken: csrf,
      name: overrides.name ?? current['name'] ?? '',
      short_description: overrides.short_description ?? current['short_description'] ?? '',
      description: overrides.description ?? current['description'] ?? '',
      delivery_type: current['delivery_type'] ?? '',
      end_date: overrides.end_date ?? current['end_date'] ?? '',
      currency: current['currency'] ?? '',
      country: current['country'] ?? '',
    };
    // Optional fields that may or may not be in the form
    if (current['users'] != null) form['users'] = current['users'];
    if (current['learn_level'] != null) form['learn_level'] = current['learn_level'];
    if (current['delivery_level'] != null) form['delivery_level'] = current['delivery_level'];

    // Checkboxes: `active` and `is_test`. To toggle ON, set `=on`. To toggle
    // OFF, OMIT the field. We preserve current state if not overridden.
    const wantActive = overrides.active ?? (current['active'] === 'on' || current['active'] === '' && editHtml.match(/name="active"[^>]*checked/));
    const wantTest = overrides.is_test ?? (current['is_test'] === 'on' || current['is_test'] === '' && editHtml.match(/name="is_test"[^>]*checked/));
    if (wantActive) form['active'] = 'on';
    if (wantTest) form['is_test'] = 'on';

    const postRes = await this.opts.request.post(editPath, {
      form,
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}/a/${organization_slug}/opportunity/`,
        'X-CSRFToken': csrf,
      },
    });
    if (postRes.status() === 302) {
      return await this.getOpportunity({ organization_slug, opportunity_id });
    }
    if (postRes.status() === 200) {
      const errs = parseFormErrors(await postRes.text());
      throw new ConnectValidationError(errs.length ? errs : ['opportunity edit rejected; no errorlist found']);
    }
    throw await httpErrorFor(postRes, editPath);
  }

  // ── Verification flags / payment units / deliver units ────────────

  /**
   * Set the top-level verification toggles. v1 supports the simple flags
   * (duplicate, gps, catchment_areas, location, form_submission_*); the
   * formset-driven per-deliver-unit checks and form-field rules are sent
   * if provided but we re-post existing formset rows verbatim if not.
   */
  setVerificationFlags: ConnectClient['setVerificationFlags'] = async ({ organization_slug, opportunity_id, flags }) => {
    const path = `/a/${organization_slug}/opportunity/${opportunity_id}/verification_flags_config/`;
    const getRes = await this.opts.request.get(path);
    if (getRes.status() !== 200) throw await httpErrorFor(getRes, path);
    const html = await getRes.text();
    const csrf = extractFormCsrfToken(html) ?? this.opts.csrfToken;
    const current = extractFormFieldValues(html);

    const form: Record<string, string> = {
      csrfmiddlewaretoken: csrf,
      // top-level toggles (checkboxes — set `=on` to enable, omit to disable)
      // location is REQUIRED (number, default 10m)
      location: current['location'] ?? '10',
      form_submission_start: flags.form_submission_start ?? current['form_submission_start'] ?? '',
      form_submission_end: flags.form_submission_end ?? current['form_submission_end'] ?? '',
    };

    const wasChecked = (name: string) => new RegExp(`name="${name}"[^>]*checked`).test(html);
    const want = (key: 'duplicate' | 'gps' | 'catchment_areas') =>
      flags[key] !== undefined ? !!flags[key] : wasChecked(key);
    if (want('duplicate')) form['duplicate'] = 'on';
    if (want('gps')) form['gps'] = 'on';
    if (want('catchment_areas')) form['catchment_areas'] = 'on';

    // Formset management: preserve every existing formset row by replaying
    // their values. The TOTAL_FORMS / INITIAL_FORMS / MIN_NUM_FORMS / MAX_NUM_FORMS
    // hidden fields are essential for Django formset processing.
    for (const k of [
      'deliver_unit-TOTAL_FORMS', 'deliver_unit-INITIAL_FORMS',
      'deliver_unit-MIN_NUM_FORMS', 'deliver_unit-MAX_NUM_FORMS',
      'form_json-TOTAL_FORMS', 'form_json-INITIAL_FORMS',
      'form_json-MIN_NUM_FORMS', 'form_json-MAX_NUM_FORMS',
    ]) {
      if (current[k] != null) form[k] = current[k];
    }
    // Replay every deliver_unit-N-* and form_json-N-* field.
    for (const [k, v] of Object.entries(current)) {
      if (/^(deliver_unit|form_json)-\d+-/.test(k)) {
        form[k] = v;
      }
    }
    // Re-apply check_attachments toggles if the caller supplied per-unit overrides
    if (flags.deliver_unit_checks) {
      for (const c of flags.deliver_unit_checks) {
        // Find the row index that points at this deliver_unit_id
        for (const [k, v] of Object.entries(current)) {
          if (/^deliver_unit-\d+-deliver_unit$/.test(k) && Number(v) === c.deliver_unit_id) {
            const idx = k.match(/^deliver_unit-(\d+)-/)![1];
            if (c.check_attachments) form[`deliver_unit-${idx}-check_attachments`] = 'on';
            else delete form[`deliver_unit-${idx}-check_attachments`];
            if (c.duration_seconds != null) form[`deliver_unit-${idx}-duration`] = String(c.duration_seconds);
          }
        }
      }
    }

    const postRes = await this.opts.request.post(path, {
      form,
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}/a/${organization_slug}/opportunity/${opportunity_id}/`,
        'X-CSRFToken': csrf,
      },
    });
    if (postRes.status() === 302 || postRes.status() === 200) {
      // Heuristic: 200 with errorlist is failure
      if (postRes.status() === 200) {
        const errs = parseFormErrors(await postRes.text());
        if (errs.length) throw new ConnectValidationError(errs);
      }
      return { ok: true };
    }
    throw await httpErrorFor(postRes, path);
  };

  listDeliverUnits: ConnectClient['listDeliverUnits'] = async ({ organization_slug, opportunity_id }) => {
    const path = `/a/${organization_slug}/opportunity/${opportunity_id}/deliver_unit_table`;
    const res = await this.opts.request.get(path);
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    return { deliver_units: parseDeliverUnitTable(await res.text()) };
  };

  createPaymentUnit: ConnectClient['createPaymentUnit'] = async (args) => {
    const formPath = `/a/${args.organization_slug}/opportunity/${args.opportunity_id}/payment_unit/create`;
    const getRes = await this.opts.request.get(formPath);
    if (getRes.status() !== 200) throw await httpErrorFor(getRes, formPath);
    const csrf = extractFormCsrfToken(await getRes.text()) ?? this.opts.csrfToken;

    // Required-deliver-units and optional-deliver-units are multi-select
    // fields. Send them as repeated form-encoded params.
    const formData = new URLSearchParams();
    formData.append('csrfmiddlewaretoken', csrf);
    formData.append('name', args.name);
    formData.append('description', args.description);
    formData.append('amount', String(args.amount));
    if (args.max_total != null) formData.append('max_total', String(args.max_total));
    if (args.max_daily != null) formData.append('max_daily', String(args.max_daily));
    if (args.start_date) formData.append('start_date', args.start_date);
    if (args.end_date) formData.append('end_date', args.end_date);
    for (const id of args.required_deliver_unit_ids) formData.append('required_deliver_units', String(id));
    for (const id of args.optional_deliver_unit_ids ?? []) formData.append('optional_deliver_units', String(id));

    const postRes = await this.opts.request.post(formPath, {
      data: formData.toString(),
      maxRedirects: 0,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${this.opts.baseUrl}/a/${args.organization_slug}/opportunity/${args.opportunity_id}/`,
        'X-CSRFToken': csrf,
      },
    });

    if (postRes.status() === 302) {
      // Connect redirects to the opp detail / payment_unit_table; re-list to find by name
      const list = await this.listPaymentUnits({
        organization_slug: args.organization_slug,
        opportunity_id: args.opportunity_id,
      });
      const created = list.payment_units.find((p) => p.name === args.name);
      if (!created) {
        throw new HttpError(500, formPath, `payment_unit create succeeded (302) but "${args.name}" not found`);
      }
      return created;
    }
    if (postRes.status() === 200) {
      const errs = parseFormErrors(await postRes.text());
      throw new ConnectValidationError(errs.length ? errs : ['payment_unit create rejected; no errorlist found']);
    }
    throw await httpErrorFor(postRes, formPath);
  };

  listPaymentUnits: ConnectClient['listPaymentUnits'] = async ({ organization_slug, opportunity_id }) => {
    const path = `/a/${organization_slug}/opportunity/${opportunity_id}/payment_unit_table/`;
    const res = await this.opts.request.get(path);
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    return { payment_units: parsePaymentUnitTable(await res.text()) };
  };

  // ── Invites (program-level) ──────────────────────────────────────

  sendLloInvite: ConnectClient['sendLloInvite'] = async (args) => {
    const invitePath = `/a/${args.organization_slug}/program/${args.opportunity_id}/invite`;
    const formPath = `/a/${args.organization_slug}/program/`;
    const listRes = await this.opts.request.get(formPath);
    if (listRes.status() !== 200) throw await httpErrorFor(listRes, formPath);
    const csrf = extractFormCsrfToken(await listRes.text()) ?? this.opts.csrfToken;

    const postRes = await this.opts.request.post(invitePath, {
      form: {
        csrfmiddlewaretoken: csrf,
        organization: args.organization_name,
      },
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}${formPath}`,
        'X-CSRFToken': csrf,
      },
    });
    if (postRes.status() === 302 || postRes.status() === 200) {
      return {
        id: 'pending',
        opportunity_id: args.opportunity_id,
        organization_name: args.organization_name,
        contact_email: args.contact_email,
        status: 'pending' as const,
      };
    }
    throw await httpErrorFor(postRes, invitePath);
  };

  listInvites: ConnectClient['listInvites'] = async ({ organization_slug, opportunity_id }) => {
    const listRes = await this.opts.request.get(`/a/${organization_slug}/program/`);
    if (listRes.status() !== 200) throw await httpErrorFor(listRes, `/a/${organization_slug}/program/`);
    return { invites: parseInvitesList(await listRes.text(), opportunity_id) };
  };

  // ── Invoices (stub — page shape not yet probed) ─────────────────

  listInvoices: ConnectClient['listInvoices'] = async ({ organization_slug, opportunity_id }) => {
    const path = `/a/${organization_slug}/opportunity/${opportunity_id}/invoices/`;
    const res = await this.opts.request.get(path);
    if (res.status() !== 200) {
      return { invoices: [] };
    }
    return { invoices: [] };
  };

  getInvoice: ConnectClient['getInvoice'] = async ({ organization_slug, invoice_id }) => {
    const path = `/a/${organization_slug}/invoice/${invoice_id}/`;
    const res = await this.opts.request.get(path);
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    return {
      id: invoice_id,
      opportunity_id: '',
      organization_name: '',
      amount: 0,
      currency: '',
      status: 'draft',
    };
  };
}
