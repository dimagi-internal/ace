/**
 * Connect MCP Server for ACE
 *
 * Exposes 20 atomic Connect capabilities as MCP tools. Delegates to a
 * CompositeBackend that routes each atom to either REST (commcare-connect
 * PR #1135's automation API, since 0.10.47) or Playwright (HTML-form-driven
 * — reads, edits, verification flags, invoices). Both backends share the
 * authenticated session established by `/ace:connect-login` (OAuth-via-CCHQ
 * as ace@dimagi-ai.com).
 *
 * See docs/superpowers/specs/2026-04-28-ace-connect-mcp-design.md
 */
import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
import { resolvePluginDataDir, logPluginDataDirDiag } from '../lib/plugin-data-dir.js';
logPluginDataDirDiag('ace-connect', import.meta.url);
const __pluginDataDir = resolvePluginDataDir(import.meta.url);
dotenvConfig({
  path: __pluginDataDir
    ? path.join(__pluginDataDir, '.env')
    : path.join(process.cwd(), '.env'),
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { RestBackend } from './connect/backends/rest.js';
import { PlaywrightBackend } from './connect/backends/playwright.js';
import { CommCareBackend, BuildRejectedError } from './connect/backends/commcare.js';
import { preflightLearnAppUser } from './connect/backends/commcare-preflight.js';
import { CompositeBackend } from './connect/backends/composite.js';
import { PlaywrightSession } from './connect/auth/playwright-session.js';
import { createLoggingProxy, defaultFileLogger } from './connect/logging.js';
import { ConnectValidationError, ConnectSilentRejectError } from './connect/errors.js';
import {
  resolvePatchXformXml,
  resolveUploadMultimediaBytes,
  resolveEnvSubstitution,
} from '../lib/atom-payload-resolver.js';

const baseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
const cchqBaseUrl = process.env.ACE_HQ_BASE_URL ?? 'https://www.commcarehq.org';

let rest: RestBackend | undefined;
let playwright: PlaywrightBackend | undefined;
let commcare: CommCareBackend | undefined;
let session: PlaywrightSession | undefined;
let initPromise: Promise<{ rest: RestBackend; playwright: PlaywrightBackend }> | undefined;

let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

function cleanup() { if (session) session.close().catch(() => {}); }
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

async function getBackends(): Promise<{ rest: RestBackend; playwright: PlaywrightBackend }> {
  if (rest && playwright) return { rest, playwright };
  if (initPromise) return initPromise;
  initPromise = (async () => {
    session = new PlaywrightSession({
      baseUrl,
      cchqBaseUrl,
      hqUsername: process.env.ACE_HQ_USERNAME,
      hqPassword: process.env.ACE_HQ_PASSWORD,
    });
    const ctx = await session.getContext();
    const csrfToken = session.getCsrfToken();
    // RestBackend takes a session reference (added 0.13.9) so its
    // `post()` helper can self-heal Django CSRF rotation:
    // 403 + body containing "CSRF" triggers `session.refreshCsrfToken()`
    // and one retry. Mirrors the 0.13.8 commcare.ts pattern but for
    // a different failure shape than CCHQ's 302-to-login.
    rest = new RestBackend({ baseUrl, csrfToken, request: ctx.request, session });
    // PlaywrightBackend takes the session reference too (added 0.13.17) so
    // its lazy `request` getter can resolve a fresh handle from
    // `session.peekRequest()` on every call. Without this, a
    // `RestBackend.reauth()` on the OTHER backend closed the shared
    // BrowserContext and stranded PlaywrightBackend on a dead
    // `APIRequestContext` — every subsequent Playwright read failed with
    // `apiRequestContext.get: Target page, context or browser has been
    // closed`. Mirrors the 0.13.15 RestBackend wiring.
    playwright = new PlaywrightBackend({ baseUrl, csrfToken, request: ctx.request, session });
    // CommCareBackend takes the session itself (not a bare APIRequestContext)
    // so each atom can pull a fresh request and recover from CCHQ-side
    // session expiry that the boot-time probe missed (0.13.8).
    commcare = new CommCareBackend({
      baseUrl: cchqBaseUrl,
      session,
      hqUsername: process.env.ACE_HQ_USERNAME,
      hqApiKey: process.env.ACE_HQ_API_KEY,
    });
    return { rest, playwright };
  })();
  try { return await initPromise; }
  catch (e) { initPromise = undefined; throw e; }
}

async function client() {
  const { rest, playwright } = await getBackends();
  return createLoggingProxy(
    new CompositeBackend({ rest, playwright }),
    defaultFileLogger(),
  );
}

async function commcareClient(): Promise<CommCareBackend> {
  await getBackends();
  if (!commcare) throw new Error('CommCare backend not initialized — getBackends should have wired it');
  return commcare;
}

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

/**
 * Run an atom call and convert ConnectValidationError into a structured JSON
 * response (with `error: 'validation_error'` and per-field `fields`) instead
 * of letting it bubble as an unstructured "tool error" through MCP.
 */
async function runAtom<T>(fn: () => Promise<T>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const result = await serialize(fn);
    return json(result);
  } catch (err) {
    if (err instanceof ConnectValidationError) {
      return { ...json(err.toJSON()), isError: true };
    }
    if (err instanceof ConnectSilentRejectError) {
      return { ...json(err.toJSON()), isError: true };
    }
    if (err instanceof BuildRejectedError) {
      return { ...json(err.toJSON()), isError: true };
    }
    throw err;
  }
}

const server = new McpServer({ name: 'ace-connect', version: '0.1.0' });

// ── Programs ──────────────────────────────────────────────────────

server.tool('connect_list_programs',
  { organization_slug: z.string(), name: z.string().optional() },
  async (args) => runAtom(async () => (await client()).listPrograms(args))
);

server.tool('connect_get_program',
  { organization_slug: z.string(), program_id: z.string() },
  async (args) => runAtom(async () => (await client()).getProgram(args))
);

server.tool('connect_create_program',
  {
    organization_slug: z.string().describe('PM-side org slug (must be a program-manager org).'),
    name: z.string(),
    description: z.string(),
    delivery_type: z.union([z.string(), z.coerce.number().int()]).describe(
      'Delivery type slug (preferred — e.g. "nutrition") or its int FK. ' +
      'The Connect REST API accepts the slug; pass the int FK only if you ' +
      'already resolved it via `connect_list_delivery_types`.',
    ),
    budget: z.coerce.number(),
    currency: z.string().describe('ISO 4217 code (e.g. "USD").'),
    country: z.string().describe('Human country name as Connect renders it (e.g. "United States of America").'),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  },
  async (args) => runAtom(async () => (await client()).createProgram(args))
);

server.tool('connect_update_program',
  {
    organization_slug: z.string(),
    program_id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    budget: z.coerce.number().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
  },
  async (args) => runAtom(async () => (await client()).updateProgram(args))
);

server.tool('connect_list_delivery_types',
  { organization_slug: z.string() },
  async (args) => runAtom(async () => (await client()).listDeliveryTypes(args))
);

// ── Opportunities ─────────────────────────────────────────────────

server.tool('connect_list_opportunities',
  { organization_slug: z.string(), program_id: z.string().optional(), name: z.string().optional() },
  async (args) => runAtom(async () => (await client()).listOpportunities(args))
);

server.tool('connect_get_opportunity',
  { organization_slug: z.string(), opportunity_id: z.string() },
  async (args) => runAtom(async () => (await client()).getOpportunity(args))
);

const HqAppZ = z.object({
  hq_server_url: z.string().url().describe('HQ instance URL (e.g. https://www.commcarehq.org)'),
  api_key: z.string().describe(
    'Raw 40-char HQ API key. Connect creates an HQApiKey record on first use. ' +
      'Accepts `${VAR}` syntax to substitute from the MCP server\'s env (e.g. ' +
      '`${ACE_HQ_API_KEY}`); the env var must be set in $CLAUDE_PLUGIN_DATA/.env. ' +
      'Use `\\${VAR}` to pass the literal string.',
  ),
  cc_domain: z.string().describe('HQ project space slug.'),
  cc_app_id: z.string().describe('Bare 32-char HQ app id.'),
});

server.tool('connect_create_opportunity',
  {
    organization_slug: z.string().describe('PM-side org running the program.'),
    program_id: z.string().describe('Program UUID — required (managed opportunity).'),
    name: z.string(),
    short_description: z.string().max(50).describe(
      'Max 50 chars — DB-enforced. Connect\'s `Opportunity.short_description` ' +
        'is `CharField(max_length=50)` but the DRF serializer is wrongly typed as ' +
        '`max_length=255`. A 51–255 char payload validates clean at the DRF layer, ' +
        'then Postgres raises `DataError: value too long for type character varying(50)` ' +
        'inside `transaction.atomic()`. That `DataError` is NOT caught by ' +
        'commcare-connect/program/api/views.py:102 (which only catches httpx errors), ' +
        'so it bubbles up as a Django 500 with no actionable response body. Bisected ' +
        'deterministically 2026-05-12 against `e62dcb06-...`: 49 chars → 201; 51 chars → 500. ' +
        'Tightening here so we fail-loud in Zod before the network round-trip. ' +
        'Upstream alignment: align serializer to model in commcare-connect (or vice versa).',
    ),
    description: z.string().describe(
      'Full opportunity description. Connect\'s `Opportunity.description` is `TextField()` — ' +
        'no DB-enforced length. Earlier ACE versions claimed an intermittent ~250-char 500 ' +
        'threshold (jjackson/ace#106 finding 7 from leep-paint-collection 2026-05-06); that ' +
        'observation has not been reproduced under the bisect protocol that proved the ' +
        'short_description 50-char trap. Treat any "description 500" as suspect-misattribution ' +
        'and re-bisect before assuming a length cap. Long-form prose belongs in the opp\'s Drive ' +
        'summary doc; the headline lives here.',
    ),
    target_organization_slug: z.string().describe(
      'LLO org slug — must already have an ACCEPTED program application. ' +
      'Use `connect_send_llo_invite` + `connect_accept_program_application` first if needed.',
    ),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Must fit inside the program window.'),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    total_budget: z.coerce.number().int().min(1).describe(
      'Must fit inside `program.budget − Σ(other managed opps)`.',
    ),
    is_test: z.boolean().optional().describe('Defaults true server-side.'),
    auto_activate: z.boolean().optional().default(true).describe(
      'When true (default), call `activateOpportunity` after a successful ' +
      'create so the returned opp reflects truly-active server state. The ' +
      'create response\'s `active: true` field is set in the Connect DB ' +
      'column but the activation hook hasn\'t run yet — downstream ' +
      'endpoints (`sendFlwInvite` / `invite_users/`) reject with ' +
      '"Opportunity must be active to invite users" until `/activate/` ' +
      'is POSTed. The activate endpoint is idempotent. Set false only ' +
      'for intentional drafts. Verified live on malaria-itn-fgd ' +
      '20260514-2352 Phase 4 (0.13.240).',
    ),
    learn_app: HqAppZ.extend({
      description: z.string().describe('Required — Connect form marks it *.'),
      passing_score: z.coerce.number().int().min(0).max(100),
    }),
    deliver_app: HqAppZ.describe('cc_app_id MUST differ from learn_app.cc_app_id.'),
  },
  async (args) =>
    runAtom(async () => {
      // Resolve `${VAR}` patterns in API keys before forwarding to
      // Connect — see jjackson/ace#106 finding 6. The atom historically
      // sent the literal `${ACE_HQ_API_KEY}` string verbatim, which
      // surfaced server-side as a misleading "Failed to fetch apps from
      // CommCare HQ" validation error.
      const resolved = {
        ...args,
        learn_app: { ...args.learn_app, api_key: resolveEnvSubstitution(args.learn_app.api_key) },
        deliver_app: { ...args.deliver_app, api_key: resolveEnvSubstitution(args.deliver_app.api_key) },
      };
      return (await client()).createOpportunity(resolved);
    })
);

