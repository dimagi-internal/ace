import type { APIRequestContext, APIResponse } from 'playwright';
import type { ConnectClient } from '../client.js';
import type { Opportunity, PaymentUnit, Program, ProgramApplication } from '../types.js';
import { HttpError, ConnectValidationError, ConnectError } from '../errors.js';
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

// Pre-0.10.47: this file kept `NotImplementedError` + a `stub()` helper for
// the eight write atoms (`createProgram`, `createOpportunity`, etc.) that
// the REST backend handled. Since 0.10.55 (this version) we ship real
// HTML-form fallbacks for those atoms so the composite can recover when
// REST returns 404 (PR #1135 not yet deployed to prod). The only one that
// stays guarded is `createOpportunity` — Connect's managed-opp HTML wizard
// is multi-step + HTMX-driven (see that method's docstring); it throws a
// clear `ConnectError` until either the REST deploy lands or someone
// invests in the full wizard driver.

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

  // ── HTML-form fallbacks for the eight write atoms ─────────────────
  //
  // These exist because commcare-connect PR #1135 (the REST automation API)
  // is merged but not deployed to connect.dimagi.com prod (verified
  // 2026-05-01: `POST /api/programs/` returns 404). The composite tries
  // REST first; only when REST 404s does it fall back here. Once Connect
  // ships PR #1135 to prod, these methods stop firing — no flag flip
  // required.
  //
  // Coverage:
  //   - createProgram         simple form, single POST → list & match by name
  //   - sendLloInvite         simple form, single POST to /program/<uuid>/invite
  //   - sendFlwInvite         simple form, single POST to /opportunity/<uuid>/user_invite/
  //   - activateOpportunity   reuse postEditForm with active=true
  //
  //   - createPaymentUnit/s   single-PU form per item (server has no batch
  //                           endpoint here); plural loops the singular
  //   - createOpportunity     multi-step HTMX wizard — current Connect HTML
  //                           form has hard-to-script HTMX-loaded subselects
  //                           (api_key → domain → app pickers). Throws a
  //                           clear error pointing at REST until Connect
  //                           builds a single-shot HTML form for managed opps
  //                           OR PR #1135 hits prod.
  //   - acceptProgramApplication  Connect's PM-side UI has no accept button;
  //                           accept happens on the LLO side via
  //                           /a/<llo>/program/<id>/application/<app>/accept/.
  //                           If the caller can supply the LLO org slug we
  //                           POST it; otherwise we throw.

  // Map ISO 4217 currency human names → codes the form accepts. The form
  // value is always the ISO code (e.g. "USD"); the REST API also accepts
  // the same code, so usually we pass the input through verbatim. This
  // helper just guards a subset of common human-name inputs we've seen
  // skills emit by accident.
  private static normalizeCurrency(input: string): string {
    if (!input) return '';
    const s = input.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(s)) return s; // already ISO
    const aliases: Record<string, string> = {
      'US DOLLAR': 'USD',
      'EURO': 'EUR',
      'POUND STERLING': 'GBP',
    };
    return aliases[s] ?? input;
  }

  // The HTML country select uses ISO 3166-1 alpha-3 codes (e.g. "USA"),
  // while the REST API accepts the human name (e.g. "United States of
  // America"). We need to translate input → ISO-3 by reading the country
  // <select> on a freshly-fetched form page. Cached per-request would be
  // nicer, but skill calls are one-at-a-time so we fetch on demand.
  private async resolveCountryCode(html: string, input: string): Promise<string> {
    const s = (input ?? '').trim();
    if (!s) return '';
    if (/^[A-Z]{3}$/.test(s)) return s; // already ISO-3
    const selectMatch = html.match(/<select[^>]*name="country"[^>]*>([\s\S]*?)<\/select>/);
    if (!selectMatch) return s;
    const opts = [...selectMatch[1].matchAll(/<option\s+value="([A-Z]{3})"[^>]*>\s*([^<]+?)\s*<\/option>/g)];
    const lc = s.toLowerCase();
    const exact = opts.find((m) => m[2].trim().toLowerCase() === lc);
    if (exact) return exact[1];
    // Fallback: contains-match for inputs like "United States" → "USA"
    const partial = opts.find((m) => m[2].trim().toLowerCase().includes(lc));
    return partial?.[1] ?? s;
  }

  // Resolve a delivery_type input (string slug or int) → the int FK that
  // the form's <select> actually accepts. The REST API tolerates either
  // shape; the HTML form requires the int.
  private resolveDeliveryTypeId(html: string, input: number | string): string {
    if (typeof input === 'number') return String(input);
    if (/^\d+$/.test(input)) return input;
    const types = parseDeliveryTypeOptions(html);
    const lc = input.toLowerCase();
    const hit =
      types.find((t) => t.name.toLowerCase() === lc) ??
      types.find((t) => t.name.toLowerCase().includes(lc));
    return hit ? String(hit.id) : '';
  }

  // ── Programs ──────────────────────────────────────────────────────

  /**
   * POSTs `/a/<org>/program/init/` with the same form fields the live HTMX
   * page exposes (`name`, `description`, `delivery_type` (int FK),
   * `budget`, `currency` (ISO), `country` (ISO-3), `start_date`,
   * `end_date`). On success Connect responds with a 200 HTML body — there
   * is no Location header — so we identify the new program by listing
   * programs and matching by name.
   *
   * The form's create-side validation will reject missing fields with
   * `<p id="error_N_id_<field>" class="text-red-500…">…</p>` markers;
   * `parseFormErrorsByField` extracts those and we surface them as a
   * `ConnectValidationError`.
   */
  createProgram: ConnectClient['createProgram'] = async (args) => {
    const orgSlug = args.organization_slug;
    const formPath = `/a/${orgSlug}/program/init/`;
    const formRes = await this.opts.request.get(formPath);
    if (formRes.status() !== 200) throw await httpErrorFor(formRes, formPath);
    const formHtml = await formRes.text();
    const csrf = extractFormCsrfToken(formHtml) ?? this.opts.csrfToken;

    const form: Record<string, string> = {
      csrfmiddlewaretoken: csrf,
      name: args.name,
      description: args.description,
      delivery_type: this.resolveDeliveryTypeId(formHtml, args.delivery_type),
      budget: String(args.budget),
      currency: PlaywrightBackend.normalizeCurrency(args.currency),
      country: await this.resolveCountryCode(formHtml, args.country),
      start_date: args.start_date,
      end_date: args.end_date,
    };

    const postRes = await this.opts.request.post(formPath, {
      form,
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}/a/${orgSlug}/program/`,
        'X-CSRFToken': csrf,
      },
    });

    // The HTMX form responds 200 in BOTH the success and the field-error
    // case — the difference is whether the response body re-renders the
    // form with errorlists embedded. So we try error-parsing first; if
    // none found, we treat it as success and look up the new program by
    // name in the list page.
    if (postRes.status() === 200) {
      const respHtml = await postRes.text();
      const errs = parseFormErrors(respHtml);
      if (errs.length) throw validationErrorFromHtml(respHtml, 'program create rejected');
      // Success path: list & match by name. This is awkward but the HTMX
      // response gives us no UUID — Connect's template returns the swapped
      // form fragment, not a redirect or JSON.
      const created = await this.findProgramByName(orgSlug, args.name);
      if (!created) {
        throw new ConnectError(
          `program create succeeded HTTP 200 but no program named "${args.name}" was found in /a/${orgSlug}/program/. ` +
            'Either Connect rejected the create silently or the listing is stale.',
        );
      }
      return created;
    }
    if (postRes.status() === 302) {
      // Some templates emit a redirect — handle it just in case.
      const loc = postRes.headers()['location'] ?? '';
      const m = loc.match(/\/program\/([a-f0-9-]{36})/);
      if (m) return await this.getProgram({ organization_slug: orgSlug, program_id: m[1] });
      const created = await this.findProgramByName(orgSlug, args.name);
      if (created) return created;
    }
    throw await httpErrorFor(postRes, formPath, 'POST');
  };

  /** Internal: list programs for an org, return the most recent match by name. */
  private async findProgramByName(orgSlug: string, name: string): Promise<Program | undefined> {
    const { programs } = await this.listPrograms({ organization_slug: orgSlug, name });
    if (!programs.length) return undefined;
    // listPrograms doesn't expose timestamps, so we hydrate the first match
    // for full Program shape parity with REST.
    const stub = programs[0];
    return await this.getProgram({ organization_slug: orgSlug, program_id: stub.id });
  }

  // ── Opportunities ─────────────────────────────────────────────────

  /**
   * Connect's HTML-side managed-opportunity creation is a 3-step HTMX
   * wizard:
   *   1. POST `/a/<org>/opportunity/init/?program_id=<uuid>` with the
   *      Opportunity Details form. The form's `api_key`, `learn_app_domain`,
   *      `learn_app`, `deliver_app_domain`, `deliver_app` selects are
   *      populated DYNAMICALLY by HTMX (`/users/api_keys/`, `/hq/domains/`,
   *      `/hq/applications/`) — they are not present in the initial GET.
   *   2. POST step 2 (payment_units/create)
   *   3. POST step 3 (finalize/) for the budget
   *
   * Driving this end-to-end without a real browser requires:
   *   - calling `/a/<org>/opportunity/add_api_key/` to get the int-FK for
   *     the raw HQ API key the caller supplied,
   *   - calling `/hq/domains/?hq_server=<id>&api_key=<id>` to verify the
   *     domain is in the allowed list,
   *   - calling `/hq/applications/?hq_server=<id>&domain=<slug>&api_key=<id>`
   *     to fetch the JSON-encoded `{id, name}` value the form expects in
   *     the `learn_app` / `deliver_app` selects,
   *   - then assembling step 1's POST body, parsing the redirect to the
   *     created opp UUID, then driving steps 2 and 3.
   *
   * This is doable, but the full pipeline has ~600 lines of regex parsing
   * + HTMX-endpoint scraping that adds significant maintenance surface for
   * a fallback path that becomes dead code the moment PR #1135 lands. For
   * now we throw a clear error pointing at the deployment status; once the
   * HTML-fallback case becomes load-bearing for a real opp run, fill in
   * the implementation. See the plan in PR comments / runs notes for the
   * full sequence.
   */
  createOpportunity: ConnectClient['createOpportunity'] = async (args) => {
    void args;
    throw new ConnectError(
      'createOpportunity Playwright fallback is not implemented. ' +
        'Connect\'s HTML opportunity-create flow is a 3-step HTMX wizard with ' +
        'dynamically-populated api_key / domain / app selects (cannot be driven ' +
        'with a single POST). Either: (a) wait for commcare-connect PR #1135 to ' +
        'deploy to prod, or (b) create the opportunity manually via the Connect ' +
        'web UI then continue the flow.',
    );
  };

  // ── Payment units ─────────────────────────────────────────────────

  /**
   * POSTs `/a/<org>/opportunity/<uuid>/payment_unit/create` with the live
   * form fields. Note Connect's HTML form is single-PU only — there is no
   * batch endpoint here. The page accepts the opportunity UUID directly
   * in the URL (the int_id route also works but UUID is preferred).
   *
   * For managed opportunities, the form should expose an `org_amount`
   * field. We send it whenever `args.org_amount` is provided and let the
   * server reject it if the field isn't accepted.
   *
   * After a successful POST, Connect redirects (302) back to the
   * `payment_unit_table/` view; we then list payment units and return
   * the most recent matching by name.
   */
  createPaymentUnit: ConnectClient['createPaymentUnit'] = async (args) => {
    return await this.postPaymentUnitForm(args);
  };

  createPaymentUnits: ConnectClient['createPaymentUnits'] = async (args) => {
    const out: PaymentUnit[] = [];
    for (const pu of args.payment_units) {
      const created = await this.postPaymentUnitForm({
        organization_slug: args.organization_slug,
        opportunity_id: args.opportunity_id,
        ...pu,
      });
      out.push(created);
    }
    return { payment_units: out };
  };

  /** Internal: drive a single payment_unit/create POST. */
  private async postPaymentUnitForm(args: {
    organization_slug: string;
    opportunity_id: string;
    name: string;
    description?: string;
    amount: number;
    org_amount?: number;
    max_total: number;
    max_daily: number;
    start_date?: string;
    end_date?: string;
    required_deliver_units?: number[];
    optional_deliver_units?: number[];
  }): Promise<PaymentUnit> {
    const path = `/a/${args.organization_slug}/opportunity/${args.opportunity_id}/payment_unit/create`;
    const formRes = await this.opts.request.get(path);
    if (formRes.status() !== 200) throw await httpErrorFor(formRes, path);
    const formHtml = await formRes.text();
    const csrf = extractFormCsrfToken(formHtml) ?? this.opts.csrfToken;

    // Build a URLSearchParams body so we can send multi-valued checkbox
    // fields (`required_deliver_units`, `optional_deliver_units`).
    // Playwright's `form:` option only accepts scalar values; for repeating
    // names we have to pass `data:` as a raw urlencoded body.
    const params = new URLSearchParams();
    params.append('csrfmiddlewaretoken', csrf);
    params.append('name', args.name);
    params.append('description', args.description ?? '');
    params.append('amount', String(args.amount));
    params.append('max_total', String(args.max_total));
    params.append('max_daily', String(args.max_daily));
    if (args.org_amount !== undefined) params.append('org_amount', String(args.org_amount));
    if (args.start_date) params.append('start_date', args.start_date);
    if (args.end_date) params.append('end_date', args.end_date);
    for (const id of args.required_deliver_units ?? []) {
      params.append('required_deliver_units', String(id));
    }
    for (const id of args.optional_deliver_units ?? []) {
      params.append('optional_deliver_units', String(id));
    }
    params.append('submit', 'Submit');

    const postRes = await this.opts.request.post(path, {
      data: params.toString(),
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}${path}`,
        'X-CSRFToken': csrf,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (postRes.status() === 302 || postRes.status() === 200) {
      // 200 may be a re-render with field errors; check before claiming success.
      if (postRes.status() === 200) {
        const respHtml = await postRes.text();
        if (parseFormErrors(respHtml).length) {
          throw validationErrorFromHtml(respHtml, 'payment_unit create rejected');
        }
      }
      // Success — match the new PU by name from the table.
      const { payment_units } = await this.listPaymentUnits({
        organization_slug: args.organization_slug,
        opportunity_id: args.opportunity_id,
      });
      const found = payment_units.find((pu) => pu.name === args.name);
      if (found) {
        return {
          ...found,
          // listPaymentUnits doesn't currently surface description/org_amount/
          // deliver_units; include the args we posted so the response shape
          // matches REST as closely as we can without an extra GET.
          description: args.description ?? found.description,
          org_amount: args.org_amount ?? found.org_amount,
          required_deliver_units: args.required_deliver_units ?? found.required_deliver_units,
          optional_deliver_units: args.optional_deliver_units ?? found.optional_deliver_units,
        };
      }
      throw new ConnectError(
        `payment_unit create succeeded but new PU "${args.name}" not found in payment_unit_table after POST. ` +
          'See ConnectSilentRejectError docs in errors.ts.',
      );
    }
    throw await httpErrorFor(postRes, path, 'POST');
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Connect's HTML side has no `/activate/` URL — activation is a checkbox
   * toggle on the opportunity edit form. We re-POST the edit form with
   * `active=on`. Server-side guards (e.g. "must have a payment unit before
   * activating") are surfaced as `ConnectValidationError` via the existing
   * postEditForm path.
   */
  activateOpportunity: ConnectClient['activateOpportunity'] = async (args) => {
    const opp = await this.postEditForm(args.organization_slug, args.opportunity_id, {
      active: true,
    });
    // REST returns `{ id: int, opportunity_id: uuid, name, active: true }`.
    // The HTML edit form gives us back the full Opportunity but no int id;
    // we set `id: 0` as a sentinel since downstream code only uses the
    // opportunity_id (UUID) for subsequent calls. If int-id consumers
    // surface, parse it out of the deliver_unit_table or related route.
    return {
      id: 0,
      opportunity_id: opp.id,
      name: opp.name,
      active: true as const,
    };
  };

  // ── Program applications (LLO invite + accept) ────────────────────

  /**
   * POSTs `/a/<pm_org>/program/<program_uuid>/invite` with `organization=
   * <llo_slug>`. Connect emails the LLO admins via `send_program_invite_email`.
   * The form 302 redirects back to the program list; we then list invites
   * to find the new application UUID.
   *
   * Note the URL is `invite` (no trailing slash) — verified live against
   * connect.dimagi.com 2026-05-01. The form action attribute confirms.
   */
  sendLloInvite: ConnectClient['sendLloInvite'] = async (args) => {
    const path = `/a/${args.organization_slug}/program/${args.program_id}/invite`;
    const formRes = await this.opts.request.get(`/a/${args.organization_slug}/program/`);
    if (formRes.status() !== 200) throw await httpErrorFor(formRes, `/a/${args.organization_slug}/program/`);
    const csrf = extractFormCsrfToken(await formRes.text()) ?? this.opts.csrfToken;

    const postRes = await this.opts.request.post(path, {
      form: {
        csrfmiddlewaretoken: csrf,
        organization: args.organization,
      },
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}/a/${args.organization_slug}/program/`,
        'X-CSRFToken': csrf,
      },
    });

    if (postRes.status() === 302 || postRes.status() === 200) {
      if (postRes.status() === 200) {
        const respHtml = await postRes.text();
        if (parseFormErrors(respHtml).length) {
          throw validationErrorFromHtml(respHtml, 'sendLloInvite rejected');
        }
      }
      // Look up the application_id by listing invites for this program.
      const { invites } = await this.listInvites({
        organization_slug: args.organization_slug,
        program_id: args.program_id,
      });
      const hit = invites.find((i) => i.organization === args.organization);
      const application_id = hit?.id ?? '';
      const status: ProgramApplication['status'] = (hit?.status as ProgramApplication['status']) ?? 'invited';
      return {
        program_application_id: application_id,
        program: args.program_id,
        organization: args.organization,
        status,
      };
    }
    throw await httpErrorFor(postRes, path, 'POST');
  };

  /**
   * Connect's PM-side UI exposes no "accept" button — acceptance happens
   * on the LLO side via `POST /a/<llo_org>/program/<uuid>/application/<app>/accept/`.
   * The atom signature gives us the PM org slug (`organization_slug`) but
   * not the LLO slug; we need to resolve it.
   *
   * Resolution: list program applications for the program (via the
   * Playwright reads), find the matching application_id, and read its
   * `organization` field. We then POST to `/a/<llo>/program/.../accept/`.
   * If the authenticated session does not have membership in that LLO
   * org, the POST will return 403 — which is the correct failure mode.
   */
  acceptProgramApplication: ConnectClient['acceptProgramApplication'] = async (args) => {
    // 1. Look up the application to find the LLO org slug
    const { invites } = await this.listInvites({
      organization_slug: args.organization_slug,
      program_id: args.program_id,
    });
    const app = invites.find((i) => i.id === args.application_id);
    if (!app) {
      throw new ConnectError(
        `acceptProgramApplication: application ${args.application_id} not found under program ${args.program_id} for org ${args.organization_slug}. ` +
          'List invites first to verify the application_id is correct.',
      );
    }
    const lloSlug = app.organization;

    const path = `/a/${lloSlug}/program/${args.program_id}/application/${args.application_id}/accept/`;
    // Need a CSRF token from a same-origin GET — ANY page works for the cookie.
    const seedRes = await this.opts.request.get(`/a/${lloSlug}/opportunity/`);
    const seedHtml = seedRes.status() === 200 ? await seedRes.text() : '';
    const csrf = extractFormCsrfToken(seedHtml) ?? this.opts.csrfToken;

    const postRes = await this.opts.request.post(path, {
      form: { csrfmiddlewaretoken: csrf },
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}/a/${lloSlug}/opportunity/`,
        'X-CSRFToken': csrf,
      },
    });

    if (postRes.status() === 302 || postRes.status() === 200) {
      if (postRes.status() === 200) {
        const respHtml = await postRes.text();
        if (parseFormErrors(respHtml).length) {
          throw validationErrorFromHtml(respHtml, 'acceptProgramApplication rejected');
        }
      }
      return {
        program_application_id: args.application_id,
        program: args.program_id,
        organization: lloSlug,
        status: 'accepted' as const,
      };
    }
    throw await httpErrorFor(postRes, path, 'POST');
  };

  // ── FLW invites ───────────────────────────────────────────────────

  /**
   * POSTs `/a/<org>/opportunity/<uuid>/user_invite/` with `users=<phones
   * joined by \n>`. The form is documented as: "Enter the phone numbers
   * of the users you want to add to this opportunity with the country
   * code, one on each line."
   *
   * REST requires the opportunity to be `active`; the HTML form does the
   * same check and surfaces "Opportunity must be active" as an errorlist.
   */
  sendFlwInvite: ConnectClient['sendFlwInvite'] = async (args) => {
    const path = `/a/${args.organization_slug}/opportunity/${args.opportunity_id}/user_invite/`;
    const formRes = await this.opts.request.get(path);
    if (formRes.status() !== 200) throw await httpErrorFor(formRes, path);
    const csrf = extractFormCsrfToken(await formRes.text()) ?? this.opts.csrfToken;

    const postRes = await this.opts.request.post(path, {
      form: {
        csrfmiddlewaretoken: csrf,
        users: args.phone_numbers.join('\n'),
        submit: 'Submit',
      },
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}${path}`,
        'X-CSRFToken': csrf,
      },
    });

    if (postRes.status() === 302 || postRes.status() === 200) {
      if (postRes.status() === 200) {
        const respHtml = await postRes.text();
        if (parseFormErrors(respHtml).length) {
          throw validationErrorFromHtml(respHtml, 'sendFlwInvite rejected');
        }
      }
      return {
        opportunity_id: args.opportunity_id,
        phone_numbers: args.phone_numbers,
        invited_count: args.phone_numbers.length,
        status: 'queued' as const,
      };
    }
    throw await httpErrorFor(postRes, path, 'POST');
  };
}
