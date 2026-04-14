# Changelog

All notable changes to the ACE plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the plugin follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0 — 2026-04-14

Orchestration restructure. The previous 4-phase flow (`app-builder` →
`connect-setup` → `llo-manager` → `closeout`) hid OCS setup as Step 4 of
LLO management — *after* go-live, so LLOs went through onboarding and UAT
with no support bot. The new 6-phase flow makes OCS a first-class phase
that runs before any LLO-facing step, and consolidates two overlapping
OCS test paths into a single skill with three modes.

### Changed

- **Six-phase orchestration.** `ace-orchestrator` now dispatches: (1)
  design-review, (2) commcare-setup, (3) connect-setup, (4) ocs-setup,
  (5) llo-manager, (6) closeout. Phases 1–4 run end-to-end with zero LLO
  involvement, so an operator can review a fully configured opportunity
  before first contact.
- **`app-builder` split** into two agents: `design-review` (Phase 1 —
  `idea-to-idd` + new `idd-to-test-prompts`) and `commcare-setup`
  (Phase 2 — apps, deploy, test, training). The old `app-builder.md`
  is removed.
- **`ocs-setup` is a new Phase 4 agent** that runs `ocs-agent-setup` →
  `ocs-chatbot-qa --quick` (smoke gate) → `ocs-chatbot-qa --deep`
  (pre-launch gate) → widget handoff to Connect.
- **`ocs-agent-setup` is now purely configuration** — the inline 3–5
  question LLM-as-Judge self-eval and the connect-setup handoff are
  removed. Quality gating and widget handoff live in `ocs-setup`.
- **`ocs-chatbot-qa` gains `--quick` / `--deep` / `--monitor` modes.**
  `--quick` replaces the inline self-eval; `--deep` is the pre-launch
  gate that uses `test-prompts.md`; `--monitor` is recurring monitoring
  invoked from Phase 5 with a trend file.
- **`llo-invite` prepares-only** in Phase 3; sending moves to
  `llo-onboarding` in Phase 5 so the onboarding email can include the
  OCS widget link.
- **`llo-onboarding`** now owns both the Connect system invite send and
  the ACE-authored onboarding email (with widget link embedded).
- **`llo-manager`** is Phase 5; the old Step 4 (`ocs-agent-setup`) is
  removed. Step 4 is now recurring monitoring, including
  `ocs-chatbot-qa --monitor`.
- **Artifact manifest** phases renamed: `build` → `design` + `commcare`;
  `setup` → `connect`; new `ocs` phase (split from `operate`). Adds
  entries for `test-prompts.md`, `ocs-setup/widget-handoff.md`, and
  `qa-reports/trend.md`.

### Added

- **`idd-to-test-prompts` skill** (Phase 1 Step 2) — derives opp-specific
  Q&A pairs with expected-answer summaries from the IDD. Produces
  `ACE/<opp-name>/test-prompts.md`, the ground truth for the Phase 4
  deep QA gate. Previously `test-prompts.md` was referenced by
  `ocs-chatbot-qa` but had no producer.
- **`ocs-setup/widget-handoff.md`** — operator-facing handoff doc with
  `{public_id, embed_key}` and paste instructions for the Connect
  opportunity widget, since `update_opportunity` is unbuilt (CCC-301).

## 0.1.11 — 2026-04-14

Three fixes from the first CRISPR-Test-001 E2E run against live OCS.

### Changed

