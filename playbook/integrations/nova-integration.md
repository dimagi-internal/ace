# Nova Integration

## Status

**Live (via the Nova Claude Code plugin's native PAT path).** First
end-to-end smoke test on 2026-04-28; migrated to API-key auth
2026-05-08; switched from ACE-side user-scope MCP override to native
plugin-side PAT support 2026-05-09 after voidcraft-labs/nova-plugin#11
landed.

Braxton (voidcraft-labs) ships Nova as a Claude Code plugin. ACE
consumes it as a sibling plugin: install once per machine, mint an
API key, export it where Claude Code can see it, and ACE invokes
Nova through its slash commands and MCP tools. Both `/nova:autobuild`
and `/nova:upload_to_hq` round-trip cleanly under the ACE service
identity, including across multiple concurrent worktrees.

## Install + auth

```
/plugin marketplace add voidcraft-labs/nova-marketplace
/plugin install nova@nova-marketplace
```

The plugin's `.mcp.json` registers the Nova HTTP MCP entry with
`headers.Authorization = "Bearer ${NOVA_API_KEY}"`. Claude Code
expands `${NOVA_API_KEY}` from its process env at MCP-spawn time.
So:

1. Sign in at `https://commcare.app/settings` as the ACE Gmail
   identity (`ACE_GMAIL_ACCOUNT` in `.env`).
2. Mint a key with Read+Write floor + the HQ scopes
   `/nova:upload_to_hq` needs.
3. Save to 1Password vault `AI-Agents`, item `ACE - Nova`, field
   `api_key`.
4. Run `/ace:setup --force-env` — this re-injects `.env` from
   1Password.
5. **Export `NOVA_API_KEY` in your shell rc** so Claude Code's
   process env has it (the ACE `.env` at
   `$CLAUDE_PLUGIN_DATA/.env` is read by ACE's own MCP servers when
   they spawn, but Claude Code itself doesn't read it). One-time
   step per machine:

   ```bash
   echo 'export NOVA_API_KEY="$(grep -E "^NOVA_API_KEY=" "$HOME/.claude/plugins/data/ace-ace/.env" | sed -E "s/^NOVA_API_KEY=//;s/^\"(.*)\"\$/\\1/")"' >> ~/.zshrc
   exec zsh   # or restart your terminal
   ```

   Restart Claude Code so the new env var is in its process tree.

When `NOVA_API_KEY` is set, every Nova MCP call goes through PAT
auth — no browser flow, no refresh-token cascade. When unset, the
header expands to `Bearer ` (empty) and Nova returns 401, after
which Claude Code falls back to interactive OAuth (the plugin's
default behavior, kept as a fallback for human-at-a-browser use).

`/ace:doctor` exposes three Nova-related liveness lines:
- `nova_env: NOVA_API_KEY present`
- `net_nova_mcp: https://mcp.commcare.app/ → HTTP 4xx (reachable)`
- `nova_auth: ace-nova authed (POST initialize → HTTP 200)`

The Nova MCP server is hosted by voidcraft at `mcp.commcare.app`;
ACE doesn't run a Nova MCP itself.

## Resolved blockers (kept for record)

Four blockers landed and were cleared between 2026-04-27 and
2026-05-09. Listed here for continuity — none active.

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
  (voidcraft-labs/nova-plugin#9, cleared 2026-05-08 server-side).**
  Two ACE worktrees on one Nova/Google identity tripped a
  `deleteMany` cascade in `@better-auth/oauth-provider`'s
  `handleRefreshTokenGrant`: when worktree B presented a stale
  refresh token (after worktree A had just rotated it), the
  provider treated the stale presentation as theft-detection and
  wiped every `(userId, clientId)` refresh row — including the
  fresh one A had just gotten. Both worktrees forced through
  interactive OAuth every ~30 minutes. Resolved by Nova shipping
  API-key auth at the same MCP URL — no rotation, no cascade.

- **Plugin didn't expose the new PAT capability
  (voidcraft-labs/nova-plugin#11, cleared 2026-05-09).** Nova
  shipped the server-side PAT in May, but the plugin's `.mcp.json`
  had no `headers` block — so Claude Code defaulted to OAuth even
  with `NOVA_API_KEY` set. ACE worked around it by registering a
  user-scope MCP entry at the same URL with `claude mcp add nova
  ... --header "Authorization: Bearer $NOVA_API_KEY"`, relying on
  URL-signature dedup to suppress the plugin entry. Fragile —
  silently fell off across CLI updates. Resolved by adding a
  `headers.Authorization = "Bearer ${NOVA_API_KEY}"` block to the
  plugin's MCP config so the plugin uses the PAT directly. The
  ACE workaround was deleted in this version.

## ACE service identity for Nova

Under API-key auth, the bearer is identity. ACE's `NOVA_API_KEY`
points the entire fleet (every worktree, every operator's machine
that re-runs `/ace:setup` and exports the key) at one Nova-side
identity, which is the account that minted the key (the ACE Gmail
identity). All Nova state — apps, HQ binding, settings — lives
under that one user.

Rotating the key: regenerate at `commcare.app/settings`, update the
1Password item in place, then `/ace:setup --force-env` on each
machine, then re-run the shell-export step from § Install + auth
(or restart the terminal if the export references the .env at read
time, which is the recommended pattern).

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
  in 1Password item `ACE - Nova` / `api_key`. Read by the plugin's
  MCP entry via `${NOVA_API_KEY}` env-var expansion.
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
| Nova MCP / plugin (ACE path) | Long-lived API key (`sk-nova-v1-…`) via `${NOVA_API_KEY}` in plugin's MCP `headers` |
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

- **`NOVA_API_KEY` must be in Claude Code's process env**, not just
  in `$CLAUDE_PLUGIN_DATA/.env`. Claude Code's MCP-header
  `${NOVA_API_KEY}` expansion reads its own process env — the ACE
  `.env` is only read by ACE's own MCP server processes, which
  spawn under `dotenv.config()`. If you set the key in the .env but
  not your shell rc, the plugin's Bearer header will be empty and
  Nova will silently fall back to OAuth. The 2026-05-09 shell-export
  step in § Install + auth fixes this.

- **Tool namespace: `mcp__plugin_nova_nova__*`.** With the plugin's
  native PAT path, there's only one MCP entry. ACE skills use bare
  tool names in prose ("Nova's `get_app` tool") so the model
  resolves the right namespace regardless.

- **Three known upstream bugs** (none auth-related):
  - **`nova-plugin#1`** — `update_form` re-injects empty
    `entity_id`/`entity_name` on `connect.deliver_unit`. ACE's
    `app-connect-coverage` skill detects this on per-mutation
    re-fetch and exits `blocked` rather than looping.
  - **`nova-plugin#2`** — `/nova:autobuild` occasionally returns
    with zero tool actions. Phase 2 retries up to 3 times.
  - **`nova-plugin#5`** — `add_fields` partial persistence on first
    call. Mitigated by call-and-verify pattern in `pdd-to-{learn,deliver}-app`.

## What is NOT here

- A Nova fork or self-hosted Nova. Earlier design notes considered
  forking; that path is dead — Nova is a maintained external service.
- A Nova MCP server in this repo. ACE does not host one; the Nova
  plugin ships its own.
- A puppeteered web-UI integration. Considered as a fallback if Nova
  shipped no API; not needed.
