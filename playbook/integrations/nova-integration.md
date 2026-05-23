# Nova Integration

## Status

**Live (via the Nova Claude Code plugin's native PAT path, v1.1.0+).**
First end-to-end smoke test on 2026-04-28; migrated to API-key auth via
user-scope MCP override 2026-05-08 (voidcraft-labs/nova-plugin#9);
migrated to plugin-native PAT path 2026-05-21 (voidcraft-labs/nova-plugin#11
/ #13 / #16) — override dropped.

Braxton (voidcraft-labs) ships Nova as a Claude Code plugin. ACE
consumes it as a sibling plugin: install once per machine, mint an
API key, expose it as `NOVA_API_KEY` in the Claude Code parent shell's
env, and ACE invokes Nova through its slash commands and MCP tools.
Both `/nova:autobuild` and `/nova:upload_to_hq` round-trip cleanly
under the ACE service identity, including across multiple concurrent
worktrees and into dispatched subagents.

## Install + auth

```
/plugin marketplace add voidcraft-labs/nova-marketplace
/plugin install nova@nova-marketplace
```

Mint an API key once, store in 1Password, run `/ace:setup`, and add
one line to your shell rc:

1. Sign in at `https://commcare.app/settings` as the ACE Gmail
   identity (`ACE_GMAIL_ACCOUNT` in `.env`).
2. Mint a key with Read+Write floor + the HQ scopes
   `/nova:upload_to_hq` needs.
3. Save to 1Password vault `AI-Agents`, item `ACE - Nova`, field
   `api_key`.
4. Run `/ace:setup --force-env`. The setup script re-injects `.env`
   from 1Password, writes `~/.ace/env.sh` containing
   `export NOVA_API_KEY=…`, and (since 0.13.298) auto-appends a
   marker-fenced source block to the right shell rc for this machine:

   - macOS + zsh → `~/.zshenv` (launchd-spawned GUI Claude Code reads
     this; `~/.zshrc` is interactive-only)
   - macOS + bash → `~/.bash_profile`
   - Linux + zsh → `~/.zshrc`
   - Linux + bash → `~/.bashrc`

   The appended block looks like:

   ```
   # >>> ACE managed >>>
   [ -f "$HOME/.ace/env.sh" ] && source "$HOME/.ace/env.sh"
   # <<< ACE managed <<<
   ```

   Idempotent (marker grep) and reversible (delete the block). Pass
   `--no-shell-edit` to opt out.

5. **Restart Claude Code** (Cmd-Q + reopen) so the Nova plugin's
   `headersHelper` reads `NOVA_API_KEY` from the new process env.

The Nova plugin v1.1.0 `.mcp.json` ships a `headersHelper` that reads
`NOVA_API_KEY` from the Claude Code process env and emits
`Authorization: Bearer …` on every Nova MCP call. Without the shell-env
wiring, the helper emits `{}` and every Nova call 401s.

Tools surface in the canonical plugin namespace `mcp__plugin_nova_nova__*`.

`/ace:doctor` exposes four Nova-related liveness lines:
- `nova_env: NOVA_API_KEY present` (in ACE's .env)
- `nova_shell_env: NOVA_API_KEY present in shell env` (the plugin path
  is the one that matters)
- `net_nova_mcp: https://mcp.commcare.app/ → HTTP 4xx (reachable)`
- `nova_auth: ace-nova authed (POST initialize → HTTP 200)` (the key
  itself is accepted by the Nova server)

The Nova MCP server is hosted by voidcraft at `mcp.commcare.app`;
ACE doesn't run a Nova MCP itself.

## Migrating from the pre-1.1.0 user-scope override

If you previously ran an ACE version before 0.13.294, your Claude Code
config has a user-scope `nova:` MCP override registered. Drop it (it
shadows the plugin's PAT-aware MCP entry under Claude Code's URL-dedup
and re-introduces the subagent identity divergence Braxton fixed):

```
/plugin marketplace update                                  # in Claude Code
/plugin update nova                                         # ditto
/ace:update                                                 # ditto
/ace:setup --force-env                                      # writes ~/.ace/env.sh,
                                                            # removes stale override,
                                                            # auto-appends source line
                                                            # to shell rc (since 0.13.298)
# then Cmd-Q Claude Code and reopen so the plugin re-registers under PAT
```

`/ace:setup` automates three pieces idempotently (post-0.13.298):
the `claude mcp remove nova --scope user` cleanup, the `~/.ace/env.sh`
write, and the marker-fenced shell-rc append. Manual steps are only
needed if you pass `--no-shell-edit` or run on a shell ACE can't
auto-detect.

## Resolved blockers (kept for record)

Five blockers landed and were cleared between 2026-04-27 and
2026-05-21. Listed here for continuity — none active.

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

- **Plugin didn't expose server-side PAT auth at first
  (voidcraft-labs/nova-plugin#11, cleared 2026-05-21).** The Nova
  server accepted bearer auth before the plugin's `.mcp.json` knew
  how to send it. ACE's workaround was a user-scope MCP override at
  the same URL that carried `Authorization: Bearer ${NOVA_API_KEY}`
  as a literal header; Claude Code's URL-dedup picked the override
  over the plugin's OAuth-mode entry. Cleared by v1.1.0's
  `headersHelper` reading `NOVA_API_KEY` from the process env.

- **Subagent identity divergence under the override
  (voidcraft-labs/nova-plugin#13, cleared 2026-05-21).** Dispatched
  subagents (Nova architect autonomous) didn't inherit the level-0
  user-scope override and fell back to the plugin's OAuth-mode entry,
  authenticating as a different Nova identity — producing apps that
  `upload_app_to_hq` (running at level-0 as the override identity)
  couldn't see. Structurally fixed by moving the PAT into the
  plugin's own MCP entry: subagents inherit the plugin entry from
  the same process env, so they read the same `NOVA_API_KEY` and
  authenticate as the same identity as level-0.

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
| Nova MCP / plugin (ACE path) | Long-lived API key (`sk-nova-v1-…`) read from `NOVA_API_KEY` shell env by the plugin's `headersHelper` (v1.1.0+) |
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

- **`NOVA_API_KEY` must be in the Claude Code parent shell's env.**
  Nova plugin v1.1.0's `headersHelper` reads `NOVA_API_KEY` from the
  process env at MCP-connection time. ACE's `.env` lives at
  `${CLAUDE_PLUGIN_DATA}/.env` and is loaded only into ACE's own MCP
  subprocesses, not the parent shell. `/ace:setup` writes the export
  to `~/.ace/env.sh`; the operator sources it from `~/.zshrc` once
  per machine. If you skip the source line, Nova calls 401 even though
  `/ace:doctor`'s `nova_auth` HTTP probe passes — the probe verifies
  the key is accepted by the server, not that Claude Code is sending
  it. The `nova_shell_env` probe catches this mismatch.

- **Stale user-scope `nova:` override from pre-1.1.0 setup.** If you
  upgraded from an ACE version before 0.13.294 without restarting
  Claude Code, the obsolete override may still be registered. It
  shadows the plugin's PAT-aware MCP entry under Claude Code's
  URL-dedup and re-introduces the subagent identity divergence
  (voidcraft-labs/nova-plugin#13). Detected by `nova_shell_env`;
  remediation: `claude mcp remove nova --scope user`, then restart
  Claude Code. `/ace:setup` removes it idempotently on every run.

- **No known upstream bugs.** 16 of 18 filed issues are closed;
  remaining two (#8 field-level multimedia, #12 multi-project-space
  picker) are feature requests. Notable capabilities:
  - `update_form` `deliver_unit` schema exposes `entity_id` and
    `entity_name` as optional fields with sensible defaults.
  - `update_form` with nullable properties (e.g. `connect: null`)
    correctly clears on disk.
  - Autonomous architect has all case-list-config tools
    (`add_case_list_column`, etc.) — multi-module builds self-resolve
    validation errors without ACE-side patching.
  - XForm entity-encoding handles `<`/`>`/`&` in labels.
  - Connect block IDs enforced to 50-char limit at save time.
  - PAT auth eliminates OAuth token rotation; turn cap is 250;
    return message reliably includes `**App Name** (app_id)`.
  ACE-side defensive checks (`app-connect-coverage`, `app-release` CCZ
  verification, `commcare-setup` turn-0 retry) remain as safety nets
  but should not fire in normal operation.

## What is NOT here

- A Nova fork or self-hosted Nova. Earlier design notes considered
  forking; that path is dead — Nova is a maintained external service.
- A Nova MCP server in this repo. ACE does not host one; the Nova
  plugin ships its own.
- A puppeteered web-UI integration. Considered as a fallback if Nova
  shipped no API; not needed.
