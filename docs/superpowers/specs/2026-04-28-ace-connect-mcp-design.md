# ACE Connect MCP — Design

**Status:** Draft
**Date:** 2026-04-28
**Author:** ACE
**Related:** [`docs/superpowers/specs/2026-04-08-ace-ocs-chatbot-buildout-design.md`](2026-04-08-ace-ocs-chatbot-buildout-design.md) (the pattern this mirrors), [`playbook/integrations/connect-api.md`](../../../playbook/integrations/connect-api.md) (current Connect API gap inventory)

## Problem

Six ACE skills are blocked on Connect APIs that don't exist yet (CCC-301 + invite + invoice). Today they fall back to "ask the operator to do it in the Connect UI." This stalls Phase 3 (Connect setup) and Phase 5/6 (LLO management + closeout) on human touchpoints for every opportunity.

The work is structurally identical to the OCS gap we closed in 0.5.x–0.6.x: a Django app with REST coverage that doesn't yet match what we need. The OCS solution — a composite MCP that exposes atomic capabilities and routes each one to either REST or Playwright, swappable one line at a time — applies directly.

## Goal

Ship `ace-connect`, a sibling MCP to `ace-ocs` that makes the blocked skills behave as if Cal's CCC-301 work has already landed. Skills call atoms; the MCP figures out whether to use a real REST endpoint or drive the UI session under `ace@dimagi-ai.com`. When real APIs ship, each Playwright atom flips to REST in a single line edit to `capability-map.ts`.

Non-goal: replace the existing `connect-labs` MCP. That MCP covers solicitations / reviews / awards / funds (a separate domain — grants pipeline). `ace-connect` is the Programs / Opportunities / Invites / Invoices domain.

## Capability map

Sized for the six blocked skills only — no speculative atoms. Skill column links each atom to its consumer.

### Authoring atoms (Playwright today)

| Atom | Eventual REST | Consumer skill |
|---|---|---|
| `connect_create_program` | `POST /api/programs/` | `connect-program-setup` |
| `connect_update_program` | `PATCH /api/programs/{id}/` | `connect-program-setup` |
| `connect_create_opportunity` | `POST /api/opportunities/` | `connect-opp-setup` |
| `connect_update_opportunity` | `PATCH /api/opportunities/{id}/` | `connect-opp-setup`, `llo-launch` |
| `connect_set_verification_rules` | `PUT /api/opportunities/{id}/verification/` | `connect-opp-setup` |
| `connect_set_delivery_units` | `PUT /api/opportunities/{id}/delivery-units/` | `connect-opp-setup` |
| `connect_set_payment_units` | `PUT /api/opportunities/{id}/payment-units/` | `connect-opp-setup` |
| `connect_activate_opportunity` | `POST /api/opportunities/{id}/activate/` | `llo-launch` |
| `connect_send_llo_invite` | `POST /api/opportunities/{id}/invites/` | `llo-onboarding` |

### Observation atoms (REST when available, Playwright HTML scrape today)

| Atom | Eventual REST | Consumer skill |
|---|---|---|
| `connect_list_programs` | `GET /api/programs/` | `connect-program-setup` (idempotency check) |
| `connect_get_program` | `GET /api/programs/{id}/` | `connect-program-setup` |
| `connect_list_opportunities` | `GET /api/opportunities/` | `connect-opp-setup` (idempotency check) |
| `connect_get_opportunity` | `GET /api/opportunities/{id}/` | `connect-opp-setup`, `llo-launch` |
| `connect_list_invites` | `GET /api/opportunities/{id}/invites/` | `llo-onboarding` (status check) |
| `connect_list_invoices` | `GET /api/opportunities/{id}/invoices/` | `opp-closeout` |
| `connect_get_invoice` | `GET /api/invoices/{id}/` | `opp-closeout` |

Sixteen atoms total. The "REST target" column is documentation only — Cal's team is not bound to those exact URLs. When real endpoints land at different paths, we update the route, not the atom name.

