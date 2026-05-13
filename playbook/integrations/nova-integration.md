# Nova Integration

## Status

**Live (via the Nova Claude Code plugin + ACE-side API-key override).**
First end-to-end smoke test on 2026-04-28; migrated to API-key auth
2026-05-08 after voidcraft-labs/nova-plugin#9 closed.

Braxton (voidcraft-labs) ships Nova as a Claude Code plugin. ACE
consumes it as a sibling plugin: install once per machine, mint an
API key, and ACE invokes Nova through its slash commands and MCP
tools. Both `/nova:autobuild` and `/nova:upload_to_hq` round-trip
cleanly under the ACE service identity, including across multiple
concurrent worktrees.

## Install + auth

```
/plugin marketplace add voidcraft-labs/nova-marketplace
/plugin install nova@nova-marketplace
```

Then mint an API key once and let `/ace:setup` register a user-scope
MCP override that carries it as a bearer:

1. Sign in at `https://commcare.app/settings` as the ACE Gmail
   identity (`ACE_GMAIL_ACCOUNT` in `.env`).
2. Mint a key with Read+Write floor + the HQ scopes
   `/nova:upload_to_hq` needs.
3. Save to 1Password vault `AI-Agents`, item `ACE - Nova`, field
   `api_key`.
4. Run `/ace:setup --force-env`. The setup script re-injects `.env`
   from 1Password and registers the user-scope override:

   ```
   claude mcp add nova https://mcp.commcare.app/mcp \
     --transport http --scope user \
     --header "Authorization: Bearer ${NOVA_API_KEY}"
   ```

Claude Code's URL-signature dedup keeps the user-scope entry over
the plugin's OAuth-mode entry, so every Nova MCP call goes through
bearer auth — no rotation, no refresh-token cascade. Tools end up
namespaced as `mcp__nova__*` (the plugin's `mcp__plugin_nova_nova__*`
namespace is suppressed).

`/ace:doctor` exposes three Nova-related liveness lines:
- `nova_env: NOVA_API_KEY present`
- `net_nova_mcp: https://mcp.commcare.app/ → HTTP 4xx (reachable)`
- `nova_auth: ace-nova authed (POST initialize → HTTP 200)`

The Nova MCP server is hosted by voidcraft at `mcp.commcare.app`;
ACE doesn't run a Nova MCP itself.

## Resolved blockers (kept for record)

Three blockers landed and were cleared between 2026-04-27 and
2026-05-08. Listed here for continuity — none active.

- **OAuth allowlist on Nova's side (2026-04-27 → cleared 2026-04-28).**
  Nova's Google OAuth client originally only allowlisted the operating
  Workspace's primary domain. Adding the secondary domain that the
  ACE Gmail identity lives under unblocked sign-in at the Nova
  boundary. Now moot under API-key auth.

- **Workspace 2FA policy (2026-04-28, brief).** With the Nova
  allowlist fixed, Google briefly blocked the ACE Gmail sign-in
  with *"Your sign-in settings don't meet your organization's 2-Step
  Verification policy."* Resolved by adjusting the Workspace 2FA
  enforcement scope so the ACE service account is exempt. Now moot
  under API-key auth.

