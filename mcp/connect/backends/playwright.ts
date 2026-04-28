import type { APIRequestContext, APIResponse } from 'playwright';
import type { ConnectClient } from '../client.js';
import type { Program, Opportunity, Invite, Invoice, DeliveryType } from '../types.js';
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
 * For mutations: GET the form page → extract CSRF → POST → on 302 we either
 * follow the Location to the list page and look up the new record by name,
 * or extract the UUID from the Location directly. Connect's program-init
 * redirects to the list (not the detail page), so create-then-find-by-name
 * is the canonical pattern. Empirically observed via scripts/_probe-create.ts.
 *
 * For reads: GET the list/detail page → parse with helpers from html-scrape.ts.
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
    const html = await res.text();
    let programs = parseProgramsList(html).map((p) => ({ ...p, organization_slug }));
    if (name) programs = programs.filter((p) => p.name === name);
    return { programs };
  };

  getProgram: ConnectClient['getProgram'] = async ({ organization_slug, program_id }) => {
    // Connect doesn't expose a "program detail" page distinct from the list.
    // Hydrate by fetching the list then matching by id.
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
      // Connect redirects to the list page, not the detail page.
      // Re-list to find the new program by name.
      const list = await this.listPrograms({ organization_slug: args.organization_slug, name: args.name });
      const created = list.programs[0];
      if (!created) {
        throw new HttpError(500, formPath, `program create succeeded (302) but new "${args.name}" not found in list`);
      }
      return { ...created, ...args };
    }
    if (postRes.status() === 200) {
      // Form re-rendered with errors
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
    const html = await res.text();
    const stubs = parseOpportunitiesList(html);
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
    const list = await this.listOpportunities({ organization_slug });
    const found = list.opportunities.find((o) => o.id === opportunity_id);
    if (!found) {
      throw new HttpError(404, `/a/${organization_slug}/opportunity/${opportunity_id}/`, 'opportunity not found in list');
    }
    return found;
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

  updateOpportunity: ConnectClient['updateOpportunity'] = async (args) => {
    const editPath = `/a/${args.organization_slug}/opportunity/${args.opportunity_id}/edit/`;
    const editRes = await this.opts.request.get(editPath);
    if (editRes.status() !== 200) throw await httpErrorFor(editRes, editPath);
    const csrf = extractFormCsrfToken(await editRes.text()) ?? this.opts.csrfToken;
    const current = await this.getOpportunity({ organization_slug: args.organization_slug, opportunity_id: args.opportunity_id });

    const postRes = await this.opts.request.post(editPath, {
      form: {
        csrfmiddlewaretoken: csrf,
        name: args.name ?? current.name,
        short_description: args.short_description ?? current.short_description,
        description: args.description ?? current.description,
      },
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}/a/${args.organization_slug}/opportunity/`,
        'X-CSRFToken': csrf,
      },
    });

    if (postRes.status() === 302) {
      return await this.getOpportunity({ organization_slug: args.organization_slug, opportunity_id: args.opportunity_id });
    }
    if (postRes.status() === 200) {
      const errs = parseFormErrors(await postRes.text());
      throw new ConnectValidationError(errs.length ? errs : ['opportunity edit rejected; no errorlist found']);
    }
    throw await httpErrorFor(postRes, editPath);
  };

  // ── Lifecycle ────────────────────────────────────────────────────

  activateOpportunity: ConnectClient['activateOpportunity'] = async ({ organization_slug, opportunity_id }) => {
    const activatePath = `/a/${organization_slug}/opportunity/${opportunity_id}/activate/`;
    const postRes = await this.opts.request.post(activatePath, {
      form: { csrfmiddlewaretoken: this.opts.csrfToken },
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}/a/${organization_slug}/opportunity/${opportunity_id}/`,
        'X-CSRFToken': this.opts.csrfToken,
      },
    });
    if (postRes.status() === 302 || postRes.status() === 200) {
      return { ok: true, status: 'active' as const };
    }
    throw await httpErrorFor(postRes, activatePath);
  };

  // ── Invites ──────────────────────────────────────────────────────
  // NB: Connect's invite UI is on the *program* page (/a/<org>/program/<uuid>/invite),
  // and the form takes an `organization` slug — not a free-form email. Until the
  // Connect data model evolves, treat `opportunity_id` here as a Connect program id.

  sendLloInvite: ConnectClient['sendLloInvite'] = async (args) => {
    const invitePath = `/a/${args.organization_slug}/program/${args.opportunity_id}/invite`;
    const formPath = `/a/${args.organization_slug}/program/`;
    // Need a CSRF + the form is rendered inline; refresh from the list page.
    const listRes = await this.opts.request.get(formPath);
    if (listRes.status() !== 200) throw await httpErrorFor(listRes, formPath);
    const csrf = extractFormCsrfToken(await listRes.text()) ?? this.opts.csrfToken;

    // Connect expects `organization` (slug) — for our purposes, contact_email
    // can't be used directly. Caller must pass the org slug as organization_name.
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
        id: 'pending',  // Connect doesn't return an invite UUID directly; would need a follow-up GET
        opportunity_id: args.opportunity_id,
        organization_name: args.organization_name,
        contact_email: args.contact_email,
        status: 'pending' as const,
      };
    }
    throw await httpErrorFor(postRes, invitePath);
  };

  listInvites: ConnectClient['listInvites'] = async ({ organization_slug, opportunity_id }) => {
    // Tries the program-level invite-table endpoint; if the schema differs, the
    // parser returns []. Real shape will be confirmed when we ship the live test.
    const path = `/a/${organization_slug}/program/${opportunity_id}/`;
    const res = await this.opts.request.get(path);
    if (res.status() !== 200) {
      // Fall back to the program list page (where invites are inlined per program)
      const listRes = await this.opts.request.get(`/a/${organization_slug}/program/`);
      if (listRes.status() !== 200) throw await httpErrorFor(listRes, path);
      return { invites: parseInvitesList(await listRes.text(), opportunity_id) };
    }
    return { invites: parseInvitesList(await res.text(), opportunity_id) };
  };

  // ── Invoices ─────────────────────────────────────────────────────
  // Connect's invoice UI hasn't been mapped yet; these atoms stub a 404 until
  // probed. Skill consumers expecting invoice data should fall back to HITL
  // until probe-connect-invoice.ts confirms the schema.

  listInvoices: ConnectClient['listInvoices'] = async ({ organization_slug, opportunity_id }) => {
    const path = `/a/${organization_slug}/opportunity/${opportunity_id}/invoices/`;
    const res = await this.opts.request.get(path);
    if (res.status() !== 200) {
      // Empty rather than throwing — invoices may simply not exist for this opp yet
      return { invoices: [] };
    }
    // TODO: scrape invoice rows when the page shape is known. For now return []
    // so callers don't crash.
    return { invoices: [] };
  };

  getInvoice: ConnectClient['getInvoice'] = async ({ organization_slug, invoice_id }) => {
    const path = `/a/${organization_slug}/invoice/${invoice_id}/`;
    const res = await this.opts.request.get(path);
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    // TODO: parse invoice detail page. For now return a minimal stub keyed by id.
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
