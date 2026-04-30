# Connect Integration

## Two MCP servers, two domains

ACE talks to Connect through **two** MCP servers, each scoped to a distinct
domain:

1. **`connect-labs` MCP** (lives in the [`connect-labs` repo](https://github.com/dimagi/connect-labs))
   — solicitations, reviews, awards, funds. Production-ready and unrelated to
   the Programs/Opportunities lifecycle ACE manages.

2. **`ace-connect` MCP** (in this repo, `mcp/connect-server.ts`) — Programs,
   Opportunities, invites, invoices. Drives the
   `connect-program-setup`, `connect-opp-setup`, `llo-onboarding`,
   `llo-launch`, and `opp-closeout` skills.

This document covers `ace-connect`. For `connect-labs`, see that repo's docs.

## What ace-connect exposes today

Twenty atomic capabilities. Eight of the authoring atoms now go through the
**REST automation API** that commcare-connect PR #1135 shipped on
2026-04-30; the remaining atoms still drive HTML form pages via Playwright
(reads, edits, verification flags, invoices). Both backends share the same
authenticated session (OAuth-via-CommCareHQ as `ace@dimagi-ai.com`) — REST
endpoints accept the Django `sessionid` cookie + CSRF token DRF's
`SessionAuthentication` enforces.

### Programs (4)

| Atom | Backend | Used by |
|---|---|---|
| `connect_create_program` | REST `POST /api/programs/` | `connect-program-setup` |
| `connect_update_program` | Playwright (no REST yet) | `connect-program-setup` |
| `connect_list_programs` | Playwright | `connect-program-setup` (idempotency check) |
| `connect_get_program` | Playwright | `connect-program-setup` |
| `connect_list_delivery_types` | Playwright | `connect-program-setup` (resolve "Nutrition" → slug/FK) |

### Opportunities (4)

| Atom | Backend | Used by |
|---|---|---|
| `connect_create_opportunity` | REST `POST /api/programs/<id>/opportunities/` | `connect-opp-setup` |
| `connect_update_opportunity` | Playwright (no REST yet) | `connect-opp-setup`, `llo-launch` |
| `connect_list_opportunities` | Playwright | `connect-opp-setup` (idempotency check) |
| `connect_get_opportunity` | Playwright | `connect-opp-setup`, `llo-launch` |

### Per-opp configuration (4)

| Atom | Backend | Used by |
|---|---|---|
| `connect_set_verification_flags` | Playwright (no REST yet) | `connect-opp-setup` |
| `connect_list_deliver_units` | Playwright | `connect-opp-setup` (also returned inline by `create_opportunity`) |
| `connect_create_payment_unit` | REST `POST /api/opportunities/<id>/payment_units/` | `connect-opp-setup` (singular wrapper) |
| `connect_create_payment_units` | REST same endpoint | `connect-opp-setup` (atomic batch — preferred) |
| `connect_list_payment_units` | Playwright | `connect-opp-setup` (verify after create) |

### Lifecycle (1)

| Atom | Backend | Used by |
|---|---|---|
| `connect_activate_opportunity` | REST `POST /api/opportunities/<id>/activate/` | `llo-launch` |

### Invites (4)

| Atom | Backend | Used by |
|---|---|---|
| `connect_send_llo_invite` | REST `POST /api/programs/<id>/applications/` | `llo-onboarding` |
| `connect_accept_program_application` | REST `POST .../accept/` | `llo-onboarding` (ACE-driven dogfood only) |
| `connect_send_flw_invite` | REST `POST /api/opportunities/<id>/invite_users/` | `connect-opp-setup` Step 7 / `llo-launch` |
| `connect_list_invites` | Playwright | `llo-onboarding` (status check) |

### Invoices (2)

| Atom | Backend | Used by |
|---|---|---|
| `connect_list_invoices` | Playwright (stub — page shape not yet probed) | `opp-closeout` |
| `connect_get_invoice` | Playwright (stub) | `opp-closeout` |

## Operator runbook

### Required env vars (all 1Password-backed in `.env.tpl`)

```
CONNECT_BASE_URL=https://connect.dimagi.com
ACE_HQ_USERNAME=op://AI-Agents/ACE - CommCareHQ/username
ACE_HQ_PASSWORD=op://AI-Agents/ACE - CommCareHQ/password
```

### Establishing a session

Two paths:

- **Automated (default):** the MCP's `PlaywrightSession.getContext()` probes
  `/accounts/login/`. If the response is 200 (anonymous), it auto-runs
  `hqOAuthLogin()` with the `.env` creds. The resulting state persists to
  `~/.ace/connect-session.json` for headless reuse.
- **Manual fallback:** run `/ace:connect-login` to open a headed Chromium
  window, sign in by hand (covers MFA / SSO edge cases the automated flow
  can't handle), and save the resulting state.

`bin/ace-doctor` checks both env-var presence and session freshness.

The REST atoms reuse the same `BrowserContext.request` and the same
session-cookie + CSRF flow as the Playwright atoms — there's no separate
token-auth path today.

### Org-admin role required

For `create_program` and other write atoms to succeed, the configured account
(`ace@dimagi-ai.com` today) must be an **Admin** in the target Connect
organization. `create_program` additionally requires that the org be a
*program-manager* org (`program_manager=True`) — the new automation API
enforces this via the `IsProgramManagerAdmin` permission. Demo/testing
happens in `ai-demo-space`.

To grant admin role:
1. As an existing org admin, open `https://connect.dimagi.com/a/<org>/organization/`
2. Members tab → either change the existing member's role to `Admin` or use the
   "Add Member" form (email + role=admin)

Without admin role, ace@dimagi-ai.com's view defaults to the
network-member-side ("Apply to Program" buttons) and authoring atoms will
fail with 403.

### Re-running probes

When Connect changes an HTML template upstream, only the *Playwright-backed*
atoms break. Each domain has a probe script under `scripts/probe-connect-*`
that documents the live HTML contract; re-run the relevant probe to update
the fixture, then update the regex in `mcp/connect/backends/html-scrape.ts`
until its unit test passes against the new fixture. REST atoms only break
when the JSON contract on `commcare-connect` changes — much less frequent.

## Adopting future REST endpoints

When commcare-connect ships an additional REST endpoint that maps to one of
the still-Playwright-backed atoms (`update_program`, `update_opportunity`,
`set_verification_flags`, the `list_*` reads, invoices):

1. Implement the method in `mcp/connect/backends/rest.ts` (replaces a stub).
2. Flip the `capability-map.ts` entry from `PLAYWRIGHT` to `REST`.
3. Flip the dispatch line in `mcp/connect/backends/composite.ts`.
4. Delete the corresponding `playwright.ts` method + its HTML fixture test.
5. Bump VERSION; ship.

When all atoms have flipped, `auth/playwright-session.ts` can be replaced
with token auth and the entire `playwright.ts` backend deleted.

## Staging

There is no separate staging instance for Connect today. Tests against
production use a name-prefix isolation pattern (`ACE-IT-<timestamp>`) to avoid
clobbering real data, and run inside the `ai-demo-space` org which is
explicitly provisioned for this kind of dogfood.

If a real staging URL becomes available, set `CONNECT_BASE_URL` in `.env`
to point at it; no other code changes needed.
