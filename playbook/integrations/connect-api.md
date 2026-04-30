# Connect Integration

## Two MCP servers, two domains

ACE talks to Connect through **two** MCP servers, each scoped to a distinct
domain:

1. **`connect-labs` MCP** (lives in the [`connect-labs` repo](https://github.com/dimagi/connect-labs))
   — solicitations, reviews, awards, funds. Production-ready and unrelated to
   the Programs/Opportunities lifecycle ACE manages.

2. **`ace-connect` MCP** (in this repo, `mcp/connect-server.ts`) — Programs,
   Opportunities, invites, invoices. Built specifically to unblock ACE's
   `connect-program-setup`, `connect-opp-setup`, `llo-invite`, `llo-onboarding`,
   `llo-launch`, and `opp-closeout` skills until Cal's team ships the real REST
   APIs (CCC-301 + invite + invoice).

This document covers `ace-connect`. For `connect-labs`, see that repo's docs.

## What ace-connect exposes today

Fourteen atomic capabilities. Authoring atoms create or modify records;
observation atoms read. Today every atom routes to a Playwright HTTP-only
backend that drives `connect.dimagi.com` through an authenticated session
(OAuth-via-CommCareHQ as `ace@dimagi-ai.com`).

### Programs (5)

| Atom | Used by |
|---|---|
| `connect_create_program` | `connect-program-setup` |
| `connect_update_program` | `connect-program-setup` |
| `connect_list_programs` | `connect-program-setup` (idempotency check) |
| `connect_get_program` | `connect-program-setup` |
| `connect_list_delivery_types` | `connect-program-setup` (resolve "Nutrition" → 13) |

### Opportunities (4)

| Atom | Used by |
|---|---|
| `connect_create_opportunity` | `connect-opp-setup` |
| `connect_update_opportunity` | `connect-opp-setup`, `llo-launch` |
| `connect_list_opportunities` | `connect-opp-setup` (idempotency check) |
| `connect_get_opportunity` | `connect-opp-setup`, `llo-launch` |

### Lifecycle (1)

| Atom | Used by |
|---|---|
| `connect_activate_opportunity` | `llo-launch` |

### Invites (3)

| Atom | Used by |
|---|---|
| `connect_send_llo_invite` | `llo-onboarding` (invite an LLO partner org to a program) |
| `connect_send_flw_invite` | `connect-opp-setup` Step 8 (pre-invite ACE test phone to the new opp; opportunity-level, not program-level — POSTs `users` textarea to `/a/<org>/opportunity/<uuid>/user_invite/`) |
| `connect_list_invites` | `llo-onboarding` (status check) |

### Invoices (2)

| Atom | Used by |
|---|---|
| `connect_list_invoices` | `opp-closeout` |
| `connect_get_invoice` | `opp-closeout` |

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

### Org-admin role required

For `create_program` and other write atoms to succeed, the configured account
(`ace@dimagi-ai.com` today) must be an **Admin** in the target Connect
organization. Demo/testing happens in `ai-demo-space`.

To grant admin role:
1. As an existing org admin, open `https://connect.dimagi.com/a/<org>/organization/`
2. Members tab → either change the existing member's role to `Admin` or use the
   "Add Member" form (email + role=admin)

Without admin role, ace@dimagi-ai.com's view defaults to the
network-member-side ("Apply to Program" buttons) and authoring atoms will
fail with HTTP errors or empty list scrapes.

### Re-running probes

When Connect changes a template upstream, the atom that depends on the changed
HTML breaks. Each domain has a probe script under `scripts/probe-connect-*`
that documents the live contract; re-run the relevant probe to update the
fixture, then update the regex in `mcp/connect/backends/html-scrape.ts` until
its unit test passes against the new fixture.

## What's not yet implemented (deferred)

- **Verification rules / delivery units / payment units** — the original spec
  called for these as separate atoms, but the concept doesn't appear on
  Connect's program/opp create or list pages today. Likely lives on a
  post-creation configuration page we haven't located. Revisit when surfaced.
- **Invoice atoms scrape** — the schema is present (`list_invoices`,
  `get_invoice`) but page parsing is conservative (returns empty/stub).
  Will be filled in as soon as the invoice page shape is observed via a
  probe (typically only happens once an opp has actually been invoiced).

These gaps are tracked as TODOs in `mcp/connect/backends/playwright.ts`.

## Migration when real REST APIs land

Per the design at `docs/superpowers/specs/2026-04-28-ace-connect-mcp-design.md`:

1. Implement the REST method in `mcp/connect/backends/rest.ts` (replaces a `stub()`)
2. Flip the `capability-map.ts` entry to `backend: 'REST'`
3. Flip the dispatch line in `mcp/connect/backends/composite.ts`
4. Delete the corresponding `playwright.ts` method + its HTML fixture test
5. Bump VERSION; ship

When all atoms have flipped, delete `auth/`, `commands/connect-login.md`, and
the HQ creds from `.env.tpl`. The MCP shrinks to a thin REST wrapper.

## Skills no longer in HITL fallback

When the `ace-connect` MCP atom for a skill ships, the skill's
`## Current Workaround` block in `SKILL.md` is removed in the same PR as the
atom adoption. The current state (after 0.8.0 lands the MCP — skill rewrites
follow):

| Skill | Phase | Atom(s) it consumes | Workaround removed in |
|-------|-------|---------------------|-----------------------|
| `connect-program-setup` | 3 | `connect_*_program*`, `connect_list_delivery_types` | TBD (skill PR) |
| `connect-opp-setup` | 3 | `connect_*_opportunity*` | TBD (skill PR) |
| `llo-invite` | 5 | (preparation only — no atom) | unchanged |
| `llo-onboarding` | 5 | `connect_send_llo_invite`, `connect_list_invites` | TBD (skill PR) |
| `llo-uat` | 5 | (uses email-communicator) | unchanged |
| `llo-launch` | 5 | `connect_activate_opportunity`, `connect_get_opportunity` | TBD (skill PR) |
| `llo-feedback` | 6 | (uses email-communicator) | unchanged |
| `opp-closeout` | 6 | `connect_list_invoices`, `connect_get_invoice` | TBD (skill PR) |

## Staging

There is no separate staging instance for Connect today. Tests against
production use a name-prefix isolation pattern (`ACE-IT-<timestamp>`) to avoid
clobbering real data, and run inside the `ai-demo-space` org which is
explicitly provisioned for this kind of dogfood.

If `ACE_SANDBOX=true` ever gets a real Connect staging URL, set
`CONNECT_BASE_URL` in `.env` to point at it; no other code changes needed.