- Default OCS base URL migrated from `chatbots.dimagi.com` to
  `www.openchatstudio.com` across all live code, templates, commands,
  scripts, and tests (#26).
- `ocs_send_test_message` rewritten to use the anonymous widget chat API
  (`POST /api/chat/start/` → `/message/` → `/poll/`). The old
  OpenAI-compatible endpoint (`/api/openai/{id}/chat/completions`)
  returns 404 on connect-ace. Interface changed from
  `experiment_id` + `messages[]` to `public_id` + `embed_key` + `message`.
- `ocs_create_collection` now defaults `llm_provider` and
  `embedding_model` from `OCS_LLM_PROVIDER_ID` and
  `OCS_EMBEDDING_MODEL_ID` env vars when not explicitly provided.

### Added

- `OCS_LLM_PROVIDER_ID` and `OCS_EMBEDDING_MODEL_ID` in `.env.tpl` and
  `.env.example` — required for creating indexed RAG collections.

## 0.1.10 — 2026-04-13

### Fixed

- `drive_read_file` and `drive_list_folder` now resolve Google Drive
  shortcuts transparently. Shortcuts (mimeType
  `application/vnd.google-apps.shortcut`) are followed to their target
  file before reading or listing (#25).
- `loadRestToken()` returns empty string instead of throwing when
  `OCS_API_TOKEN` is not set, allowing REST-only startup to proceed.
- OCS MCP server startup is now non-fatal when REST verification
  fails — authoring tools (Playwright-backed) still work.

## 0.1.9 — 2026-04-11

Live-OCS validation of the per-opp RAG collection flow. Ships four form
and response-parsing fixes to `PlaywrightBackend` that were discovered
by running the E2E bot creation test against `chatbots.dimagi.com`.

### Added

- `lib/artifact-manifest.ts` — canonical definition of 30 ACE artifacts
  across 4 lifecycle phases, with `producedBy` / `consumedBy` skill
  relationships and a `validateFixture()` helper.
- `test/fixtures/artifact-manifest.test.ts` — fixture validation unit
  test that catches drift between the manifest and `CRISPR-Test-001`.
- `test/mcp/ocs/e2e-bot-creation.integration.test.ts` — full 12-step
  end-to-end bot creation flow against live OCS. Gracefully handles
  upstream OCS bugs (filed as dimagi/open-chat-studio#3161, #3162).
- `test/fixtures/CRISPR-Test-001/connect-setup/opportunity.md` and
  `training-materials/*` stubs — completes the fixture's inputs for
  the `ocs-agent-setup` skill.
- `ocs-tester` agent and `ocs-chatbot-qa` skill (delivered earlier in
  0.1.6 but not previously documented in the changelog summary).

### Fixed

- `publishChatbotVersion`: the Django form field is
  `is_default_version`, not `make_default`. The endpoint returns a 302
  redirect (not JSON); scrape the version number from the chatbot home
  page afterwards.
- `createCollection`: the form field is `is_index` (hidden input), not
  `collection_type` (which is a UI-only Alpine radio). For indexed
  collections, `llm_provider` and `embedding_provider_model` are both
  required — without them the form silently drops `is_index`.
- `uploadCollectionFiles`: OCS returns a 302 redirect after upload,
  not JSON with `file_ids`. Scrape `CollectionFile` PKs from the files
  listing partial (`id="collection_file_<pk>"`) instead of File IDs.
- `waitForCollectionIndexing`: the status endpoint returns an HTMX
  partial (HTML) with `data-tip="<status>"` and `<N> chunks`, not
  JSON. Parse both from HTML and throw a clear error on status=Failed.
- Collection delete uses HTTP `DELETE /documents/collections/<id>`
  (no trailing slash), not `POST .../delete/`.

### Changed

- Default `createCollection` to local index (`is_remote_index=False`)
  to match the OCS UI default. Remote indexes currently crash with a
  500 on `connect-ace` — tracked as dimagi/open-chat-studio#3161.

## 0.1.8 — 2026-04-10

### Added

- CI version bump check: PRs now fail if `VERSION` is not bumped (#23).

## 0.1.7 — 2026-04-10

### Added

- `scripts/hooks/pre-commit` and `scripts/sync-version.sh` — git pre-commit
  hook that automatically syncs `VERSION` into `package.json`,
  `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` when
  `VERSION` is staged. No more forgetting to update version in four places.

## 0.1.6 — 2026-04-10

### Added

- `email-communicator` skill — sends email from `ace@dimagi-ai.com` via GOG
  CLI. Used for LLO onboarding, feedback requests, and closeout comms (#20).
- `.env.tpl` — 1Password-injectable template for OCS and Gmail secrets.
  `dotenv` loader in `ocs-server.ts` resolves from `$CLAUDE_PLUGIN_DATA/.env`
  (plugin) or `./.env` (dev) (#22).
- `ocs-tester` agent + `ocs-chatbot-qa` skill — LLM-as-Judge quality
  evaluation for OCS chatbots. Sends test prompts, evaluates responses,
  and reports a quality score (#22).
- `test/mcp/ocs/e2e.integration.test.ts` — end-to-end integration test
  exercising the full Playwright backend flow: clone → set prompt → attach
  knowledge → get embed info → chat via widget → cleanup (#21, #22).
- `test/fixtures/CRISPR-Test-001`, `CRISPR-Test-002` — golden E2E test
  fixtures with idea, IDD, state, deployment summary, and app summaries.
- Shared Connect knowledge collection wired into golden template bootstrap
  and per-opp chatbot setup (#19).

### Changed

- CLAUDE.md regenerated with worktree/version/update workflow documentation.

## 0.1.5 — 2026-04-10

### Fixed

- `ace-gdrive` MCP server was silently failing to register tools. `tools/list`
  crashed with `Cannot read properties of undefined (reading '_zod')` because
  zod 4.x's internal schema representation is incompatible with
  `zod-to-json-schema@3.25.2` (used by `@modelcontextprotocol/sdk@1.29.0`).
  Pinned zod to `^3.25.28` which restores all 18 Drive/Sheets/Docs tools.

## 0.1.4 — 2026-04-09

Fast update check — no more waiting for `git pull` just to see if you're
current.

### Changed

- `/ace:update` Step 1 now curls the raw VERSION file from GitHub (typically
  under 300ms) instead of doing a full `git pull origin main` before comparing
  versions. The `git pull` only runs in Step 2 when an update is actually
  available. Same pattern `gstack-update-check` uses.

## 0.1.3 — 2026-04-09

Auto-update checks are now built in — no setup step needed.

### Added

- `hooks/hooks.json` declares a native `SessionStart` hook that runs
  `bin/ace-update-check` on every new Claude Code session. This is the same
  mechanism superpowers uses. The hook loads automatically when the plugin is
  enabled — no user action, no settings.json patching, clean uninstall.

### Changed

- `/ace:doctor` now checks for `hooks/hooks.json` at the plugin root instead
  of grepping `~/.claude/settings.json` for a user-level hook. The old
  settings.json approach still works if present, but the native plugin hook is
  the canonical mechanism.

## 0.1.2 — 2026-04-09

`/ace:doctor` overhaul: the checks now actually print their messages, and the
detection logic stops getting confused when you run the doctor from inside a
dev worktree.

### Fixed

- `/ace:doctor` output lines were coming back as bare `PASS ` / `FAIL ` with
  empty messages. The helper functions in `commands/doctor.md` used `$1` / `$2`
  positional params, which Claude Code's slash-command argument expansion
  substituted with empty strings *before* bash ever saw the script. The doctor
  logic has been moved out of the slash command body into a real
  `bin/ace-doctor` script, so positional params behave normally.
- Plugin-root detection no longer silently audits a dev worktree when you meant
  to audit the installed plugin. Previously the detection walked up from `$PWD`
  before falling back to the installed cache, so running `/ace:doctor` from
  inside an ACE checkout shadowed the real install. `bin/ace-doctor` now
  defaults to auditing the copy it ships in (which, for the slash command, is
  always the installed plugin), and the launcher resolves that copy via
  `$CLAUDE_PLUGIN_ROOT` → `~/.claude/plugins/installed_plugins.json` → a
  version-sorted cache fallback.

### Added

- `bin/ace-doctor` standalone script. Supports `--here` (walk up from `$PWD`
  for dev workflows), `--installed` (force the registered install), and
  `ACE_DIR=/path` / `--root /path` overrides. Emits
  `INFO cwd_is_ace_checkout=...` when you're standing inside a different
  ACE checkout than the one being audited, so there's never ambiguity about
  which copy was checked.

## 0.1.1 — 2026-04-09

Shared Drive support for the Google Drive MCP and a clean service-account key
location that survives plugin updates.

### Fixed

- `mcp/google-drive-server.ts` now passes `supportsAllDrives: true` on every
  `drive.files.*` / `drive.permissions.create` call, and
  `includeItemsFromAllDrives: true` on list calls. Without these flags, service
  accounts hit `Service Accounts do not have storage quota` when creating docs
  even inside a Shared Drive folder, because the Drive API silently treated
  the write as a "My Drive" create. ACE skills can now write artifacts into
  the ACE Shared Drive folder.

### Changed

- Service-account key path is now resolved from the standard
  `GOOGLE_APPLICATION_CREDENTIALS` env var, which `.mcp.json` sets to
  `${CLAUDE_PLUGIN_DATA}/gws-sa-key.json`. That location is outside the
  versioned plugin cache dir, so it automatically survives `/ace:update` and
  is shared across worktrees and installs — drop the key once per machine.
  Falls back to the legacy `<plugin-root>/.gws-sa-key.json` for in-repo dev
  workflows.
- `/ace:setup` and `/ace:doctor` now probe the canonical
  `$CLAUDE_PLUGIN_DATA` path first and warn with a migration hint on legacy
  installs.
- `/ace:update` no longer copies `.gws-sa-key.json` forward on each update —
  it's in the persistent data dir now, so there's nothing to carry.
- README, design spec, and setup docs migrated off the retired
  `gws-local-dev@dimagi-chrome-extension` service account and on to
  `ace-service-account@connect-labs`, with a Shared Drive requirement note.

## 0.1.0 — 2026-04-09

Initial deploy infrastructure — ACE can now be installed, updated, and
diagnosed like a first-class Claude Code plugin.

### Added

- `.claude-plugin/marketplace.json` so ACE can be installed via
  `/plugin marketplace add jjackson/ace`. The repo root acts as both the
  marketplace and the plugin source.
- `VERSION` file as the lightweight source-of-truth for `bin/ace-update-check`.
  Must stay in lock-step with `plugin.json`, `marketplace.json`, and
  `package.json` on every release (`/ace:doctor` cross-checks them).
- `/ace:setup` — one-shot installer. Detects the plugin root, runs
  `npm install`, verifies `.gws-sa-key.json`, checks `tsx` and `.mcp.json`,
  and optionally registers a `SessionStart` hook for automatic update checks
  (`--auto-update`). Replaces the three manual README steps.
- `/ace:update` — rigid, scripted updater modelled on canopy's
  `/canopy:update`. Pulls from `~/.claude/plugins/marketplaces/ace`, rsyncs
  into a new versioned cache dir (excluding `node_modules` and the service
  account key, which are carried forward), runs `npm install`, updates
  `installed_plugins.json`, and tells the user to `/reload-plugins`.
- `/ace:doctor` — diagnostics command. Cross-checks version consistency,
  dependencies, the service account key, the MCP manifest, the update-check
  script, and related repos (`ace-web`, `connect-labs`). Prints PASS/WARN/FAIL
  with fix hints for each check.
- `bin/ace-update-check` — lightweight bash script borrowed from gstack. Reads
  local `VERSION`, curls the remote from `raw.githubusercontent.com`, caches
  in `~/.ace/update-check` (60-min TTL up-to-date, 720-min TTL
  upgrade-available), and respects a snooze file with escalating backoff
  (24h / 48h / 7d). Outputs `UPGRADE_AVAILABLE` / `JUST_UPGRADED` / nothing.
- `migrations/` directory and `migrations/README.md` explaining when to add
  version-to-version migration scripts for breaking changes.

### Changed

- README `Setup` section rewritten to describe the marketplace install
  followed by `/ace:setup` and `/ace:doctor`. Manual instructions are kept as
  a fallback for local dev checkouts.

### Inheritance notes

- **Canopy pattern (plugin manifest + marketplace + rigid update):** the
  update flow and marketplace layout are straight ports of canopy's approach,
  which has proven durable across 0.2.20 → 0.2.28 releases. ACE improves on
  canopy by carrying the service-account key forward across upgrades
  explicitly (canopy has no equivalent secret) and by running `npm install`
  inside the new cache dir so `node_modules` is always in sync with the
  updated `package.json`.
- **Gstack pattern (lightweight update-check + snooze):** `bin/ace-update-check`
  is a direct port of gstack's `bin/gstack-update-check`, minus the telemetry
  ping and the stale-Codex-description migration. The snooze levels (24h / 48h
  / 7d) and cache TTLs (60m / 720m) are kept identical — they're well-tuned
  and I didn't see a reason to deviate for a first cut.
