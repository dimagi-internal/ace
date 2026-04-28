# ACE Connect MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `ace-connect`, a sibling MCP to `ace-ocs` that exposes 16 atomic Connect capabilities (Programs, Opportunities, verification/delivery/payment units, activation, invites, invoices) backed by a CompositeBackend that routes each atom to either REST (when those endpoints land) or Playwright (today).

**Architecture:** Mirror `mcp/ocs/` byte-for-byte. Sixteen atoms in `mcp/connect/capability-map.ts`; today every authoring atom routes to a headless HTTP-only Playwright backend that drives `connect.dimagi.com` under `ace@dimagi-ai.com` via OAuth-via-CommCare-HQ. Observation atoms scrape HTMX list/detail pages. When real REST endpoints land, the route line in `capability-map.ts` flips one atom at a time.

**Tech Stack:** TypeScript (ESM, `npx tsx` direct), `@modelcontextprotocol/sdk`, `playwright` (HTTP-only via `page.request`), `vitest`, 1Password-backed `.env`.

**Reference:** Spec at `docs/superpowers/specs/2026-04-28-ace-connect-mcp-design.md`. Pattern source at `mcp/ocs/`. Skill consumers documented in `playbook/integrations/connect-api.md` (rewrite this doc when atoms ship).

**Worktree:** This plan executes in `~/emdash/worktrees/ace/emdash/ccc-mcp-l2kjv/` on branch `emdash/ccc-mcp-l2kjv`.

**Testing strategy:** Pure functions (HTML scrape helpers, capability map) are unit-tested against fixtures captured from live Connect. Integration tests are gated on `CONNECT_INTEGRATION=1` plus a live session and run end-to-end against prod with name-prefix isolation (`ACE-MCP-Test-<timestamp>`).

**Commit strategy:** Each task ends with a commit. Branch is `emdash/ccc-mcp-l2kjv` (already current). VERSION is bumped once at the end (Task 22).

---

## File Structure

```
mcp/
  connect-server.ts                             # NEW — MCP entrypoint, registers 16 tools
  connect/                                      # NEW
    capability-map.ts
    client.ts
    types.ts
    errors.ts
    logging.ts                                  # lifted from ocs/logging.ts
    auth/
      playwright-session.ts
      hq-oauth-login.ts
    backends/
      rest.ts
      playwright.ts
      composite.ts
commands/
  connect-login.md                              # NEW — mirror of ocs-login.md
scripts/
  probe-connect-login.ts                        # NEW — durable HQ-OAuth flow probe
  probe-connect-programs.ts                     # NEW — captures programs list HTML
  probe-connect-opportunity.ts                  # NEW — captures opp create+detail HTML
  probe-connect-invoice.ts                      # NEW — captures invoices HTML
test/
  mcp/connect/
    unit/
      capability-map.test.ts
      html-scrape.test.ts
      errors.test.ts
    integration/
      e2e.integration.test.ts
  fixtures/connect-html/                        # captured snapshots from probe scripts
.env.tpl                                        # MODIFIED — add HQ + Connect vars
.claude-plugin/plugin.json                      # MODIFIED — add ace-connect MCP entry
bin/ace-doctor                                  # MODIFIED — add Connect block
playbook/integrations/connect-api.md            # MODIFIED — flip "blocked" → "covered by ace-connect"
VERSION                                         # MODIFIED — bump
```

---

## Task 1: Bootstrap directories + env config

**Files:**
- Create: `mcp/connect/` (empty dir, populated by later tasks)
- Modify: `.env.tpl`

- [ ] **Step 1: Add Connect + HQ env vars to `.env.tpl`**

Append this block at the bottom of `.env.tpl`:

```
# ── Connect (ace-connect MCP) ────────────────────────────────────────
#
# ace-connect drives connect.dimagi.com through an authenticated browser
# session belonging to ace@dimagi-ai.com. Login is OAuth-via-CommCare-HQ:
# Connect bounces to HQ; HQ accepts these creds; HQ redirects back.
#
# When real Connect REST APIs land (CCC-301 + invite + invoice), individual
# atoms flip from PLAYWRIGHT to REST in mcp/connect/capability-map.ts.

CONNECT_BASE_URL=https://connect.dimagi.com

# CommCare HQ credentials for the ACE service account. ace-connect drives
# the HQ OAuth flow with these to mint a Connect session cookie.
ACE_HQ_USERNAME=op://AI-Agents/ACE - CommCare HQ/username
ACE_HQ_PASSWORD=op://AI-Agents/ACE - CommCare HQ/password
```

- [ ] **Step 2: Verify 1Password resolves the new refs**

Run: `op inject -i .env.tpl -o /tmp/connect-env-check --account dimagi.1password.com 2>&1 | tail -10`
Expected: file written, no `[ERROR] item not found`. If 1Password item names differ, update the refs to match. If the item doesn't exist yet, create it in the AI-Agents vault (item type: Login, fields `username`, `password`) before proceeding.

- [ ] **Step 3: Inject .env for local dev**

Run: `op inject -i .env.tpl -o .env --account dimagi.1password.com`
Expected: succeeds; `grep CONNECT_BASE_URL .env` returns the URL.

- [ ] **Step 4: Commit**

```bash
git add .env.tpl
git commit -m "feat(connect): add Connect + HQ env vars to .env.tpl"
```

---

## Task 2: Errors + types

**Files:**
- Create: `mcp/connect/errors.ts`
- Create: `mcp/connect/types.ts`
- Create: `test/mcp/connect/unit/errors.test.ts`

- [ ] **Step 1: Write failing tests for error classes**

Create `test/mcp/connect/unit/errors.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  ConnectError,
  SessionExpiredError,
  CsrfTokenMissingError,
  HttpError,
  ConnectValidationError,
} from '../../../../mcp/connect/errors.js';

describe('connect errors', () => {
  it('SessionExpiredError mentions the connect-login command', () => {
    const err = new SessionExpiredError();
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/connect-login/);
  });

  it('CsrfTokenMissingError is retryable', () => {
    expect(new CsrfTokenMissingError().retryable).toBe(true);
  });

  it('HttpError carries status + path + body and is retryable on 5xx/429', () => {
    expect(new HttpError(503, '/api/foo', 'down').retryable).toBe(true);
    expect(new HttpError(429, '/api/foo', 'slow').retryable).toBe(true);
    expect(new HttpError(404, '/api/foo', 'no').retryable).toBe(false);
    expect(new HttpError(400, '/api/foo', 'bad').message).toMatch(/HTTP 400/);
  });

  it('ConnectValidationError aggregates messages', () => {
    const err = new ConnectValidationError(['name required', 'budget must be positive']);
    expect(err.message).toMatch(/name required/);
    expect(err.message).toMatch(/budget must be positive/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mcp/connect/unit/errors.test.ts`
Expected: FAIL — `Cannot find module '../../../../mcp/connect/errors.js'`

- [ ] **Step 3: Implement `mcp/connect/errors.ts`**

```typescript
export class ConnectError extends Error {
  retryable = false;
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class SessionExpiredError extends ConnectError {
  constructor() {
    super('Connect session expired. Run `/ace:connect-login` to re-authenticate.');
  }
}

export class CsrfTokenMissingError extends ConnectError {
  retryable = true;
  constructor() {
    super('CSRF token missing or stale; refetching.');
  }
}

export class HttpError extends ConnectError {
  constructor(public status: number, public path: string, public body: string) {
    super(`HTTP ${status} ${path}: ${body.slice(0, 200)}`);
    this.retryable = status >= 500 || status === 429;
  }
}

export class ConnectValidationError extends ConnectError {
  constructor(public validationErrors: string[]) {
    super(`Connect rejected request: ${validationErrors.join('; ')}`);
  }
}
```

- [ ] **Step 4: Implement `mcp/connect/types.ts`**

```typescript
// Connect domain types. snake_case at the HTTP boundary (matches eventual REST);
// camelCase for TS-internal helpers. Field names mirror what we observe on the
// Connect server templates and what CCC-301 is expected to expose.

export interface Program {
  id: number;
  name: string;
  description?: string;
  organization_id?: number;
}

export interface Opportunity {
  id: number;
  program_id: number;
  name: string;
  description?: string;
  start_date?: string;   // ISO YYYY-MM-DD
  end_date?: string;
  total_budget?: number;
  currency?: string;
  status: 'draft' | 'active' | 'completed' | 'cancelled';
}

export interface VerificationRule {
  rule_type: 'gps_accuracy' | 'photo_required' | 'duplicate_check' | 'form_field_required';
  config: Record<string, unknown>;
}

export interface DeliveryUnit {
  id?: number;
  name: string;
  app_form_xmlns?: string;     // CommCare form unique id this delivery unit corresponds to
  max_per_day?: number;
  max_total?: number;
}

export interface PaymentUnit {
  id?: number;
  name: string;
  amount: number;             // base currency units
  delivery_unit_ids: number[];  // which delivery units must be completed for this payment
  required_count?: number;
}

export interface Invite {
  id: number;
  opportunity_id: number;
  organization_name: string;
  organization_id?: number;
  contact_email: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  sent_at?: string;
}

export interface Invoice {
  id: number;
  opportunity_id: number;
  organization_name: string;
  amount: number;
  currency: string;
  status: 'draft' | 'pending' | 'paid' | 'cancelled';
  period_start?: string;
  period_end?: string;
  created_at?: string;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/mcp/connect/unit/errors.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add mcp/connect/errors.ts mcp/connect/types.ts test/mcp/connect/unit/errors.test.ts
git commit -m "feat(connect): add error classes + domain types"
```