- **Refresh-token cascade across concurrent worktrees
  (voidcraft-labs/nova-plugin#9, cleared 2026-05-08).** Two ACE
  worktrees on one Nova/Google identity tripped a `deleteMany`
  cascade in `@better-auth/oauth-provider`'s
  `handleRefreshTokenGrant`: when worktree B presented a stale
  refresh token (after worktree A had just rotated it), the
  provider treated the stale presentation as theft-detection and
  wiped every `(userId, clientId)` refresh row — including the
  fresh one A had just gotten. Both worktrees forced through
  interactive OAuth every ~30 minutes. Resolved by Nova shipping
  API-key auth at the same MCP URL — no rotation, no cascade.

## ACE service identity for Nova

Under API-key auth, the bearer is identity. ACE's `NOVA_API_KEY`
points the entire fleet (every worktree, every operator's machine
that re-runs `/ace:setup`) at one Nova-side identity, which is the
account that minted the key (the ACE Gmail identity). All Nova
state — apps, HQ binding, settings — lives under that one user.

Rotating the key: regenerate at `commcare.app/settings`, update the
1Password item in place, then `/ace:setup --force-env` on each
machine. The user-scope override is re-registered with the new
bearer.

The plugin's OAuth path is still available for human-at-a-browser
use (one user, one Claude Code session, no concurrent sessions);
ACE just doesn't take that path because of the cascade.

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
3. The operator pastes that HQ key into Nova's settings page once.
4. `app-deploy` pre-flights Nova's confirmation line and aborts with
   a `[BLOCKER]` in the gate brief if Nova's bound domain differs
   from `ACE_HQ_DOMAIN`.

**Two distinct keys.** Don't conflate them:
- `NOVA_API_KEY` (`sk-nova-v1-…`) authenticates **ACE → Nova**. Lives
  in 1Password item `ACE - Nova` / `api_key`. Read by the user-scope
  MCP override.
- HQ API key (UUID) authenticates **Nova → CommCareHQ**. Lives on
  Nova's settings page (server-side). Generated under
  `<ACE_HQ_BASE_URL>/account/api_keys/`.

Rotating the HQ key follows the same shape: regenerate at
`<ACE_HQ_BASE_URL>/account/api_keys/`, update its 1Password item in
place, then re-paste into Nova settings.

## Authentication summary

| Surface | Auth |
|---------|------|
| Nova web app | Google OAuth (sign-in with Google, ACE Gmail identity) |
| Nova MCP / plugin (ACE path) | Long-lived API key (`sk-nova-v1-…`) via user-scope MCP override |
| Nova MCP / plugin (human path) | Real OAuth 2.1 (RFC-compliant DCR) — Braxton: "yank a client and the next call from it 401s instantly" |
| HQ upload (downstream of Nova) | HQ API key from `account/api_keys/`, scoped per project space |

There's no ACE-side service account on Nova — the API key is bound
to the ACE Gmail identity (`ACE_GMAIL_ACCOUNT`) at mint time.

## Operating notes

- **No API costs from Nova.** The build runs through the user's local
  Claude Code session; Nova's MCP server hosts the tool surface but
  the LLM is yours. Storage on Nova's side is "$0.00001 GCP-tier"
  per Braxton.
- **App lives on Nova until uploaded.** A built app stays in Nova's
  storage as a durable record (`/nova:list`, `/nova:show`). HQ only
  receives a copy when `/nova:upload_to_hq` runs.
- **Nova edits are atomic.** Don't rebuild a whole app to add one
  form — that's what `/nova:edit` is for.

## Gotchas

- **Plugin OAuth entry vs user-scope override coexist; URL-dedup
  picks the override.** When `/ace:setup` registers the user-scope
  bearer entry at `https://mcp.commcare.app/mcp`, Claude Code's MCP
  host dedups by URL signature and keeps the more specific entry
  (the bearer-carrying user-scope one). The plugin's OAuth entry is
  silently suppressed; tools surface as `mcp__nova__*`. If both
  show up in `claude mcp list` distinctly, something is wrong with
  the override registration — re-run `/ace:setup --force-env`.

- **Tool namespace depends on which entry wins.** Without the
  override (e.g. machine that hasn't run `/ace:setup` post-migration)
  tools surface as `mcp__plugin_nova_nova__*`. ACE skills use bare
  tool names in prose ("Nova's `get_app` tool") so the model resolves
  whichever namespace is live.

- **Three known upstream bugs** (none auth-related):
  - **`nova-plugin#1`** — `update_form` re-injects empty
    `entity_id`/`entity_name` on `connect.deliver_unit`. ACE's
    `app-connect-coverage` skill detects this on per-mutation
    re-fetch and exits `blocked` rather than looping.
  - **`nova-plugin#2`** — `/nova:autobuild` occasionally returns
    with zero tool actions. Phase 3 retries up to 3 times.
  - **`nova-plugin#5`** — `add_fields` partial persistence on first
    call. Mitigated by call-and-verify pattern in `pdd-to-{learn,deliver}-app`.

## What is NOT here

- A Nova fork or self-hosted Nova. Earlier design notes considered
  forking; that path is dead — Nova is a maintained external service.
- A Nova MCP server in this repo. ACE does not host one; the Nova
  plugin ships its own.
- A puppeteered web-UI integration. Considered as a fallback if Nova
  shipped no API; not needed.
