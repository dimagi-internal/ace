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
import { CommCareBackend } from './connect/backends/commcare.js';
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
    commcare = new CommCareBackend({ baseUrl: cchqBaseUrl, session });
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
    short_description: z.string().max(255),
    description: z.string().describe(
      'Full opportunity description. Server has an upper bound around ~250 ' +
        'chars before HTTP 500s start firing intermittently (verified 2026-05-06 ' +
        'on leep-paint-collection — see jjackson/ace#106 finding 7). Default to ' +
        'a one-paragraph headline (≤250 chars). Stash the long-form prose in the ' +
        'opp\'s Drive summary doc and link to it from the headline. Once the ' +
        'server-side fix lands and the cap can be raised safely, this note ' +
        'should be removed.',
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
    short_description: z.string().max(255).optional(),
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
  location: z.boolean().optional(),
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
  { organization_slug: z.string(), opportunity_id: z.string(), flags: VerificationFlagsZ },
  async (args) => runAtom(async () => (await client()).setVerificationFlags(args))
);

server.tool('connect_list_deliver_units',
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
  'Writes the CCZ to `$CLAUDE_PLUGIN_DATA/ccz-cache/` and returns `ccz_path` for the caller to open. Inline `ccz_base64` was removed in 0.13.116 because the MCP transport silently truncated large base64 payloads — a 29 KB CCZ came back missing 2.5 KB of trailing bytes. Returns `{status, size_bytes, ccz_path, ccz_sha256, connect_markers, projected_connect_state}`. CCZs > 25 MB still get written to disk + return the path, but skip the in-memory inflate (so `connect_markers` and `projected_connect_state` are absent). Use `connect_markers` and `projected_connect_state` for cheap server-side validation; read the file at `ccz_path` only when you need the raw bytes.',
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
// quiz forms). Both upstream blockers gate ACE Phase 3 e2e for any
// Nova-built Connect Learn app with the standard quiz scaffold. When
// Nova ships fixes for both, the `commcare-form-patch` skill — and this
// atom along with it — should be deleted (verified by re-running
// leep-paint-collection Phase 3 with no patches needed).
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

await server.connect(new StdioServerTransport());