---

## Task 3: Capability map

**Files:**
- Create: `mcp/connect/capability-map.ts`
- Create: `test/mcp/connect/unit/capability-map.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/mcp/connect/unit/capability-map.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { CAPABILITY_MAP } from '../../../../mcp/connect/capability-map.js';

describe('connect capability map', () => {
  it('has 16 atoms', () => {
    expect(Object.keys(CAPABILITY_MAP)).toHaveLength(16);
  });

  it('every atom routes to PLAYWRIGHT or REST and has a documented restTarget', () => {
    for (const [name, route] of Object.entries(CAPABILITY_MAP)) {
      expect(['PLAYWRIGHT', 'REST'], `${name} backend`).toContain(route.backend);
      expect(route.restTarget, `${name} restTarget`).toMatch(/^(GET|POST|PATCH|PUT|DELETE) /);
    }
  });

  it('has the nine authoring atoms for the six blocked skills', () => {
    const authoring = [
      'create_program', 'update_program',
      'create_opportunity', 'update_opportunity',
      'set_verification_rules', 'set_delivery_units', 'set_payment_units',
      'activate_opportunity',
      'send_llo_invite',
    ];
    for (const a of authoring) expect(CAPABILITY_MAP).toHaveProperty(a);
  });

  it('has the seven observation atoms', () => {
    const observation = [
      'list_programs', 'get_program',
      'list_opportunities', 'get_opportunity',
      'list_invites',
      'list_invoices', 'get_invoice',
    ];
    for (const o of observation) expect(CAPABILITY_MAP).toHaveProperty(o);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run test/mcp/connect/unit/capability-map.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mcp/connect/capability-map.ts`**

```typescript
export type Backend = 'REST' | 'PLAYWRIGHT';

export interface CapabilityRoute {
  backend: Backend;
  restTarget: string; // eventual REST endpoint, documentation only
}

export type Capability =
  // Authoring (9)
  | 'create_program'
  | 'update_program'
  | 'create_opportunity'
  | 'update_opportunity'
  | 'set_verification_rules'
  | 'set_delivery_units'
  | 'set_payment_units'
  | 'activate_opportunity'
  | 'send_llo_invite'
  // Observation (7)
  | 'list_programs'
  | 'get_program'
  | 'list_opportunities'
  | 'get_opportunity'
  | 'list_invites'
  | 'list_invoices'
  | 'get_invoice';

export const CAPABILITY_MAP: Record<Capability, CapabilityRoute> = {
  // Authoring — Playwright today, REST targets are documentation-only
  create_program:           { backend: 'PLAYWRIGHT', restTarget: 'POST /api/programs/' },
  update_program:           { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/programs/{id}/' },
  create_opportunity:       { backend: 'PLAYWRIGHT', restTarget: 'POST /api/opportunities/' },
  update_opportunity:       { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/opportunities/{id}/' },
  set_verification_rules:   { backend: 'PLAYWRIGHT', restTarget: 'PUT /api/opportunities/{id}/verification/' },
  set_delivery_units:       { backend: 'PLAYWRIGHT', restTarget: 'PUT /api/opportunities/{id}/delivery-units/' },
  set_payment_units:        { backend: 'PLAYWRIGHT', restTarget: 'PUT /api/opportunities/{id}/payment-units/' },
  activate_opportunity:     { backend: 'PLAYWRIGHT', restTarget: 'POST /api/opportunities/{id}/activate/' },
  send_llo_invite:          { backend: 'PLAYWRIGHT', restTarget: 'POST /api/opportunities/{id}/invites/' },

  // Observation — Playwright today (HTML scrapes), REST when available
  list_programs:            { backend: 'PLAYWRIGHT', restTarget: 'GET /api/programs/' },
  get_program:              { backend: 'PLAYWRIGHT', restTarget: 'GET /api/programs/{id}/' },
  list_opportunities:       { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/' },
  get_opportunity:          { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/' },
  list_invites:             { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/invites/' },
  list_invoices:            { backend: 'PLAYWRIGHT', restTarget: 'GET /api/opportunities/{id}/invoices/' },
  get_invoice:              { backend: 'PLAYWRIGHT', restTarget: 'GET /api/invoices/{id}/' },
};
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/mcp/connect/unit/capability-map.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/connect/capability-map.ts test/mcp/connect/unit/capability-map.test.ts
git commit -m "feat(connect): add 16-atom capability map"
```

---

## Task 4: Client interface

**Files:**
- Create: `mcp/connect/client.ts`

- [ ] **Step 1: Implement `mcp/connect/client.ts`**

This is the contract every backend implements. No tests yet — it's just types; tests come with backend impls.

```typescript
import type {
  Program,
  Opportunity,
  VerificationRule,
  DeliveryUnit,
  PaymentUnit,
  Invite,
  Invoice,
} from './types.js';

export interface ConnectClient {
  // Programs
  listPrograms(args: { name?: string }): Promise<{ programs: Program[] }>;
  getProgram(args: { program_id: number }): Promise<Program>;
  createProgram(args: { name: string; description?: string; organization_id?: number }): Promise<Program>;
  updateProgram(args: { program_id: number; name?: string; description?: string }): Promise<Program>;

  // Opportunities
  listOpportunities(args: { program_id?: number; name?: string }): Promise<{ opportunities: Opportunity[] }>;
  getOpportunity(args: { opportunity_id: number }): Promise<Opportunity>;
  createOpportunity(args: {
    program_id: number;
    name: string;
    description?: string;
    start_date?: string;
    end_date?: string;
    total_budget?: number;
    currency?: string;
  }): Promise<Opportunity>;
  updateOpportunity(args: {
    opportunity_id: number;
    name?: string;
    description?: string;
    start_date?: string;
    end_date?: string;
    total_budget?: number;
  }): Promise<Opportunity>;

  // Configuration sub-objects
  setVerificationRules(args: { opportunity_id: number; rules: VerificationRule[] }): Promise<{ ok: true }>;
  setDeliveryUnits(args: { opportunity_id: number; units: DeliveryUnit[] }): Promise<{ ok: true; units: DeliveryUnit[] }>;
  setPaymentUnits(args: { opportunity_id: number; units: PaymentUnit[] }): Promise<{ ok: true; units: PaymentUnit[] }>;

  // Lifecycle
  activateOpportunity(args: { opportunity_id: number }): Promise<{ ok: true; status: 'active' }>;

  // Invites
  sendLloInvite(args: {
    opportunity_id: number;
    organization_name: string;
    contact_email: string;
  }): Promise<Invite>;
  listInvites(args: { opportunity_id: number }): Promise<{ invites: Invite[] }>;

  // Invoices
  listInvoices(args: { opportunity_id: number }): Promise<{ invoices: Invoice[] }>;
  getInvoice(args: { invoice_id: number }): Promise<Invoice>;
}
```

- [ ] **Step 2: Compile-check**

Run: `npx tsc --noEmit`
Expected: no errors. (If errors are unrelated to connect/, ignore — Connect adds nothing yet.)

- [ ] **Step 3: Commit**

```bash
git add mcp/connect/client.ts
git commit -m "feat(connect): add ConnectClient interface"
```

---

## Task 5: Logging proxy (lift from OCS)

**Files:**
- Create: `mcp/connect/logging.ts`

- [ ] **Step 1: Lift `mcp/ocs/logging.ts` and rename**

Read `mcp/ocs/logging.ts` and write `mcp/connect/logging.ts` as a near-copy. Rename:
- The log filename pattern from `ocs-<date>.jsonl` to `connect-<date>.jsonl`.
- Any `OcsClient` references in JSDoc to `ConnectClient`.

Don't change the proxy mechanics — they're domain-agnostic.

- [ ] **Step 2: Compile-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add mcp/connect/logging.ts
git commit -m "feat(connect): add logging proxy (lifted from ocs)"
```

---

## Task 6: Probe — login flow + Programs page

**Files:**
- Create: `scripts/probe-connect-login.ts`
- Create: `scripts/probe-connect-programs.ts`
- Create: `test/fixtures/connect-html/programs-list.html`
- Create: `test/fixtures/connect-html/program-create-form.html`

This task is investigative. Probes are durable reproducers — they document live-server contract and can be re-run when Connect templates change.

- [ ] **Step 1: Write `scripts/probe-connect-login.ts`**

```typescript
// Probe: drive the connect.dimagi.com → CommCare HQ OAuth flow programmatically
// using ACE_HQ_USERNAME / ACE_HQ_PASSWORD from .env. Saves the resulting
// Connect storageState to ~/.ace/connect-session.json. Used to validate
// open-question 1 from the design spec ("does HQ accept programmatic POST?").
//
// Run: npx tsx scripts/probe-connect-login.ts

import 'dotenv/config';
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const baseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
const hqUser = process.env.ACE_HQ_USERNAME;
const hqPass = process.env.ACE_HQ_PASSWORD;
if (!hqUser || !hqPass) throw new Error('ACE_HQ_USERNAME and ACE_HQ_PASSWORD must be set in .env');

