import type { APIRequestContext, APIResponse } from 'playwright';
import type { ConnectClient } from '../client.js';
import type { Opportunity } from '../types.js';
import { HttpError, ConnectValidationError } from '../errors.js';
import {
  extractFormCsrfToken,
  extractFormFieldValues,
  parseDeliveryTypeOptions,
  parseProgramsList,
  parseOpportunitiesList,
  parseInvitesList,
  parseFormErrors,
  parseFormErrorsByField,
  parseDeliverUnitTable,
  parsePaymentUnitTable,
} from './html-scrape.js';

/**
 * Build a structured ConnectValidationError from a 200-with-errorlist response
 * body. Tries field-keyed parsing first (preferred); falls back to the flat
 * list. If neither finds anything, returns a single-line "rejected" stub so
 * the caller still gets a typed validation error rather than an opaque 500.
 */
function validationErrorFromHtml(html: string, contextLabel: string): ConnectValidationError {
  const fields = parseFormErrorsByField(html);
  const flat = parseFormErrors(html);
  if (Object.keys(fields).length === 0 && flat.length === 0) {
    return new ConnectValidationError([`${contextLabel}; no errorlist found`]);
  }
  const messages = flat.length ? flat : Object.values(fields).flat();
  return new ConnectValidationError(messages, fields);
}

export interface PlaywrightBackendOptions {
  baseUrl: string;
  csrfToken: string;
  request: APIRequestContext;
}

async function httpErrorFor(res: APIResponse, urlPath: string, method: string = 'GET'): Promise<HttpError> {
  let body = '';
  try { body = await res.text(); } catch { /* swallow */ }
  const contentType = res.headers()['content-type'];
  return new HttpError(res.status(), `${method} ${urlPath}`, body, contentType);
}

class NotImplementedError extends Error {
  constructor(method: string) {
    super(
      `${method}: not implemented in the Playwright backend — composite should route this atom to REST.`,
    );
  }
}
const stub = (name: string) => () => { throw new NotImplementedError(name); };

