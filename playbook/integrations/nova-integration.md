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
| `app-deploy` | `/nova:upload_to_hq <app_id> <ACE_HQ_DOMAIN>` | Push both apps to the named HQ project space |

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
  (`/nova:upload_to_hq` DOES take a per-call HQ domain as a trailing
  argument — see `## HQ domain coupling` below.)

## HQ domain coupling

Since the voidcraft-labs/nova-plugin#12 release, `/nova:upload_to_hq`
takes the **target project space as an explicit trailing argument**:
`/nova:upload_to_hq <app_id> <domain>`. The underlying tool is
`upload_app_to_hq({ app_id, domain })`; ACE always passes `domain`.
Naming the space IS the upload confirmation, so Nova goes straight to
the upload — no interactive prompt, no `get_hq_connection` round-trip,
no confirmation line to watch. This is the clean path for hands-off
automated runs, and it makes a multi-space HQ API key safe (Nova no
longer guesses which of several reachable spaces to use).

ACE's contract:

1. `.env` declares `ACE_HQ_DOMAIN` (the HQ project space every upload
   targets) and `ACE_HQ_BASE_URL` (defaults to
   `https://www.commcarehq.org`). The committed template leaves
   `ACE_HQ_DOMAIN` unset — operators set it locally per deployment.
