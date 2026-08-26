import type { APIRequestContext, APIResponse } from 'playwright';
import type { ConnectClient } from '../client.js';
import type {
  ListingCompleteness,
  Opportunity,
  PaymentUnit,
  Program,
  ProgramApplication,
  VerificationFlags,
} from '../types.js';
import { HttpError, ConnectValidationError, ConnectError, UnsupportedVerificationFlagError } from '../errors.js';
import { assertFundsAtLeastOneUser } from '../opportunity-capacity.js';
import type { PlaywrightSession } from '../auth/playwright-session.js';
import { parseOrgMemberTable, type OrgMemberRow } from '../../../lib/connect-member-table.js';
import { parseWorkersTable, findInviteByPhone } from '../../../lib/connect-flw-invites.js';
import { toConnectQuestionPath } from '../../../lib/connect-question-path.js';
import {
  decodeHtmlEntities,
  extractFormCsrfToken,
  extractFormFieldValues,
  isCheckboxChecked,
  parseOpportunityDashboard,
  classifyDashboardRead,
  extractDisabledFormFieldNames,
  scopeToFormContaining,
  extractUuidFromPath,
  parseDeliveryTypeOptions,
  parseProgramsList,
  parseOpportunitiesList,
  parseTablePagination,
  parseInvitesList,
  parseFormErrors,
  parseFormErrorsByField,
  parseDeliverUnitTable,
  parseDeliverUnitFormCheckboxes,
  parsePaymentUnitTable,
  parseWorkerLearnTable,
  parseWorkerDeliverTable,
} from './html-scrape.js';

/**
 * Page size requested when walking Connect's paginated opportunity list.
 *
 * Upstream honours ONLY `PAGE_SIZE_OPTIONS = [20, 30, 50, 100]`
 * (`commcare_connect/utils/tables.py`); `get_validated_page_size` silently
 * falls back to `DEFAULT_PAGE_SIZE = 20` for any other value, so this must
 * stay one of those four. 100 is the largest, minimising round-trips.
 */
const OPPORTUNITY_LIST_PAGE_SIZE = 100;

/**
 * Hard stop on the page walk so a server that ignores `page` can never spin
 * forever. At 100 rows/page this covers 5,000 opportunities in one org —
 * far beyond any real ACE org — and the loop normally exits much earlier on
 * a short page.
 */
const OPPORTUNITY_LIST_MAX_PAGES = 50;

/** Upstream `DEFAULT_PAGE_SIZE` — the smallest page a NON-final page can be. */
const CONNECT_DEFAULT_PAGE_SIZE = 20;

/**
 * django-tables2 `prefixed_page_field` with the default empty table prefix.
 * Only a fallback: the real name is read off the rendered footer, because a
 * table with a prefix ignores a bare `?page=` entirely.
 */
const OPPORTUNITY_LIST_DEFAULT_PAGE_FIELD = 'page';

/**
 * Max hydrate fetches in flight at once.
 *
 * Hydration is 2 GETs per row, and it used to be bounded by accident: the
 * listing stopped at 20 rows, so `Promise.all` fanned out ~40 requests. Now
 * that the walk is exhaustive, an org like `ai-demo-space` (114 opportunities
 * at ace#938 time) would fan out ~230 in one burst against a single Playwright
 * request context. Correct-and-exhaustive must not mean unbounded.
 */
const OPPORTUNITY_HYDRATE_CONCURRENCY = 8;

/**
 * `Promise.all`-shaped map with a fixed concurrency ceiling. Results keep the
 * input order; the first rejection propagates, as with `Promise.all`.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

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
/**
 * The one page that renders `learn_app_passing_score`.
 *
 * It is the PROGRAM-scoped init-edit form (`OpportunityInitUpdateForm`), NOT
 * the `/a/<org>/opportunity/<id>/edit` form `updateOpportunity` posts and NOT
 * the read-only detail page `getOpportunity` scrapes — neither of those
 * renders the field at all. Shared by the getter and the setter so a URL
 * change cannot leave one reading a page the other does not.
 */
function learnPassingScoreEditPath(
  organizationSlug: string, programId: string, opportunityId: string,
): string {
  return `/a/${organizationSlug}/program/${programId}/opportunity/${opportunityId}/init/edit/`;
}