const stateFile = path.join(os.homedir(), '.ace', 'connect-session.json');

const browser = await chromium.launch({ headless: false });   // headed first so we can watch
const context = await browser.newContext({ baseURL: baseUrl });
const page = await context.newPage();

await page.goto('/');
console.log('Initial URL:', page.url());

// Click whatever auth button or link Connect renders. Try common selectors;
// fall back to manual sign-in window if the click chain doesn't carry us.
const candidates = [
  'a:has-text("Sign in with CommCare")',
  'button:has-text("Sign in with CommCare")',
  'a:has-text("Login with CommCare")',
  'a:has-text("CommCare HQ")',
];
for (const sel of candidates) {
  const el = await page.$(sel);
  if (el) { await el.click(); break; }
}

// If we're on accounts.commcarehq.org or commcarehq.org/accounts/login, fill creds
const url = page.url();
if (/commcarehq\.org/.test(url)) {
  await page.fill('input[name="auth-username"], input[name="username"]', hqUser);
  await page.fill('input[name="auth-password"], input[name="password"]', hqPass);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
}

console.log('Final URL after login attempt:', page.url());
console.log('Cookies:', (await context.cookies()).map((c) => `${c.domain}/${c.name}`));

fs.mkdirSync(path.dirname(stateFile), { recursive: true });
await context.storageState({ path: stateFile });
console.log(`storageState saved to ${stateFile}`);

await browser.close();
```

- [ ] **Step 2: Run the login probe**

Run: `npx tsx scripts/probe-connect-login.ts`

Watch the headed browser. **Record what you observe** in a comment block at the bottom of `probe-connect-login.ts` ("Observations 2026-04-28: ...") — at minimum:
- Does Connect bounce automatically to HQ, or does it show its own login form? (The login probe earlier showed `<form method="post">` with username + password inputs — Connect may have local accounts AND/OR an HQ button. Find out.)
- What's the cookie name Connect drops after login (`sessionid`? `connect_session`?)
- Does HQ accept programmatic POST, or does it have JS-driven validation?

If automated login worked, `~/.ace/connect-session.json` exists and re-running with `headless: true` succeeds. If it didn't (e.g. SSO redirect loop, JS-only form), record that and proceed — we still have the manual `/ace:connect-login` fallback in Task 7.

- [ ] **Step 3: Write `scripts/probe-connect-programs.ts`**

```typescript
// Probe: capture the HTML of the programs list page and the program-create
// form so we can write deterministic regex helpers against fixtures.
// Requires a valid ~/.ace/connect-session.json from probe-connect-login.ts.
//
// Run: npx tsx scripts/probe-connect-programs.ts

import 'dotenv/config';
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const baseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
const stateFile = path.join(os.homedir(), '.ace', 'connect-session.json');
if (!fs.existsSync(stateFile)) throw new Error(`Run probe-connect-login.ts first; ${stateFile} missing`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '../test/fixtures/connect-html');
fs.mkdirSync(fixturesDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: stateFile, baseURL: baseUrl });

// Likely paths — adjust based on what Connect's nav exposes. Try /a/<org>/programs/
// or /programs/ first; iterate if 404.
const candidates = ['/programs/', '/a/admin/programs/', '/admin/programs/'];
for (const p of candidates) {
  const r = await ctx.request.get(p);
  console.log(p, '→', r.status());
  if (r.status() === 200) {
    const html = await r.text();
    fs.writeFileSync(path.join(fixturesDir, 'programs-list.html'), html);
    console.log('Saved programs-list.html (', html.length, 'bytes)');
    break;
  }
}

const formCandidates = ['/programs/new/', '/programs/create/', '/admin/programs/new/'];
for (const p of formCandidates) {
  const r = await ctx.request.get(p);
  console.log(p, '→', r.status());
  if (r.status() === 200) {
    const html = await r.text();
    fs.writeFileSync(path.join(fixturesDir, 'program-create-form.html'), html);
    console.log('Saved program-create-form.html (', html.length, 'bytes)');
    break;
  }
}

await browser.close();
```

- [ ] **Step 4: Run the programs probe**

Run: `npx tsx scripts/probe-connect-programs.ts`
Expected: at least `programs-list.html` written; `program-create-form.html` written if a separate page exists (some Django apps post directly to the list URL with form params).

If neither candidate URL works, open the live Connect site in a browser logged in as ace@dimagi-ai.com, find the actual programs URL by hand, update the candidates list, re-run.

- [ ] **Step 5: Inspect the fixtures**

Run:
```bash
grep -c 'program' test/fixtures/connect-html/programs-list.html
head -100 test/fixtures/connect-html/programs-list.html
grep -E 'csrfmiddlewaretoken|<input|<form' test/fixtures/connect-html/program-create-form.html | head -30
```

Record observations as comments at the top of `scripts/probe-connect-programs.ts`:
- The id/class on the table row that wraps each program (e.g. `<tr id="record-42">`)
- The form action URL and required hidden fields
- Whether names are in `<a>` text, `<td class="name">`, etc.

- [ ] **Step 6: Commit**

```bash
git add scripts/probe-connect-login.ts scripts/probe-connect-programs.ts test/fixtures/connect-html/
git commit -m "feat(connect): add login + programs probes; capture HTML fixtures"
```

---

## Task 7: `/ace:connect-login` command (manual fallback)

**Files:**
- Create: `commands/connect-login.md`

- [ ] **Step 1: Mirror `commands/ocs-login.md`**

Copy `commands/ocs-login.md` to `commands/connect-login.md`, then s/ocs/connect/g across:
- frontmatter `name`, `description`
- `OCS_BASE_URL` → `CONNECT_BASE_URL`
- `OCS_TEAM_SLUG` → (delete; Connect doesn't have team slugs)
- `ocs-session-${teamSlug}.json` → `connect-session.json`
- The auth probe URL `/a/${teamSlug}/chatbots/` → just `/` (anything that 200s when authed and 302s when not).

- [ ] **Step 2: Verify the embedded `/tmp/connect-login.ts` script runs**

Run: copy the heredoc body from the new command file to `/tmp/connect-login.ts` and run `npx tsx /tmp/connect-login.ts`. Sign in manually (or use the saved session from Task 6's automated probe). Press enter; check `~/.ace/connect-session.json` exists.

- [ ] **Step 3: Commit**

```bash
git add commands/connect-login.md
git commit -m "feat(connect): add /ace:connect-login command (manual fallback)"
```

---

## Task 8: PlaywrightSession + automated HQ-OAuth login

**Files:**
- Create: `mcp/connect/auth/playwright-session.ts`
- Create: `mcp/connect/auth/hq-oauth-login.ts`

- [ ] **Step 1: Implement `mcp/connect/auth/playwright-session.ts`**

Pattern is identical to `mcp/ocs/auth/playwright-session.ts`. Differences:
- `stateFile()` returns `~/.ace/connect-session.json` (no team slug suffix).
- Auth probe URL is `/` (or whatever the login probe in Task 6 confirms is a reliable authed-only endpoint).
- On `SessionExpiredError`, before throwing, attempt automated re-login via `hqOAuthLogin()` from `hq-oauth-login.ts` if `ACE_HQ_USERNAME` + `ACE_HQ_PASSWORD` are set. Throw only if that also fails.

Code:

```typescript
import { chromium, type BrowserContext, type Browser } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionExpiredError } from '../errors.js';
import { hqOAuthLogin } from './hq-oauth-login.js';

export interface SessionOptions {
  baseUrl: string;
  stateDir?: string;
  hqUsername?: string;
  hqPassword?: string;
}

export interface Cookie { name: string; value: string }

export function extractCsrfToken(cookies: readonly Cookie[]): string | undefined {
  return cookies.find((c) => c.name === 'csrftoken')?.value;
}

export class PlaywrightSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private csrfToken?: string;

  constructor(private opts: SessionOptions) {}

  private stateFile(): string {
    const dir = this.opts.stateDir ?? path.join(os.homedir(), '.ace');
    return path.join(dir, 'connect-session.json');
  }

  async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    const statePath = this.stateFile();
    let storageState = fs.existsSync(statePath) ? statePath : undefined;

    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({ storageState, baseURL: this.opts.baseUrl });

    // Probe for authed access. If 302/401/403, attempt automated re-login once.
    const probeRes = await this.context.request.get('/');
    if ([302, 401, 403].includes(probeRes.status())) {
      if (this.opts.hqUsername && this.opts.hqPassword) {
        await hqOAuthLogin({
          context: this.context,
          baseUrl: this.opts.baseUrl,
          hqUsername: this.opts.hqUsername,
          hqPassword: this.opts.hqPassword,
        });
        // Re-probe
        const retry = await this.context.request.get('/');
        if ([302, 401, 403].includes(retry.status())) throw new SessionExpiredError();
      } else {
        throw new SessionExpiredError();
      }
    }

    const cookies = await this.context.cookies();
    this.csrfToken = extractCsrfToken(cookies);

    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    await this.context.storageState({ path: statePath });

    return this.context;
  }

  getCsrfToken(): string {
    if (!this.csrfToken) throw new Error('CSRF token not available — call getContext() first');
    return this.csrfToken;
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }
}
```

- [ ] **Step 2: Implement `mcp/connect/auth/hq-oauth-login.ts`**

Translate the working flow from `scripts/probe-connect-login.ts` (recorded in Task 6) into a programmatic function. Use the exact selector that worked in the probe — don't generalize.

```typescript
import type { BrowserContext } from 'playwright';