server.tool('connect_update_opportunity',
  {
    organization_slug: z.string(),
    opportunity_id: z.string(),
    name: z.string().optional(),
    short_description: z.string().max(50).optional().describe(
      'Max 50 chars — DB-enforced (see connect_create_opportunity for the full bisect note).',
    ),
    description: z.string().optional(),
    end_date: z.string().optional(),
    is_test: z.boolean().optional(),
  },
  async (args) => runAtom(async () => (await client()).updateOpportunity(args))
);

// ── Per-opportunity configuration ────────────────────────────────

const VerificationFlagsZ = z.object({
  duplicate: z.boolean().optional(),
  gps: z.boolean().optional(),
  catchment_areas: z.boolean().optional(),
  gps_radius_meters: z.number().int().min(0).max(10000).optional()
    .describe('GPS radius (meters) for catchment-area / location-based verification. Surfaced through the form\'s `location` numeric input. Default is the form\'s pre-filled value (10m). Typical PDD specs are 100-500m. Renamed from `location: boolean` in 0.13.240 — the form field has always been a number, never a boolean.'),
  form_submission_start: z.string().optional(),
  form_submission_end: z.string().optional(),
  deliver_unit_checks: z.array(z.object({
    deliver_unit_id: z.number().int(),
    check_attachments: z.boolean(),
    duration_seconds: z.number().int().optional(),
    id: z.number().int().optional(),
  })).optional(),
  form_field_rules: z.array(z.object({
    name: z.string(),
    question_path: z.string(),
    question_value: z.string(),
    deliver_unit_id: z.number().int(),
    id: z.number().int().optional(),
  })).optional(),
});