function parseSelectOptions(html: string): Array<{ value: string; text: string }> {
  const opts: Array<{ value: string; text: string }> = [];
  for (const m of html.matchAll(/<option[^>]*value=["']([^"']*)["'][^>]*>([^<]*)<\/option>/g)) {
    opts.push({ value: m[1], text: m[2].trim() });
  }
  return opts;
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
/**
 * Which requested verification flags have NO backing input on the live
 * `verification_flags_config/` page (dimagi-internal/ace#1013).
 *
 * Pure over the fetched HTML, deliberately: the page IS the authority on what
 * Connect can enforce today, so the guard cannot go stale the way a hardcoded
 * denylist of the five removed fields would — if Connect restores `gps`, this
 * stops firing with no code change.
 *
 * Only TRUTHY requests are checked. `duplicate: false` against a page with no
 * `duplicate` input is a no-op that already matches the caller's intent, so
 * flagging it would be a false positive on callers that pass explicit falses.
 */
export function findUnsupportedVerificationFlags(
  html: string,
  flags: VerificationFlags,
): { flag: string; expected_input: string }[] {
  const has = (re: RegExp) => re.test(html);
  const exact = (name: string) => new RegExp(`name=["']${name}["']`);
  const out: { flag: string; expected_input: string }[] = [];

  const simple: [keyof VerificationFlags, string][] = [
    ['duplicate', 'duplicate'],
    ['gps', 'gps'],
    ['catchment_areas', 'catchment_areas'],
  ];
  for (const [flag, input] of simple) {
    if (flags[flag] && !has(exact(input))) out.push({ flag, expected_input: input });
  }
  // `gps_radius_meters` writes the form's numeric `location` input.
  if (flags.gps_radius_meters != null && !has(exact('location'))) {
    out.push({ flag: 'gps_radius_meters', expected_input: 'location' });
  }
  // Time-window fields (these DO still exist — the probe is general, so it
  // would catch their removal too rather than silently no-op'ing).
  if (flags.form_submission_start && !has(exact('form_submission_start'))) {
    out.push({ flag: 'form_submission_start', expected_input: 'form_submission_start' });
  }
  if (flags.form_submission_end && !has(exact('form_submission_end'))) {
    out.push({ flag: 'form_submission_end', expected_input: 'form_submission_end' });
  }
  for (const c of flags.deliver_unit_checks ?? []) {
    if (c.check_attachments && !has(/name=["'][^"']*check_attachments["']/)) {
      out.push({ flag: 'deliver_unit_checks[].check_attachments', expected_input: 'deliver_unit-<i>-check_attachments' });
      break;
    }
  }
  for (const c of flags.deliver_unit_checks ?? []) {
    if (c.duration_minutes != null && !has(/name=["']deliver_unit-\d+-duration["']/)) {
      out.push({ flag: 'deliver_unit_checks[].duration_minutes', expected_input: 'deliver_unit-<i>-duration' });
      break;
    }
  }
  if (flags.form_field_rules?.length && !has(/name=["']form_json-/)) {
    out.push({ flag: 'form_field_rules', expected_input: 'form_json-<i>-*' });
  }
  return out;
}

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
    if (name) {
      // Case-insensitive SUBSTRING match, applied client-side — the list
      // page has no server-side filter at all. Exact-match here returned a
      // silent [] for a real prefix of a real program name, which callers
      // (connect-program-setup reuse-vs-create) read as "no program
      // exists" and minted duplicates (jjackson/ace#1089).
      const needle = name.trim().toLowerCase();
      programs = programs.filter((p) => p.name.toLowerCase().includes(needle));
      // The list page does not render delivery_type / budget / currency /
      // country / dates. Hydrate the (few) filtered matches via getProgram
      // so reuse decisions see real values instead of nulls.
      programs = await Promise.all(
        programs.map(async (row) => ({
          ...row,
          ...(await this.getProgram({ organization_slug, program_id: row.id })),
        })),
      );
    }
    return { programs };
  };

  getProgram: ConnectClient['getProgram'] = async ({ organization_slug, program_id }) => {
    const editPath = `/a/${organization_slug}/program/${program_id}/edit`;
    const editRes = await this.request.get(editPath);
    if (editRes.status() === 404) throw new HttpError(404, editPath, 'program not found');
    // ace#1461 — deliberately NO viewer-tier fallback here, unlike
    // getOpportunity. There is nowhere to fall back TO: every program route
    // (`init/`, `<pk>/edit`, `<pk>/view`) is guarded by upstream's
    // `ProgramManagerMixin`, which requires org-membership `is_admin` AND
    // `org.program_manager` — stricter than the opportunity edit form's
    // `org_member_required`, and with no read-only detail view anywhere in
    // `program/urls.py`. Program metadata is simply not exposed below that
    // tier, so a fallback parser would have to invent its source. What we can
    // do is stop reporting a bare 403 and name the actual requirement.
    if (editRes.status() === 403) {
      throw new HttpError(
        403,
        editPath,
        `needs ADMIN + program-manager on org "${organization_slug}"; no degraded read ` +
          `exists (ace#1461). Fix: grant admin, or read the opportunities individually. ` +
          `Every program route is behind ProgramManagerMixin — Connect exposes no ` +
          `viewer-tier program page, unlike connect_get_opportunity.`,
      );
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

  /**
   * List an org's opportunities from the list page.
   *
   * ## What this atom can and cannot answer (dimagi-internal/ace#1022)
   *
   * The list page carries an opportunity's id, name and short description —
   * and nothing else. Until #1022 this method papered over that by
   * hardcoding `managed: true, active: false` and silently DROPPING the
   * `program_id` filter it accepts, so:
   *
   * - `connect-program-setup § Step 4a` (program-budget headroom, ace#588)
   *   needs `Σ(total_budget)` over a PROGRAM's opps. The filter was ignored
   *   AND `total_budget` was never returned, so the headroom check silently
   *   no-opped and surfaced later as an un-actionable "Budget exceeds the
   *   program budget" rejection — precisely the failure #588 was filed to
   *   prevent. Both inputs now exist on the HYDRATED row only:
   *   `getOpportunity` reads `total_budget` and `program_name` off the
   *   opportunity dashboard (ace#1550). The list page still carries neither,
   *   so `hydrate: true` is not optional for that sum.
   * - `connect-opp-setup § Step 4` (single-active-opp invariant, #106
   *   finding 11) warns "for each opp where `active=true`". With `active`
   *   hardcoded `false` that WARN could NEVER fire, so the silent
   *   deactivation it was written to catch was undetectable by it.
   *
   * Live on spark-facilitator/20260728-1338: called with a program created
   * seconds earlier holding ZERO opportunities, it returned 20 belonging to
   * other programs, every one `managed: true, active: false`.
   *
   * So now: `program_id` is REFUSED loudly (a wrong result set is worse than
   * an error), and fields the page does not carry are left `undefined`
   * rather than fabricated. Pass `hydrate: true` to fetch each opp through
   * `getOpportunity`, which parses the real `active` toggle off the edit
   * form — the same hydrate-the-filtered-rows pattern `listPrograms` uses.
   */
  listOpportunities: ConnectClient['listOpportunities'] = async ({
    organization_slug,
    name,
    program_id,
    hydrate,
  }) => {
    if (program_id) {
      throw new Error(
        `unsupported_filter: the opportunity list page carries no program column, so ` +
          `program_id cannot be filtered here and silently ignoring it returns the whole org ` +
          `(dimagi-internal/ace#1022). Either hydrate and filter yourself — ` +
          `listOpportunities({organization_slug, hydrate: true}) then get_opportunity per row — ` +
          `or read the opportunities off the program page.`,
      );
    }
    // WALK EVERY PAGE (dimagi-internal/ace#1590). Connect's `OpportunityList`
    // is a paginated `SingleTableView` whose page size is
    // `get_validated_page_size(request)` — `DEFAULT_PAGE_SIZE = 20`, and only
    // `PAGE_SIZE_OPTIONS = [20, 30, 50, 100]` are honoured (anything else
    // silently falls back to 20). A single unparameterised GET therefore
    // returns the 20 most-recent opportunities with NO signal that more exist,
    // and the caller cannot tell a complete org listing from page 1 of N.
    //
    // That silence is load-bearing: `connect-program-setup § Step 4a` sums
    // `total_budget` over a program's opps to size the budget headroom, and it
    // treats a truncated page as a fully-known Σ — too small, so the raise
    // never fires and the next create rejects with "Budget exceeds the program
    // budget", the exact failure the step exists to prevent. The `name` filter
    // below is applied CLIENT-SIDE too, so it returned zero for an opportunity
    // that existed on page 2+.
    const stubs: ReturnType<typeof parseOpportunitiesList> = [];
    const seenIds = new Set<string>();
    let pageField = OPPORTUNITY_LIST_DEFAULT_PAGE_FIELD;
    let declaredPages: number | undefined;
    let pagesFetched = 0;
    let pageSizeHonored = false;
    let truncatedReason: string | undefined;
    for (let page = 1; page <= OPPORTUNITY_LIST_MAX_PAGES; page++) {
      const path =
        `/a/${organization_slug}/opportunity/` +
        `?page_size=${OPPORTUNITY_LIST_PAGE_SIZE}&${pageField}=${page}`;
      const res = await this.request.get(path);
      // An out-of-range page is NOT an error on this surface: django-tables2
      // configures the table with `RequestConfig(..., silent=True)`, which maps
      // `EmptyPage` to `paginator.page(paginator.num_pages)` -- the LAST page,
      // HTTP 200 (`django_tables2/config.py`). The stop conditions below are
      // what actually terminate the walk. This branch stays as a defensive
      // floor for a surface that behaves differently; on page 1 a non-200 is a
      // real error and must still surface.
      if (res.status() !== 200) {
        if (page === 1) throw await httpErrorFor(res, path);
        break;
      }
      const html = await res.text();
      pagesFetched++;
      if (page === 1) {
        // The footer carries BOTH the paginator page count and the name of the
        // page parameter (`table.prefixed_page_field`), so neither is guessed.
        const pagination = parseTablePagination(html);
        pageField = pagination.page_field ?? pageField;
        declaredPages = pagination.num_pages;
      }
      const pageStubs = parseOpportunitiesList(html);
      if (page === 1) {
        // Did the server actually honour `page_size`? Only conclude "short
        // page means last page" against the size it really used. A response
        // pinned at DEFAULT_PAGE_SIZE would otherwise look short on page 1 and
        // stop the walk at 20 rows -- the exact shape ace#1590 reported live.
        pageSizeHonored = pageStubs.length > CONNECT_DEFAULT_PAGE_SIZE;
      }
      const fresh = pageStubs.filter((s) => !seenIds.has(s.id));
      for (const s of fresh) seenIds.add(s.id);
      stubs.push(...fresh);
      // Stop where the paginator says it ends; failing that, on a short page
      // (the last one) or when a page adds nothing new -- the latter also makes
      // this terminate against a server that ignores the page parameter and
      // re-serves the same rows.
      const shortPageAt = pageSizeHonored ? OPPORTUNITY_LIST_PAGE_SIZE : CONNECT_DEFAULT_PAGE_SIZE;
      if (declaredPages !== undefined) {
        if (page >= declaredPages) break;
      } else if (pageStubs.length < shortPageAt || fresh.length === 0) {
        break;
      }
      if (page === OPPORTUNITY_LIST_MAX_PAGES) {
        truncatedReason =
          `walked ${OPPORTUNITY_LIST_MAX_PAGES} pages of ${OPPORTUNITY_LIST_PAGE_SIZE} without ` +
          `reaching the end of /a/${organization_slug}/opportunity/` +
          (declaredPages !== undefined ? ` (page declares ${declaredPages} pages)` : '');
      }
    }
    // Say whether the walk actually finished. Without this a caller cannot
    // distinguish a complete listing from a capped one, which is the half of
    // ace#1590 that makes a silently-wrong Sigma possible in the first place.
    const listing: ListingCompleteness = {
      complete: truncatedReason === undefined,
      total_count: stubs.length,
      pages_fetched: pagesFetched,
      page_size: OPPORTUNITY_LIST_PAGE_SIZE,
      ...(declaredPages !== undefined ? { declared_pages: declaredPages } : {}),
      ...(truncatedReason !== undefined ? { truncated_reason: truncatedReason } : {}),
    };
    // `managed`, `active` and `total_budget` are deliberately ABSENT: the
    // list page does not carry them, and a fabricated value is worse than a
    // missing one because a caller cannot tell it apart from a real one.
    let opportunities = stubs.map((s) => ({
      id: s.id,
      name: s.name,
      short_description: s.short_description,
      description: '',
      organization_slug,
    })) as unknown as Opportunity[];
    if (name) opportunities = opportunities.filter((o) => o.name === name);
    if (hydrate) {
      opportunities = await mapWithConcurrency(
        opportunities,
        OPPORTUNITY_HYDRATE_CONCURRENCY,
        async (o) => ({
          ...o,
          ...(await this.getOpportunity({ organization_slug, opportunity_id: o.id })),
        }),
      );
    }
    return { opportunities, listing };
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

    // ace#1461 — a pure READ must not require write tier. Upstream guards the
    // edit form with `org_member_required` and its decorator raises Http404
    // (not 403), so a VIEWER-tier account that can open the opportunity in a
    // browser used to get `404 .../edit` for the whole call. The detail page
    // is `org_viewer_required` and carries most of the same fields, so on an
    // edit-page permission failure we degrade to it instead of throwing.
    //
    // Only 403/404 degrade. A 500 or a redirect-to-login is NOT a permission
    // answer and must still surface — silently returning a thin object for a
    // broken session would be worse than the original bug.
    const editDenied = editRes.status() === 403 || editRes.status() === 404;
    if (editRes.status() !== 200 && !editDenied) throw await httpErrorFor(editRes, editPath);

    const detailHtmlText = detailRes.status() === 200 ? await detailRes.text() : '';

    if (editDenied && !detailHtmlText) {
      // Neither surface is readable — that is a real failure, not a degrade.
      throw await httpErrorFor(editRes, editPath);
    }

    const editFormHtml = editDenied ? '' : await editRes.text();
    const v = editDenied ? {} : extractFormFieldValues(editFormHtml);
    // Parse the dashboard WHENEVER it is readable, not only on the viewer-tier
    // degrade (ace#1550): it is the only read surface that carries
    // `total_budget`, `start_date` and the opportunity's program. `dash` keeps
    // its old meaning — the degrade-path merge, empty when the edit form won —
    // so edit-form precedence is untouched.
    const detail = detailHtmlText ? parseOpportunityDashboard(detailHtmlText) : {};
    // ace#1637 - say whether the dashboard half ANSWERED, so a caller stops
    // inferring "not in a program / no budget" from "could not read the
    // page". 16 of 81 hydrated ai-demo-space rows came back with the
    // list-page key set only; Step 4a read that as absent and inflated a
    // live LLO-facing program ceiling by EXPECTED_OPP_BUDGET x 10 every run.
    const dashboardRead = classifyDashboardRead(detailHtmlText);
    const dash = editDenied ? detail : {};

    // The edit form's `active` checkbox is authoritative when we have it; the
    // dashboard's is derived from a three-way badge and is lossy on Inactive
    // (see parseOpportunityDashboard). Prefer the form, fall back to the badge.
    const isActive = editDenied
      ? (dash.active ?? false)
      : isCheckboxChecked(v, editFormHtml, 'active');

    let learnAppDomain = '';
    let learnAppId = '';
    let deliverAppDomain = '';
    let deliverAppId = '';
    if (detailHtmlText) {
      const detailHtml = detailHtmlText;
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
      name: v['name'] ?? dash.name ?? '',
      // NOT on the dashboard — stays empty on the degraded path rather than
      // being inferred from `description`.
      short_description: v['short_description'] ?? '',
      description: v['description'] ?? dash.description ?? '',
      organization_slug,
      managed: true,
      active: isActive,
      currency: v['currency'] ?? dash.currency ?? '',
      // NOT on the dashboard either.
      country: v['country'] ?? '',
      end_date: v['end_date'] ?? dash.end_date ?? '',
      // ace#1448. Field names verified LIVE against the real edit form on
      // 2026-08-15 (ai-demo-space / 34703fdb-…), which carries exactly:
      //   active, country, csrfmiddlewaretoken, currency, delivery_level,
      //   delivery_type, description, enable_credentials, end_date, is_test,
      //   learn_level, name, short_description, submit, users
      // `total_budget` and `start_date` are on NEITHER this form nor the
      // program init/edit form (which carries learn_app_passing_score, not
      // passing_score) — see the three dashboard-sourced fields below for
      // where they DO come from (ace#1550).
      is_test: editDenied ? (dash.is_test ?? false) : isCheckboxChecked(v, editFormHtml, 'is_test'),
      // ace#1550 — the three fields the EDIT form cannot answer, read off the
      // DASHBOARD this method already fetches for the app-wire ids. Upstream
      // source, not a live capture: `OpportunityDashboard.get_context_data`
      // renders the "Max Budget" infocard as
      // f"{object.currency_code} {intcomma(object.total_budget)}" and a
      // "Start Date" card (commcare_connect/opportunity/views.py), and
      // templates/opportunity/dashboard.html renders the program as
      // <h3 class="… text-brand-sky …">{{ object.program.name }}</h3>.
      //
      // `total_budget` is the field Connect's own program-budget validation
      // sums —
      //   Opportunity.objects.filter(program=program).aggregate(Sum("total_budget"))
      // in program/api/serializers.py, the check that raises "Budget exceeds
      // the program budget" — so this is the exact input
      // connect-program-setup § Step 4a needs, and until now had no way to get.
      //
      // Each degrades to `undefined` when its card is absent. UNDEFINED MEANS
      // UNKNOWN, NEVER ZERO: a caller summing budgets must treat a missing
      // value as an unknown Σ, because a partial sum silently understates the
      // ceiling in exactly the direction that lets a create fail later.
      total_budget:
        detail.total_budget != null && Number.isFinite(Number(detail.total_budget))
          ? Number(detail.total_budget)
          : undefined,
      start_date: detail.start_date,
      // A program NAME, not the program UUID — no opportunity read surface
      // carries the id (`program_id` stays undefined here, and the list page
      // has no program column at all, which is why `list_opportunities`
      // REFUSES a program_id filter — ace#1022). A caller scoping a sum to one
      // program matches on this name and must treat a name that is not unique
      // in the org as unknown rather than guessing.
      program_name: detail.program_name,
      dashboard_read: dashboardRead,
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
    const wantActive = overrides.active ?? isCheckboxChecked(current, editHtml, 'active');
    const wantTest = overrides.is_test ?? isCheckboxChecked(current, editHtml, 'is_test');
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

  /**
   * Set the Learn-app passing score on an existing opportunity.
   *
   * Read-modify-write against the program-scoped INIT form. It is the FULL
   * init form, not a partial: posting only `learn_app_passing_score` fails
   * validation on every other required field, so the whole rendered body has
   * to go back with exactly one value changed.
   *
   * Three server behaviours this has to respect, all read out of
   * `commcare_connect/opportunity/forms.py` rather than guessed:
   *
   *  1. `OpportunityInitUpdateForm` is where the field lives — NOT the
   *     `/opportunity/<id>/edit` form `updateOpportunity` posts.
   *  2. Once workers have joined, six app fields are Django-`disabled` AND
   *     `clean()` errors if any of them appears in the payload. We drop every
   *     field the server rendered `disabled` (see
   *     `extractDisabledFormFieldNames`) instead of hardcoding that list.
   *  3. `save()` → `_build_commcare_app(update_existing=True)` assigns
   *     `app.passing_score` and saves with an explicit `update_fields`, so the
   *     write persists. On the CREATE path `update_existing` is `false` and
   *     `get_or_create`'s `defaults` are ignored for an existing row — which
   *     is exactly why a repair path is needed at all.
   *
   * `CommCareApp` is keyed `(cc_app_id, cc_domain, organization, hq_server)`,
   * NOT by opportunity — so this score is shared by every opportunity in the
   * org wired to the same HQ Learn app. Callers changing it on a reused app
   * are changing it for all of them; the returned `previous_passing_score`
   * makes that visible rather than silent.
   */
  setLearnPassingScore: ConnectClient['setLearnPassingScore'] = async ({
    organization_slug, program_id, opportunity_id, passing_score,
  }) => {
    const editPath = learnPassingScoreEditPath(
      organization_slug, program_id, opportunity_id,
    );

    const getRes = await this.request.get(editPath);
    if (getRes.status() !== 200) throw await httpErrorFor(getRes, editPath);
    // Scope to the form that OWNS the score before reading anything off it.
    // The page also renders an htmx api-key sub-form carrying a duplicate,
    // unselected `hq_server`, and the whole-document read is last-wins — so
    // unscoped, `hq_server` resolves to '' and gets POSTed back as empty,
    // which Django rejects as "This field is required" (ace#1449).
    const html = scopeToFormContaining(await getRes.text(), 'learn_app_passing_score');

    const current = extractFormFieldValues(html);
    if (!('learn_app_passing_score' in current)) {
      // Fail loud rather than posting a body the form will silently drop.
      // Connect 302s on unrecognized POST keys (the ace#1013 class), so a
      // missing input must be caught HERE or the call reports success for a
      // write that never happened.
      throw new ConnectValidationError([
        `learn_app_passing_score is not rendered on ${editPath} — the init-edit form shape changed. ` +
        'Re-read commcare_connect/opportunity/forms.py before sending a repair.',
      ]);
    }
    const previousRaw = current['learn_app_passing_score'];
    const previous = previousRaw === '' ? null : Number(previousRaw);

    const csrf = extractFormCsrfToken(html) ?? this.opts.csrfToken;
    const disabled = extractDisabledFormFieldNames(html);

    const form: Record<string, string> = { csrfmiddlewaretoken: csrf };
    for (const [name, value] of Object.entries(current)) {
      if (name === 'csrfmiddlewaretoken') continue;
      if (disabled.has(name)) continue;   // see (2) above
      form[name] = value;
    }
    form['learn_app_passing_score'] = String(passing_score);

    const postRes = await this.request.post(editPath, {
      form,
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}${editPath}`,
        'X-CSRFToken': csrf,
      },
    });
    if (postRes.status() === 200) {
      throw validationErrorFromHtml(await postRes.text(), 'passing_score edit rejected');
    }
    if (postRes.status() !== 302) throw await httpErrorFor(postRes, editPath, 'POST');

    // Verify after write. A 302 only says the form validated; it does not say
    // this field persisted, and `passing_score` is the one value whose being
    // wrong is completely silent downstream — the app still builds, the worker
    // still sees a result screen, only the gate differs.
    const afterRes = await this.request.get(editPath);
    if (afterRes.status() !== 200) throw await httpErrorFor(afterRes, editPath);
    const after = extractFormFieldValues(
      scopeToFormContaining(await afterRes.text(), 'learn_app_passing_score'),
    );
    const verified = Number(after['learn_app_passing_score']);
    if (verified !== passing_score) {
      throw new ConnectValidationError([
        `passing_score read-back mismatch on ${opportunity_id}: sent ${passing_score}, ` +
        `form now renders ${after['learn_app_passing_score'] || '(empty)'}. The opportunity is in an ` +
        'unknown state — inspect it in the Connect UI before relying on the gate.',
      ]);
    }

    return {
      ok: true as const,
      opportunity_id,
      passing_score,
      verified_passing_score: verified,
      previous_passing_score: Number.isNaN(previous as number) ? null : previous,
    };
  };

  /**
   * Read the Learn-app passing score. GET-only — no form is posted.
   *
   * This is the first half of `setLearnPassingScore` lifted into its own
   * capability, and it shares that method's page and field via
   * `learnPassingScoreEditPath` so the two cannot drift on the URL.
   *
   * The write path is the fragile one (it has to re-post the whole init form,
   * respecting Django-`disabled` fields), and it has been observed failing on
   * an unrelated required field — which previously took the READ down with it,
   * because the read only existed inside the write. Separating them means a
   * broken repair path no longer costs the ability to verify the gate.
   */
  getLearnPassingScore: ConnectClient['getLearnPassingScore'] = async ({
    organization_slug, program_id, opportunity_id,
  }) => {
    const sourcePath = learnPassingScoreEditPath(
      organization_slug, program_id, opportunity_id,
    );

    const res = await this.request.get(sourcePath);
    if (res.status() !== 200) throw await httpErrorFor(res, sourcePath);

    // Same form-scoping as the setter — see ace#1449. The score itself is not
    // duplicated across the two forms on this page, but reading it through the
    // identical path is what keeps getter and setter describing one form.
    const fields = extractFormFieldValues(
      scopeToFormContaining(await res.text(), 'learn_app_passing_score'),
    );
    if (!('learn_app_passing_score' in fields)) {
      // Same fail-loud contract as the setter: a missing input means the form
      // shape changed, and returning a default here would report a gate value
      // ACE invented as one Connect stored.
      throw new ConnectValidationError([
        `learn_app_passing_score is not rendered on ${sourcePath} — the init-edit form shape changed. ` +
        'Re-read commcare_connect/opportunity/forms.py before trusting any gate value.',
      ]);
    }

    const rendered = fields['learn_app_passing_score'] ?? '';
    // An empty input is UNSET, which is not 0 — 0 would mean "every worker
    // passes", the opposite of an unconfigured gate. Report null and let the
    // caller decide.
    const parsed = rendered.trim() === '' ? null : Number(rendered);

    return {
      opportunity_id,
      passing_score: parsed !== null && Number.isFinite(parsed) ? parsed : null,
      rendered,
      source_path: sourcePath,
    };
  };

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

    // Refuse BEFORE writing anything (ace#1013). Connect drops unrecognized
    // POST keys and still 302s, so posting a flag whose input no longer exists
    // returned `{ok:true}` for a control that was never set — the shape that
    // let every run from 2026-06-06 to 2026-07-28 claim "verification flags
    // configured" with INITIAL_FORMS: 0 on every opportunity.
    const unsupported = findUnsupportedVerificationFlags(html, flags);
    if (unsupported.length) throw new UnsupportedVerificationFlagError(path, unsupported);

    // `duration_seconds` was a 60x misnomer: the form's help text reads
    // "Minimum time to complete form (minutes)", so a caller converting a
    // 6-minute floor to 360 set a six-hour floor and made the gate unfirable.
    // Reject rather than reinterpret — silently treating 360 as minutes would
    // be a different wrong answer.
    for (const c of flags.deliver_unit_checks ?? []) {
      if (c.duration_seconds != null) {
        throw new ConnectError(
          `deliver_unit_checks[].duration_seconds is not a supported parameter: Connect's ` +
            `field is MINUTES ("Minimum time to complete form (minutes)"), so a ` +
            `seconds-converted value sets a 60x-too-long floor. Pass duration_minutes ` +
            `instead (dimagi-internal/ace#1013).`,
        );
      }
    }

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
            if (c.duration_minutes != null) form[`deliver_unit-${idx}-duration`] = String(c.duration_minutes);
          }
        }
      }
    }

    // `form_json` formset — the per-deliver-unit form-field-value rules
    // ("flag unless <question_path> == <question_value>"). Until 0.13.x this
    // was accepted by the Zod schema, typed in VerificationFlags, and then
    // silently dropped: nothing between here and the POST ever read
    // `flags.form_field_rules`, so the atom returned `{ok:true}` having
    // written nothing (dimagi-internal/ace#1011).
    //
    // This matters more than the other flags: per ace#1013, `duplicate` /
    // `gps` / `catchment_areas` / `location` / `check_attachments` no longer
    // exist on Connect's verification form at all, which leaves `form_json`
    // as the ONLY surviving surface on which a PDD's Evidence-Model Layer A
    // predicate can actually be enforced server-side.
    //
    // Semantics: additive and idempotent. Existing rows (replayed verbatim
    // above) are preserved; each requested rule is appended only when no
    // existing row already carries the same (question_path, question_value,
    // deliver_unit) triple, so re-running Phase 4 on the same opportunity
    // does not accumulate duplicates.
    //
    // Every `question_path` — incoming AND replayed — goes through
    // `toConnectQuestionPath`, because Connect reads this field as a JSONPath
    // into the whole HQ form-JSON doc and an XForm XPath makes its parse raise
    // an uncaught JsonPathParserError, i.e. HTTP 500 on the HQ->Connect
    // forward and a payable visit that never reaches Connect
    // (dimagi-internal/ace#1301 — see lib/connect-question-path.ts for the
    // motech-log evidence and the reproducer). Normalising the REPLAYED rows
    // too is deliberate: it repairs an opportunity a previous run poisoned,
    // rather than faithfully re-posting the value that breaks it.
    if (flags.form_field_rules?.length) {
      const rowIndices = new Set<number>();
      for (const k of Object.keys(current)) {
        const m = k.match(/^form_json-(\d+)-/);
        if (m) rowIndices.add(Number(m[1]));
      }

      type JsonRow = { name: string; question_path: string; question_value: string; deliver_unit: string; id: string };
      const rows: JsonRow[] = [];
      for (const i of [...rowIndices].sort((a, b) => a - b)) {
        const row: JsonRow = {
          name: current[`form_json-${i}-name`] ?? '',
          question_path: toConnectQuestionPath(current[`form_json-${i}-question_path`] ?? ''),
          question_value: current[`form_json-${i}-question_value`] ?? '',
          deliver_unit: current[`form_json-${i}-deliver_unit`] ?? '',
          id: current[`form_json-${i}-id`] ?? '',
        };
        // Skip blank template rows Django renders for the "add another" slot.
        if (row.question_path || row.id) rows.push(row);
      }

      const keyOf = (r: { question_path: string; question_value: string; deliver_unit: string }) =>
        `${r.question_path}\u0000${r.question_value}\u0000${r.deliver_unit}`;
      const seen = new Set(rows.map(keyOf));
      for (const r of flags.form_field_rules) {
        const row: JsonRow = {
          name: r.name,
          question_path: toConnectQuestionPath(r.question_path),
          question_value: r.question_value,
          deliver_unit: String(r.deliver_unit_id),
          id: r.id != null ? String(r.id) : '',
        };
        if (seen.has(keyOf(row))) continue;
        seen.add(keyOf(row));
        rows.push(row);
      }

      // Rewrite the formset from `rows` (the replayed keys are a subset of it).
      for (const k of Object.keys(form)) {
        if (/^form_json-\d+-/.test(k)) delete form[k];
      }
      rows.forEach((row, i) => {
        form[`form_json-${i}-name`] = row.name;
        form[`form_json-${i}-question_path`] = row.question_path;
        form[`form_json-${i}-question_value`] = row.question_value;
        form[`form_json-${i}-deliver_unit`] = row.deliver_unit;
        form[`form_json-${i}-id`] = row.id;
      });
      form['form_json-TOTAL_FORMS'] = String(rows.length);
      form['form_json-INITIAL_FORMS'] = current['form_json-INITIAL_FORMS'] ?? '0';
      if (form['form_json-MIN_NUM_FORMS'] == null) form['form_json-MIN_NUM_FORMS'] = '0';
      if (form['form_json-MAX_NUM_FORMS'] == null) form['form_json-MAX_NUM_FORMS'] = '1000';
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
      // Read-back so callers get evidence, not just an HTTP outcome. A bare
      // `{ok:true}` is what let ace#1011/#1013 persist unnoticed across every
      // ACE run: Phase 4 reported "verification flags configured" while
      // `form_json-INITIAL_FORMS` stayed 0 on every opportunity ever created.
      // INITIAL_FORMS counts rows Django loaded from the DB, so re-reading it
      // after the POST is a direct measure of what was actually persisted.
      let form_field_rules_saved: number | undefined;
      try {
        const afterRes = await this.request.get(path);
        if (afterRes.status() === 200) {
          const after = extractFormFieldValues(await afterRes.text());
          const initial = Number(after['form_json-INITIAL_FORMS']);
          if (Number.isFinite(initial)) form_field_rules_saved = initial;
        }
      } catch {
        // Read-back is diagnostic only — never fail a successful write on it.
      }
      return { ok: true, form_field_rules_saved };
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

  // ── Organization membership ───────────────────────────────────────

  /**
   * Invite a human user to a Connect workspace (organization) by email.
   * Full contract + the two clean_email rules are documented on
   * `ConnectClient.addOrgMember`. Endpoint probed against commcare-connect
   * `organization/views.py::add_members_form` + `forms.py::MembershipForm`
   * (the source of truth — POST `/a/<org>/organization/member`, form
   * fields `email` + `role`).
   *
   * The view is `@api_view(["POST"]) @org_admin_required` and ALWAYS
   * 302-redirects to `?active_tab=members` — including on validation
   * failure, which it does NOT echo. So the POST status can't distinguish
   * success from rejection; we verify by reading back the member table
   * (`org_member_table`, which renders the `user__email` column) and
   * confirming the email landed.
   */
  addOrgMember: ConnectClient['addOrgMember'] = async ({ organization_slug, email, role }) => {
    const wantRole = role ?? 'member';
    const tablePath = `/a/${organization_slug}/organization/member_table?page_size=100`;

    /** Read the member table as structured rows: one per membership. */
    const readMembers = async (): Promise<OrgMemberRow[]> => {
      const res = await this.request.get(tablePath);
      if (res.status() !== 200) throw await httpErrorFor(res, tablePath);
      return parseOrgMemberTable(await res.text());
    };
    const findRow = (rows: OrgMemberRow[]) =>
      rows.find((r) => r.email.toLowerCase() === email.toLowerCase()) ?? null;

    // 0. PRE-read. Connect's MembershipForm.clean_email EXCLUDES users already
    //    in the org, so for an existing member the form never validates and the
    //    POST is a silent no-op — same 302 as success. Without knowing the
    //    before-state we cannot tell "added" from "was already there", and we
    //    would report a role that was never applied. (dimagi-internal/ace#911)
    const before = findRow(await readMembers());
    // 1. GET the org home page — it renders the add-member modal whose
    //    form carries the {% csrf_token %} we need.
    const homePath = `/a/${organization_slug}/organization/`;
    const homeRes = await this.request.get(homePath);
    if (homeRes.status() !== 200) throw await httpErrorFor(homeRes, homePath);
    const csrf = extractFormCsrfToken(await homeRes.text()) ?? this.opts.csrfToken;

    // 2. POST the membership form.
    const postPath = `/a/${organization_slug}/organization/member`;
    const postRes = await this.request.post(postPath, {
      form: { csrfmiddlewaretoken: csrf, email, role: wantRole },
      maxRedirects: 0,
      headers: {
        Referer: `${this.opts.baseUrl}${homePath}`,
        'X-CSRFToken': csrf,
      },
    });
    // 302 (redirect to the members tab) is the normal outcome for BOTH
    // success and validation failure; only a non-redirect/non-200 is a
    // hard transport/permission error (e.g. 403 if the ACE session user
    // isn't an org admin — @org_admin_required).
    if (postRes.status() !== 302 && postRes.status() !== 200) {
      throw await httpErrorFor(postRes, postPath, 'POST');
    }

    // 3. POST-read. `page_size=100` is Connect's max page size
    //    (PAGE_SIZE_OPTIONS = [20,30,50,100]); a fresh membership sorts to
    //    the end of the queryset, so the large page keeps it on the single
    //    page for any realistic workspace (<100 members).
    const after = findRow(await readMembers());

    if (!after) {
      // Absent before AND after → the POST genuinely did nothing. With the
      // pre-read we can now name the ONE remaining cause precisely: the
      // "already a member" branch is excluded by `before` being null.
      throw new ConnectValidationError(
        [
          `Connect did not add '${email}' to workspace '${organization_slug}', and they were not a member beforehand. ` +
            `Connect's MembershipForm.clean_email rejects with a silent 302; since the pre-read confirms they were NOT ` +
            `already a member, the cause is that no Connect account exists for that email yet — the person must sign in ` +
            `at https://connect.dimagi.com/ once before they can be added.`,
        ],
        { email: ['No Connect account exists for this email'] },
      );
    }

    if (before) {
      // They were already a member: clean_email rejected the form, so NOTHING
      // changed — least of all the role. Report the stored role, not the ask.
      const result = {
        organization_slug,
        email,
        role: after.role,
        requested_role: wantRole,
        status: 'already-member' as const,
      };
      if (after.role?.toLowerCase() !== wantRole.toLowerCase()) {
        return {
          ...result,
          role_unchanged: {
            requested: wantRole,
            actual: after.role,
            note:
              `'${email}' was already a member with role '${after.role ?? 'unknown'}'. Connect's add-member form ` +
              `excludes existing members (MembershipForm.clean_email), so the requested role '${wantRole}' was NOT ` +
              `applied and no membership was modified. Change an existing member's role in the Connect UI.`,
          },
        };
      }
      return result;
    }

    return {
      organization_slug,
      email,
      role: after.role,
      requested_role: wantRole,
      status: 'invited' as const,
    };
  };

  // ── Learn progression (authoritative Deliver-gate read) ──────────

  getLearnProgress: ConnectClient['getLearnProgress'] = async ({ domain, opportunity_id }) => {
    // WorkerLearnView renders an htmx fragment; the `HX-Request` header is
    // what returns the table fragment rather than the full page chrome.
    const path = `/a/${domain}/opportunity/${opportunity_id}/workers/learn/`;
    const res = await this.request.get(path, { headers: { 'HX-Request': 'true' } });
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    const { workers } = parseWorkerLearnTable(await res.text());
    return { domain, opportunity_id, workers };
  };

  getDeliverProgress: ConnectClient['getDeliverProgress'] = async ({ domain, opportunity_id }) => {
    // WorkerDeliverView is the Deliver sibling of WorkerLearnView; same
    // htmx contract — `HX-Request` returns the table fragment, not the
    // full page chrome. Probed live 2026-07-30 (dimagi-internal/ace#1066).
    const path = `/a/${domain}/opportunity/${opportunity_id}/workers/deliver/`;
    const res = await this.request.get(path, { headers: { 'HX-Request': 'true' } });
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    const { workers } = parseWorkerDeliverTable(await res.text());
    return { domain, opportunity_id, workers };
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
    // Name-filtered rows come back hydrated to full Program shape —
    // listPrograms runs getProgram per match (jjackson/ace#1089) — so no
    // second hydration fetch is needed here.
    return programs[0] as Program;
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
        // Connect's apps endpoint embeds JSON in option `value`s and
        // HTML-encodes the quotes; decodeHtmlEntities is the shared inverse
        // of Django's escape() (was a local htmlDecodeAttr copy pre-#1140).
        const decoded = decodeHtmlEntities(o.value);
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
    if (args.total_budget !== undefined) {
      assertFundsAtLeastOneUser(args.total_budget, [args]);
    }
    return await this.postPaymentUnitForm(args);
  };

  createPaymentUnits: ConnectClient['createPaymentUnits'] = async (args) => {
    // Funds-≥1-FLW guard (jjackson/ace#729) — backend-independent; mirrors the
    // REST backend so the HTML fallback path enforces the same invariant.
    if (args.total_budget !== undefined) {
      assertFundsAtLeastOneUser(args.total_budget, args.payment_units);
    }
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

  /**
   * Read-back of the opportunity's workers table — the authoritative answer to
   * "did that invite actually land?" (dimagi-internal/ace#824 / #855).
   *
   * The workers table is an **htmx fragment**: without `HX-Request: true`
   * Connect returns the page shell with no `<tr>` rows, which would read as
   * "no invites" and be exactly the kind of confidently-wrong answer this
   * atom exists to prevent. The header is therefore mandatory here.
   *
   * Parsing lives in `lib/connect-flw-invites.ts` and resolves columns by
   * header label, so a Connect template reshape throws instead of silently
   * shifting fields.
   */
  listFlwInvites: ConnectClient['listFlwInvites'] = async (args) => {
    const path = `/a/${args.organization_slug}/opportunity/${args.opportunity_id}/workers/`;
    const res = await this.request.get(path, {
      headers: { 'HX-Request': 'true', Referer: `${this.opts.baseUrl}${path}` },
    });
    if (res.status() !== 200) throw await httpErrorFor(res, path, 'GET');
    const invites = parseWorkersTable(await res.text());
    return {
      opportunity_id: args.opportunity_id,
      invites,
      ...(args.phone !== undefined ? { match: findInviteByPhone(invites, args.phone) } : {}),
    };
  };
}