2. The HQ API key is generated under the ACE Gmail identity at
   `<ACE_HQ_BASE_URL>/account/api_keys/` and stored in 1Password
   (operator's vault choice; not pinned by the codebase). The key only
   needs to *reach* `ACE_HQ_DOMAIN` — it may be scoped to several
   spaces.
3. The operator pastes that HQ key into Nova's settings page once.
4. Phase 3's `Step 0b` pre-flight calls `get_hq_connection` and halts
   unless `ACE_HQ_DOMAIN` appears in the returned `available_domains`.
5. `app-deploy` / `app-release` pass `<ACE_HQ_DOMAIN>` on every
   `/nova:upload_to_hq` call. If the key can't reach it, Nova returns
   `error_type: domain_not_authorized` with the list of reachable
   spaces — `app-deploy` surfaces that as a `[BLOCKER]` rather than
   uploading to an unintended space.

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

- **Notable capabilities (no open upstream bugs blocking ACE).** 16 of
  18 filed issues are closed; remaining two (#8 field-level multimedia,
  #12 multi-project-space picker) are feature requests.
  - `update_form` with nullable properties (e.g. `connect: null`)
    correctly clears on disk.
  - Autonomous architect has all case-list-config tools
    (`add_case_list_columns`, etc.) — multi-module builds self-resolve
    validation errors without ACE-side patching.
  - XForm entity-encoding handles `<`/`>`/`&` in labels.
  - Connect block IDs enforced to 50-char limit at save time.
  - PAT auth eliminates OAuth token rotation; turn cap is 250;
    return message reliably includes `**App Name** (app_id)`.
  ACE-side defensive checks (`app-connect-coverage`, `app-release` CCZ
  verification, `commcare-setup` turn-0 retry) remain as safety nets
  but should not fire in normal operation.

- **`learn_module.time_estimate` is HOURS, not minutes — upstream's own
  description is wrong.** The live schema still reads *"Estimated
  minutes to complete the module's content"* on both `configure_connect`
  and `update_form` (re-confirmed 2026-07-31), but the value renders in
  Connect as hours. Author it as hours. Upstream:
  voidcraft-labs/nova-plugin#36. Do not "correct" ACE's skill text to
  match the upstream string — the string is the bug.

## The 2026-07-31 uuid-addressing migration (read this before writing a Nova call)

Nova redeployed mid-run at ~15:45Z on 2026-07-31 and moved its **entire**
surface from index-based to uuid-based addressing in one shot. A call
that returned real data at 14:55Z was rejected at 15:50Z:

```
MCP error -32602: Invalid arguments for tool get_field:
  path: ["moduleUuid"]  expected string, received undefined
  code: "unrecognized_keys"  keys: ["moduleIndex","formIndex","fieldId"]
```

Discovered two Nova builds deep in Phase 3 of
`spark-facilitator/20260731-0656` (jjackson/ace#1132, #1133). Verified
against `POST https://mcp.commcare.app/mcp` `tools/list` — **63 tools,
and zero of them accept any `*Index` parameter.** The migration is
total; there is no partial-rollout tool still taking indices.

| tool | live `required` |
|---|---|
| `get_module` | `[moduleUuid, app_id]` |
| `get_form` | `[moduleUuid, formUuid, app_id]` |
| `get_field` | `[moduleUuid, formUuid, fieldUuid, app_id]` |
| `add_fields` | `[moduleUuid, formUuid, fields, app_id]` (+ `parentUuid` / `afterFieldUuid` / `beforeFieldUuid`) |
| `edit_field` | `[moduleUuid, formUuid, fieldUuid, updates, app_id]` |
| `update_form` | `[moduleUuid, formUuid, app_id]` (+ `connect`, new `displayCondition`) |
| `update_module` | `[moduleUuid, app_id]` — **no `module_type`** |
| `update_app` | `[name, app_id]` — **`connect_type` REMOVED** |
| `get_app`, `list_apps`, `search_apps`, `search_blueprint`, `upload_app_to_hq`, `compile_app` | unchanged |

`moduleUuid` / `formUuid` / `fieldUuid` are regex-checked as canonical
**lowercase RFC UUIDs**, so a semantic field id (`community_id`) is
rejected outright — this is not a rename you can paper over.

### Where uuids come from — capture them, don't re-derive them

**`get_app({app_id})` is the one-call resolver.** Its markdown blueprint
carries a `[uuid …]` on every module, every form, and every field, plus
case-list column and search-input uuids — the whole addressing map in a
single read. Confirmed live 2026-07-31:

```
- Module "CBF Registration" [uuid b60055c1-ad1c-4542-895e-1ce42a8596de] (case_type: cbf)
  - Form "CBF Registration" [uuid c3deb000-1903-46cd-91cf-e7771ddd070e] (registration, 12 fields)
    [Connect enabled]
    - community_id [uuid c3df54f7-ba50-4639-a1a6-804dfa30b2bf] (text): "Community number" → cbf.community_id
```

Two sanctioned resolvers, for different jobs:

- **`get_app({app_id})`** — whole-app enumeration. Use this when a skill
  walks every form (coverage loops, field-count recipes, eval reads).
  One call, then read uuids off the map.
- **`search_blueprint({query, app_id})`** — targeted lookup when you hold
  a *semantic* name (a field id, case property, label fragment, or
  module/form name) and need its uuids. Returns
  `{results: [{type, moduleUuid, formUuid, fieldUuid, columnUuid?, field, value, context}]}`.

**Rule: persist uuids at build time.** `pdd-to-*-app` writes the module /
form / field uuids into its `*_app_summary.md` frontmatter so downstream
steps address by uuid without a re-lookup. One `get_app` at the end of
the build beats N resolutions later. `create_module` and `create_form`
also accept a **caller-supplied** `moduleUuid` / `formUuid`, so a build
can mint uuids up front and never look them up at all.

### `configure_connect` replaced `update_app({connect_type})` — and it is REPLACE-ALL

`update_app` now sets the display name only. The app-level Connect type
moved to a new tool:

```
configure_connect({ app_id, mode, participants })
  mode: "learn" | "deliver" | null
  participants: [{ formUuid, connect: { learn_module?, assessment?, deliver_unit?, task? } }]
```

It sets the app-level mode **and** every form's Connect block atomically,
which is strictly better than the hand-enforced set-then-re-read retry
loop it replaced — the `connect_type: ""`-with-populated-form-blocks
state that ace#783 healed is unreachable through this API.

> **⚠ It is REPLACE-ALL, not a patch.** Upstream's own words: *"learn/deliver
> requires the complete nonempty UUID-addressed participant set, and every
> unlisted form becomes auxiliary."* A partial `participants[]` **silently
> clears the Connect block off every form you omitted** — turning a
> marker-repair into a marker-deletion. Always enumerate the COMPLETE
> participating set (read it from `get_app` first) before calling.
> `mode: null` turns Connect off and clears every form block.

`update_form({moduleUuid, formUuid, connect})` still exists and has the
**opposite** semantics — per-form and additive. Upstream: *"Refine this
already-participating form after the app has a Connect mode: omitted
sub-configs keep their current value … Use configure_connect for enable,
mode switch, participant-set changes, or disable; whole-slot null is
refused here."*

| Job | Tool |
|---|---|
| Enable Connect / set app mode / add or remove a participating form / disable | `configure_connect` (complete participant set) |
| Tweak one sub-config on a form that ALREADY participates | `update_form({connect})` |

Connect blocks are **form-level**, addressed by `formUuid`. (The prior
note here said `deliver_unit` was module-level via
`add_module`/`update_module(module_type: …)` — that is dead: there is no
`add_module` tool, and live `update_module` has no `module_type`
property.)

### Field and expression shapes changed in the same redeploy

- **`case_property_on: "cbf"` → `caseWrite: {caseType, property}`.**
  Upstream: *"Complete case destination for this answer … The module's
  own type writes its primary case; a different type creates a child case
  (that child needs a writer whose `property` is `case_name`). Never set
  this on media kinds."*
- **`caseWrite` is WRITE-ONLY — it does not preload.** A *visible*
  case-bound field on a followup form preloads implicitly, with no
  expression needed. Don't author a preload expression to "fix" a field
  that already reads its case value.
- **Expressions are STRUCTURED, not strings.** `label`, `hint`,
  `required`, `relevant`, `validate`, `calculate`, `default_value`,
  `deliver_unit.entity_id` / `entity_name`, and `assessment.user_score`
  all take `{parts: [...]}`, where a part is one of:
  `{kind:'text', text}` · `{kind:'field-ref', uuid}` ·
  `{kind:'path-ref', uuid}` · `{kind:'case-ref', caseType, property}` ·
  `{kind:'user-ref', property}` ·
  `{kind:'user-property-ref', userPropertyUuid}`.
  **A plain string is rejected.**
- **A `hidden` field is rejected unless it carries `calculate` or
  `default_value`.** `calculate` recomputes when a referenced field
  changes; `default_value` is fixed at load.
- **Nova validates on write and applies NOTHING on rejection.** A failed
  call returns "Nothing was changed" and names the exact problem — so a
  rejection is safe to read and retry against, and a partial-apply state
  is not a thing to defend against.

### Four tools ACE did not previously know

`configure_connect` (above), `get_lookup_tables` (project data tables +
column uuids for lookup-backed fields), `rename_case_properties`
(whole-app simultaneous rename; chains/swaps/cycles allowed, merges
rejected), `set_field_options_source` (atomically replace a choice
field's complete option source — inline choices or a data table).

### The preventer

`scripts/probe-nova-contract.ts` pins the live `tools/list` to what ACE
actually sends — required params per tool, the removed-`connect_type`
assertion, the uuid regex, and a global "no tool anywhere accepts an
index-addressing param" rule. `test/scripts/nova-contract.test.ts` runs
the pure checker offline against a captured fixture on every `npm test`,
and hits the live server under `NOVA_INTEGRATION=1`. ACE had no probe
pinning Nova's contract before this; that absence is precisely why the
migration cost two Nova builds. Run it manually with
`npx tsx scripts/probe-nova-contract.ts`.

## What is NOT here

- A Nova fork or self-hosted Nova. Earlier design notes considered
  forking; that path is dead — Nova is a maintained external service.
- A Nova MCP server in this repo. ACE does not host one; the Nova
  plugin ships its own.
- A puppeteered web-UI integration. Considered as a fallback if Nova
  shipped no API; not needed.