export interface HqOAuthLoginOptions {
  context: BrowserContext;
  baseUrl: string;          // Connect base URL
  hqUsername: string;
  hqPassword: string;
}

/**
 * Drive the Connect → CommCare HQ OAuth flow with the supplied creds.
 * On success, the BrowserContext's cookie jar contains a valid Connect session.
 *
 * Selectors below match what `scripts/probe-connect-login.ts` confirmed on
 * 2026-04-28. If Connect or HQ change their login templates, the probe is
 * the canonical reproducer — re-run it, update both the probe-observed
 * notes and these selectors.
 */
export async function hqOAuthLogin(opts: HqOAuthLoginOptions): Promise<void> {
  const page = await opts.context.newPage();
  try {
    // 1. Hit Connect root → bounces to login page (or HQ)
    await page.goto(opts.baseUrl);

    // 2. Click "Sign in with CommCare" if present (TODO: confirm exact selector
    //    from probe observations and replace this candidate list with the one
    //    that works).
    const candidates = [
      'a:has-text("Sign in with CommCare")',
      'a:has-text("Login with CommCare")',
      'button:has-text("CommCare HQ")',
    ];
    for (const sel of candidates) {
      const el = await page.$(sel);
      if (el) { await el.click(); break; }
    }

    // 3. On HQ login form, fill creds + submit
    if (/commcarehq\.org/.test(page.url())) {
      await page.waitForSelector('input[name="auth-username"], input[name="username"]');
      await page.fill('input[name="auth-username"], input[name="username"]', opts.hqUsername);
      await page.fill('input[name="auth-password"], input[name="password"]', opts.hqPassword);
      await page.click('button[type="submit"]');
      await page.waitForLoadState('networkidle');
    }

    // 4. Verify we're back at Connect with a session cookie
    if (!/connect\.dimagi\.com/.test(page.url())) {
      throw new Error(`HQ-OAuth login did not return to Connect; ended at ${page.url()}`);
    }
  } finally {
    await page.close();
  }
}
```

- [ ] **Step 3: Compile-check**

Run: `npx tsc --noEmit`
Expected: no errors in `mcp/connect/`.

- [ ] **Step 4: Smoke test the automated login end-to-end**

Run a one-liner that delete-and-re-creates the session purely from creds:

```bash
rm ~/.ace/connect-session.json && \
npx tsx -e "import 'dotenv/config'; \
  const { PlaywrightSession } = await import('./mcp/connect/auth/playwright-session.js'); \
  const s = new PlaywrightSession({ \
    baseUrl: process.env.CONNECT_BASE_URL, \
    hqUsername: process.env.ACE_HQ_USERNAME, \
    hqPassword: process.env.ACE_HQ_PASSWORD \
  }); \
  await s.getContext(); \
  console.log('CSRF:', s.getCsrfToken()); \
  await s.close();"
```

Expected: prints a CSRF token and exits 0. If it fails, the selectors in `hq-oauth-login.ts` need to match Task 6's observations exactly.

- [ ] **Step 5: Commit**

```bash
git add mcp/connect/auth/
git commit -m "feat(connect): add Playwright session + automated HQ-OAuth login"
```

---

## Task 9: HTML scrape helpers + unit tests

**Files:**
- Create: `mcp/connect/backends/html-scrape.ts`
- Create: `test/mcp/connect/unit/html-scrape.test.ts`

- [ ] **Step 1: Write failing tests against fixtures**

Create `test/mcp/connect/unit/html-scrape.test.ts`. Each helper has one test that loads the actual fixture file and asserts the parser returns the expected count/values.

The exact field names + counts depend on what's in your captured `programs-list.html`. Use the head/grep output from Task 6 step 5 to fill these in concretely. Replace placeholders (`<EXPECTED_PROGRAM_NAME>`, `<EXPECTED_COUNT>`) with what's in your fixture.

```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  extractCsrfToken,
  extractFormFieldNames,
  parseProgramsTable,
  extractProgramIdFromLocation,
} from '../../../../mcp/connect/backends/html-scrape.js';

const fix = (name: string) =>
  fs.readFileSync(path.join(__dirname, '../../../fixtures/connect-html', name), 'utf8');

describe('extractCsrfToken', () => {
  it('extracts the csrfmiddlewaretoken value', () => {
    const html = '<input type="hidden" name="csrfmiddlewaretoken" value="abc123def">';
    expect(extractCsrfToken(html)).toBe('abc123def');
  });
  it('returns undefined when no token present', () => {
    expect(extractCsrfToken('<div>nope</div>')).toBeUndefined();
  });
});

describe('parseProgramsTable', () => {
  it('parses every program row from the live fixture', () => {
    const html = fix('programs-list.html');
    const map = parseProgramsTable(html);
    // Replace these with the ground-truth values you recorded in Task 6.
    expect(map.size).toBeGreaterThanOrEqual(1);
    // expect(map.get('<EXPECTED_PROGRAM_NAME>')).toBe(<EXPECTED_INTEGER_ID>);
  });
});

describe('extractProgramIdFromLocation', () => {
  it('extracts the integer id from a redirect Location after POST /create/', () => {
    expect(extractProgramIdFromLocation('/programs/42/')).toBe(42);
    expect(extractProgramIdFromLocation('/programs/42/edit/')).toBe(42);
    expect(extractProgramIdFromLocation('/no-match/')).toBeUndefined();
  });
});

describe('extractFormFieldNames', () => {
  it('returns the names of all <input>, <select>, <textarea> in a form', () => {
    const html = fix('program-create-form.html');
    const names = extractFormFieldNames(html);
    expect(names).toContain('csrfmiddlewaretoken');
    expect(names).toContain('name');
  });
});
```

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run test/mcp/connect/unit/html-scrape.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mcp/connect/backends/html-scrape.ts`**

```typescript
/**
 * HTML-scrape helpers for the Playwright backend.
 *
 * Each helper is a pure function with a unit test against a captured Connect
 * fixture in test/fixtures/connect-html/. When Connect changes a template
 * upstream, the corresponding regex test fails first — the integration tests
 * don't have to.
 */

/** Extract the csrfmiddlewaretoken value from a Django form HTML. */
export function extractCsrfToken(html: string): string | undefined {
  const m = html.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/);
  return m?.[1];
}

/**
 * Parse a Connect programs-list page into a `name → id` map.
 *
 * The exact regex below depends on Connect's template — fill in based on the
 * fixture inspection from Task 6. Default form: each row has
 * `<tr id="record-<int>"> ... <a ...>NAME</a> ... </tr>` (this is the OCS
 * pattern; if Connect uses different markup, adjust).
 */
export function parseProgramsTable(html: string): Map<string, number> {
  const map = new Map<string, number>();
  const rowRegex = /id="record-(\d+)"[\s\S]*?<a [^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(rowRegex)) {
    const id = Number(m[1]);
    const name = m[2].replace(/<[^>]+>/g, '').trim();
    if (name && Number.isFinite(id)) map.set(name, id);
  }
  return map;
}

/** Extract integer id from a redirect Location like `/programs/42/...`. */
export function extractProgramIdFromLocation(loc: string): number | undefined {
  const m = loc.match(/\/programs\/(\d+)\//);
  return m ? Number(m[1]) : undefined;
}

/** Same shape but for opportunities. */
export function extractOpportunityIdFromLocation(loc: string): number | undefined {
  const m = loc.match(/\/opportunities\/(\d+)\//);
  return m ? Number(m[1]) : undefined;
}

/** Names of every `<input>`, `<select>`, `<textarea>` inside the first <form>. */
export function extractFormFieldNames(html: string): string[] {
  const formMatch = html.match(/<form[^>]*>([\s\S]*?)<\/form>/);
  if (!formMatch) return [];
  const body = formMatch[1];
  const names = new Set<string>();
  for (const m of body.matchAll(/<(?:input|select|textarea)[^>]*\sname="([^"]+)"/g)) {
    names.add(m[1]);
  }
  return [...names];
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run test/mcp/connect/unit/html-scrape.test.ts`
Expected: PASS. If `parseProgramsTable` size is 0, the row regex doesn't match Connect's actual markup — inspect the fixture (`grep -c 'record-' test/fixtures/connect-html/programs-list.html`), update the regex, re-run.

- [ ] **Step 5: Commit**

```bash
git add mcp/connect/backends/html-scrape.ts test/mcp/connect/unit/html-scrape.test.ts
git commit -m "feat(connect): add HTML scrape helpers with unit tests"
```

---

## Task 10: REST backend stubs

**Files:**
- Create: `mcp/connect/backends/rest.ts`

REST backend exists today as a stub so the composite can hold a reference to it. Each method throws `NotImplementedError` — when an actual REST endpoint lands for an atom, that method is fleshed out and the capability map flips.

- [ ] **Step 1: Implement `mcp/connect/backends/rest.ts`**

