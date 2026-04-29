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

async function httpErrorFor(res: APIResponse, urlPath: string, method: string = 'GET'): Promise<HttpError> {
  let body = '';
  try { body = await res.text(); } catch { /* swallow */ }
  return new HttpError(res.status(), `${method} ${urlPath}`, body);
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
 * Resolve a caller-friendly hq_server label ("prod" / "india" / "eu" or a
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
  for (const o of opts) {
    if (!o.value || o.value === '' || o.value === 'None') continue;
    // direct int match
    if (o.value === label) return o.value;
    // URL appears in option text
    if (o.text.toLowerCase().includes(lc)) return o.value;
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
    // Hydrate from the edit form. The list page only renders name and
    // description (parseProgramsList zeroes the rest) so going through
    // listPrograms returns a shell — same pattern as getOpportunity.
    const editPath = `/a/${organization_slug}/program/${program_id}/edit`;
    const editRes = await this.opts.request.get(editPath);
    if (editRes.status() === 404) {
      throw new HttpError(404, editPath, 'program not found');
    }
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
    throw await httpErrorFor(postRes, formPath, 'POST');
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

  /**
   * Register an HQ API key with Connect (if not already registered) and
   * return its Connect-side int FK as string. Idempotent: if the key is
   * already registered for this hq_server, just looks up and returns the
   * existing id.
   *
   * Background: Connect's create-opportunity form takes `api_key` as an
   * int FK to a Connect-internal `HQApiKey` record, NOT the raw 40-char
   * HQ API key. The user has to register the key first via the Connect
   * UI's "+" / "Add API Key" modal. We do that for the agent here.
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
    let listRes = await this.opts.request.get(listPath, { headers: { 'HX-Request': 'true' } });
    if (listRes.status() === 200) {
      const opts = parseSelectOptions(await listRes.text());
      const found = opts.find((o) => o.text === truncated && /^\d+$/.test(o.value));
      if (found) return found.value;
    }

    // Not registered — POST /add_api_key/. Connect's HTMX endpoint returns
    // 200 with a re-rendered form fragment regardless of new vs duplicate.
    const addPath = `/a/${args.organization_slug}/opportunity/add_api_key/`;
    const addRes = await this.opts.request.post(addPath, {
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
    listRes = await this.opts.request.get(listPath, { headers: { 'HX-Request': 'true' } });
    if (listRes.status() !== 200) throw await httpErrorFor(listRes, listPath, 'GET');
    const opts = parseSelectOptions(await listRes.text());
    const found = opts.find((o) => o.text === truncated && /^\d+$/.test(o.value));
    if (!found) {
      throw new HttpError(500, addPath, `add_api_key returned 200 but ${truncated} did not appear in /users/api_keys/?hq_server=${args.hq_server_id}`);
    }
    return found.value;
  }

  /**
   * Resolve a bare HQ app id (e.g. `76fd5f0e2834454bb946bdf9ae9bff71`) to the
   * JSON-encoded form value Connect's create-opportunity form expects:
   *   `{"id": "<id>", "name": "<full app name>"}`
   *
   * Connect populates the learn_app/deliver_app dropdowns via an HTMX GET
   * to /hq/applications/?hq_server=<id>&<field>=<domain>&api_key=<id>. The
   * `value` attribute of each <option> is the full JSON string the form
   * expects. We GET that fragment, parse the options, and find the one
   * whose JSON `id` matches the caller's app id.
   */
  private async resolveHqAppValue(args: {
    organization_slug: string;
    hq_server_id: string;
    domain: string;
    api_key_id: string;
    app_id: string;
    domainField: 'learn_app_domain' | 'deliver_app_domain';
  }): Promise<string> {
    const path = `/hq/applications/?hq_server=${encodeURIComponent(args.hq_server_id)}&${args.domainField}=${encodeURIComponent(args.domain)}&api_key=${encodeURIComponent(args.api_key_id)}`;
    const res = await this.opts.request.get(path, { headers: { 'HX-Request': 'true' } });
    if (res.status() !== 200) throw await httpErrorFor(res, path, 'GET');
    const opts = parseSelectOptions(await res.text());
    const real: Array<{ value: string; text: string; id: string }> = [];
    for (const o of opts) {
      if (!o.value || o.value === 'None' || o.value === '') continue;
      try {
        const decoded = htmlDecodeAttr(o.value);
        const parsed = JSON.parse(decoded);
        if (parsed?.id) real.push({ value: decoded, text: o.text, id: parsed.id });
      } catch { /* not JSON, skip */ }
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

  createOpportunity: ConnectClient['createOpportunity'] = async (args) => {
    const formPath = `/a/${args.organization_slug}/opportunity/init/`;
    const formRes = await this.opts.request.get(formPath);
    if (formRes.status() !== 200) throw await httpErrorFor(formRes, formPath, 'GET');
    const formHtml = await formRes.text();
    const csrf = extractFormCsrfToken(formHtml) ?? this.opts.csrfToken;

    // 1. Resolve hq_server label → int FK by parsing the form's options.
    const hqServerId = resolveHqServer(formHtml, args.hq_server);
    if (!hqServerId) {
      throw new ConnectValidationError([
        `hq_server '${args.hq_server}' did not match any Connect-known server. Use 'prod', 'india', 'eu', a server URL, or the int FK directly.`,
      ]);
    }

    // 2. Register the raw HQ API key with Connect (idempotent) → int FK.
    const apiKeyId = await this.ensureHqApiKeyRegistered({
      organization_slug: args.organization_slug,
      hq_server_id: hqServerId,
      api_key: args.api_key,
      csrf,
    });

    // 3. Resolve learn/deliver app ids → JSON-encoded form values.
    const learnAppValue = await this.resolveHqAppValue({
      organization_slug: args.organization_slug,
      hq_server_id: hqServerId,
      domain: args.learn_app_domain,
      api_key_id: apiKeyId,
      app_id: args.learn_app,
      domainField: 'learn_app_domain',
    });
    const deliverAppValue = await this.resolveHqAppValue({
      organization_slug: args.organization_slug,
      hq_server_id: hqServerId,
      domain: args.deliver_app_domain,
      api_key_id: apiKeyId,
      app_id: args.deliver_app,
      domainField: 'deliver_app_domain',
    });

    // 4. Refetch CSRF — Django one-shot tokens may have rotated after
    //    the add_api_key POST.
    const formRes2 = await this.opts.request.get(formPath);
    if (formRes2.status() !== 200) throw await httpErrorFor(formRes2, formPath, 'GET');
    const csrf2 = extractFormCsrfToken(await formRes2.text()) ?? this.opts.csrfToken;

    const formData: Record<string, string> = {
      csrfmiddlewaretoken: csrf2,
      name: args.name,
      short_description: args.short_description,
      description: args.description,
      currency: args.currency,
      country: args.country,
      hq_server: hqServerId,
      api_key: apiKeyId,
      learn_app_domain: args.learn_app_domain,
      learn_app: learnAppValue,
      learn_app_passing_score: String(args.learn_app_passing_score),
      learn_app_description: args.learn_app_description ?? '',
      deliver_app_domain: args.deliver_app_domain,
      deliver_app: deliverAppValue,
    };
    if (args.program_id) formData['program'] = args.program_id;

    const postRes = await this.opts.request.post(formPath, {
      form: formData,
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}/a/${args.organization_slug}/opportunity/`,
        'X-CSRFToken': csrf2,
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
        throw new HttpError(500, `POST ${formPath}`, `opportunity create succeeded (302) but "${args.name}" not found in list`);
      }
      return list.opportunities[0];
    }
    if (postRes.status() === 200) {
      const errs = parseFormErrors(await postRes.text());
      throw new ConnectValidationError(errs.length ? errs : ['opportunity create rejected; no errorlist found']);
    }
    throw await httpErrorFor(postRes, formPath, 'POST');
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
    throw await httpErrorFor(postRes, editPath, 'POST');
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
    throw await httpErrorFor(postRes, path, 'POST');
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
    const formHtml = await getRes.text();
    const csrf = extractFormCsrfToken(formHtml) ?? this.opts.csrfToken;

    // The deliver-unit checkboxes use a different id namespace than
    // `connect_list_deliver_units` returns. The list returns a small
    // per-opp display id (1, 2, 3...); the form-checkbox `value` is the
    // global Connect-side DB primary key (e.g. 5112). Connect's view
    // reads the PK form-value, NOT the display id. If we POST the
    // display id directly, Connect 302-redirects with a Django messages
    // cookie of "Invalid Data" — silently dropping the create.
    //
    // Mitigation: parse this form's `<input name="required_deliver_units"
    // value="5112">Vendor visit</label>` checkboxes and map our caller's
    // display ids → form values by matching against the deliver-unit
    // table list (same opp). We look up name first, then fall back to
    // numeric position if the names diverge.
    const checkboxValueByName = new Map<string, string>();
    for (const m of formHtml.matchAll(
      /<input[^>]*name="(?:required|optional)_deliver_units"[^>]*value="(\d+)"[^>]*>\s*([^<]+)/g,
    )) {
      const value = m[1];
      const label = m[2].trim();
      if (!checkboxValueByName.has(label)) checkboxValueByName.set(label, value);
    }
    const list = await this.listDeliverUnits({
      organization_slug: args.organization_slug,
      opportunity_id: args.opportunity_id,
    });
    const idToFormValue = new Map<number, string>();
    for (const du of list.deliver_units) {
      const v = checkboxValueByName.get(du.name);
      if (v) idToFormValue.set(du.id, v);
    }
    const mapId = (id: number): string => {
      const v = idToFormValue.get(id);
      if (v) return v;
      // Caller may have passed a form-value PK directly; if it's a
      // value the form actually exposes, accept it. Otherwise surface
      // a clear error rather than silent-drop on Connect's side.
      const idStr = String(id);
      if ([...checkboxValueByName.values()].includes(idStr)) return idStr;
      throw new ConnectValidationError([
        `deliver_unit_id ${id} did not resolve to any form-value in the create-payment_unit form. ` +
        `Available deliver units (display id → form name → form value): ` +
        `${list.deliver_units
          .map((du) => `${du.id} → "${du.name}" → ${idToFormValue.get(du.id) ?? '?'}`)
          .join('; ')}`,
      ]);
    };

    const formData = new URLSearchParams();
    formData.append('csrfmiddlewaretoken', csrf);
    formData.append('name', args.name);
    formData.append('description', args.description);
    formData.append('amount', String(args.amount));
    if (args.max_total != null) formData.append('max_total', String(args.max_total));
    if (args.max_daily != null) formData.append('max_daily', String(args.max_daily));
    if (args.start_date) formData.append('start_date', args.start_date);
    if (args.end_date) formData.append('end_date', args.end_date);
    for (const id of args.required_deliver_unit_ids) formData.append('required_deliver_units', mapId(id));
    for (const id of args.optional_deliver_unit_ids ?? []) formData.append('optional_deliver_units', mapId(id));

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
    throw await httpErrorFor(postRes, formPath, 'POST');
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
    throw await httpErrorFor(postRes, invitePath, 'POST');
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
