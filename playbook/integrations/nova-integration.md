# Nova Integration

> **Upstream repo: [`voidcraft-labs/commcare-nova`](https://github.com/voidcraft-labs/commcare-nova).** Nova ships continuously,
> so an ACE call path that has not changed in months can break because *they* shipped.
> When something that used to work starts failing — especially with an opaque error —
> run `skills/upstream-regression-triage` before concluding it needs a live probe.

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

## Uploading to HQ updates in place

**`upload_app_to_hq` is idempotent on the HQ application document.** The first
upload of a Nova app to a project space CREATES the HQ application; every
upload after that UPDATES that same document and keeps its id. The result says
which happened:

| field | meaning |
|---|---|
| `hq_app_action` | `created` on the first upload to the space, `updated` after |
| `hq_app_id` | stable across updates — this is the id Phase 4 wires into Connect |
| `deployment.remote_revision` | HQ's own revision, advances on each update |
| `deployment.left_behind` | superseded HQ app id(s). Normally `[]` |

Verified live 2026-08-18 against `connect-ace-prod`: Nova app `4dd0325b…`
(already linked to HQ `c0d7027316bc46f8b4fdf4b47fd8d90b` at
`pushed_revision: 10`) re-uploaded twice returned `hq_app_action: "updated"`
both times, held the same `hq_app_id`, advanced `remote_revision` 6 → 8, and
returned `left_behind: []` each time.

**This retires ACE's previous belief** that "CCHQ has no atomic app-update API,
so every `upload_app_to_hq` creates a fresh HQ application document." That
premise drove three things that are now wrong: an orphan cleanup on every
re-upload, an `hq_app_id_history` chase in `app-release`'s build-rejection
loop, and the Phase 3→4 HQ-id-stability warning in `agents/commcare-setup.md`.
All three are corrected; the `left_behind` cleanup survives as a defensive
branch, not the expected path.

**The id is still not immutable.** If the linked HQ app is deleted on HQ, the
call refuses with `remote_app_missing`; uploading again then creates a fresh
one. So read `hq_app_action` and `left_behind` rather than assuming stability
in either direction.

**Creating a NEW app needs a permission that updating does not appear to.** On
2026-08-18 two fresh Nova apps uploading to `connect-ace-prod` for the first
time both failed with:

```
error_type: hq_upload_failed
message: Your CommCare HQ account can't create apps in this project space.
         Ask an administrator there for the Edit Apps permission.
```

…while the update path against an already-linked app succeeded in the same
session with the same key. Tracked as an ACE issue; if Phase 3 `app-deploy`
halts on `hq_upload_failed` for a brand-new app, this is the first thing to
check (the HQ role behind Nova's stored HQ API key, on `ACE_HQ_DOMAIN`).

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

## Plugin freshness — treat every Nova release as a compatibility update

Braxton's standing ask (2026-08-02, ace#1165): **do not judge a Nova plugin
release optional from its version number.** Refresh, then restart.

```
/plugin marketplace update
/plugin update nova
# RESTART Claude Code (Cmd-Q + reopen) whenever the MCP tool surface changed —
# /reload-plugins does NOT respawn MCP connections.
```

**What actually goes stale — the distinction that decides how you debug this.**
The plugin declares an **HTTP** MCP server (`https://mcp.commcare.app/mcp`), so
the **tool surface is served live and does not ship in the package**. Verified
2026-08-02: `get_app_hq_feature_flags`, released in plugin 1.14.0, both loaded
*and* returned a real result from a 1.13.0 install. A new Nova tool is callable
from an old plugin.

What *does* ship in the package is the command/skill/agent layer —
`/nova:autobuild`, `/nova:upload_to_hq`, `nova-architect-autonomous`, and their
prompt guidance. So a stale plugin does not hide tools; it **silently runs an
older Nova workflow** (1.14.0's automatic HQ feature-flag check at final handoff,
for instance, simply does not happen) and carries prose describing retired tools
and argument shapes into an architect dispatch. Nova validates every mutation
before saving, so this fails closed rather than corrupting an app — but the
error looks arbitrary, especially when the same ACE workflow worked last run.
That is `commcare-setup` Step 0c's symptom with a nameable cause.

**Checked automatically:** `/ace:doctor` emits `nova_plugin_current` (WARN when
stale), and Phase 3 Step 0a reads it before dispatching the architect. Standalone:

```
bin/ace-nova-check   # UP_TO_DATE <v> | UPGRADE_AVAILABLE <old> <new> | NOT_INSTALLED | ERROR <why>
```

**Do not "improve" this into a commit-SHA comparison.** That was the first
implementation, and it is wrong here for two independent reasons.

**It solves a problem Nova doesn't have.** canopy's checker compares SHAs
because `canopy version bump` picks `max(local, origin/main)+1`, so two PRs off
the same base can both merge claiming the same number (`0.2.369` shipped twice,
40 seconds apart) — a reusable label can't be a freshness key. Nova is
hand-released by its maintainer, one commit per version, monotonic. The version
IS the correct key here; reaching for a SHA was importing canopy's fix for
canopy's pathology.

**And the SHA is unusable for this plugin anyway.** `nova@nova-marketplace` is
installed from a **`source.url` repo** (`voidcraft-labs/nova-plugin`) named in
the marketplace manifest, rather than living inside the marketplace repo — and
for that install shape the recorded `gitCommitSha` is **frozen at first install
and never rewritten.** Measured 2026-08-02: the entry read `version: 1.14.0`,
`installPath: …/1.14.0` and a fresh `lastUpdated`, while `gitCommitSha` was
still `5d1842bd` — whose own `plugin.json` says **1.0.0**, 22 commits and 14
releases back, matching `installedAt: 2026-05-01`.

**This is not general Claude Code behaviour**, and the distinction matters if
you ever write this check for another plugin. Measured across every plugin
installed on this machine, 2026-08-02:

| install shape | plugins | recorded `gitCommitSha` |
|---|---|---|
| marketplace-hosted (`source` is the marketplace repo) | canopy, ace, hal, eva, ada | matches `origin/main` **exactly**, 5/5, moves on every update |
| `source.url` (a separate repo named in the manifest) | nova, superpowers | **frozen near first install**, 2/2 |

`superpowers` is the confirming second case, and it is worth reading because it
shows the same defect on a plugin nobody here maintains: its registry entry
records `e7a2d16` (committed 2026-04-30) with `lastUpdated: 2026-07-24`, while
the marketplace manifest pins `source.sha: 44c9b2d…` — which IS current `main`.
So the registry's SHA disagrees with the SHA the plugin was actually installed
at. **Where a `source.url` entry carries a `source.sha`, that manifest pin is
the truthful pointer; the registry's `gitCommitSha` is not.**

So a SHA compare here reports "stale" on a current install, permanently, with no
operator action able to clear it — and a gate that cries wolf gets ignored.

The probe therefore compares versions, reading the local one from the
**installed cache dir's own `.claude-plugin/plugin.json`** rather than the
registry's metadata. Locked by `test/scripts/ace-nova-check.test.ts`.

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

- **Open upstream bugs (2, both filed 2026-08-13).** Neither halts a run;
  both silently degrade what Phase 3 can express.
  - `voidcraft-labs/commcare-nova#458` — on a **followup form**, a
    `case-ref` part addressing a property of that form's OWN case type is
    rejected with *"This expression does not survive Nova's canonical
    identity parse and print round trip"*. Observed across four expression
    shapes, two properties and three slot kinds (`validate`, `hint`, and
    the Connect `deliver_unit` `entity_id`/`entity_name`); `field-ref`
    parts round-trip fine in the same slots. This makes
    `pdd-to-deliver-app` § `entity_id`'s mandated case-UPDATE pattern
    (`#case/entity_key`) unexecutable as written. **Workaround:** add
    always-relevant hidden fields bound to the case properties you need
    (each needs `default_value: ''` or it is rejected — the preload then
    wins over the seed), and read them with ordinary `field-ref` parts.
    ACE-side tracking: ace#1180.
  - ~~`voidcraft-labs/commcare-nova#459`~~ — **CLOSED NOT_PLANNED
    2026-08-16, and DISPROVED. This was never a Nova bug.** Kept here
    because ACE shipped the wrong root cause into every architect brief
    for three days, and the correction is the useful part.

    What we claimed: Nova truncated tool payloads in transport before the
    tool saw them, surfacing as `InputValidationError: could not be
    parsed as JSON`, with an unclean threshold (~5 KB, then 1.9 KB).

    What upstream found: **the payloads never reached Nova.** That error
    string does not exist anywhere in Nova's stack — it is Claude Code's
    own client-side error, raised when the model's streamed tool-call
    arguments fail `JSON.parse` locally, *before any HTTP request is
    made*. Nova's request logs for 2026-08-10 show zero malformed-body
    failures and payloads up to **23.4 KB returning 200** — including
    7-8 KB calls from ACE's own batch workaround, already above the
    ceiling we thought we were avoiding. There is no size limit on
    Nova's input path, which is also why Nova could not have returned a
    "payload is N bytes, limit is M" refusal: there is no limit to name.

    Why it LOOKED like truncation: the harness echoes only the first
    ~200 chars of the received input in that error, so any larger payload
    reads as "cut mid-string" by construction. Two harness-side causes
    fit the inconsistent threshold — the generation being cut mid-call,
    and a deferred tool's schema dropping out of context after
    compaction (typed params then arrive as unparseable strings). The
    byte count the error reports is the RECEIVED length, so comparing it
    to the intended payload size distinguishes the two.

    **What this changes for ACE:** stop pre-batching `add_fields`
    defensively. The ~5-fields-per-call cadence guarded a limit that does
    not exist and cost real turns against the architect's 250-turn budget
    (one 51-field form burned ~20 batches). Send the natural batch; treat
    the error as a RECOVERY trigger — shrink and retry — not a planned
    cadence. Nova commits each batch atomically, so "nothing partially
    persisted" holds by construction and a retry cannot double-write.
    The receipt-checked verify-then-retry rule stays: it was always
    justified independently of this bug.

    The trilingual pressure that made this bite is gone regardless —
    per-language label support shipped upstream in #465/#466/#467, so
    labels no longer stack English + Chichewa + Tumbuka into every
    string. ACE-side tracking: ace#1181.

- **Notable capabilities (nothing upstream currently BLOCKS a run).** The
  two bugs above degrade expressiveness rather than halting. Counts of
  "N of M filed issues closed" are deliberately not kept here — they go
  stale silently and did (this line previously claimed 16 of 18 closed
  with the remainder being feature requests, while
  `voidcraft-labs/nova-plugin#25` — `create_app` failing 100% — was open
  and is not a feature request). Check the tracker.
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

## The per-language (i18n) channel — shipped 2026-08-16/17

Nova shipped a real translation channel over that weekend. Verified live
against `tools/list` on **2026-08-17**: **95 tools, up from 81 on
2026-08-14** — the date ACE checked and found zero language surface, which
is why ACE spent three days building English-only UIs (ace#1391 — now CLOSED
carrying the superseded English-only resolution, as is ace#968 before it. This
section plus `_app-component-library.md § app-language-layer` IS the current
source of truth; cite them and PR #1463, not those tickets).

**Six atoms:** `get_languages`, `get_translatable_content`, `add_language`,
`update_language`, `remove_language`, `update_translations`. All six are
already on `nova-architect-autonomous`'s allowed-tool list. Read their
schemas from the live `tools/list`; do not paraphrase them into a skill.

It is a genuine itext-shaped layer, not a workaround: translation units
(`tu1:` ids) over 17 worker-facing roles, per-language effective values,
source fingerprints for optimistic concurrency, explicit provenance and
review state, protected reference parts (a `field-ref` / `case-ref` /
`user-ref` inside a label survives translation exactly), ordered
source/default/target languages, ltr/rtl, and per-language coverage counts.

**The architect will not use it unprompted.** `get_agent_prompt`
(`autonomous_build`, 70,643 chars, read live 2026-08-17) contains **zero**
occurrences of `itext`, `locale`, `multiling` or `English`. Its only
substantive `language` mention states that the *chat* language is
independent of the app's configured languages, and its numbered build
workflow has no language step. The capability is real and the tools are
reachable; nothing happens unless the brief asks. ACE asks via
`_app-component-library.md § app-language-layer`.

### Contract facts — observed live, not inferred

Proven on 2026-08-17 against scratch app `b4e2c8fd` (created, exercised,
deleted). Each line is a behaviour ACE would otherwise have guessed at.

| Behaviour | Detail |
|---|---|
| Apps are born English | `sourceLanguage: en`, `defaultLanguage: en` on a fresh app |
| Catalog is broad, auto-translation is narrow | `classicCatalogSize: 486` codes addable manually; automatic translation covers only a checked-in **57-language set**, and **no MCP atom triggers it**. Chichewa/Nyanja (`ny`) returns `automaticTranslation.status: not-evaluated` |
| `add_language` COPIES, it does not translate | Response: *"copied 4 worker-facing strings from English. Every copied value needs review."* Entries land `origin: copied`, `review: needs-review`. A language added and left alone is an English app wearing another language's name |
| Writes are provenance-tagged automatically | An `update_translations` write flips `origin` from `copied` to **`ai`**. ACE never has to self-declare machine authorship — Nova records it |
| **`needs-review` text IS served to workers** | A `needs-review` unit's `effective` is the translation (`"Kafukufuku"`), not the English. **`review` is bookkeeping, not a publish gate.** Nothing withholds unreviewed text from a worker |
| **Stale translations fail safe to English** | Editing an English label demoted its `ny` translation to `out-of-date`, and that unit's `effective` reverted to the English source. Coverage moved `needs-review: 4` → `needs-review: 3, out-of-date: 1` |
| Optimistic concurrency is mandatory | `set` requires the current `expectedSourceFingerprint` (`source-v1:text:"Survey"` / `source-v1:prose:{…}`). Max 50 units per call. Page reads with `nextCursor` |
| `prose` units reject bare strings | `{"error":"Translation unit tu1:… requires a prose value."}`. Labels/hints/help/validation messages are `prose` → `{parts:[{kind:'text',text:'…'}]}`. App/module/form names are `text` → bare string |

### The two rules that follow

1. **Translate LAST.** Because any English edit demotes that unit to
   `out-of-date` and silently reverts it to English, a language added
   mid-build is progressively undone by the rest of the build. Finish the
   English, then add the language, then author translations, then confirm
   `get_languages` reports `out-of-date: 0`.
2. **`needs-review` is not a safety net.** Unreviewed ACE-authored text
   reaches workers immediately. The honesty mechanism is the provenance
   record (`origin: ai`) plus a real downstream review — not the state name.
   Do not tell an LLO that unreviewed translations are "not live yet."

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