```typescript
import type { ConnectClient } from '../client.js';

class NotImplementedError extends Error {
  constructor(method: string) {
    super(`${method}: REST backend not implemented yet — capability map should route this atom to PLAYWRIGHT.`);
  }
}

const stub = (name: string) => () => { throw new NotImplementedError(name); };

/**
 * REST backend for ace-connect.
 *
 * Today every method throws — Connect doesn't expose the endpoints we need
 * (CCC-301 and friends are not yet shipped). When a real endpoint lands for
 * an atom, replace that method's `stub(...)` with a real fetch impl, then
 * flip the corresponding entry in `capability-map.ts` from PLAYWRIGHT to
 * REST.
 */
export class RestBackend implements ConnectClient {
  constructor(private opts: { baseUrl: string; token?: string }) {}

  listPrograms = stub('listPrograms') as ConnectClient['listPrograms'];
  getProgram = stub('getProgram') as ConnectClient['getProgram'];
  createProgram = stub('createProgram') as ConnectClient['createProgram'];
  updateProgram = stub('updateProgram') as ConnectClient['updateProgram'];
  listOpportunities = stub('listOpportunities') as ConnectClient['listOpportunities'];
  getOpportunity = stub('getOpportunity') as ConnectClient['getOpportunity'];
  createOpportunity = stub('createOpportunity') as ConnectClient['createOpportunity'];
  updateOpportunity = stub('updateOpportunity') as ConnectClient['updateOpportunity'];
  setVerificationRules = stub('setVerificationRules') as ConnectClient['setVerificationRules'];
  setDeliveryUnits = stub('setDeliveryUnits') as ConnectClient['setDeliveryUnits'];
  setPaymentUnits = stub('setPaymentUnits') as ConnectClient['setPaymentUnits'];
  activateOpportunity = stub('activateOpportunity') as ConnectClient['activateOpportunity'];
  sendLloInvite = stub('sendLloInvite') as ConnectClient['sendLloInvite'];
  listInvites = stub('listInvites') as ConnectClient['listInvites'];
  listInvoices = stub('listInvoices') as ConnectClient['listInvoices'];
  getInvoice = stub('getInvoice') as ConnectClient['getInvoice'];
}
```

- [ ] **Step 2: Compile-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add mcp/connect/backends/rest.ts
git commit -m "feat(connect): add REST backend stub (NotImplemented per atom)"
```

---

## Task 11: Playwright backend — Programs (list/get/create/update)

**Files:**
- Create: `mcp/connect/backends/playwright.ts` (start it; subsequent tasks add atoms)

Each atom has one method. Mutations: GET form → extract CSRF + hidden inputs → POST → parse Location for new id. Reads: GET list/detail → parse with helpers from Task 9.

- [ ] **Step 1: Stub `mcp/connect/backends/playwright.ts` with shared infra**

```typescript
import type { APIRequestContext } from 'playwright';
import type { ConnectClient } from '../client.js';
import type {
  Program, Opportunity, VerificationRule, DeliveryUnit, PaymentUnit, Invite, Invoice,
} from '../types.js';
import { HttpError, ConnectValidationError } from '../errors.js';
import {
  extractCsrfToken,
  parseProgramsTable,
  extractProgramIdFromLocation,
} from './html-scrape.js';

export interface PlaywrightBackendOptions {
  baseUrl: string;
  csrfToken: string;
  request: APIRequestContext;
}

/** Build an HttpError with truncated body for context. */
async function httpErrorFor(res: Awaited<ReturnType<APIRequestContext['get']>>, urlPath: string) {
  let body = '';
  try { body = await res.text(); } catch { /* swallow */ }
  return new HttpError(res.status(), urlPath, body);
}

/** Parse common Django form-error patterns from response HTML. Returns [] if none. */
function parseFormErrors(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<ul class="errorlist[^"]*"[^>]*>([\s\S]*?)<\/ul>/g)) {
    for (const li of m[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
      out.push(li[1].replace(/<[^>]+>/g, '').trim());
    }
  }
  return out;
}

export class PlaywrightBackend implements ConnectClient {
  constructor(private opts: PlaywrightBackendOptions) {}

  // ── Programs ─────────────────────────────────────────────────────

  listPrograms: ConnectClient['listPrograms'] = async ({ name } = {}) => {
    const path = '/programs/';
    const res = await this.opts.request.get(path);
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    const html = await res.text();
    const map = parseProgramsTable(html);
    let programs: Program[] = [...map.entries()].map(([n, id]) => ({ id, name: n }));
    if (name) programs = programs.filter((p) => p.name === name);
    return { programs };
  };

  getProgram: ConnectClient['getProgram'] = async ({ program_id }) => {
    const path = `/programs/${program_id}/`;
    const res = await this.opts.request.get(path);
    if (res.status() !== 200) throw await httpErrorFor(res, path);
    const html = await res.text();
    // Programs detail page should include the name in <h1> or similar; adjust regex to fixture.
    const nameMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const descMatch = html.match(/<meta name="description" content="([^"]*)"/);
    return {
      id: program_id,
      name: nameMatch?.[1].replace(/<[^>]+>/g, '').trim() ?? `program-${program_id}`,
      description: descMatch?.[1],
    };
  };

  createProgram: ConnectClient['createProgram'] = async ({ name, description }) => {
    // 1. Idempotency: check whether a program with this name already exists.
    const existing = await this.listPrograms({ name });
    if (existing.programs.length > 0) return existing.programs[0];

    // 2. POST the create form. Form action and field names confirmed via the
    //    program-create-form.html fixture in Task 6.
    const formPath = '/programs/new/';
    const formRes = await this.opts.request.get(formPath);
    if (formRes.status() !== 200) throw await httpErrorFor(formRes, formPath);
    const formHtml = await formRes.text();
    const csrf = extractCsrfToken(formHtml) ?? this.opts.csrfToken;

    const postRes = await this.opts.request.post(formPath, {
      form: {
        csrfmiddlewaretoken: csrf,
        name,
        description: description ?? '',
      },
      maxRedirects: 0,
      headers: { Referer: this.opts.baseUrl + formPath },
    });

    if (postRes.status() === 302) {
      const loc = postRes.headers()['location'] ?? '';
      const id = extractProgramIdFromLocation(loc);
      if (id == null) throw new HttpError(302, formPath, `unexpected redirect: ${loc}`);
      return { id, name, description };
    }
    if (postRes.status() === 200) {
      // Form re-rendered with errors
      const html = await postRes.text();
      const errs = parseFormErrors(html);
      throw new ConnectValidationError(errs.length ? errs : ['form rejected; no errorlist found']);
    }
    throw await httpErrorFor(postRes, formPath);
  };

  updateProgram: ConnectClient['updateProgram'] = async ({ program_id, name, description }) => {
    const formPath = `/programs/${program_id}/edit/`;
    const formRes = await this.opts.request.get(formPath);
    if (formRes.status() !== 200) throw await httpErrorFor(formRes, formPath);
    const formHtml = await formRes.text();
    const csrf = extractCsrfToken(formHtml) ?? this.opts.csrfToken;

    const current = await this.getProgram({ program_id });
    const postRes = await this.opts.request.post(formPath, {
      form: {
        csrfmiddlewaretoken: csrf,
        name: name ?? current.name,
        description: description ?? current.description ?? '',
      },
      maxRedirects: 0,
      headers: { Referer: this.opts.baseUrl + formPath },
    });
    if (postRes.status() === 302) {
      return { id: program_id, name: name ?? current.name, description: description ?? current.description };
    }
    if (postRes.status() === 200) {
      const errs = parseFormErrors(await postRes.text());
      throw new ConnectValidationError(errs);
    }
    throw await httpErrorFor(postRes, formPath);
  };

  // The remaining 12 atoms are added in Tasks 12–14. Stub them so the file
  // compiles against the ConnectClient interface.

  listOpportunities: ConnectClient['listOpportunities'] = async () => { throw new Error('TODO Task 12'); };
  getOpportunity: ConnectClient['getOpportunity'] = async () => { throw new Error('TODO Task 12'); };
  createOpportunity: ConnectClient['createOpportunity'] = async () => { throw new Error('TODO Task 12'); };
  updateOpportunity: ConnectClient['updateOpportunity'] = async () => { throw new Error('TODO Task 12'); };
  setVerificationRules: ConnectClient['setVerificationRules'] = async () => { throw new Error('TODO Task 13'); };
  setDeliveryUnits: ConnectClient['setDeliveryUnits'] = async () => { throw new Error('TODO Task 13'); };
  setPaymentUnits: ConnectClient['setPaymentUnits'] = async () => { throw new Error('TODO Task 13'); };
  activateOpportunity: ConnectClient['activateOpportunity'] = async () => { throw new Error('TODO Task 14'); };
  sendLloInvite: ConnectClient['sendLloInvite'] = async () => { throw new Error('TODO Task 14'); };
  listInvites: ConnectClient['listInvites'] = async () => { throw new Error('TODO Task 14'); };
  listInvoices: ConnectClient['listInvoices'] = async () => { throw new Error('TODO Task 14'); };
  getInvoice: ConnectClient['getInvoice'] = async () => { throw new Error('TODO Task 14'); };
}
```

- [ ] **Step 2: Compile-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add mcp/connect/backends/playwright.ts
git commit -m "feat(connect): playwright backend skeleton + Programs atoms"
```

---

## Task 12: Probe + implement Opportunities atoms

