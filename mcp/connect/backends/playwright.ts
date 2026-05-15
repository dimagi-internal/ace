import type { APIRequestContext, APIResponse } from 'playwright';
import type { ConnectClient } from '../client.js';
import type { Opportunity, PaymentUnit, Program, ProgramApplication } from '../types.js';
import { HttpError, ConnectValidationError, ConnectError } from '../errors.js';
import type { PlaywrightSession } from '../auth/playwright-session.js';
import {
  extractFormCsrfToken,
  extractFormFieldValues,
  extractUuidFromPath,
  parseDeliveryTypeOptions,
  parseProgramsList,
  parseOpportunitiesList,
  parseInvitesList,
  parseFormErrors,
  parseFormErrorsByField,
  parseDeliverUnitTable,
  parseDeliverUnitFormCheckboxes,
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
  /**
   * Optional session reference. When supplied (the production wiring),
   * the backend resolves `request` lazily from `session.getContext()` on
   * every call so a `RestBackend.reauth()`-driven `session.invalidate()`
   * (which closes the underlying BrowserContext) doesn't leave THIS
   * backend holding a dead `APIRequestContext`. Pre-0.13.17 the
   * constructor-bound `opts.request` went stale on every reauth and
   * subsequent Playwright reads failed with `apiRequestContext.get:
   * Target page, context or browser has been closed`. Tests can omit
   * it; the lazy resolver falls back to the constructor-bound handle.
   */
  session?: PlaywrightSession;
}

async function httpErrorFor(res: APIResponse, urlPath: string, method: string = 'GET'): Promise<HttpError> {
  let body = '';
  try { body = await res.text(); } catch { /* swallow */ }
  const contentType = res.headers()['content-type'];
  return new HttpError(res.status(), `${method} ${urlPath}`, body, contentType);
}

/**
 * Parse all <option> elements out of a select/HTMX-fragment HTML blob.
 * Used for hq_server resolution, api_key dropdown, and learn/deliver app
 * dropdowns where the value attribute is the actual form payload.
 */
function parseSelectOptions(html: string): Array<{ value: string; text: string }> {
  const opts: Array<{ value: string; text: string }> = [];
  for (const m of html.matchAll(/<option[^>]*value=["']([^"']*)["'][^>]*>([^<]*)<\/option>/g)) {
    opts.push({ value: m[1], text: m[2].trim() });
  }
  return opts;
}

/**
 * Decode HTML entities in form-value attributes (Connect's apps endpoint
 * embeds JSON in option `value`s and HTML-encodes the quotes).
 */
function htmlDecodeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
}

/**
 * Extract the opp's integer FK from a form HTML's HTMX `Sync Deliver Units`
 * button. Connect's UI uses two id namespaces for the same opportunity:
 * a UUID exposed in REST URLs and the JSON-API responses, and an integer
 * primary key embedded in HTMX hx-* attributes. This helper finds the
 * int id from the create-PU form's sync button without needing a separate
 * lookup atom.
 *
 * Looks for the canonical pattern:
 *   <button ... hx-post="/a/<org>/opportunity/<int_id>/sync_deliver_units/">
 *
 * Returns null if the button isn't present (Connect UI changed, or this
 * isn't a create-PU form). Callers should treat null as a soft signal —
 * skip the sync precondition rather than halting.
 */