server.tool('connect_set_verification_flags',
  'Set per-opportunity verification toggles via the `/opportunity/<id>/verification_flags_config/` HTML form (not yet on the public REST API; routes through Playwright). Supports the top-level booleans (`duplicate` / `gps` / `catchment_areas`), the numeric `gps_radius_meters` field (renamed from the historic `location: boolean` typo), submission-window times, and the per-deliver-unit attachment / duration checks. Re-posts every existing formset row verbatim so changes are additive.',
  { organization_slug: z.string(), opportunity_id: z.string(), flags: VerificationFlagsZ },
  async (args) => runAtom(async () => (await client()).setVerificationFlags(args))
);

server.tool(
  'connect_list_deliver_units',
  'List deliver units for an opportunity. Each entry has `id` (per-opp display index 1/2/3…), `name`, `slug`, plus `server_id` — the server-side primary key suitable for `connect_create_payment_unit.required_deliver_units` / `optional_deliver_units`. `server_id` is populated by reading the create-payment-unit form\'s checkbox values; absent only on the rare degraded path where that secondary fetch fails. Pass `server_id` (not `id`) to `connect_create_payment_unit`.',
  { organization_slug: z.string(), opportunity_id: z.string() },
  async (args) => runAtom(async () => (await client()).listDeliverUnits(args))
);