**Files:**
- Create: `scripts/probe-connect-opportunity.ts`
- Create: `test/fixtures/connect-html/opportunities-list.html`
- Create: `test/fixtures/connect-html/opportunity-create-form.html`
- Create: `test/fixtures/connect-html/opportunity-detail.html`
- Modify: `mcp/connect/backends/playwright.ts`
- Modify: `mcp/connect/backends/html-scrape.ts`
- Modify: `test/mcp/connect/unit/html-scrape.test.ts`

- [ ] **Step 1: Write the probe**

Same shape as `probe-connect-programs.ts`. Try `/opportunities/`, `/programs/<id>/opportunities/`, `/admin/opportunities/`. Save list, create form, and one detail page.

- [ ] **Step 2: Run + record observations**

Run: `npx tsx scripts/probe-connect-opportunity.ts`. Inspect fixtures; record the form action URL, field names (`program`, `name`, `start_date`, `end_date`, `total_budget`, etc.), and detail-page status indicator (look for a `data-status="..."` or status badge).

- [ ] **Step 3: Add `parseOpportunitiesTable` + `extractOpportunityStatus` to `html-scrape.ts` + tests**

Pattern matches `parseProgramsTable`. Use the row id and anchor text the way Connect's actual template renders them (which you confirmed in Step 2). For `extractOpportunityStatus`, return the `'draft' | 'active' | ...` literal from the detail page badge.

Add tests against `opportunities-list.html` and `opportunity-detail.html`.

Run: `npx vitest run test/mcp/connect/unit/html-scrape.test.ts`
Expected: all tests pass (existing + new).

- [ ] **Step 4: Replace the four `TODO Task 12` stubs in `playwright.ts`**

Implement `listOpportunities`, `getOpportunity`, `createOpportunity`, `updateOpportunity` following the Programs pattern. Form fields determined by Step 2 observations. Pre-flight idempotency on `createOpportunity` by name + program_id.

- [ ] **Step 5: Smoke-test create + read against staging or with a temp name**

Run a one-liner equivalent to Task 8 step 4 that creates `ACE-MCP-Test-<timestamp>` opportunity under an existing program, then `getOpportunity` on the returned id.

- [ ] **Step 6: Commit**

```bash
git add scripts/probe-connect-opportunity.ts test/fixtures/connect-html/opportun* mcp/connect/backends/ test/mcp/connect/unit/html-scrape.test.ts
git commit -m "feat(connect): Opportunities atoms (list/get/create/update)"
```

---

## Task 13: Probe + implement verification / delivery / payment unit atoms

**Files:**
- Create: `scripts/probe-connect-opp-config.ts`
- Create: `test/fixtures/connect-html/opp-verification-form.html`
- Create: `test/fixtures/connect-html/opp-delivery-units-form.html`
- Create: `test/fixtures/connect-html/opp-payment-units-form.html`
- Modify: `mcp/connect/backends/playwright.ts`

These are the "Verification rules / Delivery units / Payment units" sub-objects from the spec — likely three separate forms on the opportunity edit page.

- [ ] **Step 1: Probe the opportunity edit page and any sub-forms**

Likely URLs to try: `/opportunities/<id>/edit/`, `/opportunities/<id>/verification/`, `/opportunities/<id>/delivery-units/`, `/opportunities/<id>/payment-units/`. Capture each that returns 200.

If the configuration is one big form (rather than separate URLs), record that — the three atoms collapse to one HTTP round-trip but still expose three distinct API surfaces to skill consumers.

- [ ] **Step 2: Implement `setVerificationRules`, `setDeliveryUnits`, `setPaymentUnits`**

Follow the Programs/Opportunities pattern. `DeliveryUnit[]` and `PaymentUnit[]` will likely need to be serialized as repeated form fields (e.g. `units[0][name]=foo`) or a JSON blob — Connect's actual template determines the wire format.

If the form is HTMX-driven and posts JSON instead of multipart, use `request.post(path, { data: { ... }, headers: { 'Content-Type': 'application/json' } })`.

- [ ] **Step 3: Smoke-test against the test opportunity from Task 12**

Set 1 verification rule + 2 delivery units + 1 payment unit, then re-fetch the opportunity and confirm via the detail page that the configuration persisted.

- [ ] **Step 4: Commit**

```bash
git add scripts/probe-connect-opp-config.ts test/fixtures/connect-html/opp-* mcp/connect/backends/playwright.ts
git commit -m "feat(connect): verification/delivery/payment unit atoms"
```

---

## Task 14: Activate opportunity + invites + invoices

**Files:**
- Create: `scripts/probe-connect-invite.ts`
- Create: `scripts/probe-connect-invoice.ts`
- Create: `test/fixtures/connect-html/opp-activate-form.html` (if separate)
- Create: `test/fixtures/connect-html/invites-list.html`
- Create: `test/fixtures/connect-html/invite-form.html`
- Create: `test/fixtures/connect-html/invoices-list.html`
- Create: `test/fixtures/connect-html/invoice-detail.html`
- Modify: `mcp/connect/backends/playwright.ts`
- Modify: `mcp/connect/backends/html-scrape.ts`
- Modify: `test/mcp/connect/unit/html-scrape.test.ts`

- [ ] **Step 1: Probe activation, invites, invoices**

Each domain gets its own probe. Activation may be a button POST to `/opportunities/<id>/activate/` or a status-toggle form. Invites likely live at `/opportunities/<id>/invites/` (list) + `/opportunities/<id>/invites/new/` (form). Invoices at `/opportunities/<id>/invoices/` and `/invoices/<id>/`.

- [ ] **Step 2: Add scrape helpers for each new HTML shape + unit tests**

Likely additions: `parseInvitesTable`, `parseInvoicesTable`, `extractInvoiceDetail`. One unit test per helper against the captured fixture.

- [ ] **Step 3: Implement the five atoms**

`activateOpportunity`, `sendLloInvite`, `listInvites`, `listInvoices`, `getInvoice`. Same pattern.

- [ ] **Step 4: Smoke-test against the test opportunity**

End-to-end: create program → create opp → set config → invite a known test address → activate. Verify each step landed by re-reading. Skip the actual invoice creation (those are minted by Connect when payments are issued; we can only `list_*` and `get_*`).

- [ ] **Step 5: Commit**

```bash
git add scripts/probe-connect-* test/fixtures/connect-html/{opp-activate-form,invites-*,invite-form,invoices-list,invoice-detail}.html mcp/connect/backends/ test/mcp/connect/unit/html-scrape.test.ts
git commit -m "feat(connect): activate + invites + invoices atoms"
```

---

## Task 15: Composite backend

**Files:**
- Create: `mcp/connect/backends/composite.ts`
- Create: `test/mcp/connect/unit/composite.test.ts`

- [ ] **Step 1: Write a failing test that proves routing works**

Create `test/mcp/connect/unit/composite.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { CompositeBackend } from '../../../../mcp/connect/backends/composite.js';
import type { ConnectClient } from '../../../../mcp/connect/client.js';

const fakeRest: Partial<ConnectClient> = {
  listPrograms: vi.fn(async () => ({ programs: [{ id: 1, name: 'rest-result' }] })),
};

const fakePlaywright: Partial<ConnectClient> = {
  listPrograms: vi.fn(async () => ({ programs: [{ id: 2, name: 'pw-result' }] })),
  createProgram: vi.fn(async ({ name }) => ({ id: 99, name })),
};

describe('CompositeBackend', () => {
  it('routes Playwright-backed atoms to the playwright impl', async () => {
    const c = new CompositeBackend({
      rest: fakeRest as ConnectClient,
      playwright: fakePlaywright as ConnectClient,
    });
    const out = await c.listPrograms({});
    expect(out.programs[0].name).toBe('pw-result');
    expect(fakeRest.listPrograms).not.toHaveBeenCalled();
  });

  it('forwards createProgram args to the playwright impl', async () => {
    const c = new CompositeBackend({
      rest: fakeRest as ConnectClient,
      playwright: fakePlaywright as ConnectClient,
    });
    const out = await c.createProgram({ name: 'X' });
    expect(out).toEqual({ id: 99, name: 'X' });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/mcp/connect/unit/composite.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mcp/connect/backends/composite.ts`**

