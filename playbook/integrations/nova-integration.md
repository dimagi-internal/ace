# Nova Integration

## Status

**Live (via the Nova Claude Code plugin). End-to-end smoke test passed
on 2026-04-28.**

Braxton (voidcraft-labs) shipped Nova as a Claude Code plugin on
2026-04-26. ACE consumes it as a sibling plugin: install once per
machine, sign in once via OAuth, and ACE invokes Nova through its
slash commands. Both `/nova:autobuild` and `/nova:upload_to_hq` round-
trip cleanly under the ACE service identity.

Install:

```
/plugin marketplace add voidcraft-labs/nova-marketplace
/plugin install nova@nova-marketplace
/mcp                # then pick `nova` and sign in (OAuth, one time)
```

The Nova MCP server is bundled with the plugin; ACE doesn't run a
Nova MCP itself.

## Resolved blockers (kept for record)

Two sequential blockers landed and were cleared on 2026-04-28. Listed
here for continuity — neither is active.

- **OAuth allowlist on Nova's side (2026-04-27 → cleared 2026-04-28).**
  Nova's Google OAuth client originally only allowlisted the operating
  Workspace's primary domain. Adding the secondary domain that the
  ACE Gmail identity lives under unblocked sign-in at the Nova
  boundary.

- **Workspace 2FA policy (2026-04-28, brief).** With the Nova
  allowlist fixed, Google briefly blocked the ACE Gmail sign-in
  with *"Your sign-in settings don't meet your organization's 2-Step
  Verification policy."* Resolved by adjusting the Workspace 2FA
  enforcement scope so the ACE service account is exempt. The
  account is now sign-in-able via password (1Password-stored) +
  OAuth consent.

## ACE service identity for Nova

The Nova MCP plugin authenticates as a real Google identity — there's
no service-account flow on Nova's side. ACE binds Nova to the ACE
Gmail identity (whatever `ACE_GMAIL_ACCOUNT` is set to in `.env`) so
that Nova-side state (apps, HQ connection, settings) lives in one
place across sessions and operators. To re-bind, run `/mcp` →
disconnect `nova` → reconnect, and sign in as the desired identity.
Each Nova user has their own settings store; the HQ API key only
applies to the user it was saved under.

## ACE's surface area on Nova

Three skills consume Nova directly:

| Skill | Slash command | Purpose |
|-------|---------------|---------|
| `pdd-to-learn-app` | `/nova:autobuild "<brief>"` | Build the Learn app from a brief composed off the PDD |
| `pdd-to-deliver-app` | `/nova:autobuild "<brief>"` | Build the Deliver app |
| `app-deploy` | `/nova:upload_to_hq <app_id>` | Push both apps to the bound HQ project space |

Helpful read-only commands:
- `/nova:show <app_id>` — blueprint summary; useful for cross-checking
  Nova's output against the PDD before writing the app summary.
- `/nova:list` — 10 most recently updated Nova apps, for human
  inspection / debugging.
- `/nova:edit <app_id> "<instruction>"` — atomic targeted edit; ACE
  does not call this in the default flow but it's the right tool for
  hot-fixing a specific form/module without rebuilding the whole app.

Inputs Nova **does not** accept:
- File paths or attachments. The brief is the entire description
  string passed to `/nova:autobuild`.
- A markdown PDD as-is. ACE composes a focused, archetype-aware brief
  from the PDD's Learn or Deliver spec section; pasting the whole PDD
  is wasteful and dilutes Nova's signal.
- Per-call HQ domain. `/nova:upload_to_hq` reads the target HQ project
  space from whichever HQ API key is saved on Nova's settings page
  (`https://commcare.app/settings`). ACE cannot pick the domain at
  call time — only verify it. See `## HQ domain coupling` below.

## HQ domain coupling

`/nova:upload_to_hq` always uploads to the project space that owns the
HQ API key currently saved in Nova's settings. There's no flag to
override at call time.

ACE's contract:

1. `.env` declares `ACE_HQ_DOMAIN` (the HQ project space ACE expects
   Nova to be bound to) and `ACE_HQ_BASE_URL` (defaults to
   `https://www.commcarehq.org`). The committed template leaves
   `ACE_HQ_DOMAIN` unset — operators set it locally per deployment.
2. The HQ API key for that domain is generated under the ACE Gmail
   identity at `<ACE_HQ_BASE_URL>/account/api_keys/` and stored in
   1Password (operator's vault choice; not pinned by the codebase).
3. The operator pastes that key into Nova's settings page once
   (currently gated on the OAuth allowlist fix, see above).
4. `app-deploy` pre-flights Nova's confirmation line and aborts with
   a `[BLOCKER]` in the gate brief if Nova's bound domain differs
   from `ACE_HQ_DOMAIN`.

Rotating the HQ key follows the same shape: regenerate at
`<ACE_HQ_BASE_URL>/account/api_keys/`, update the 1Password item in
place, then re-paste into Nova settings.

## Authentication summary

| Surface | Auth |
|---------|------|
| Nova web app | Google OAuth (sign-in with Google) |
| Nova MCP / plugin | Real OAuth 2.1 (RFC-compliant DCR) — Braxton's note: "yank a client and the next call from it 401s instantly" |
| HQ upload (downstream of Nova) | HQ API key from `account/api_keys/`, scoped per project space |

There's no ACE-side service account for Nova — Nova is bound to the
ACE Gmail identity (configured via `ACE_GMAIL_ACCOUNT`) for both web
and plugin auth.

## Operating notes

- **No API costs from Nova.** The build runs through the user's local
  Claude Code session; Nova's MCP server hosts the tool surface but
  the LLM is yours. Storage on Nova's side is "$0.00001 GCP-tier"
  per Braxton.
- **App lives on Nova until uploaded.** A built app stays in Nova's
  storage as a durable record (`/nova:list`, `/nova:show`). HQ only
  receives a copy when `/nova:upload_to_hq` runs.
- **Nova edits are atomic.** Don't rebuild a whole app to add one
  form — that's what `/nova:edit` is for. ACE does not yet use this
  in the default flow but should once `app-test` finds bugs.

## What is NOT here

- A Nova fork or self-hosted Nova. Earlier design notes considered
  forking; that path is dead — Nova is a maintained external service.
- A Nova MCP server in this repo. ACE does not host one; the Nova
  plugin ships its own.
- A puppeteered web-UI integration. Considered as a fallback if Nova
  shipped no API; not needed.