## Architecture

```
mcp/
  connect-server.ts                 # MCP entrypoint; registers 16 tools
  connect/
    capability-map.ts               # 16 atoms × { backend, restTarget }
    client.ts                       # ConnectClient interface (the contract skills consume)
    types.ts                        # Program, Opportunity, VerificationRule, Invite, Invoice
    errors.ts                       # SessionExpiredError, HttpError, ConnectValidationError
    logging.ts                      # createLoggingProxy (lifted verbatim from ocs/)
    auth/
      playwright-session.ts         # Headless Chromium + storageState reuse
      hq-oauth-login.ts             # Automated HQ-OAuth flow (creds from .env)
    backends/
      rest.ts                       # No-op stub today; one method per REST atom
      playwright.ts                 # HTML-scrape + form-POST per atom
      composite.ts                  # Routes per capability-map.ts
```

Same shape as `mcp/ocs/`. A reader who knows OCS will recognize every file.

### Authentication

Connect uses OAuth-via-CommCare-HQ. The session flow is:

1. Hit `https://connect.dimagi.com/accounts/login/` (or whatever protected page) → redirected to HQ at `https://www.commcarehq.org/accounts/login/?next=...`
2. POST HQ credentials (CSRF + username + password)
3. HQ redirects back with an OAuth-grant URL → follow the redirect chain
4. Connect sets its own session cookie

Credentials live in `.env` (1Password-injected via `.env.tpl`):

```
ACE_HQ_USERNAME=op://AI-Agents/ACE - CommCare HQ/username
ACE_HQ_PASSWORD=op://AI-Agents/ACE - CommCare HQ/password
CONNECT_BASE_URL=https://connect.dimagi.com
```

Two login modes:

- **Automated** (default for fresh sessions and silent refresh): `auth/hq-oauth-login.ts` drives the flow headlessly using creds from `.env`. Called automatically when `auth/playwright-session.ts` detects a missing or expired storageState.
- **Manual fallback** via `/ace:connect-login`: opens headed Chromium, user signs in (covers MFA / SSO edge cases), saves storageState. Mirrors `/ace:ocs-login` byte-for-byte.

Session state file: `~/.ace/connect-session.json`. CSRF token extracted from `csrftoken` cookie, refreshed on 403 with one retry (same pattern as OCS).

### Backend routing

Today every authoring atom routes to Playwright; every observation atom also routes to Playwright (because there are no observation REST endpoints either yet — `list_*` and `get_*` will scrape HTMX tables and detail pages, the same trick OCS uses for `experiment_id` recovery in `parseChatbotTable`).

When a real REST endpoint lands for any atom, the route line in `capability-map.ts` flips from `'PLAYWRIGHT'` to `'REST'` and `composite.ts`'s dispatch line flips from `this.opts.playwright.X` to `this.opts.rest.X`. The atom signature, the MCP tool schema, and every skill consumer stay untouched.

### What Playwright actually does

For each atom, `playwright.ts` exposes one method that:

1. Issues authenticated `page.request` calls (HTTP-only — no click-driving, same constraint as OCS)
2. For mutations: GET the form page → extract CSRF + hidden inputs from HTML → POST the form
3. For reads: GET the list/detail page → parse HTML with anchored regex → return typed result

Each HTML-scrape helper is a pure function with a unit test against a fixture file (`test/fixtures/connect-html/*.html`). The contract is "this regex matches templates X/Y/Z" — when the upstream template changes, the regex test fails first, before any integration test.

The "no click-driving" rule is hard-enforced by importing `page.request` at the module level and never importing `Page` itself.

## Skill integration

Each blocked skill replaces its `## Current Workaround` with calls to atoms. Example for `connect-program-setup`:

Before (HITL):
```
1. Read PDD; ask user to create program in UI; record returned ID.
```