```typescript
import type { ConnectClient } from '../client.js';
import type { RestBackend } from './rest.js';
import type { PlaywrightBackend } from './playwright.js';

export interface CompositeOptions {
  rest: ConnectClient;       // RestBackend | a future real impl
  playwright: ConnectClient; // PlaywrightBackend
}

/**
 * Routes each ConnectClient method to either REST or Playwright per
 * capability-map.ts. Today every line points at `playwright`; when an atom's
 * REST endpoint ships, flip its dispatch line — this is the only file that
 * changes for that flip.
 */
export class CompositeBackend implements ConnectClient {
  constructor(private opts: CompositeOptions) {}

  // Programs (Playwright today)
  listPrograms = (a: Parameters<ConnectClient['listPrograms']>[0]) => this.opts.playwright.listPrograms(a);
  getProgram = (a: Parameters<ConnectClient['getProgram']>[0]) => this.opts.playwright.getProgram(a);
  createProgram = (a: Parameters<ConnectClient['createProgram']>[0]) => this.opts.playwright.createProgram(a);
  updateProgram = (a: Parameters<ConnectClient['updateProgram']>[0]) => this.opts.playwright.updateProgram(a);

  // Opportunities (Playwright today)
  listOpportunities = (a: Parameters<ConnectClient['listOpportunities']>[0]) => this.opts.playwright.listOpportunities(a);
  getOpportunity = (a: Parameters<ConnectClient['getOpportunity']>[0]) => this.opts.playwright.getOpportunity(a);
  createOpportunity = (a: Parameters<ConnectClient['createOpportunity']>[0]) => this.opts.playwright.createOpportunity(a);
  updateOpportunity = (a: Parameters<ConnectClient['updateOpportunity']>[0]) => this.opts.playwright.updateOpportunity(a);

  // Configuration sub-objects (Playwright today)
  setVerificationRules = (a: Parameters<ConnectClient['setVerificationRules']>[0]) => this.opts.playwright.setVerificationRules(a);
  setDeliveryUnits = (a: Parameters<ConnectClient['setDeliveryUnits']>[0]) => this.opts.playwright.setDeliveryUnits(a);
  setPaymentUnits = (a: Parameters<ConnectClient['setPaymentUnits']>[0]) => this.opts.playwright.setPaymentUnits(a);

  // Lifecycle (Playwright today)
  activateOpportunity = (a: Parameters<ConnectClient['activateOpportunity']>[0]) => this.opts.playwright.activateOpportunity(a);

  // Invites (Playwright today)
  sendLloInvite = (a: Parameters<ConnectClient['sendLloInvite']>[0]) => this.opts.playwright.sendLloInvite(a);
  listInvites = (a: Parameters<ConnectClient['listInvites']>[0]) => this.opts.playwright.listInvites(a);

  // Invoices (Playwright today)
  listInvoices = (a: Parameters<ConnectClient['listInvoices']>[0]) => this.opts.playwright.listInvoices(a);
  getInvoice = (a: Parameters<ConnectClient['getInvoice']>[0]) => this.opts.playwright.getInvoice(a);
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/mcp/connect/unit/composite.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp/connect/backends/composite.ts test/mcp/connect/unit/composite.test.ts
git commit -m "feat(connect): composite backend with capability-map routing"
```

---

## Task 16: MCP server entrypoint

**Files:**
- Create: `mcp/connect-server.ts`

- [ ] **Step 1: Implement the server**

This is `mcp/ocs-server.ts` adapted to Connect. Copy that file as a starting point, then:
- Replace OCS-specific imports with `mcp/connect/*`.
- Drop OCS env vars (`OCS_TEAM_SLUG`, `OCS_API_TOKEN`, etc.); use `CONNECT_BASE_URL`, `ACE_HQ_USERNAME`, `ACE_HQ_PASSWORD`.
- Replace the 22 OCS tool registrations with the 16 Connect ones below.

```typescript
/**
 * Connect MCP Server for ACE
 *
 * Exposes 16 atomic Connect capabilities as MCP tools. Delegates to a
 * CompositeBackend that routes each atom to either REST (when those endpoints
 * land) or Playwright (today, driving connect.dimagi.com under
 * ace@dimagi-ai.com via OAuth-via-CommCare-HQ).
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

// REST backend (stub today; methods throw NotImplemented)
const rest = new RestBackend({ baseUrl });

// Playwright backend — lazily initialized on first call
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

const server = new McpServer({ name: 'ace-connect', version: '0.1.0' });

// ── Programs ──────────────────────────────────────────────────────

server.tool('connect_list_programs',
  { name: z.string().optional() },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await serialize(async () => (await client()).listPrograms(args)), null, 2) }] })
);

server.tool('connect_get_program',
  { program_id: z.number().int() },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await serialize(async () => (await client()).getProgram(args)), null, 2) }] })
);

server.tool('connect_create_program',
  { name: z.string(), description: z.string().optional(), organization_id: z.number().int().optional() },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await serialize(async () => (await client()).createProgram(args)), null, 2) }] })
);

server.tool('connect_update_program',
  { program_id: z.number().int(), name: z.string().optional(), description: z.string().optional() },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await serialize(async () => (await client()).updateProgram(args)), null, 2) }] })
);

// ── Opportunities ─────────────────────────────────────────────────

server.tool('connect_list_opportunities',
  { program_id: z.number().int().optional(), name: z.string().optional() },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await serialize(async () => (await client()).listOpportunities(args)), null, 2) }] })
);

server.tool('connect_get_opportunity',
  { opportunity_id: z.number().int() },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await serialize(async () => (await client()).getOpportunity(args)), null, 2) }] })
);

server.tool('connect_create_opportunity',
  {
    program_id: z.number().int(), name: z.string(), description: z.string().optional(),
    start_date: z.string().optional(), end_date: z.string().optional(),
    total_budget: z.number().optional(), currency: z.string().optional(),
  },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await serialize(async () => (await client()).createOpportunity(args)), null, 2) }] })
);

server.tool('connect_update_opportunity',
  {
    opportunity_id: z.number().int(),
    name: z.string().optional(), description: z.string().optional(),
    start_date: z.string().optional(), end_date: z.string().optional(),
    total_budget: z.number().optional(),
  },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await serialize(async () => (await client()).updateOpportunity(args)), null, 2) }] })
);

// ── Configuration ─────────────────────────────────────────────────

const VerificationRuleZ = z.object({
  rule_type: z.enum(['gps_accuracy', 'photo_required', 'duplicate_check', 'form_field_required']),
  config: z.record(z.unknown()),
});
const DeliveryUnitZ = z.object({
  id: z.number().int().optional(),
  name: z.string(),
  app_form_xmlns: z.string().optional(),
  max_per_day: z.number().int().optional(),
  max_total: z.number().int().optional(),
});
const PaymentUnitZ = z.object({
  id: z.number().int().optional(),
  name: z.string(),
  amount: z.number(),
  delivery_unit_ids: z.array(z.number().int()),
  required_count: z.number().int().optional(),
});

server.tool('connect_set_verification_rules',
  { opportunity_id: z.number().int(), rules: z.array(VerificationRuleZ) },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await serialize(async () => (await client()).setVerificationRules(args)), null, 2) }] })
);

server.tool('connect_set_delivery_units',
  { opportunity_id: z.number().int(), units: z.array(DeliveryUnitZ) },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await serialize(async () => (await client()).setDeliveryUnits(args)), null, 2) }] })
);

server.tool('connect_set_payment_units',
  { opportunity_id: z.number().int(), units: z.array(PaymentUnitZ) },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await serialize(async () => (await client()).setPaymentUnits(args)), null, 2) }] })
);

// ── Lifecycle / invites / invoices ───────────────────────────────

server.tool('connect_activate_opportunity',
  { opportunity_id: z.number().int() },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await serialize(async () => (await client()).activateOpportunity(args)), null, 2) }] })
);

server.tool('connect_send_llo_invite',
  { opportunity_id: z.number().int(), organization_name: z.string(), contact_email: z.string().email() },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await serialize(async () => (await client()).sendLloInvite(args)), null, 2) }] })
);

server.tool('connect_list_invites',
  { opportunity_id: z.number().int() },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await serialize(async () => (await client()).listInvites(args)), null, 2) }] })
);

server.tool('connect_list_invoices',
  { opportunity_id: z.number().int() },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await serialize(async () => (await client()).listInvoices(args)), null, 2) }] })
);

server.tool('connect_get_invoice',
  { invoice_id: z.number().int() },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await serialize(async () => (await client()).getInvoice(args)), null, 2) }] })
);

await server.connect(new StdioServerTransport());
```

- [ ] **Step 2: Verify the server boots**