const PaymentUnitItemZ = z.object({
  name: z.string().max(255),
  description: z.string().optional(),
  amount: z.coerce.number().int().min(0).describe('FLW pay per unit.'),
  org_amount: z.coerce.number().int().min(0).optional().describe('LLO pay per unit. REQUIRED for managed opportunities.'),
  max_total: z.coerce.number().int().min(1).describe('Total visits per user across the opportunity.'),
  max_daily: z.coerce.number().int().min(1).describe('Visits per user per day.'),
  required_deliver_units: z.array(z.coerce.number().int()).optional(),
  optional_deliver_units: z.array(z.coerce.number().int()).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

server.tool('connect_create_payment_units',
  {
    organization_slug: z.string(),
    opportunity_id: z.string(),
    payment_units: z.array(PaymentUnitItemZ).min(1).describe(
      'Atomic batch — server validates DU assignments across the whole list ' +
      'and rejects the entire request if any unit is invalid.',
    ),
  },
  async (args) => runAtom(async () => (await client()).createPaymentUnits(args))
);

server.tool('connect_create_payment_unit',
  {
    organization_slug: z.string(),
    opportunity_id: z.string(),
    name: z.string().max(255),
    description: z.string().optional(),
    amount: z.coerce.number().int().min(0),
    org_amount: z.coerce.number().int().min(0).optional().describe('Required for managed opportunities.'),
    max_total: z.coerce.number().int().min(1),
    max_daily: z.coerce.number().int().min(1),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    required_deliver_units: z.array(z.coerce.number().int()).optional(),
    optional_deliver_units: z.array(z.coerce.number().int()).optional(),
  },
  async (args) => runAtom(async () => (await client()).createPaymentUnit(args))
);

server.tool('connect_list_payment_units',
  'List payment units on an opportunity. **HTML-scraped read-back has known unreliable fields:** `amount` returns undefined (the table doesn\'t render it); `max_total` and `max_daily` are mislabeled / swapped on some pages (verified live on `malaria-itn-fgd/20260514-2352` Phase 4); `required_deliver_units` returns `[]` regardless of actual config. **Use `createPaymentUnit`\'s response object for round-trip verification** of those fields rather than this list endpoint. `id`, `payment_unit_uuid`, `name`, and `description` ARE reliable. Issue tracking: jjackson/ace#106 finding 5 + turmeric-20260503-0835. When upstream ships a real GET /api/payment_units/ endpoint, all fields become reliable in one routing change.',
  { organization_slug: z.string(), opportunity_id: z.string() },
  async (args) => runAtom(async () => (await client()).listPaymentUnits(args))
);

server.tool('connect_activate_opportunity',
  { organization_slug: z.string(), opportunity_id: z.string() },
  async (args) => runAtom(async () => (await client()).activateOpportunity(args))
);

// ── Program applications (LLO invite + auto-accept) ──────────────

server.tool('connect_send_llo_invite',
  {
    organization_slug: z.string().describe('PM-side org running the program.'),
    program_id: z.string().describe('Program UUID — invite is program-level.'),
    organization: z.string().describe('LLO org slug to invite.'),
  },
  async (args) => runAtom(async () => (await client()).sendLloInvite(args))
);

server.tool('connect_accept_program_application',
  {
    organization_slug: z.string(),
    program_id: z.string(),
    application_id: z.string().describe('ProgramApplication UUID returned by `connect_send_llo_invite`.'),
  },
  async (args) => runAtom(async () => (await client()).acceptProgramApplication(args))
);

server.tool('connect_list_invites',
  { organization_slug: z.string(), program_id: z.string() },
  async (args) => runAtom(async () => (await client()).listInvites(args))
);

// ── FLW invites ──────────────────────────────────────────────────

server.tool('connect_send_flw_invite',
  {
    organization_slug: z.string(),
    opportunity_id: z.string().describe('Opportunity must be active and not ended.'),
    phone_numbers: z.array(z.string().regex(/^\+\d+$/, 'Phone must start with + and contain only digits')).min(1),
  },
  async (args) => runAtom(async () => (await client()).sendFlwInvite(args))
);

server.tool('connect_delete_unaccepted_flw_invites',
  'Hard-delete unaccepted FLW invites by integer id. Invites with `status=accepted` are silently skipped server-side (those represent real workers and cannot be deleted via this endpoint). Associated `OpportunityAccess` rows cascade-delete. Used by `/ace:sweep connect` to clean up orphan invites tied to deactivated opportunities. Routes through Playwright to the `@csrf_exempt` `/opportunity/<opp_id>/delete_invites/` HTML view; no REST equivalent. `opportunity_id` is the opportunity UUID slug; `user_invite_ids` are the integer ids returned by `connect_list_invites`.',
  {
    organization_slug: z.string(),
    opportunity_id: z.string().describe('Opportunity UUID slug (same shape used by connect_list_invites).'),
    user_invite_ids: z.array(z.coerce.number().int()).min(1).describe(
      'Integer ids from connect_list_invites. Accepted invites in this list are silently skipped server-side.',
    ),
  },
  async (args) => runAtom(async () => (await client()).deleteUnacceptedFlwInvites(args))
);

// ── Invoices ─────────────────────────────────────────────────────

server.tool('connect_list_invoices',
  { organization_slug: z.string(), opportunity_id: z.string() },
  async (args) => runAtom(async () => (await client()).listInvoices(args))
);

server.tool('connect_get_invoice',
  { organization_slug: z.string(), invoice_id: z.string() },
  async (args) => runAtom(async () => (await client()).getInvoice(args))
);

// ── CommCare HQ (release pipeline) ───────────────────────────────
//
// These atoms talk to www.commcarehq.org, not connect.dimagi.com. They
// share the Playwright session because Connect's OAuth-via-CCHQ login
// flow leaves valid CCHQ cookies in the same BrowserContext.

server.tool('commcare_list_apps',
  'List CommCare HQ applications in a domain. Hits the REST API at GET /a/<domain>/api/v0.4/application/ (domain-scoped — the unscoped /api/v0.4/application/?domain= form returns 404 from Django routing) using the existing PlaywrightSession cookie jar (allow_session_auth=True on CCHQ\'s TaskPie resource — no separate API key needed). Returns id, name, and doc_type per app. Soft-deleted apps (doc_type ending in `-Deleted`) are filtered server-side; the field is preserved for callers that cross-check against `commcare_delete_app`. Used by `/ace:sweep hq` to enumerate the universe of apps in the ACE-owned domain.',
  { domain: z.string() },
  async (args) => runAtom(async () => (await commcareClient()).listApps(args))
);

server.tool('commcare_delete_app',
  'Soft-delete a CommCare HQ application. POST /a/<domain>/apps/delete_app/<app_id>/ via the web view (no REST equivalent — the view soft-deletes by mutating doc_type to `<original>-Deleted` and creates a DeleteApplicationRecord for restore). Restore is possible via HQ admin UI\'s "deleted applications" list. Routes through the existing PlaywrightSession (session cookies + CSRF from cookie jar; API key auth is insufficient because this is a CSRF-protected Django web view). Used by `/ace:sweep hq` to clean up orphan apps in the ACE-owned domain.',
  {
    domain: z.string(),
    app_id: z.string(),
  },
  async (args) => runAtom(async () => (await commcareClient()).deleteApp(args))
);

server.tool('commcare_create_domain',
  'Create a new CommCare HQ project space (domain). POST /register/domain/ via the DomainRegistrationForm CSRF-protected web view (no REST equivalent — corehq/apps/registration/views.py:RegisterDomainView). For an existing (non-new) user — which ACE\'s ace@dimagi-ai.com always is — success is a 302 to /a/<slug>/dashboard/; the returned `domain` is the slug HQ derived from `hr_name`. `hr_name` is capped at 25 chars (HQ\'s DomainRegistrationForm.max_name_length); pass an already-slug-shaped value (lowercase, hyphens) for predictable slug derivation. Daily-creation rate-limit and `RESTRICT_DOMAIN_CREATION` errors are surfaced explicitly.',
  {
    hr_name: z.string().max(25).describe('Human-readable project name; HQ derives the URL slug from this. Max 25 chars. Pass a slug-shaped value (lowercase + hyphens) for predictable results.'),
    org: z.string().optional().describe('Optional organization id (hidden form field; usually empty).'),
  },
  async (args) => runAtom(async () => (await commcareClient()).createDomain(args))
);

server.tool('commcare_get_lookup_table',
  'Fetch a CommCare HQ lookup table by tag (name). GET /a/<domain>/api/v0.5/lookup_table/ via Tastypie (session auth OK). Lists all tables in the domain and returns the one whose `tag` matches; returns `{table: null}` if not found. Use this to verify a lookup table exists before appending rows (see also commcare_lookup_table_append_rows, planned).',
  {
    domain: z.string(),
    tag: z.string().describe('Lookup table name as the team uses it (e.g. "interview_schedule").'),
  },
  async (args) => runAtom(async () => (await commcareClient()).getLookupTable(args))
);

server.tool('commcare_create_lookup_table',
  'Create a new CommCare HQ lookup table. POST /a/<domain>/api/v0.5/lookup_table/ via Tastypie. Body: {tag, is_global, fields: [{field_name, properties}], item_attributes}. Returns the new table\'s UUID hex id. Rejects with 400 if a table with the same tag already exists in the domain.',
  {
    domain: z.string(),
    tag: z.string().describe('Name for the new table (e.g. "interview_schedule").'),
    fields: z.array(z.object({
      field_name: z.string(),
      properties: z.array(z.string()).optional().describe('Sub-properties for this column. Empty/omitted for plain string columns.'),
    })),
    is_global: z.boolean().optional().describe('If true, table is shared across the domain (default false).'),
    item_attributes: z.array(z.string()).optional(),
  },
  async (args) => runAtom(async () => (await commcareClient()).createLookupTable(args))
);

server.tool('commcare_list_ucr_expressions',
  'List named UCR expressions / filters on a CommCare HQ domain. POST /a/<domain>/data/ucr_expressions/ with action=paginate via CRUDPaginatedView. Returns id, name, expression_type ("named_expression" | "named_filter"), description, parsed definition JSON. Auth: session (BaseProjectDataView).',
  { domain: z.string(), limit: z.number().int().positive().optional() },
  async (args) => runAtom(async () => (await commcareClient()).listUcrExpressions(args))
);

server.tool('commcare_create_ucr_expression',
  'Create a named UCR expression or filter on a domain. POST the UCRExpressionForm to /a/<domain>/data/ucr_expressions/ via action=create. Required fields: name, expression_type ("named_expression" | "named_filter"), definition (JSON spec). The Connect Interviews bootstrap creates 4: "Register User OCS" + "Trigger OCS Bot" (named_filter), "Session Completion API" + "24 hr Expiry API" (named_expression). Duplicate name in domain raises IntegrityError surfaced as explicit error.',
  {
    domain: z.string(),
    name: z.string(),
    expression_type: z.enum(['named_expression', 'named_filter']),
    definition: z.record(z.any()).describe('The UCR spec JSON object (e.g. {"type": "boolean_expression", ...}).'),
    description: z.string().optional(),
  },
  async (args) => runAtom(async () => (await commcareClient()).createUcrExpression(args))
);

server.tool('commcare_list_inbound_apis',
  'List Inbound API configurations on a CommCare HQ domain. POST /a/<domain>/motech/inbound/ with action=paginate. Returns each API\'s id, name, description, api_url, edit_url. Pro Edition / DATA_FORWARDING required.',
  { domain: z.string(), limit: z.number().int().positive().optional() },
  async (args) => runAtom(async () => (await commcareClient()).listInboundApis(args))
);

server.tool('commcare_create_inbound_api',
  'Create an Inbound API configuration. POST the ConfigurableAPICreateForm to /a/<domain>/motech/inbound/ via CRUDPaginatedViewMixin\'s action=create. Requires filter_expression_id (UCR FK) and optionally transform_expression_id — these UCR expressions must exist on the domain first (typically pushed via linked_domain in the Connect Interviews flow). Returns new id and name. The Connect Interviews "Session Completion API" + "24 hr Expiry API" are created via this atom in the per-domain bootstrap.',
  {
    domain: z.string(),
    name: z.string(),
    description: z.string().optional(),
    filter_expression_id: z.number().int().positive(),
    transform_expression_id: z.number().int().positive().optional(),
    backend: z.enum(['json', 'form_data']).optional(),
  },
  async (args) => runAtom(async () => (await commcareClient()).createInboundApi(args))
);

server.tool('commcare_create_repeater',
  'Create a Data-Forwarding Repeater on a CommCare HQ domain. POST the GenericRepeaterForm (or BaseExpressionRepeaterForm for *ExpressionRepeater types) to /a/<domain>/motech/forwarding/new/<repeater_type>/. Plain FormRepeater forwards every submission; FormExpressionRepeater applies a UCR filter (configured_filter) and emits a UCR-derived payload (configured_expression) — the Connect Interviews "OCS User Registration" and "Trigger Bot" repeaters use this variant. Pro Edition required (DATA_FORWARDING privilege).',
  {
    domain: z.string(),
    repeater_type: z.enum(['FormRepeater', 'CaseRepeater', 'FormExpressionRepeater', 'CaseExpressionRepeater', 'ConnectFormRepeater']),
    connection_settings_id: z.number().int().positive().describe('FK to a Connection (from commcare_list_connections).'),
    name: z.string().optional(),
    request_method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    format: z.string().optional().describe('Payload format slug (e.g. "form_json", "form_xml").'),
    configured_filter: z.record(z.any()).optional().describe('UCR filter spec as a JSON object. Required for *ExpressionRepeater types.'),
    configured_expression: z.record(z.any()).optional().describe('UCR payload-expression spec as a JSON object. Required for POST/PUT *ExpressionRepeater.'),
    url_template: z.string().optional(),
  },
  async (args) => runAtom(async () => (await commcareClient()).createRepeater(args))
);

server.tool('commcare_list_connections',
  'List Connection settings (motech outbound connections) on a CommCare HQ domain. POST /a/<domain>/motech/conn/ with action=paginate via the CRUDPaginatedView. Returns each connection\'s id, name, url, notify_addresses, used_by. Gated by privileges.DATA_FORWARDING (Pro Edition) — 404s without it. Used by verifier to confirm "Connect Interviews" and "OCS Interviews Bot" connections exist.',
  { domain: z.string(), limit: z.number().int().positive().optional() },
  async (args) => runAtom(async () => (await commcareClient()).listConnections(args))
);

server.tool('commcare_create_connection',
  'Create a Connection (motech outbound connection settings). POST the ConnectionSettingsForm to /a/<domain>/motech/conn/add/ (form-encoded, CSRF-protected). Success redirects to the list view — atom re-lists by name to recover the new id. Auth types per corehq/motech/auth.py: none, basic, digest, bearer, oauth1, oauth2_pwd, oauth2_client, api_key. Pro Edition required (DATA_FORWARDING privilege).',
  {
    domain: z.string(),
    name: z.string(),
    url: z.string().describe('Base URL of the target system (e.g. "https://connect.dimagi.com/").'),
    auth_type: z.enum(['none','basic','digest','bearer','oauth1','oauth2_pwd','oauth2_client','api_key']).optional(),
    username: z.string().optional(),
    plaintext_password: z.string().optional(),
    client_id: z.string().optional(),
    plaintext_client_secret: z.string().optional(),
    token_url: z.string().optional(),
    notify_addresses_str: z.string().optional().describe('Comma-separated emails for failure notifications.'),
    skip_cert_verify: z.boolean().optional(),
    plaintext_custom_headers: z.string().optional().describe('JSON string of custom headers (e.g. \'{"Authorization": "Token xyz"}\').'),
  },
  async (args) => runAtom(async () => (await commcareClient()).createConnection(args))
);

server.tool('commcare_get_case',
  'Fetch a single CommCare HQ case by case_id. GET /a/<domain>/api/v0.5/case/<id>/?format=json via Tastypie (API-key auth — CaseResource sets RequirePermissionAuthentication(edit_data) without allow_session_auth). Returns the case\'s dynamic property bag (commcare-user case has session_completion / last_bot_interaction_date / interaction_validation written by OCS-to-HQ custom action). 404 surfaces as an explicit error.',
  { domain: z.string(), case_id: z.string() },
  async (args) => runAtom(async () => (await commcareClient()).getCase(args))
);

server.tool('commcare_list_users',
  'List mobile workers (CommCareUser) in a CommCare HQ domain. GET /a/<domain>/api/v0.5/user/ via Tastypie (API key auth). Supports standard Tastypie pagination (limit/offset) and group filter. Returns each user\'s id, username, basic profile, and the full user_data dict (including custom fields like cohort_id). Used by verifier to confirm cohort_id is set on the right FLWs.',
  {
    domain: z.string(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
    group: z.string().optional(),
  },
  async (args) => runAtom(async () => (await commcareClient()).listUsers(args))
);

server.tool('commcare_get_user',
  'Fetch a single CommCare HQ mobile worker by id. GET /a/<domain>/api/v0.5/user/<user_id>/. Returns the full record including user_data.',
  { domain: z.string(), user_id: z.string() },
  async (args) => runAtom(async () => (await commcareClient()).getUser(args))
);

server.tool('commcare_update_user_field',
  'Set a single custom-user-data field on a mobile worker. Implemented as GET → mutate user_data → PUT (v0_5 CommCareUserResource exposes PUT but not PATCH, so we PUT the merged user_data). Pass value=null to clear the field. Used by per-FLW cohort_id assignment after Learn completion.',
  {
    domain: z.string(),
    user_id: z.string(),
    field_slug: z.string().describe('User-data field slug (e.g. "cohort_id").'),
    value: z.union([z.string(), z.null()]).describe('New value, or null to clear.'),
  },
  async (args) => runAtom(async () => (await commcareClient()).updateUserField(args))
);

server.tool('commcare_get_lookup_table_rows',
  'Get rows of a CommCare HQ lookup table. GET /a/<domain>/api/v0.5/lookup_table_item/ via Tastypie (API key auth). Tastypie returns ALL rows in the domain (no querystring filter); this atom client-side filters by data_type_id resolved from the supplied tag or UUID. Returns each row\'s fields as a flat map (column → first field_value).',
  {
    domain: z.string(),
    table_id_or_tag: z.string().describe('Either a 32-hex table UUID or the human-readable tag (e.g. "interview_schedule").'),
  },
  async (args) => runAtom(async () => (await commcareClient()).getLookupTableRows(args))
);

server.tool('commcare_lookup_table_append_rows',
  'Append rows to a CommCare HQ lookup table. POST /a/<domain>/api/v0.5/lookup_table_item/ once per row (Tastypie doesn\'t support list POST for this resource). Each row is a flat field_name→string-value map; HQ wraps it into its field_list shape internally. Used by the cohort-create skill to populate interview_schedule rows for a new cohort.',
  {
    domain: z.string(),
    table_id_or_tag: z.string(),
    rows: z.array(z.record(z.string())).describe('List of flat row maps: each {field_name: value}.'),
    item_attributes: z.record(z.string()).optional(),
  },
  async (args) => runAtom(async () => (await commcareClient()).appendLookupTableRows(args))
);

server.tool('commcare_link_domains',
  'Set up a linked-project-spaces relationship: upstream (master) → downstream. Required before linked-app push / linked content sync. POST /a/<upstream>/linked_domain/service/ via the jQuery-RMI protocol (corehq/util/jqueryrmi.py + corehq/apps/linked_domain/views.py:DomainLinkRMIView.create_domain_link). Caller must have access in both domains. Pro Edition is required for the LITE_RELEASE_MANAGEMENT privilege that backs linked spaces — without it, the call may succeed structurally but content-push operations downstream will fail.',
  {
    upstream_domain: z.string().describe('Master domain slug (must have access).'),
    downstream_domain: z.string().describe('Downstream domain slug to attach (must also have access).'),
  },
  async (args) => runAtom(async () => (await commcareClient()).linkDomains(args))
);

server.tool('commcare_make_build',
  {
    domain: z.string(),
    app_id: z.string(),
    comment: z.string().optional(),
  },
  async (args) => runAtom(async () => (await commcareClient()).makeBuild(args))
);

server.tool('commcare_release_build',
  {
    domain: z.string(),
    app_id: z.string(),
    build_id: z.string(),
  },
  async (args) => runAtom(async () => (await commcareClient()).releaseBuild(args))
);

server.tool('commcare_download_ccz',
  {
    domain: z.string(),
    app_id: z.string(),
    build_id: z.string().optional(),
    include_multimedia: z.boolean().optional().describe('If true, request the full CCZ with multimedia binaries inlined under commcare/multimedia/...; default false returns the lite manifest-only response.'),
  },
  async (args) => runAtom(async () => (await commcareClient()).downloadCcz(args))
);

// commcare_patch_xform — surgical CommCare HQ form-XML patch endpoint.
//
// TEMPORARY workaround for nova-plugin#5 (compile_app emits empty
// `<user_score/>`) and nova-plugin#6 (`connect: null` is auto-restored on
// quiz forms). Both upstream blockers gate ACE Phase 4 e2e for any
// Nova-built Connect Learn app with the standard quiz scaffold. When
// Nova ships fixes for both, the `commcare-form-patch` skill — and this
// atom along with it — should be deleted (verified by re-running
// leep-paint-collection Phase 4 with no patches needed).
//
// Endpoint: POST /a/<domain>/apps/edit_form_attr/<app_id>/<form_unique_id>/xform/
// Auth: same `@login_or_digest` Playwright session as other commcare_* atoms.
// Note: this patches the **draft** only — caller must follow with
// `commcare_make_build` + `commcare_release_build` to ship the change.
//
// XML payload — two-arg shape (added 0.13.29):
//   - `new_xform_xml`        — inline XForm XML string. Easy for short
//                              patches but practical tool-call wrappers
//                              hit arg-size limits on real forms (12K+).
//   - `new_xform_xml_path`   — local filesystem path to the XForm XML.
//                              The handler reads the file as UTF-8 and
//                              forwards the contents to the backend
//                              method, which still takes a string. Use
//                              this when the patched XML is too large
//                              for inline arg passing (the typical
//                              app-multimedia-coverage case).
//   Exactly one of the two must be supplied — Zod refines to a
//   usage error when both or neither are given.
server.tool('commcare_patch_xform',
  {
    domain: z.string(),
    app_id: z.string(),
    form_unique_id: z.string().regex(/^[0-9a-f]{32}$/, 'unique_id is a 32-char hex string from suite.xml or the delete_form action URL'),
    new_xform_xml: z.string().min(1).optional().describe('Inline XForm XML (mutually exclusive with new_xform_xml_path).'),
    new_xform_xml_path: z.string().optional().describe('Local path to the XForm XML file (mutually exclusive with new_xform_xml). Use this for large patched XML that blows past tool-call arg-size limits.'),
    sha1: z.string().optional().describe('Optional concurrency token; CCHQ rejects with XformConflictError on mismatch.'),
  },
  async (args) =>
    runAtom(async () => {
      const { new_xform_xml, new_xform_xml_path, ...rest } = args;
      const xml = resolvePatchXformXml({ new_xform_xml, new_xform_xml_path });
      return (await commcareClient()).patchXform({ ...rest, new_xform_xml: xml });
    }),
);

// commcare_upload_multimedia — POST a binary multimedia asset to CCHQ.
// Required companion to commcare_patch_xform: the form-XML patch makes the
// build *reference* the asset; this atom puts the *bytes* into CouchDB so
// CCHQ's clean_paths() doesn't prune the reference on the next make_build.
//
// Endpoint: POST /a/<domain>/apps/<app_id>/multimedia/uploaded/<media_type>/
//   <media_type> derives from content_type MIME prefix.
// Auth: same Playwright session as commcare_patch_xform; X-CSRFToken header.
// Returns: { multimedia_id, file_hash_md5 } — see backends/commcare.ts.
//
// CRITICAL ORDER OF OPERATIONS:
//   1. patch form XML to reference jr://file/commcare/<type>/<filename>
//   2. commcare_upload_multimedia (this atom)
//   3. commcare_make_build + commcare_release_build
// Reversing 1 and 2 still works (uploads are idempotent), but skipping
// step 1 means the upload is silently no-op for FLW devices because
// CCHQ's clean_paths() prunes orphaned media on every build.
//
// File-bytes payload — two-arg shape (added 0.13.29):
//   - `file_bytes_base64`  — inline base64-encoded payload. Convenient
//                            for tiny test assets but a typical PNG
//                            (~1.2 MB → ~1.6 MB base64) blows past
//                            practical tool-call arg-size limits.
//   - `file_bytes_path`    — local filesystem path to the binary
//                            payload. Handler reads the file as raw
//                            bytes and forwards a Buffer to the
//                            backend (which already takes a Buffer);
//                            no backend signature change.
//   Exactly one of the two must be supplied.
server.tool('commcare_upload_multimedia',
  {
    domain: z.string(),
    app_id: z.string().regex(/^[0-9a-f]{32}$/, '32-char hex'),
    media_path: z.string().regex(/^jr:\/\/file\/commcare\/(image|audio|video|text)\/[^\/]+$/),
    file_bytes_base64: z.string().min(1).optional().describe('Asset bytes, base64-encoded (mutually exclusive with file_bytes_path).'),
    file_bytes_path: z.string().optional().describe('Local path to the binary payload (mutually exclusive with file_bytes_base64). Use this for typical-sized PNGs that blow past tool-call arg-size limits.'),
    content_type: z.string().regex(/^(image|audio|video|text)\//),
  },
  async (args) =>
    runAtom(async () => {
      const { file_bytes_base64, file_bytes_path, ...rest } = args;
      const file_bytes = resolveUploadMultimediaBytes({
        file_bytes_base64,
        file_bytes_path,
      });
      return (await commcareClient()).uploadMultimedia({
        ...rest,
        file_bytes,
      });
    }),
);

// ── Learn-app CCHQ pre-flight ────────────────────────────────────
//
// `connect_preflight_learn_app_user` — defense-in-depth check before
// the Phase 6 mobile recipe triggers `POST /users/start_learn_app/`.
// Catches the auth / domain / user-conflict failure modes that would
// otherwise surface only at recipe runtime, when the FLW client has
// already started navigating.
//
// What it checks: API key + domain reachability on CCHQ, and (if a
// `connect_username` is supplied) whether the mobile worker already
// exists with a conflicting link. Recommended caller:
// `connect-opp-setup` Step 7 (just before `connect_send_flw_invite`).
//
// The probe is read-only and idempotent; safe to also wire as a
// Phase-6 pre-flight at the cloud-emulator recipe entrypoint.
//
// See `mcp/connect/backends/commcare-preflight.ts` for the full
// rationale + the cheapest-probe-that-catches-the-class design.
server.tool('connect_preflight_learn_app_user',
  {
    hq_domain: z.string().describe(
      'HQ project space slug (e.g. `connect-ace-prod`). Same value that flows ' +
      'through `connect_create_opportunity` as `learn_app.cc_domain` / ' +
      '`deliver_app.cc_domain`.',
    ),
    connect_username: z.string().optional().describe(
      'ConnectID username for the FLW about to claim the opp. Optional — when ' +
      'omitted, the probe still validates API-key auth + domain reachability ' +
      '(catches the most common auth/domain failure modes at near-zero cost). Supply ' +
      'when you have the username in hand to additionally screen for ' +
      'already-linked-to-different-connect-username conflicts.',
    ),
    api_key: z.string().describe(
      'CCHQ REST API key. Accepts `${VAR}` syntax (same convention as ' +
      '`connect_create_opportunity.learn_app.api_key`); typically called as ' +
      '`${ACE_HQ_API_KEY}`.',
    ),
    hq_username: z.string().describe(
      'CCHQ username the API key belongs to. Typically `${ACE_HQ_USERNAME}`.',
    ),
    base_url: z.string().url().optional().describe(
      'Override CCHQ base URL. Defaults to https://www.commcarehq.org.',
    ),
  },
  async (args) =>
    runAtom(async () => {
      // Resolve `${VAR}` patterns just like `connect_create_opportunity` does.
      // Same env-substitution helper, same `.env` rules.
      const resolved = {
        ...args,
        api_key: resolveEnvSubstitution(args.api_key),
        hq_username: resolveEnvSubstitution(args.hq_username),
      };
      return preflightLearnAppUser(resolved);
    }),
);

await server.connect(new StdioServerTransport());