function extractOppIntIdFromForm(html: string): number | null {
  const m = html.match(/hx-post="\/a\/[^"\/]+\/opportunity\/(\d+)\/sync_deliver_units\//);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Resolve a caller-friendly hq_server label or URL ("prod" / "india" / "eu" /
 * full URL) against Connect's <select name="hq_server"> options on the
 * create-opportunity form. Returns the int FK as string (e.g. "1") or
 * undefined if no match.
 *
 * Connect's Knockout-driven form select looks like:
 *   <option value="1">CommCareHQ (https://www.commcarehq.org)</option>
 *   <option value="2">India (https://india.commcarehq.org)</option>
 *   <option value="3">CommCareHQ EU (https://eu.commcarehq.org)</option>
 *
 * We parse it from the form HTML rather than hardcoding so this tracks
 * any Connect-side server-list changes without code edits.
 */
function resolveHqServer(formHtml: string, label: string): string | undefined {
  const sel = formHtml.match(/<select[^>]*name=["']hq_server["'][^>]*>([\s\S]*?)<\/select>/);
  if (!sel) return undefined;
  const opts = parseSelectOptions(sel[1]);
  const lc = label.toLowerCase();
  // Strip protocol + trailing slash to make URL inputs match the URL fragment
  // Connect renders inside the option text (e.g. "https://www.commcarehq.org"
  // → "www.commcarehq.org").
  const lcHost = lc.replace(/^https?:\/\//, '').replace(/\/$/, '');
  for (const o of opts) {
    if (!o.value || o.value === '' || o.value === 'None') continue;
    // direct int match
    if (o.value === label) return o.value;
    // URL or hostname appears in option text
    if (o.text.toLowerCase().includes(lcHost)) return o.value;
    // shorthand mapping
    if (lc === 'prod' && /www\.commcarehq\.org/i.test(o.text)) return o.value;
    if (lc === 'india' && /india\.commcarehq\.org/i.test(o.text)) return o.value;
    if (lc === 'eu' && /eu\.commcarehq\.org/i.test(o.text)) return o.value;
  }
  return undefined;
}

/**
 * Build the truncated label Connect uses to display an HQ API key in the
 * api_key dropdown: first 4 + "..." + last 4 hex chars.
 */
function truncatedKeyLabel(rawKey: string): string {
  return `${rawKey.slice(0, 4)}...${rawKey.slice(-4)}`;
}

// Pre-0.10.47: this file kept `NotImplementedError` + a `stub()` helper for
// the eight write atoms (`createProgram`, `createOpportunity`, etc.) that
// the REST backend handled. Since 0.10.55 we ship real HTML-form fallbacks
// for those atoms so the composite can recover when REST returns 404 (PR
// #1135 not yet deployed to prod).
//
// 0.10.82 rewired `createOpportunity` against a live HTMX probe of
// connect.dimagi.com (the prior 0.10.81 implementation 500'd because it
// sent a `program` field the form doesn't accept and tried to drive a
// `/finalize/` step that requires payment units which don't exist yet at
// create time). The current implementation is single-step:
//   1. Register the HQ API key with Connect (HTMX add_api_key/) → int FK
//   2. Resolve learn/deliver app ids via GET /hq/applications/...
//   3. POST /a/<org>/opportunity/init/ with the resolved values; capture
//      the new opp UUID from the 302 redirect (target is the wizard's
//      next step `/payment_units/create`).
// `registerHqApiKey` lives as a private helper. Payment-unit creation,
// dates / budget, and activation are handled by separate atoms that the
// orchestrator runs after this one.

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

  /**
   * Lazily resolved `APIRequestContext`. When wired to a session
   * (production), returns the session's current request handle so that
   * `RestBackend.reauth()` (which closes the underlying BrowserContext
   * via `session.invalidate()` and then rebuilds via
   * `session.getContext()`) doesn't strand THIS backend on a dead
   * handle. Pre-0.13.17 the constructor cached `opts.request` as a
   * private field, and any reauth path silently broke every subsequent
   * Playwright read with `apiRequestContext.get: Target page, context
   * or browser has been closed`. Falls back to the constructor-bound
   * handle when no session was supplied (the test path).
   */
  private get request(): APIRequestContext {
    const live = this.opts.session?.peekRequest();
    return live ?? this.opts.request;
  }

  // ── Programs ─────────────────────────────────────────────────────

  listPrograms: ConnectClient['listPrograms'] = async ({ organization_slug, name }) => {
    const path = `/a/${organization_slug}/program/`;
    const res = await this.request.get(path);
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    let programs = parseProgramsList(await res.text()).map((p) => ({ ...p, organization_slug }));
    if (name) programs = programs.filter((p) => p.name === name);
    return { programs };
  };

  getProgram: ConnectClient['getProgram'] = async ({ organization_slug, program_id }) => {
    const editPath = `/a/${organization_slug}/program/${program_id}/edit`;
    const editRes = await this.request.get(editPath);
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
    const res = await this.request.get(path);
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    return { delivery_types: parseDeliveryTypeOptions(await res.text()) };
  };

  updateProgram: ConnectClient['updateProgram'] = async (args) => {
    const editPath = `/a/${args.organization_slug}/program/${args.program_id}/edit`;
    const editRes = await this.request.get(editPath);
    if (editRes.status() !== 200) throw await httpErrorFor(editRes, editPath);
    const editHtml = await editRes.text();
    const csrf = extractFormCsrfToken(editHtml) ?? this.opts.csrfToken;
    const current = extractFormFieldValues(editHtml);

    const postRes = await this.request.post(editPath, {
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
    const res = await this.request.get(path);
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
      this.request.get(editPath),
      this.request.get(detailPath),
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
    const editRes = await this.request.get(editPath);
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

    const postRes = await this.request.post(editPath, {
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
    const getRes = await this.request.get(path);
    if (getRes.status() !== 200) throw await httpErrorFor(getRes, path);
    const html = await getRes.text();
    const csrf = extractFormCsrfToken(html) ?? this.opts.csrfToken;
    const current = extractFormFieldValues(html);

    // `location` is the form's numeric "GPS radius (meters)" field — NOT
    // a boolean toggle. Surfaced through `flags.gps_radius_meters` since
    // 0.13.240; preserve the form's current value (default 10m) if not
    // explicitly set. Renamed from the historic boolean-shaped
    // `flags.location` which never worked anyway.
    const radiusFromArg = flags.gps_radius_meters != null ? String(flags.gps_radius_meters) : undefined;
    const form: Record<string, string> = {
      csrfmiddlewaretoken: csrf,
      location: radiusFromArg ?? current['location'] ?? '10',
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

    const postRes = await this.request.post(path, {
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
    const res = await this.request.get(path);
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    const deliver_units = parseDeliverUnitTable(await res.text());
    // Server-PK enrichment (added 0.13.126 — closes jjackson/ace#106 finding 5).
    //
    // The `deliver_unit_table` page above renders display indices (1, 2, 3…)
    // but not the server-side primary keys that
    // `payment_unit.required_deliver_units` accepts. Connect leaks those PKs
    // on the create-payment-unit form's checkbox `value` attributes — the
    // ONLY HTML route on which they're observable today. Fetch that form,
    // sync deliver-units if needed, parse the checkboxes, and join by name
    // back to each DU. On any error we log and proceed with `server_id`
    // undefined (back-compat with pre-0.13.126 callers; createPaymentUnit
    // still has its inline name-mapping fallback).
    if (deliver_units.length > 0) {
      try {
        const formPath = `/a/${organization_slug}/opportunity/${opportunity_id}/payment_unit/create`;
        let formRes = await this.request.get(formPath);
        if (formRes.status() === 200) {
          let formHtml = await formRes.text();
          let nameToPk = parseDeliverUnitFormCheckboxes(formHtml);
          // Sync precondition — the form's checkbox list is empty until
          // the HTMX `Sync Deliver Units` button has fired (the deliver_units
          // table cache and the create-PU checkbox cache are separate).
          if (nameToPk.size === 0) {
            const oppIntId = extractOppIntIdFromForm(formHtml);
            const csrf = extractFormCsrfToken(formHtml) ?? this.opts.csrfToken;
            if (oppIntId !== null) {
              const syncPath = `/a/${organization_slug}/opportunity/${oppIntId}/sync_deliver_units/`;
              const syncRes = await this.request.post(syncPath, {
                headers: {
                  'X-CSRFToken': csrf,
                  'HX-Request': 'true',
                  Referer: `${this.opts.baseUrl}${formPath}`,
                },
              });
              const syncStatus = syncRes.status();
              if (syncStatus === 200 || syncStatus === 204 || syncStatus === 302) {
                formRes = await this.request.get(formPath);
                if (formRes.status() === 200) {
                  formHtml = await formRes.text();
                  nameToPk = parseDeliverUnitFormCheckboxes(formHtml);
                }
              }
            }
          }
          for (const du of deliver_units) {
            const pk = nameToPk.get(du.name);
            if (pk !== undefined) {
              const n = Number(pk);
              if (Number.isInteger(n) && n > 0) du.server_id = n;
            }
          }
        }
      } catch {
        // Server-PK enrichment is best-effort — never fail listDeliverUnits
        // over it. Callers that genuinely need server_id will see undefined
        // and surface a typed error at use-site (e.g. createPaymentUnit's
        // existing checkbox-mapping diagnostic).
      }
    }
    return { deliver_units };
  };

  listPaymentUnits: ConnectClient['listPaymentUnits'] = async ({ organization_slug, opportunity_id }) => {
    const path = `/a/${organization_slug}/opportunity/${opportunity_id}/payment_unit_table/`;
    const res = await this.request.get(path);
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    return { payment_units: parsePaymentUnitTable(await res.text()) };
  };

  // ── Invites (read-only listing; create/accept moved to REST) ──────

  listInvites: ConnectClient['listInvites'] = async ({ organization_slug, program_id }) => {
    const listRes = await this.request.get(`/a/${organization_slug}/program/`);
    if (listRes.status() !== 200) throw await httpErrorFor(listRes, `/a/${organization_slug}/program/`);
    return { invites: parseInvitesList(await listRes.text(), program_id) };
  };

  // ── Invoices (stub — page shape not yet probed) ───────────────────

  listInvoices: ConnectClient['listInvoices'] = async ({ organization_slug, opportunity_id }) => {
    const path = `/a/${organization_slug}/opportunity/${opportunity_id}/invoices/`;
    const res = await this.request.get(path);
    if (res.status() !== 200) return { invoices: [] };
    return { invoices: [] };
  };

  getInvoice: ConnectClient['getInvoice'] = async ({ organization_slug, invoice_id }) => {
    const path = `/a/${organization_slug}/invoice/${invoice_id}/`;
    const res = await this.request.get(path);
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
  //   - createPaymentUnit/s   single-PU form per item (server has no batch
  //                           endpoint here); plural loops the singular
  //   - createOpportunity     HTMX init-form fallback rewired in 0.10.82:
  //                           register HQ key → resolve learn/deliver app
  //                           values → POST /opportunity/init/ → return
  //                           the new opp UUID. Does NOT drive the
  //                           wizard's payment-units or finalize steps —
  //                           those are separate atoms. The pre-0.10.81
  //                           code attempted to POST /finalize/ inline,
  //                           which 500s because the form doesn't accept
  //                           a `program` field and finalize requires PUs
  //                           that don't yet exist at create time.
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
    const formRes = await this.request.get(formPath);
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

    const postRes = await this.request.post(formPath, {
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

  // ── Opportunities (HTMX init-form fallback, rewired 0.10.82) ──

  /**
   * Drive Connect's HTML opportunity-creation form. Live-probed against
   * connect.dimagi.com 2026-05-02; the prior 0.10.81 implementation
   * 500-failed because it sent a `program` field the form doesn't accept
   * AND tried to drive a `/finalize/` step inside this atom that the
   * server can only accept once payment units exist.
   *
   * What the live wizard actually looks like (probed 2026-05-02):
   *
   *   1. The /opportunity/init/ form is the ONLY create endpoint on
   *      connect.dimagi.com. It produces standalone (un-managed)
   *      opportunities — there is NO `program` field on the HTML form.
   *      Sending one is silently ignored. Program binding for downstream
   *      EOI / multi-LLO routing happens via the REST automation API
   *      ([commcare-connect#1135](https://github.com/dimagi/commcare-connect/pull/1135));
   *      this fallback only fires when REST 404s, so the resulting opp
   *      is necessarily standalone.
   *
   *   2. The form is HTMX-cascaded. Endpoints (no `/a/<org>/` prefix —
   *      they hang off the global `/users/...` and `/hq/...` routes):
   *        - `GET /users/api_keys/?hq_server=<int_fk>`
   *            → `<select>` of registered HQ API keys (truncated label →
   *               int FK as value)
   *        - `GET /hq/domains/?hq_server=<id>&api_key=<id>`
   *            → `<select>` of HQ project-spaces the key has access to
   *        - `GET /hq/applications/?hq_server=<id>&<learn|deliver>_app_domain=<d>&api_key=<id>`
   *            → `<select>` whose `value` attribute is a JSON string
   *               `{"id":"<32hex>","name":"<status> - <app name>"}`. The
   *               status prefix in `name` is informational only — Connect
   *               currently labels everything as "Unreleased" regardless
   *               of HQ-side release state. Sending the JSON verbatim
   *               (including the prefix) is what the form expects.
   *
   *   3. `POST /a/<org>/opportunity/add_api_key/` registers a new HQ key
   *      against an `hq_server`; the key shows up in subsequent
   *      `/users/api_keys/` lookups by truncated label.
   *
   *   4. `POST /a/<org>/opportunity/init/` with the assembled form body
   *      302-redirects to `/a/<org>/opportunity/<uuid>/payment_units/create`
   *      on success. Validation errors return 200 with crispy-tailwind
   *      `<p id="error_N_id_<field>">` markers.
   *
   * What the wizard does NOT do here:
   *   - The init step does NOT take dates or budget. Those are wizard
   *     step 3 (`/finalize/`), which requires payment units to exist
   *     first. PUs are a separate atom (`createPaymentUnit(s)`) and the
   *     orchestrator runs them after this atom returns. The opportunity
   *     becomes runnable when a separate `activateOpportunity` call
   *     toggles `active=on` on the edit form (server-side guards reject
   *     activation if PUs / dates / budget are missing — that's the
   *     correct surfaced error).
   *   - There is no `target_organization_slug` field on the HTML form —
   *     standalone opps live under the calling PM org. Cross-org
   *     transfer is REST-only.
   *   - The `program` field is NOT sent (form doesn't accept it).
   *
   * The shared learn/deliver `hq_server_url` + `api_key` invariant still
   * holds — Connect's form has a single picker for each.
   */
  createOpportunity: ConnectClient['createOpportunity'] = async (args) => {
    if (
      args.target_organization_slug &&
      args.target_organization_slug !== args.organization_slug
    ) {
      // The HTML form creates under the PM slug. There is no equivalent
      // field for `target_organization_slug` — that's REST-only. Surface
      // a non-fatal note so the caller knows ownership transfer needs a
      // separate (out-of-band) acceptance step.
      // eslint-disable-next-line no-console
      console.warn(
        `[ace-connect] createOpportunity Playwright fallback: target_organization_slug='${args.target_organization_slug}' differs from organization_slug='${args.organization_slug}'. The HTML form creates a standalone opp under the PM org; cross-org transfer is REST-only.`,
      );
    }

    if (args.learn_app.hq_server_url !== args.deliver_app.hq_server_url) {
      throw new ConnectValidationError([
        `Playwright fallback requires learn_app.hq_server_url and deliver_app.hq_server_url to match (Connect's HTML form has a single hq_server picker). Got '${args.learn_app.hq_server_url}' vs '${args.deliver_app.hq_server_url}'.`,
      ]);
    }
    // Connect's HTML form similarly has a single api_key picker shared
    // across learn + deliver. We expect both nested objects to use the
    // same key for the fallback path.
    if (args.learn_app.api_key !== args.deliver_app.api_key) {
      throw new ConnectValidationError([
        `Playwright fallback requires learn_app.api_key and deliver_app.api_key to match (Connect's HTML form has a single api_key picker).`,
      ]);
    }

    const orgSlug = args.organization_slug;
    const formPath = `/a/${orgSlug}/opportunity/init/`;

    // 1. GET the init form → CSRF + hq_server option list.
    const formRes = await this.request.get(formPath);
    if (formRes.status() !== 200) throw await httpErrorFor(formRes, formPath, 'GET');
    const formHtml = await formRes.text();
    const csrf = extractFormCsrfToken(formHtml) ?? this.opts.csrfToken;

    const hqServerId = resolveHqServer(formHtml, args.learn_app.hq_server_url);
    if (!hqServerId) {
      throw new ConnectValidationError(
        [
          `hq_server_url '${args.learn_app.hq_server_url}' did not match any Connect-known server. ` +
            `Use 'prod', 'india', 'eu', a server URL like 'https://www.commcarehq.org', or the int FK directly.`,
        ],
        { hq_server: ['Unknown server'] },
      );
    }

    // 2. Register the raw HQ API key with Connect (idempotent) → int FK.
    const apiKeyId = await this.ensureHqApiKeyRegistered({
      organization_slug: orgSlug,
      hq_server_id: hqServerId,
      api_key: args.learn_app.api_key,
      csrf,
    });

    // 3. Resolve learn/deliver app ids → JSON-encoded form values.
    const learnAppValue = await this.resolveHqAppValue({
      hq_server_id: hqServerId,
      domain: args.learn_app.cc_domain,
      api_key_id: apiKeyId,
      app_id: args.learn_app.cc_app_id,
      domainField: 'learn_app_domain',
    });
    const deliverAppValue = await this.resolveHqAppValue({
      hq_server_id: hqServerId,
      domain: args.deliver_app.cc_domain,
      api_key_id: apiKeyId,
      app_id: args.deliver_app.cc_app_id,
      domainField: 'deliver_app_domain',
    });

    // 4. Refetch CSRF — Django one-shot tokens may have rotated after
    //    the add_api_key POST. The HTML init form requires currency +
    //    country (it does NOT have a `program` field, so it can't
    //    inherit them server-side the way the REST API does). We still
    //    look up the parent program to source those two values, even
    //    though we never POST a `program=<uuid>` field.
    const formRes2 = await this.request.get(formPath);
    if (formRes2.status() !== 200) throw await httpErrorFor(formRes2, formPath, 'GET');
    const formHtml2 = await formRes2.text();
    const csrf2 = extractFormCsrfToken(formHtml2) ?? this.opts.csrfToken;
    const program = await this.getProgram({
      organization_slug: orgSlug,
      program_id: args.program_id,
    });
    // Resolve country from the form's <select> options (the form expects
    // ISO-3 codes; the program may store the human-readable name).
    const resolvedCountry = await this.resolveCountryCode(formHtml2, program.country ?? 'USA');

    const initBody: Record<string, string> = {
      csrfmiddlewaretoken: csrf2,
      name: args.name,
      short_description: args.short_description,
      description: args.description,
      currency: PlaywrightBackend.normalizeCurrency(program.currency ?? 'USD'),
      country: resolvedCountry || 'USA',
      hq_server: hqServerId,
      api_key: apiKeyId,
      learn_app_domain: args.learn_app.cc_domain,
      learn_app: learnAppValue,
      learn_app_passing_score: String(args.learn_app.passing_score),
      learn_app_description: args.learn_app.description ?? '',
      deliver_app_domain: args.deliver_app.cc_domain,
      deliver_app: deliverAppValue,
    };

    const initRes = await this.request.post(formPath, {
      form: initBody,
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}/a/${orgSlug}/opportunity/init/`,
        'X-CSRFToken': csrf2,
      },
    });

    let createdOppId: string | undefined;
    if (initRes.status() === 302) {
      const loc = initRes.headers()['location'] ?? '';
      // Live success redirects to /a/<org>/opportunity/<uuid>/payment_units/create
      // (the wizard's step-2 page). Earlier templates may redirect to
      // /opportunity/<uuid>/init/edit/ — both forms include the UUID we want.
      const m = loc.match(/\/opportunity\/([a-f0-9-]{36})\b/);
      createdOppId = m?.[1];
      if (!createdOppId) {
        // extractUuidFromPath looks for `/<keyword>/<uuid>/` shape.
        createdOppId = extractUuidFromPath(loc, 'opportunity');
      }
      if (!createdOppId) {
        // Last resort: list opps and match by name (most recent wins).
        const list = await this.listOpportunities({ organization_slug: orgSlug, name: args.name });
        if (!list.opportunities[0]) {
          throw new HttpError(
            500,
            `POST ${formPath}`,
            `opportunity create succeeded (302) but "${args.name}" not found in list and Location='${loc}' contained no opp UUID`,
          );
        }
        createdOppId = list.opportunities[0].id;
      }
    } else if (initRes.status() === 200) {
      throw validationErrorFromHtml(await initRes.text(), 'opportunity init rejected');
    } else {
      throw await httpErrorFor(initRes, formPath, 'POST');
    }

    // 5. Hydrate. The opp won't have start/end/budget/active set yet —
    //    those are configured via separate atoms (createPaymentUnit(s),
    //    then activateOpportunity which toggles `active=on` on the edit
    //    form, which itself triggers Connect's payment-unit / dates /
    //    budget guards).
    return await this.getOpportunity({
      organization_slug: orgSlug,
      opportunity_id: createdOppId,
    });
  };

  /**
   * Private helper (was a public atom before 0.10.47): register an HQ
   * API key with Connect via the HTMX `/opportunity/add_api_key/` endpoint
   * and return its Connect-side int FK as string. Idempotent: if the key
   * is already registered for this hq_server, look up and return the
   * existing id without re-POSTing.
   *
   * Background: Connect's create-opportunity form takes `api_key` as an
   * int FK to a Connect-internal `HQApiKey` record, NOT the raw 40-char
   * HQ API key. PR #1135's REST API does this server-side via
   * `get_or_create`; the HTML form expects the user to register the key
   * via the "+" / "Add API Key" modal first. We do that for the agent here.
   */
  private async ensureHqApiKeyRegistered(args: {
    organization_slug: string;
    hq_server_id: string;
    api_key: string;
    csrf: string;
  }): Promise<string> {
    const truncated = truncatedKeyLabel(args.api_key);
    const listPath = `/users/api_keys/?hq_server=${args.hq_server_id}`;

    // First check: is this key already registered? Connect shows it in
    // the dropdown by truncated label.
    let listRes = await this.request.get(listPath, { headers: { 'HX-Request': 'true' } });
    if (listRes.status() === 200) {
      const opts = parseSelectOptions(await listRes.text());
      const found = opts.find((o) => o.text === truncated && /^\d+$/.test(o.value));
      if (found) return found.value;
    }

    // Not registered — POST /add_api_key/. Connect's HTMX endpoint returns
    // 200 with a re-rendered form fragment regardless of new vs duplicate.
    const addPath = `/a/${args.organization_slug}/opportunity/add_api_key/`;
    const addRes = await this.request.post(addPath, {
      form: {
        csrfmiddlewaretoken: args.csrf,
        hq_server: args.hq_server_id,
        api_key: args.api_key,
      },
      headers: {
        Referer: `${this.opts.baseUrl}/a/${args.organization_slug}/opportunity/init/`,
        'X-CSRFToken': args.csrf,
        'HX-Request': 'true',
      },
    });
    if (addRes.status() !== 200) throw await httpErrorFor(addRes, addPath, 'POST');

    // Re-query the dropdown to pick up the freshly-registered key.
    listRes = await this.request.get(listPath, { headers: { 'HX-Request': 'true' } });
    if (listRes.status() !== 200) throw await httpErrorFor(listRes, listPath, 'GET');
    const opts = parseSelectOptions(await listRes.text());
    const found = opts.find((o) => o.text === truncated && /^\d+$/.test(o.value));
    if (!found) {
      throw new HttpError(
        500,
        addPath,
        `add_api_key returned 200 but ${truncated} did not appear in /users/api_keys/?hq_server=${args.hq_server_id}`,
      );
    }
    return found.value;
  }

  /**
   * Private helper: resolve a bare HQ app id (e.g.
   * `76fd5f0e2834454bb946bdf9ae9bff71`) to the JSON-encoded form value
   * Connect's create-opportunity form expects:
   *   `{"id": "<id>", "name": "<full app name>"}`
   *
   * Connect populates the learn_app/deliver_app dropdowns via an HTMX GET
   * to `/hq/applications/?hq_server=<id>&<field>=<domain>&api_key=<id>`.
   * The `value` attribute of each <option> is the full JSON string the
   * form expects. We GET that fragment, parse the options, and find the
   * one whose JSON `id` matches the caller's app id.
   */
  private async resolveHqAppValue(args: {
    hq_server_id: string;
    domain: string;
    api_key_id: string;
    app_id: string;
    domainField: 'learn_app_domain' | 'deliver_app_domain';
  }): Promise<string> {
    const path = `/hq/applications/?hq_server=${encodeURIComponent(args.hq_server_id)}&${args.domainField}=${encodeURIComponent(args.domain)}&api_key=${encodeURIComponent(args.api_key_id)}`;
    const res = await this.request.get(path, { headers: { 'HX-Request': 'true' } });
    if (res.status() !== 200) throw await httpErrorFor(res, path, 'GET');
    const opts = parseSelectOptions(await res.text());
    const real: Array<{ value: string; text: string; id: string }> = [];
    for (const o of opts) {
      if (!o.value || o.value === 'None' || o.value === '') continue;
      try {
        const decoded = htmlDecodeAttr(o.value);
        const parsed = JSON.parse(decoded);
        if (parsed?.id) real.push({ value: decoded, text: o.text, id: parsed.id });
      } catch {
        /* not JSON, skip */
      }
    }
    const match = real.find((o) => o.id === args.app_id);
    if (!match) {
      const available = real.length
        ? real.map((o) => `${o.id} (${o.text})`).join(', ')
        : '(none — domain may have no apps, or HQ key may not have access)';
      throw new ConnectValidationError([
        `app id '${args.app_id}' not found in Connect's options for ${args.domainField}='${args.domain}'. Available: ${available}`,
      ]);
    }
    return match.value;
  }

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
    let formRes = await this.request.get(path);
    if (formRes.status() !== 200) throw await httpErrorFor(formRes, path);
    let formHtml = await formRes.text();
    let csrf = extractFormCsrfToken(formHtml) ?? this.opts.csrfToken;

    // Sync-deliver-units precondition (added 0.11.12).
    //
    // Connect's create-PU form leaves the deliver-unit checkbox list
    // empty until an HTMX-driven `Sync Deliver Units` button is fired,
    // even when `connect_create_opportunity` already synced the DUs
    // into the opp's `deliver_units` table on the server side. The two
    // caches are separate — `connect_list_deliver_units` reads the
    // table directly (returns the DUs cleanly), but the create-PU
    // form's checkbox list reads a UI-level cache that's only
    // populated by clicking the sync button. Without this precondition,
    // the regex below scrapes zero DU options and any
    // `required_deliver_units` arg fails to map.
    //
    // Diagnosed `turmeric-20260503-0835` Phase 4 by reading the live
    // form HTML on 2026-05-04: the form structurally has
    // `<div id="div_id_required_deliver_units">` but no
    // `<input name="required_deliver_units">` checkboxes; the form
    // also embeds `<button id="sync-button" hx-post=".../sync_deliver_units/">`.
    //
    // Failure mode: if the sync POST fails (auth, 5xx, etc), log and
    // proceed with the original form — the existing checkbox-mapping
    // error below surfaces a clean diagnostic, which is better than
    // halting on a precondition that wasn't there before.
    const needsDuSync =
      (args.required_deliver_units?.length ?? 0) > 0 ||
      (args.optional_deliver_units?.length ?? 0) > 0;
    if (needsDuSync) {
      const oppIntId = extractOppIntIdFromForm(formHtml);
      if (oppIntId !== null) {
        const syncPath = `/a/${args.organization_slug}/opportunity/${oppIntId}/sync_deliver_units/`;
        const syncRes = await this.request.post(syncPath, {
          headers: {
            'X-CSRFToken': csrf,
            'HX-Request': 'true',
            Referer: `${this.opts.baseUrl}${path}`,
          },
        });
        const syncStatus = syncRes.status();
        if (syncStatus === 200 || syncStatus === 204 || syncStatus === 302) {
          // Re-fetch the form so the DU checkboxes are populated.
          formRes = await this.request.get(path);
          if (formRes.status() !== 200) throw await httpErrorFor(formRes, path);
          formHtml = await formRes.text();
          csrf = extractFormCsrfToken(formHtml) ?? csrf;
        } else {
          // Log and continue with the original form — the mapping
          // error below will surface a clean diagnostic.
          // eslint-disable-next-line no-console
          console.warn(
            `[connect] sync_deliver_units precondition POST returned ${syncStatus} for opp_int_id=${oppIntId}; proceeding without DU sync.`,
          );
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[connect] could not extract opp int_id from create-PU form HTML; skipping sync_deliver_units precondition. Connect UI may have changed; check the hx-post URL on the Sync Deliver Units button.`,
        );
      }
    }

    // The deliver-unit checkboxes use a different id namespace than
    // `connect_list_deliver_units` returns. The list returns a small
    // per-opp display id (1, 2, 3...); the form-checkbox `value` is the
    // global Connect-side DB primary key (e.g. 5112). Connect's view
    // reads the PK form-value, NOT the display id. If we POST the
    // display id directly, Connect 302-redirects with a Django messages
    // cookie of "Invalid Data" — silently dropping the create. (The
    // 0.10.64 fallback omitted this mapping; the pre-0.10.47 code had
    // it; restored 0.10.68.)
    //
    // Mitigation: parse this form's `<input name="required_deliver_units"
    // value="5112">Vendor visit</label>` checkboxes, then map the
    // caller's input ids → form values by matching against the deliver-
    // unit table's name. If the input id is ALREADY a form-value PK
    // (e.g. came from REST createOpportunity), pass it through.
    // Shared with `listDeliverUnits` server_id enrichment (0.13.126).
    // The same name→PK extraction underpins both surfaces; if you change
    // it here, change `parseDeliverUnitFormCheckboxes` in html-scrape.ts
    // and re-run its unit test.
    const checkboxValueByName = parseDeliverUnitFormCheckboxes(formHtml);
    const allCheckboxValues = new Set<string>(checkboxValueByName.values());

    // Pre-fetch deliver_units list once (used for display-id → name → form-value mapping).
    let idToFormValue = new Map<number, string>();
    const needsMapping = (args.required_deliver_units ?? []).some(
      (id) => !allCheckboxValues.has(String(id)),
    ) ||
      (args.optional_deliver_units ?? []).some(
        (id) => !allCheckboxValues.has(String(id)),
      );
    if (needsMapping && (args.required_deliver_units?.length || args.optional_deliver_units?.length)) {
      // Use the bare deliver_unit_table fetch here, NOT the enriched
      // public `listDeliverUnits` — we don't need `server_id` (the
      // already-parsed `checkboxValueByName` map IS the server-PK
      // source) and the public path's secondary form-fetch would be
      // duplicate work since we already have `formHtml` in scope.
      const tablePath = `/a/${args.organization_slug}/opportunity/${args.opportunity_id}/deliver_unit_table`;
      const tableRes = await this.request.get(tablePath);
      if (tableRes.status() === 200) {
        const tableHtml = await tableRes.text();
        for (const du of parseDeliverUnitTable(tableHtml)) {
          const v = checkboxValueByName.get(du.name);
          if (v) idToFormValue.set(du.id, v);
        }
      }
    }
    const mapId = (id: number): string => {
      const idStr = String(id);
      // If the input is already a known checkbox value, accept it.
      if (allCheckboxValues.has(idStr)) return idStr;
      const v = idToFormValue.get(id);
      if (v) return v;
      throw new ConnectValidationError([
        `deliver_unit_id ${id} did not resolve to any form-value in the create-payment_unit form. ` +
          `Available form values: [${[...allCheckboxValues].join(', ')}]; ` +
          `display→form mapping built from listDeliverUnits: ` +
          `${[...idToFormValue.entries()].map(([k, v]) => `${k}→${v}`).join(', ') || '(empty)'}`,
      ]);
    };

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
      params.append('required_deliver_units', mapId(id));
    }
    for (const id of args.optional_deliver_units ?? []) {
      params.append('optional_deliver_units', mapId(id));
    }
    params.append('submit', 'Submit');

    const postRes = await this.request.post(path, {
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
          // listPaymentUnits parses the payment_unit_table HTML, which
          // does not render `amount`, `description`, `org_amount`, or the
          // per-PU `required_deliver_units` ids. Echo what we posted so
          // the returned shape matches the REST `createPaymentUnits`
          // response. `max_total` and `max_daily` ARE in the table and
          // come back populated from `found`.
          amount: args.amount,
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
    const formRes = await this.request.get(`/a/${args.organization_slug}/program/`);
    if (formRes.status() !== 200) throw await httpErrorFor(formRes, `/a/${args.organization_slug}/program/`);
    const csrf = extractFormCsrfToken(await formRes.text()) ?? this.opts.csrfToken;

    const postRes = await this.request.post(path, {
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
    const seedRes = await this.request.get(`/a/${lloSlug}/opportunity/`);
    const seedHtml = seedRes.status() === 200 ? await seedRes.text() : '';
    const csrf = extractFormCsrfToken(seedHtml) ?? this.opts.csrfToken;

    const postRes = await this.request.post(path, {
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
    const formRes = await this.request.get(path);
    if (formRes.status() !== 200) throw await httpErrorFor(formRes, path);
    const csrf = extractFormCsrfToken(await formRes.text()) ?? this.opts.csrfToken;

    const postRes = await this.request.post(path, {
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

  /**
   * Delete unaccepted FLW invites by their integer ids. The Django view at
   * `/a/<org>/opportunity/<opp_id>/delete_invites/` is `@csrf_exempt` so we
   * skip the GET-form-to-scrape-CSRF dance the other write atoms do.
   *
   * The view expects the same form key (`user_invite_ids`) repeated once
   * per id — Playwright's `request.post({ form })` flattens an object into
   * non-repeating keys, so we build the URL-encoded body manually.
   *
   * Server-side filter is `id__in=invite_ids` AND `opportunity=request.opportunity`
   * AND `exclude(status=accepted)` — accepted invites are silently skipped,
   * so a caller passing an accepted invite's id gets no error (it just
   * doesn't get deleted). The view returns 200 with an `HX-Redirect`
   * header to the worker list; 400 if the list is empty.
   */
  deleteUnacceptedFlwInvites: ConnectClient['deleteUnacceptedFlwInvites'] = async (args) => {
    if (args.user_invite_ids.length === 0) {
      return { requested: 0 };
    }
    const path = `/a/${args.organization_slug}/opportunity/${args.opportunity_id}/delete_invites/`;
    const body = args.user_invite_ids
      .map((id) => `user_invite_ids=${encodeURIComponent(String(id))}`)
      .join('&');
    const res = await this.request.post(path, {
      data: body,
      maxRedirects: 0,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${this.opts.baseUrl}${path}`,
      },
    });
    if (res.status() === 200 || res.status() === 302) {
      return { requested: args.user_invite_ids.length };
    }
    throw await httpErrorFor(res, path, 'POST');
  };
}