After:
```
1. connect_list_programs(name=<derived>) → if exists, reuse; else
2. connect_create_program(name, description) → record program_id in state.yaml
```

The replacement happens skill-by-skill in follow-up PRs after the MCP ships, so the MCP can land with full test coverage before any skill consumes it. Each skill PR is a small diff: delete the workaround block, add 3–5 atom calls, update the gate-brief output.

## Testing

Mirror `test/mcp/ocs/`:

```
test/mcp/connect/
  unit/                                  # html-scrape helpers, errors, capability-map
  integration/
    e2e.integration.test.ts              # full create-program → create-opp → activate → invite flow
  fixtures/connect-html/                 # captured snapshots of each scraped page
```

Live integration tests gated on `CONNECT_INTEGRATION=1` plus a valid session, identical to OCS.

Golden E2E uses a sandbox program named `ACE-MCP-Test-<timestamp>` and tears down on completion. If Cal's team has a staging Connect we route there via `CONNECT_BASE_URL`; otherwise tests run against prod with isolation by name prefix.

## Operational concerns

- **Idempotency.** `create_*` atoms first call `list_*` and reuse if a same-named record exists. Same idempotency guarantee OCS gives `clone_chatbot`.
- **Error contract.** Lift `errors.ts` from OCS verbatim — `SessionExpiredError`, `HttpError`, `ConnectValidationError`. Skills already know these shapes.
- **Logging.** `createLoggingProxy` from OCS reused unchanged; logs to `~/.ace/logs/connect-<date>.jsonl`.
- **Concurrency.** Single promise-chain serializer in `connect-server.ts`, identical to OCS, to prevent CSRF-rotation races during concurrent authoring.

## Wire-up

`.claude-plugin/plugin.json` adds a third entry under `mcpServers`:

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

`commands/connect-login.md` mirrors `commands/ocs-login.md`. `bin/ace-doctor` gains a Connect block (env-var presence, session file freshness, base URL reachability).

## Out of scope

- **Real API design.** Cal's team owns the eventual endpoint shapes; we document our targets in the capability map but don't try to influence them.
- **Connect-labs MCP integration.** Solicitations / reviews / awards / funds stay in the connect-labs MCP. No tool here overlaps.
- **CommCare HQ atoms.** ACE's HQ touchpoints (Nova upload + project-space pre-flight) stay where they are.
- **Browser-driven UI testing.** This is an HTTP-only Playwright client, same as OCS.

## Migration when real APIs land

For each atom:

1. Implement the REST method in `backends/rest.ts`
2. Flip `capability-map.ts` entry to `backend: 'REST'`
3. Flip the dispatch line in `backends/composite.ts`
4. Delete the corresponding Playwright method + its HTML fixture test
5. Bump VERSION; ship

When all atoms have flipped, delete `backends/playwright.ts`, `auth/`, `commands/connect-login.md`, and the HQ creds from `.env.tpl`. The MCP shrinks to a thin REST wrapper. That's the rip-out the spec is engineered for.

## Open verification items

Resolved during implementation, tracked here so they don't get lost:

1. Does HQ accept programmatic password POST, or does it bounce to a JS-driven SSO page that requires a real Chromium render? (If the latter, automated login degrades to manual `/ace:connect-login`-only.)
2. Does Connect's Program/Opportunity create form post directly, or is it HTMX-driven with a JSON return? (Affects scrape vs. JSON-extract for the new ID.)
3. Verification / delivery / payment unit configuration — are these one form, three forms, or inline editing? (Affects whether we have one atom or three.)
4. Invite flow — does Connect generate an email invite, or does it just register the LLO and we email separately via `email-communicator`? (Affects whether `send_llo_invite` is full-flow or just the registration half.)
5. Invoice access — do invoices live on the opportunity detail page, or under a separate `/billing/` URL? (Affects scrape target.)

Each item gets a probe script under `scripts/probe-connect-*.ts` (durable reproducer, same convention as OCS probes).