/**
 * Playwright HTTP-only Connect backend — handles atoms that don't yet have
 * REST endpoints in commcare-connect (reads, edits, verification flags,
 * invoices, deliver/payment-unit listings).
 *
 * For mutations: GET the form page → extract CSRF + prefilled values → POST
 * the merged set. Connect's edit and config pages use Knockout/Alpine for
 * presentation but post normal Django form data.
 *
 * For reads: GET the list/detail/table page → parse with helpers from
 * html-scrape.ts.
 *
 * Concurrency: this class assumes the caller serializes calls (the MCP
 * server uses a promise-chain serializer) so CSRF rotation can't race.
 *
 * History: pre-0.10.47, this backend also handled the eight write atoms
 * that PR #1135 covered (createProgram, createOpportunity, etc.). Those
 * moved to `rest.ts` once the automation API shipped — saving ~600 lines
 * of HTML-form scraping.
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
    const editPath = `/a/${organization_slug}/program/${program_id}/edit`;
    const editRes = await this.opts.request.get(editPath);
    if (editRes.status() === 404) throw new HttpError(404, editPath, 'program not found');
    if (editRes.status() !== 200) throw await httpErrorFor(editRes, editPath);
    const v = extractFormFieldValues(await editRes.text());
    return {
      id: program_id,
      name: v['name'] ?? '',
      description: v['description'] ?? '',
      delivery_type: Number(v['delivery_type'] ?? 0),
      budget: Number(v['budget'] ?? 0),
      currency: v['currency'] ?? '',
      country: v['country'] ?? '',
      start_date: v['start_date'] ?? '',
      end_date: v['end_date'] ?? '',
      organization_slug,
    };
  };

  listDeliveryTypes: ConnectClient['listDeliveryTypes'] = async ({ organization_slug }) => {
    const path = `/a/${organization_slug}/program/init/`;
    const res = await this.opts.request.get(path);
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    return { delivery_types: parseDeliveryTypeOptions(await res.text()) };
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
      throw validationErrorFromHtml(await postRes.text(), 'program edit rejected');
    }
    throw await httpErrorFor(postRes, editPath, 'POST');
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
      organization_slug,
      managed: true,
      active: false,
    }));
    if (name) opportunities = opportunities.filter((o) => o.name === name);
    return { opportunities };
  };

  getOpportunity: ConnectClient['getOpportunity'] = async ({ organization_slug, opportunity_id }) => {
    // Hydrate from BOTH the edit form (metadata + active toggle) AND the
    // detail page (app-wire fields). The edit form does NOT expose
    // `learn_app` / `deliver_app` — those fields only appear on the
    // /init/ create form and the read-only detail page.
    const editPath = `/a/${organization_slug}/opportunity/${opportunity_id}/edit`;
    const detailPath = `/a/${organization_slug}/opportunity/${opportunity_id}/`;
    const [editRes, detailRes] = await Promise.all([
      this.opts.request.get(editPath),
      this.opts.request.get(detailPath),
    ]);
    if (editRes.status() !== 200) throw await httpErrorFor(editRes, editPath);
    const v = extractFormFieldValues(await editRes.text());
    const isActive = v['active'] === 'on' || v['active'] === 'true' || v['active'] === '';

    let learnAppDomain = '';
    let learnAppId = '';
    let deliverAppDomain = '';
    let deliverAppId = '';
    if (detailRes.status() === 200) {
      const detailHtml = await detailRes.text();
      const matches = [...detailHtml.matchAll(/\/a\/([a-z0-9_-]+)\/apps\/(?:view\/)?([a-f0-9]{32})/g)];
      const seen = new Set<string>();
      const uniq: Array<{ domain: string; appId: string }> = [];
      for (const m of matches) {
        const key = `${m[1]}/${m[2]}`;
        if (!seen.has(key)) { seen.add(key); uniq.push({ domain: m[1], appId: m[2] }); }
      }
      if (uniq[0]) { learnAppId = uniq[0].appId; learnAppDomain = uniq[0].domain; }
      if (uniq[1]) { deliverAppId = uniq[1].appId; deliverAppDomain = uniq[1].domain; }
    }

    return {
      id: opportunity_id,
      name: v['name'] ?? '',
      short_description: v['short_description'] ?? '',
      description: v['description'] ?? '',
      organization_slug,
      managed: true,
      active: isActive,
      currency: v['currency'] ?? '',
      country: v['country'] ?? '',
      end_date: v['end_date'] ?? '',
      learn_app: learnAppId
        ? { cc_domain: learnAppDomain, cc_app_id: learnAppId, name: '' }
        : undefined,
      deliver_app: deliverAppId
        ? { cc_domain: deliverAppDomain, cc_app_id: deliverAppId, name: '' }
        : undefined,
    };
  };

  updateOpportunity: ConnectClient['updateOpportunity'] = async (args) => {
    return this.postEditForm(args.organization_slug, args.opportunity_id, {
      name: args.name,
      short_description: args.short_description,
      description: args.description,
      end_date: args.end_date,
      is_test: args.is_test,
    });
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
    if (current['users'] != null) form['users'] = current['users'];
    if (current['learn_level'] != null) form['learn_level'] = current['learn_level'];
    if (current['delivery_level'] != null) form['delivery_level'] = current['delivery_level'];

    // Checkboxes: `active` and `is_test`. To toggle ON, set `=on`. To toggle
    // OFF, OMIT the field. We preserve current state if not overridden.
    const wantActive = overrides.active ?? (current['active'] === 'on' || (current['active'] === '' && /name="active"[^>]*checked/.test(editHtml)));
    const wantTest = overrides.is_test ?? (current['is_test'] === 'on' || (current['is_test'] === '' && /name="is_test"[^>]*checked/.test(editHtml)));
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
      throw validationErrorFromHtml(await postRes.text(), 'opportunity edit rejected');
    }
    throw await httpErrorFor(postRes, editPath, 'POST');
  }

  // ── Verification flags ────────────────────────────────────────────

  /**
   * Set the top-level verification toggles. v1 supports the simple flags
   * (duplicate, gps, catchment_areas, location, form_submission_*); the
   * formset-driven per-deliver-unit checks and form-field rules are sent
   * if provided but we re-post existing formset rows verbatim if not.
   *
   * No REST endpoint for this yet; PR #1135 didn't ship verification flags.
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
      // location is a number field (default 10m)
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
    for (const [k, v] of Object.entries(current)) {
      if (/^(deliver_unit|form_json)-\d+-/.test(k)) form[k] = v;
    }
    if (flags.deliver_unit_checks) {
      for (const c of flags.deliver_unit_checks) {
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
      if (postRes.status() === 200) {
        const respHtml = await postRes.text();
        if (parseFormErrors(respHtml).length) {
          throw validationErrorFromHtml(respHtml, 'verification flags rejected');
        }
      }
      return { ok: true };
    }
    throw await httpErrorFor(postRes, path, 'POST');
  };

  listDeliverUnits: ConnectClient['listDeliverUnits'] = async ({ organization_slug, opportunity_id }) => {
    const path = `/a/${organization_slug}/opportunity/${opportunity_id}/deliver_unit_table`;
    const res = await this.opts.request.get(path);
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    return { deliver_units: parseDeliverUnitTable(await res.text()) };
  };

  listPaymentUnits: ConnectClient['listPaymentUnits'] = async ({ organization_slug, opportunity_id }) => {
    const path = `/a/${organization_slug}/opportunity/${opportunity_id}/payment_unit_table/`;
    const res = await this.opts.request.get(path);
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    return { payment_units: parsePaymentUnitTable(await res.text()) };
  };

  // ── Invites (read-only listing; create/accept moved to REST) ──────

  listInvites: ConnectClient['listInvites'] = async ({ organization_slug, program_id }) => {
    const listRes = await this.opts.request.get(`/a/${organization_slug}/program/`);
    if (listRes.status() !== 200) throw await httpErrorFor(listRes, `/a/${organization_slug}/program/`);
    return { invites: parseInvitesList(await listRes.text(), program_id) };
  };

  // ── Invoices (stub — page shape not yet probed) ───────────────────

  listInvoices: ConnectClient['listInvoices'] = async ({ organization_slug, opportunity_id }) => {
    const path = `/a/${organization_slug}/opportunity/${opportunity_id}/invoices/`;
    const res = await this.opts.request.get(path);
    if (res.status() !== 200) return { invoices: [] };
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

  // ── Stubs (REST-driven; never invoked in composite) ───────────────

  createProgram = stub('createProgram') as ConnectClient['createProgram'];
  createOpportunity = stub('createOpportunity') as ConnectClient['createOpportunity'];
  createPaymentUnit = stub('createPaymentUnit') as ConnectClient['createPaymentUnit'];
  createPaymentUnits = stub('createPaymentUnits') as ConnectClient['createPaymentUnits'];
  activateOpportunity = stub('activateOpportunity') as ConnectClient['activateOpportunity'];
  sendLloInvite = stub('sendLloInvite') as ConnectClient['sendLloInvite'];
  acceptProgramApplication = stub('acceptProgramApplication') as ConnectClient['acceptProgramApplication'];
  sendFlwInvite = stub('sendFlwInvite') as ConnectClient['sendFlwInvite'];
}
