/**
 * Connect MCP Server for ACE
 *
 * Exposes 14 atomic Connect capabilities as MCP tools. Delegates to a
 * CompositeBackend that routes each atom to either REST (when those endpoints
 * land) or Playwright (today, driving connect.dimagi.com under
 * ace@dimagi-ai.com via OAuth-via-CommCareHQ).
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
import { CompositeBackend } from './connect/backends/composite.js';
import { PlaywrightSession } from './connect/auth/playwright-session.js';
import { createLoggingProxy, defaultFileLogger } from './connect/logging.js';

const baseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';

const rest = new RestBackend({ baseUrl });

let playwright: PlaywrightBackend | undefined;
let session: PlaywrightSession | undefined;
let initPromise: Promise<PlaywrightBackend> | undefined;

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

async function getPlaywrightBackend(): Promise<PlaywrightBackend> {
  if (playwright) return playwright;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    session = new PlaywrightSession({
      baseUrl,
      hqUsername: process.env.ACE_HQ_USERNAME,
      hqPassword: process.env.ACE_HQ_PASSWORD,
    });
    const ctx = await session.getContext();
    playwright = new PlaywrightBackend({
      baseUrl,
      csrfToken: session.getCsrfToken(),
      request: ctx.request,
    });
    return playwright;
  })();
  try { return await initPromise; }
  catch (e) { initPromise = undefined; throw e; }
}

async function client() {
  const pw = await getPlaywrightBackend();
  return createLoggingProxy(
    new CompositeBackend({ rest, playwright: pw }),
    defaultFileLogger(),
  );
}

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

const server = new McpServer({ name: 'ace-connect', version: '0.1.0' });

// ── Programs ──────────────────────────────────────────────────────

server.tool('connect_list_programs',
  { organization_slug: z.string(), name: z.string().optional() },
  async (args) => json(await serialize(async () => (await client()).listPrograms(args)))
);

server.tool('connect_get_program',
  { organization_slug: z.string(), program_id: z.string() },
  async (args) => json(await serialize(async () => (await client()).getProgram(args)))
);

server.tool('connect_create_program',
  {
    organization_slug: z.string(),
    name: z.string(),
    description: z.string(),
    delivery_type: z.coerce.number().int(),
    budget: z.coerce.number(),
    currency: z.string(),
    country: z.string(),
    start_date: z.string(),
    end_date: z.string(),
  },
  async (args) => json(await serialize(async () => (await client()).createProgram(args)))
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
  async (args) => json(await serialize(async () => (await client()).updateProgram(args)))
);

server.tool('connect_list_delivery_types',
  { organization_slug: z.string() },
  async (args) => json(await serialize(async () => (await client()).listDeliveryTypes(args)))
);

// ── Opportunities ─────────────────────────────────────────────────

server.tool('connect_list_opportunities',
  { organization_slug: z.string(), program_id: z.string().optional(), name: z.string().optional() },
  async (args) => json(await serialize(async () => (await client()).listOpportunities(args)))
);

server.tool('connect_get_opportunity',
  { organization_slug: z.string(), opportunity_id: z.string() },
  async (args) => json(await serialize(async () => (await client()).getOpportunity(args)))
);

server.tool('connect_create_opportunity',
  {
    organization_slug: z.string(),
    program_id: z.string().optional().describe('Program UUID; opp shows up under that program'),
    name: z.string(),
    short_description: z.string().max(50),
    description: z.string(),
    currency: z.string().describe('3-letter ISO (e.g. USD)'),
    country: z.string().describe('3-letter ISO3 (e.g. IND)'),
    hq_server: z.string().describe(
      'CCHQ server label: "prod"/"india"/"eu", a server URL, or the Connect-internal int FK ' +
      '("1" CommCareHQ, "2" India, "3" CommCareHQ EU). The MCP resolves it against Connect\'s ' +
      'live form options, so passing the human label is the recommended form.'
    ),
    api_key: z.string().describe(
      'The raw 40-char CommCare HQ API key for the user. The MCP registers it with Connect ' +
      'idempotently via /opportunity/add_api_key/ and uses the resulting Connect-side int FK on ' +
      'the create form. Do NOT pass the int FK directly.'
    ),
    learn_app_domain: z.string().describe('CCHQ project space slug (e.g. connect-ace-prod)'),
    learn_app: z.string().describe('Bare CCHQ app id (32-char hex). The MCP wraps it in the JSON form-value Connect expects.'),
    learn_app_description: z.string().describe(
      'Required. Connect\'s form marks this field with a *. Pulled from PDD § Training Plan in ACE skills.'
    ),
    learn_app_passing_score: z.coerce.number().int().min(0).max(100),
    deliver_app_domain: z.string(),
    deliver_app: z.string().describe('Bare CCHQ app id (32-char hex). The MCP wraps it in the JSON form-value Connect expects.'),
  },
  async (args) => json(await serialize(async () => (await client()).createOpportunity(args)))
);

server.tool('connect_update_opportunity',
  {
    organization_slug: z.string(),
    opportunity_id: z.string(),
    name: z.string().optional(),
    short_description: z.string().max(50).optional(),
    description: z.string().optional(),
    end_date: z.string().optional(),
    is_test: z.boolean().optional(),
  },
  async (args) => json(await serialize(async () => (await client()).updateOpportunity(args)))
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
  async (args) => json(await serialize(async () => (await client()).setVerificationFlags(args)))
);

server.tool('connect_list_deliver_units',
  { organization_slug: z.string(), opportunity_id: z.string() },
  async (args) => json(await serialize(async () => (await client()).listDeliverUnits(args)))
);

server.tool('connect_create_payment_unit',
  {
    organization_slug: z.string(),
    opportunity_id: z.string(),
    name: z.string(),
    description: z.string(),
    amount: z.coerce.number(),
    max_total: z.coerce.number().int().optional(),
    max_daily: z.coerce.number().int().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    required_deliver_unit_ids: z.array(z.coerce.number().int()),
    optional_deliver_unit_ids: z.array(z.coerce.number().int()).optional(),
  },
  async (args) => json(await serialize(async () => (await client()).createPaymentUnit(args)))
);

server.tool('connect_list_payment_units',
  { organization_slug: z.string(), opportunity_id: z.string() },
  async (args) => json(await serialize(async () => (await client()).listPaymentUnits(args)))
);

server.tool('connect_activate_opportunity',
  { organization_slug: z.string(), opportunity_id: z.string() },
  async (args) => json(await serialize(async () => (await client()).activateOpportunity(args)))
);

// ── Invites ──────────────────────────────────────────────────────

server.tool('connect_send_llo_invite',
  {
    organization_slug: z.string(),
    opportunity_id: z.string(),
    organization_name: z.string(),
    contact_email: z.string().email(),
  },
  async (args) => json(await serialize(async () => (await client()).sendLloInvite(args)))
);

server.tool('connect_list_invites',
  { organization_slug: z.string(), opportunity_id: z.string() },
  async (args) => json(await serialize(async () => (await client()).listInvites(args)))
);

// ── Invoices ─────────────────────────────────────────────────────

server.tool('connect_list_invoices',
  { organization_slug: z.string(), opportunity_id: z.string() },
  async (args) => json(await serialize(async () => (await client()).listInvoices(args)))
);

server.tool('connect_get_invoice',
  { organization_slug: z.string(), invoice_id: z.string() },
  async (args) => json(await serialize(async () => (await client()).getInvoice(args)))
);

await server.connect(new StdioServerTransport());