Run: `npx tsx mcp/connect-server.ts < /dev/null` (it'll wait on stdio; ctrl-c after a second).
Expected: prints the plugin-data-dir diag line; no exception. If it prints an error about a missing `connect/...` file, fix the import path before continuing.

- [ ] **Step 3: Add npm scripts for parity with OCS**

Edit `package.json`'s `scripts`:

```json
"mcp:connect": "npx tsx mcp/connect-server.ts",
"test:connect": "vitest run test/mcp/connect"
```

- [ ] **Step 4: Commit**

```bash
git add mcp/connect-server.ts package.json
git commit -m "feat(connect): MCP server entrypoint with 16 tool registrations"
```

---

## Task 17: Wire MCP into plugin.json

**Files:**
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Add ace-connect entry**

Edit the `mcpServers` block to add a third entry next to `ace-gdrive` and `ace-ocs`:

```json
"ace-connect": {
  "command": "npx",
  "args": ["tsx", "${CLAUDE_PLUGIN_ROOT}/mcp/connect-server.ts"],
  "env": {
    "CLAUDE_PLUGIN_DATA": "${CLAUDE_PLUGIN_DATA}",
    "CLAUDE_PLUGIN_ROOT_ECHO": "${CLAUDE_PLUGIN_ROOT}"
  }
}
```

- [ ] **Step 2: Validate JSON**

Run: `python3 -m json.tool < .claude-plugin/plugin.json > /dev/null && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/plugin.json
git commit -m "feat(connect): wire ace-connect MCP into plugin.json"
```

---

## Task 18: Update `bin/ace-doctor` with Connect block

**Files:**
- Modify: `bin/ace-doctor`

- [ ] **Step 1: Read the existing OCS doctor block**

Find the section in `bin/ace-doctor` that prints OCS health (look for `ace-ocs`, `OCS_BASE_URL`, etc.). The Connect block should mirror it.

- [ ] **Step 2: Add Connect block**

After the OCS block, insert a Connect block that checks:
- `CONNECT_BASE_URL` is set in `.env` (compare against `.env.tpl`)
- `ACE_HQ_USERNAME` and `ACE_HQ_PASSWORD` are set
- `~/.ace/connect-session.json` exists; print mtime ("Session age: N hours")
- Reachability: `curl -s -o /dev/null -w "%{http_code}" "$CONNECT_BASE_URL/"` returns 200

Output style matches the OCS block ("OK" / "MISSING" / "STALE" with appropriate colors).

- [ ] **Step 3: Run the doctor**

Run: `bin/ace-doctor`
Expected: includes a "Connect" section that prints `CONNECT_BASE_URL: OK`, `HQ creds: OK`, etc.

- [ ] **Step 4: Commit**

```bash
git add bin/ace-doctor
git commit -m "feat(connect): add Connect block to ace-doctor"
```

---

## Task 19: E2E integration test

**Files:**
- Create: `test/mcp/connect/integration/e2e.integration.test.ts`

- [ ] **Step 1: Write the E2E test**

```typescript
/**
 * Full create-program → create-opp → set-config → invite → activate flow
 * against live Connect. Gated on CONNECT_INTEGRATION=1 and a valid session
 * at ~/.ace/connect-session.json.
 *
 * Run: CONNECT_INTEGRATION=1 npx vitest run test/mcp/connect/integration/e2e.integration.test.ts
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PlaywrightSession } from '../../../../mcp/connect/auth/playwright-session.js';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';

const skip = process.env.CONNECT_INTEGRATION !== '1';
const stamp = Date.now();
const PROGRAM_NAME = `ACE-MCP-Test-${stamp}`;
const OPP_NAME = `ACE-MCP-Test-Opp-${stamp}`;

describe.skipIf(skip)('connect e2e (live)', () => {
  let session: PlaywrightSession;
  let backend: PlaywrightBackend;
  let programId: number;
  let opportunityId: number;

  beforeAll(async () => {
    session = new PlaywrightSession({
      baseUrl: process.env.CONNECT_BASE_URL!,
      hqUsername: process.env.ACE_HQ_USERNAME,
      hqPassword: process.env.ACE_HQ_PASSWORD,
    });
    const ctx = await session.getContext();
    backend = new PlaywrightBackend({
      baseUrl: process.env.CONNECT_BASE_URL!,
      csrfToken: session.getCsrfToken(),
      request: ctx.request,
    });
  }, 60_000);

  afterAll(async () => { await session.close(); });

  it('creates a program', async () => {
    const p = await backend.createProgram({ name: PROGRAM_NAME, description: 'created by ace-connect e2e' });
    expect(p.name).toBe(PROGRAM_NAME);
    expect(p.id).toBeGreaterThan(0);
    programId = p.id;
  }, 30_000);

  it('lists the program (idempotency check would return same id)', async () => {
    const out = await backend.listPrograms({ name: PROGRAM_NAME });
    expect(out.programs.find((p) => p.id === programId)).toBeDefined();
  });

  it('creates an opportunity under the program', async () => {
    const o = await backend.createOpportunity({
      program_id: programId,
      name: OPP_NAME,
      description: 'ace-connect e2e',
      start_date: '2026-05-01',
      end_date: '2026-08-01',
      total_budget: 1000,
      currency: 'USD',
    });
    expect(o.name).toBe(OPP_NAME);
    expect(o.program_id).toBe(programId);
    opportunityId = o.id;
  }, 30_000);

  it('sets verification + delivery + payment configuration', async () => {
    await backend.setVerificationRules({
      opportunity_id: opportunityId,
      rules: [{ rule_type: 'gps_accuracy', config: { max_meters: 50 } }],
    });
    const du = await backend.setDeliveryUnits({
      opportunity_id: opportunityId,
      units: [{ name: 'Visit', max_per_day: 10 }],
    });
    expect(du.units[0].id).toBeGreaterThan(0);
    await backend.setPaymentUnits({
      opportunity_id: opportunityId,
      units: [{ name: 'Per visit', amount: 5, delivery_unit_ids: [du.units[0].id!] }],
    });
  }, 60_000);

  it('sends an invite to a test address', async () => {
    const inv = await backend.sendLloInvite({
      opportunity_id: opportunityId,
      organization_name: `Test Org ${stamp}`,
      contact_email: 'ace+test@dimagi-ai.com',
    });
    expect(inv.opportunity_id).toBe(opportunityId);
    expect(inv.status).toBe('pending');
  }, 30_000);

  it('activates the opportunity', async () => {
    const out = await backend.activateOpportunity({ opportunity_id: opportunityId });
    expect(out.status).toBe('active');
    const detail = await backend.getOpportunity({ opportunity_id: opportunityId });
    expect(detail.status).toBe('active');
  }, 30_000);
});
```

- [ ] **Step 2: Run with `CONNECT_INTEGRATION=1`**

Run: `CONNECT_INTEGRATION=1 npx vitest run test/mcp/connect/integration/e2e.integration.test.ts`
Expected: all six tests pass against live Connect.

If a test fails, the failure is the first signal that the corresponding atom's HTML scrape or form POST diverged from the fixture. Capture a fresh fixture (re-run the corresponding probe), update the regex, and re-run.

- [ ] **Step 3: Commit**

```bash
git add test/mcp/connect/integration/e2e.integration.test.ts
git commit -m "feat(connect): live E2E integration test"
```

---

## Task 20: Update `playbook/integrations/connect-api.md`

**Files:**
- Modify: `playbook/integrations/connect-api.md`

- [ ] **Step 1: Flip the "What Needs to Be Built" section**

Replace the `### Program + Opportunity CRUD (CCC-301)` and downstream blocked sections with a new `## What ACE Has Today` section listing the 16 atoms `ace-connect` exposes (cross-reference `mcp/connect/capability-map.ts`). Note that the Playwright backend will rip out when CCC-301 lands.

Update the "Skills currently in HITL fallback" table — for each of the 6 blocked skills, replace the "What humanly happens today" column with "Calls `connect_*` atoms (rewrite in skill PR)".

- [ ] **Step 2: Add an "Operator runbook" subsection**

Document `/ace:connect-login`, env-var requirements (`ACE_HQ_USERNAME`, `ACE_HQ_PASSWORD`, `CONNECT_BASE_URL`), and how to re-run the probes when Connect templates change.

- [ ] **Step 3: Commit**

```bash
git add playbook/integrations/connect-api.md
git commit -m "docs(connect): rewrite connect-api.md to reflect ace-connect MCP"
```

---

## Task 21: Run the full suite

**Files:** none

- [ ] **Step 1: Run unit + integration suites**

```bash
npm test -- test/mcp/connect       # unit tests
CONNECT_INTEGRATION=1 npm test -- test/mcp/connect/integration
```

Expected: all green. If anything fails, fix it before bumping VERSION.

- [ ] **Step 2: Run `bin/ace-doctor`**

Expected: Connect section reports green.

---

## Task 22: Bump VERSION + ship

**Files:**
- Modify: `VERSION`

- [ ] **Step 1: Bump VERSION**

Read current value (e.g. `0.7.3`); write `0.8.0` (this adds a new MCP — minor bump per ACE convention).

- [ ] **Step 2: Verify the pre-commit hook syncs the four version files**

Run: `git add VERSION && git commit -m "chore: bump VERSION to 0.8.0 (ace-connect)"`
Expected: hook runs; `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` all updated and included in the commit. Verify with `git show --stat HEAD`.

- [ ] **Step 3: Merge to main**

From the worktree:

```bash
cd ~/emdash-projects/ace && \
  [ "$(git branch --show-current)" = "main" ] || git checkout main && \
  git pull --ff-only && \
  git merge emdash/ccc-mcp-l2kjv --no-ff -m "feat: ace-connect MCP (0.8.0)" && \
  git push
```

- [ ] **Step 4: Run `/ace:update`**

In this session, run `/ace:update`. The plugin cache picks up the new MCP entry. New sessions will boot `ace-connect` automatically.

---

## Self-review notes

- Spec coverage: every section of the design spec is touched by a task. The 16-atom capability map (Task 3) maps 1:1 to the spec's table. Auth (Tasks 6–8) covers both automated and manual paths from the spec. Skill rewrites are explicitly out of scope and scheduled for follow-up PRs (mentioned in the spec's "Skill integration" section and reaffirmed in Task 20).
- Placeholders: probe scripts (Tasks 6, 12, 13, 14) intentionally instruct the implementer to record observations and refine selectors against live HTML — this is investigation, not "TODO." All code blocks contain runnable code.
- Type consistency: `ConnectClient` defined in Task 4; every backend (Tasks 10, 11, 15) implements it. Method names match across `client.ts`, `composite.ts`, `playwright.ts`, `rest.ts`, and the MCP tool registrations in Task 16.
- Open verification items from the spec resolve naturally: item 1 (HQ programmatic POST) is answered by Task 6; items 2-5 (form shapes for opps/config/invite/invoice) are answered by Tasks 12-14's probes.
