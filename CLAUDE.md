# ACE — Agent Guide

ACE (AI Connect Engine) is a Claude Code plugin that orchestrates the CRISPR-Connect lifecycle for Connect opportunities — idea → app build → deploy → LLO management → closeout. It follows the canopy plugin architecture, with a tweak: agents in `agents/` come in two forms (procedure docs that the top-level session executes inline, and subagents dispatched from level 0); skills in `skills/` are prompt-based `SKILL.md` files; MCP servers in `mcp/` provide external-system access. See § Agent topology below for the invariant that determines which agents are which form.

## Agent topology

ACE has one architectural rule: **anything that calls `Agent` must run
at level 0** (the top-level Claude Code session). The `Agent` tool is
unavailable to subagents, so a node that needs to dispatch further work
cannot itself be a subagent. The directory structure looks the same
either way (everything lives under `agents/`), but the wiring differs:

| Node | Calls `Agent`? | Form | Invoked how |
|------|----------------|------|-------------|
| `ace-orchestrator` | yes (dispatches phases + Nova) | procedure doc | `/ace:run` reads it and executes inline |
| `commcare-setup` (Phase 2) | yes — `/nova:autobuild` is a hidden Agent dispatch | procedure doc | orchestrator reads it and executes inline |
| `design-review` (Phase 1) | no | subagent | `Agent(design-review)` from level 0 |
| `connect-setup` (Phase 3) | no | subagent | `Agent(connect-setup)` from level 0 |
| `ocs-setup` (Phase 4) | no | subagent | `Agent(ocs-setup)` from level 0 |
| `qa-and-training` (Phase 5) | no | subagent | `Agent(qa-and-training)` from level 0 |
| `execution-manager` (Phase 7) | no | subagent | `Agent(execution-manager)` from level 0 |
| `closeout` (Phase 8) | no | subagent | `Agent(closeout)` from level 0 |
| `ocs-tester` | no — leaf qa+eval pair | subagent | `Agent(ocs-tester)` ad-hoc |

There are never two levels of `Agent` dispatch — that's the invariant.
Procedure docs retain frontmatter so tooling (`/ace:status`, `/ace:eval`,
`/ace:doctor`, `/ace:docs`) that introspects agent metadata keeps
working. They are not registered as subagents in the dispatch sense:
`/ace:run` and `/ace:step` execute them inline.

This rule landed in 0.7.0. The previous design dispatched the
orchestrator as a subagent, which silently broke Phase 2 the moment
ACE migrated CommCare app builds onto Nova's `/nova:autobuild` (0.6.0)
— Nova's slash command dispatches the architect via `Agent`, and an
orchestrator-as-subagent put that dispatch at level 2 where `Agent`
isn't available. The fix flattens the dispatch tree so every `Agent`
call originates at level 0.

## Layout

- `agents/` — 9 agents total. Two are procedure docs (`ace-orchestrator`, `commcare-setup`); seven are subagents (`design-review`, `connect-setup`, `ocs-setup`, `qa-and-training`, `execution-manager`, `closeout`, `ocs-tester`). See § Agent topology above for the rule. Phases 1–5 run end-to-end with zero LLO involvement; Phase 7 is where LLOs first hear from ACE (Phase 6 publishes a public solicitation but does not contact specific LLOs unless the PDD names preferred candidates).
- `skills/` — ~36 skills, one directory per skill, each with a single `SKILL.md`. Skills are stateless; opportunity state lives in Google Drive under `ACE/<opp-name>/`. See `skills/README.md` for the author contract, including the `## QA vs Eval — the two-phase pattern` section that governs `-qa` / `-eval` skill pairs and the `opp-eval` umbrella-aggregator pattern. Per-skill `-eval` rubrics are calibrated against ground-truth catalogues — see `skills/eval-calibration/SKILL.md`.

  **Phase 5 per-artifact training split (0.10.79–0.10.89):** the previous `training-materials` monolith was decomposed into one skill per artifact: `training-llo-guide`, `training-flw-guide`, `training-quick-reference`, `training-faq`, `training-onboarding-email`, `training-deck-outline`. Plus `training-deck-build` which renders the deck-outline markdown into a real Google Slides deck. The umbrella was removed entirely in 0.10.89; Phase 5 dispatches each per-artifact skill directly. See `playbook/integrations/slides-integration.md` for the Slides API contract + gotchas.
- `commands/` — 13 slash commands: `run`, `step`, `status`, `eval`, `docs`, `setup`, `update`, `doctor`, `ocs-login`, `connect-login`, `mobile-bootstrap`, `ocs-bootstrap-template`, `labs-token-mint`.
- `mcp/` — 4 MCP servers, all wired inline in `.claude-plugin/plugin.json` under `mcpServers` (moved there in 0.5.16 from a plugin-root `.mcp.json` to work around [anthropics/claude-code#9427](https://github.com/anthropics/claude-code/issues/9427) — `${CLAUDE_PLUGIN_DATA}` / `${CLAUDE_PLUGIN_ROOT}` substitution is broken in plugin-root `.mcp.json` but works inline):
  - `google-drive-server.ts` → `ace-gdrive` (Drive + Docs + Slides + Sheets tooling). Slides atoms (`slides_get`, `slides_batch_update`, `slides_copy_template`) shipped 0.10.78; back the `training-deck-build` skill. See `playbook/integrations/slides-integration.md` for the durable-knowledge gotcha record (SA can't `presentations.create`, `createImage` needs anyone-with-link, etc.).
  - `ocs-server.ts` → `ace-ocs` (composite Open Chat Studio backend, 22 atoms). Source under `mcp/ocs/` — `capability-map.ts`, `client.ts`, `types.ts`, `backends/{composite,rest,playwright,pipeline-patch}.ts`, `auth/`, `logging.ts`, `errors.ts`.
  - `connect-server.ts` → `ace-connect` (composite Connect backend, 21 atoms — Programs, Opportunities, verification flags, payment units, deliver units, activation, LLO program-applications, FLW invites, invoices). 8 of the 11 authoring atoms route to the REST automation API ([commcare-connect#1135](https://github.com/dimagi/commcare-connect/pull/1135), since 0.10.47); the rest still drive HTML form pages via Playwright. Source under `mcp/connect/` mirrors the OCS shape exactly.
  - `mobile-server.ts` → `ace-mobile` (Maestro + AVD + Playwright OTP, 10 atoms — Mac-only local Android emulation for Phase 5 `qa-and-training`). Source under `mcp/mobile/` mirrors the OCS shape: `capability-map.ts`, `client.ts`, `types.ts`, `errors.ts`, `logging.ts`, `auth/fetch-otp.ts`, `backends/{avd,maestro,recipe-generator}.ts`, plus `recipes/static/*.yaml`.
- `playbook/integrations/` — integration reference: `ocs-integration.md`, `nova-integration.md`, `connect-api.md`, `commcare-api.md`, `mobile-integration.md`, `slides-integration.md`. Each describes what exists today vs. what still needs to be built, plus the durable-knowledge gotcha record for that integration.
- `docs/superpowers/specs/` — design specs (see Key Docs).
- `docs/superpowers/plans/` — implementation plans (see Key Docs).
- `docs/examples/` — PDD examples + stress-test observations.
- `docs/generated/playbook.md` — human-readable process flow, regenerated by `/ace:docs` from agent + skill definitions. Derived; not a source of truth.
- `templates/` — `pdd-template.md`, `onboarding-email-template.md`.
- `lib/artifact-manifest.ts` — canonical definition of every artifact in `ACE/<opp-name>/`, which skill produces it, and which skills consume it. Used by fixture validation tests and future ace:doctor checks. Companion: `lib/verdict-schema.ts` (uniform `-eval` verdict shape) and `lib/plugin-data-dir.ts`.
- `test/` — `vitest` suites under `test/mcp/ocs/` and `test/mcp/connect/` (unit, integration, and E2E tests), `test/eval/` for PDD evals, `test/fixtures/` with golden E2E fixtures (`CRISPR-Test-001` atomic-visit, `CRISPR-Test-002` focus-group, `CRISPR-Test-003-Turmeric` complete closeout fixture) plus `test/fixtures/connect-html/` HTML scrape fixtures, `test/fixtures/artifact-manifest.test.ts` validates fixtures against the manifest.
- `scripts/` — `bootstrap-ocs-golden-template.ts` (backing `/ace:ocs-bootstrap-template`), `sync-version.sh` (called by pre-commit hook), `version-bump.sh` (worktree-safe bumper: fetches origin and picks `max(local, origin) + patch+1`, then delegates to `sync-version.sh`), `hooks/pre-commit` (git hook for version sync), plus 10 `probe-*.ts` scripts and `test-sa-*.ts` — executable investigation scripts that document live OCS / Connect contract probes (kept under `scripts/` as durable reproducers; safe to re-run).
- `hooks/hooks.json` — native Claude Code plugin hook: runs `bin/ace-update-check` on `SessionStart`.
- `.env.tpl` — 1Password-injectable template for OCS, Connect-HQ, and Gmail secrets. Installed `.env` lives at `${CLAUDE_PLUGIN_DATA}/.env` (legacy fallback: plugin root). Regenerate with `op inject -i .env.tpl -o "$CLAUDE_PLUGIN_DATA/.env" --account dimagi.1password.com`. **1Password is the source of truth**; never paste values into `.env` directly — they get blown away on the next `op inject`.
- `bin/ace-doctor` — bash-driven diagnostic script behind `/ace:doctor`; checks deps, version sync, env-var drift (`.env.tpl` ↔ installed `.env`), MCP wiring, OCS/Drive/Connect readiness, and the live `ocs_shared_collection_team` HTTP probe.
- `bin/ace-update-check` — background update-check shim (borrowed from gstack).
- `migrations/` — version-to-version migration scripts for breaking changes. See `migrations/README.md`.

## Current state

- **Plugin is installable and self-updating.** `/ace:setup`, `/ace:update`, `/ace:doctor` all shipped (0.1.0, PRs #11, #13). See `CHANGELOG.md`.
- **Google Drive MCP is live.** `ace-gdrive` wired inline in `.claude-plugin/plugin.json` `mcpServers` (moved in 0.5.16; PR #6 originally landed it; PR #25 added shortcut resolution). Requires a service-account key at `${CLAUDE_PLUGIN_DATA}/gws-sa-key.json` (or `.gws-sa-key.json` in the plugin root as legacy fallback).
- **OCS MCP is mature and contract-hardened.** `ace-ocs` with 22 atomic capabilities and composite + REST + Playwright backends (PRs #9, #10, #14). E2E integration tests (PR #22, PR #24) cover full clone → configure → embed → chat against live OCS. The `ocs-tester` agent + `ocs-chatbot-qa` / `ocs-chatbot-eval` pair provide LLM-as-Judge quality evaluation. Contract-hardening fixes drove the turmeric dogfood validation composite from 6.5 to 9.1: 0.5.1 publish pre-flight (PR #39), 0.5.18 Drive Shared-Drive guard, 0.6.1 `experiment_id` contract + `attach_knowledge` pre-flight, 0.6.4 transactional `set_chatbot_pipeline` (PR #61), 0.6.9 HTMX-scrape `experiment_id` recovery (PR #63), 0.6.10 `{collection_index_summaries}` cross-field rule (PR #64). The OCS plan `docs/superpowers/plans/2026-04-08-ace-ocs-chatbot-buildout.md` is **substantially shipped** through 0.6.10. Authenticate with `/ace:ocs-login` before calling tools that hit live OCS.
- **OCS domain migrated.** Default base URL is `https://www.openchatstudio.com` (was `chatbots.dimagi.com`); PR #26. `ocs_send_test_message` uses the anonymous widget chat API (`/api/chat/start/` → `/message/` → `/poll/`); `ocs_create_collection` defaults `llm_provider` and `embedding_model` from `OCS_LLM_PROVIDER_ID` / `OCS_EMBEDDING_MODEL_ID`.
- **Connect MCP shipped (0.8.0–0.10.38), automation-API adoption in 0.10.47.** `ace-connect` mirrors the `ace-ocs` pattern — composite backend over `connect.dimagi.com`, authenticated as `ace@dimagi-ai.com` via OAuth-with-CommCareHQ. 21 atoms today: 8 authoring atoms go through the new REST automation API ([commcare-connect#1135](https://github.com/dimagi/commcare-connect/pull/1135) — `create_program`, `create_opportunity`, `create_payment_unit`/`create_payment_units`, `activate_opportunity`, `send_llo_invite`, `accept_program_application`, `send_flw_invite`); the remaining atoms still drive HTML pages via Playwright (reads, edits, verification flags, invoices). Both backends share the same authenticated session — DRF's `SessionAuthentication` accepts the same Django sessionid + CSRF that the Playwright OAuth flow produces. Five Phase-3/5/6 skills that previously shipped `## Current Workaround` blocks (`connect-program-setup`, `connect-opp-setup`, `llo-onboarding`, `llo-launch`, `opp-closeout`) are atom-driven and HITL-free. Authenticate with `/ace:connect-login` (covers MFA/SSO via headed browser). Plan: `docs/superpowers/plans/2026-04-28-ace-connect-mcp.md`. Key contract notes: Connect has TWO invite atoms — `connect_send_llo_invite` is **program-level** (takes a `program_id` UUID and a target LLO workspace `organization` slug); `connect_send_flw_invite` is **opportunity-level** and takes an array of `+<country><digits>` phones. The new `/invite_users/` endpoint requires the opp to be `active`, so call `connect_activate_opportunity` first. The previous `register_hq_api_key` and `finalize_opportunity` atoms were removed in 0.10.47 — `create_opportunity` now folds both jobs server-side (registers `HQApiKey` records via `get_or_create` and takes `start_date`/`end_date`/`total_budget` upfront).
- **Mobile MCP shipped (0.10.0).** `ace-mobile` mirrors the `ace-ocs` pattern — 10 atomic capabilities driving a local Mac AVD via Maestro + adb + Playwright OTP fetcher. Backs the new Phase 5 `qa-and-training` agent and its `app-screenshot-capture` skill. Mac-only, dev-machine-only — no cloud device farms. Static Maestro recipes in `mcp/mobile/recipes/static/` ship as scaffolds with `REPLACE_*` selectors that need filling via `maestro studio` against the Connect Android APK before live runs. Plan: `docs/superpowers/plans/2026-04-28-ace-mobile-emulation.md`. Bootstrap with `/ace:mobile-bootstrap`.
- **Orchestration runs 8 phases as of 0.12.0.** Phase order: (1) design-review → (2) commcare-setup → (3) connect-setup → (4) ocs-setup → (5) qa-and-training → (6) **solicitation-management** (NEW) → (7) **execution-management** (renamed from llo-management) → (8) closeout. Phase 6 publishes a solicitation derived from the PDD on labs.connect.dimagi.com and emails PDD-named candidate LLOs the public URL, then halts at the new external-comms boundary. Phase 7 onboards the awarded LLO chosen by the manual `solicitation-review` skill; entry is gated on `opp.yaml.selected_llo.org_slug`. Phase 7 is the first 1-1 LLO contact (Phase 6 publishes a public listing but does not target individuals unless the PDD names preferred candidates).
- **Self-improving eval framework (0.8.0 → 0.9.11).** The original `opp-eval` umbrella (0.4.0) gained ground-truth catalogues, multi-run variance protocol, inflation guards, and coverage-aware verdicts. Per-opp ground truth lives at `ACE/<opp>/eval-calibration/known-issues.md`; rubric audit trails live at `ACE/<opp>/eval-calibration/<rubric>-runs.md`. Eight `-eval` rubrics across 6 categories (4 strongly calibrated, 4 provisional). `opp-eval` produced its **first real PASS verdict** (not coverage-capped) on `smoke-20260428-1242` in 0.9.3; cross-opp validation in 0.9.11 confirms 3 of 4 calibrated rubrics generalize. Methodology in `skills/eval-calibration/SKILL.md` and `docs/eval-calibration-learnings.md`.
- **Connect-labs MCP integration via stdio proxy (0.12.0).** `connect-labs` covers the *grants pipeline* (solicitations, reviews, awards, funds) and runs as a remote HTTP MCP at `https://labs.connect.dimagi.com/mcp/`. ACE consumes it via a thin local stdio proxy (`mcp/connect-labs-server.ts`) that forwards JSON-RPC frames and injects `LABS_MCP_TOKEN` (Bearer PAT). When Claude Code's plugin.json gains first-class HTTP MCP support, the proxy can be deleted in favor of a direct `type: "http"` entry. ACE's new Phase 6 (Solicitation Management) consumes 10 atoms from this MCP: `create_solicitation`, `list_solicitations`, `get_solicitation`, `list_responses`, `get_response`, `award_response`, `create_review`, `list_reviews`, `update_solicitation`, `generate_criteria`. CommCare's MCP also lives in `connect-labs`. ACE's `ace-connect` covers the orthogonal *opportunities pipeline* (Programs, Opportunities, Invites, Invoices) on `connect.dimagi.com`. Skills that depend on CommCare APIs still ship `## Current Workaround` sections and degrade to human-in-the-loop.
- **Nova plugin is live end-to-end.** Nova ships as its own Claude Code plugin (`voidcraft-labs/nova-marketplace`). ACE consumes Nova as a sibling — install once with `/plugin install nova@nova-marketplace`, OAuth on first use, and `pdd-to-learn-app` / `pdd-to-deliver-app` / `app-deploy` invoke its slash commands. End-to-end smoke test passed 2026-04-28 (PR #62). See `playbook/integrations/nova-integration.md`.
- **ace-web is a sibling repo, not a submodule.** Removed in commit `b7ccf35`. Browser-harness work happens in the `ace-web` checkout; this repo owns the design spec, `ace-web` owns implementation plans 1A–1D.
- **Doctor is class-level preventer for silent misconfigs.** 0.5.4 closes `.env-drift`; 0.5.9 detects MCP env-passthrough gaps; 0.5.18 catches Drive Shared-Drive misconfig; 0.7.1 adds `ocs_shared_collection_team` — a 50ms HTTP probe that catches an `OCS_SHARED_COLLECTION_ID` that exists but lives on a *different* OCS team (the previous check only verified the env var was non-empty). Doctor now also reports `connect_env` and `connect_session` freshness, plus a `[Mobile]` section for Maestro/AVD/Playwright readiness (0.10.0).
- **Email skill shipped.** `email-communicator` (PR #20) uses GOG CLI to send from `ace@dimagi-ai.com`. Config via `.env.tpl` / `.env`.
- **CI version-bump check.** PR #23 verifies VERSION is bumped on PRs.
- **Plugin is installable and self-updating.** `/ace:setup`, `/ace:update`, `/ace:doctor` all shipped (PRs #11, #13). See `CHANGELOG.md` for 0.1.0 release notes.
- **Google Drive MCP is live.** `ace-gdrive` wired inline in `.claude-plugin/plugin.json` `mcpServers` (moved there in 0.5.16 from `.mcp.json`; PR #6 originally landed it). Resolves Drive shortcuts transparently in `drive_read_file` and `drive_list_folder` (PR #25). Requires a service-account key at `${CLAUDE_PLUGIN_DATA}/gws-sa-key.json` (or `.gws-sa-key.json` in the plugin root as legacy fallback) — see README for setup.
- **OCS MCP is mature and contract-hardened.** `ace-ocs` is wired, ~22 atomic capabilities are defined in `mcp/ocs/capability-map.ts`, and composite + REST + Playwright backends are implemented (PRs #9, #10, #14). E2E integration test (PR #22) exercises the full clone→configure→embed→chat flow against live OCS. The `ocs-tester` agent + `ocs-chatbot-qa` / `ocs-chatbot-eval` pair provide LLM-as-Judge quality evaluation. A series of contract-hardening fixes drove the turmeric dogfood validation composite from 6.5 to 9.1: 0.5.1 publish pre-flight (PR #39), 0.5.18 Drive Shared-Drive guard, 0.6.1 `experiment_id` contract + `attach_knowledge` pre-flight, 0.6.4 transactional `set_chatbot_pipeline` (PR #61), 0.6.9 HTMX-scrape `experiment_id` recovery (PR #63), 0.6.10 `{collection_index_summaries}` cross-field rule fix (PR #64). The active plan is `docs/superpowers/plans/2026-04-08-ace-ocs-chatbot-buildout.md`. Authenticate with `/ace:ocs-login` before calling tools that hit live OCS.
- **OCS domain migrated.** Default base URL is now `https://www.openchatstudio.com` (was `chatbots.dimagi.com`). PR #26 updated all live code, templates, commands, scripts, and tests. The `ocs_send_test_message` tool now uses the anonymous widget chat API (`/api/chat/start/` → `/message/` → `/poll/`) instead of the broken OpenAI-compatible REST endpoint. `ocs_create_collection` defaults `llm_provider` and `embedding_model` from `OCS_LLM_PROVIDER_ID` and `OCS_EMBEDDING_MODEL_ID` env vars.
- **Orchestration restructured into 7 phases (0.9.0).** Phase order: (1) design-review → (2) commcare-setup → (3) connect-setup → (4) ocs-setup → (5) qa-and-training → (6) llo-manager → (7) closeout. Key consequences (from the original 0.2.0 6-phase split, now extended in 0.9.0): `app-builder` was split into `design-review` + `commcare-setup`; `ocs-setup` is a first-class phase (previously OCS was buried as Step 4 of LLO management *after* go-live); `qa-and-training` is a new Phase 5 that synthesizes upstream artifacts into screenshots (`app-screenshot-capture`) and training docs (`training-materials`, moved out of Phase 2) before any LLO contact; `ocs-chatbot-qa` gained `--quick`/`--deep`/`--monitor` modes and replaces the inline self-eval that used to live in `ocs-agent-setup`; new `pdd-to-test-prompts` skill in Phase 1 produces `test-prompts.md` as ground truth for the deep QA gate; `llo-invite` prepares only, send moves to `llo-onboarding` so the onboarding email can include the OCS widget link.

## Running tests

```bash
npm test                                           # vitest unit suites
npm run test:watch                                 # watch mode
OCS_INTEGRATION=1 npm run test:integration         # hits live OCS; requires ocs-login
OCS_INTEGRATION=1 npm test -- test/mcp/ocs/e2e.integration.test.ts              # basic OCS E2E flow
OCS_INTEGRATION=1 npm test -- test/mcp/ocs/e2e-bot-creation.integration.test.ts # full OCS bot creation E2E
CONNECT_INTEGRATION=1 npm test -- test/mcp/connect/integration/                 # Connect E2E; requires connect-login
LABS_INTEGRATION=1 npm test -- test/mcp/connect-labs/integration/                # Connect Labs E2E; requires LABS_MCP_TOKEN
npm run eval                                       # PDD evals via test/eval/run-eval.ts
```

## Running MCP servers standalone

```bash
npm run mcp:gdrive    # npx tsx mcp/google-drive-server.ts
npm run mcp:ocs       # npx tsx mcp/ocs-server.ts
npm run mcp:connect   # npx tsx mcp/connect-server.ts
```

All three also auto-register via the `mcpServers` block in `.claude-plugin/plugin.json` when the plugin is installed.

## Key docs

**Design specs (`docs/superpowers/specs/`):**
- `2026-04-01-ace-design.md` — full ACE architecture and rationale. The anchor doc.
- `2026-04-07-ace-web-harness-design.md` — browser harness + transcript library (implemented in the `ace-web` sibling repo).
- `2026-04-08-ace-ocs-chatbot-buildout-design.md` — ACE↔OCS integration layer design.
- `2026-04-28-ace-connect-mcp-design.md` — ACE↔Connect integration layer design (mirrors OCS pattern).

**Plans (`docs/superpowers/plans/`):**
- `2026-04-01-ace-plugin.md` — initial plugin scaffold + skills + commands. Substantially shipped across PRs #1–#7.
- `2026-04-08-ace-ocs-chatbot-buildout.md` — OCS composite backend + 22 atomic capabilities. **Substantially shipped through 0.6.10.**
- `2026-04-28-ace-connect-mcp.md` — **active**. ace-connect MCP, 21 atoms, mirrors the OCS shape; v1 shipped in 0.8.0/0.8.1, finalize + FLW invite added in 0.10.35/0.10.38.

**Integration reference (`playbook/integrations/`):**
- `ocs-integration.md` — atoms, backends, how to run.
- `nova-integration.md` — what exists vs. what needs exploration.
- `connect-api.md` — `ace-connect` atom inventory + connect-labs reference (lives in a different repo).
- `commcare-api.md` — connect-labs CommCare tools (lives in a different repo).

**Examples (`docs/examples/`):**
- `pdd-stress-test-observations.md` — worked-through PDD validation with two sample PDDs.
- `pdd-vaccine-hesitancy.md`, `pdd-turmeric-market-survey.md` — full sample PDDs used in stress testing and evals.

**Planning spreadsheet:** ACE planning spreadsheet at `https://docs.google.com/spreadsheets/d/1XxcPxK1oYtDxcfmElBb73U2UtLYEodiaMUazjmEVAWE/edit` — reference only, not source of truth for agent work.

## Git worktrees and merging to main

This repo uses emdash which manages git worktrees. If you are in a worktree (check: `git rev-parse --git-dir` contains `/worktrees/`), then `main` is checked out in the main repo at `~/emdash/repositories/ace/`. You CANNOT `git checkout main` from a worktree — it will fail.

To merge to main:
```bash
cd ~/emdash/repositories/ace && git merge <branch-name> && git push
```

If that fails with local changes, stash first:
```bash
cd ~/emdash/repositories/ace && git stash && git merge <branch-name> && git push
```

If remote is ahead, pull first:
```bash
cd ~/emdash/repositories/ace && git pull --rebase && git push
```

**Always verify the main checkout is on `main` before merging.** A leftover branch from a prior `/ship` can be checked out in the sibling repo; merging to that revives it on origin. Canonical safe form:
```bash
cd ~/emdash/repositories/ace && \
  [ "$(git branch --show-current)" = "main" ] || git checkout main && \
  git pull --ff-only && git merge <branch> --no-ff && git push
```

## Plugin updates — NEVER locally patch

**CRITICAL: Never directly copy, rsync, or write files into `~/.claude/plugins/cache/` or edit `~/.claude/plugins/installed_plugins.json` by hand.** This is "local patching" and it bypasses the plugin system, creates version mismatches, and makes bugs hard to diagnose. If you feel the urge to locally patch, STOP — use `/ace:update` instead.

### Update workflow (the ONLY way to update)
1. Make changes to skills, commands, agents, or MCP servers in the repo
2. Bump the version. Two ways:
   - **Recommended (worktree-safe):** run `scripts/version-bump.sh` — fetches `origin/main`, picks `max(local, origin) + patch+1`, writes all 4 files atomically. Use this when several worktrees might be bumping in parallel (the common case): it removes the deterministic VERSION/plugin.json/marketplace.json/package.json rebase conflict that hits otherwise. Mirrors `canopy version bump`.
   - **Manual:** edit `VERSION` only (e.g. `0.9.4` → `0.9.5`). The pre-commit hook (`scripts/hooks/pre-commit`) automatically syncs `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` when `VERSION` is staged.
3. Commit, merge to main, push:
   ```bash
   # From a worktree:
   git add -A && git commit -m "feat/fix: description (0.9.5)"
   cd ~/emdash/repositories/ace && git merge <branch> && git push
   ```
4. **IMMEDIATELY after pushing**, run `/ace:update` in the current session. This is mandatory — it pulls from GitHub, creates a new cache dir, and updates `installed_plugins.json`. Without it, the current session runs stale code while other sessions get the new version on next start. Do NOT skip this step.

New sessions auto-detect the version bump on startup — no manual steps needed.

### Version sync hook setup
The repo uses `core.hooksPath = scripts/hooks`. If the hook isn't firing (e.g. fresh clone), run:
```bash
git config core.hooksPath scripts/hooks
```

### How it works
- `~/.claude/plugins/known_marketplaces.json` — marketplace entry pointing at this git repo
- `~/.claude/plugins/installed_plugins.json` — installed plugin entry with version + commit SHA
- Cache dir is keyed by version: `~/.claude/plugins/cache/ace/ace/<version>/`
- On session start, Claude Code pulls the marketplace repo and compares `plugin.json` version against the installed version — if different, it re-installs

## Conventions

- **Skills are stateless.** All per-opportunity state lives in Google Drive `ACE/<opp-name>/`. Don't introduce local state in `SKILL.md` files.
- **SKILL.md naming.** Skill directory name is kebab-case verb phrases (`idea-to-pdd`, `app-test`, `llo-onboarding`) and must match the frontmatter `name:` field exactly. See `skills/README.md`.
- **MCP servers run direct from TypeScript.** ESM + `npx tsx`, no build step.
- **MCP capabilities are atomic.** Each atom in `mcp/ocs/capability-map.ts` and `mcp/connect/capability-map.ts` routes to REST or Playwright; skill code never knows which. When the upstream service ships a real API for a Playwright-backed atom, it becomes a one-line routing change.
- **VERSION is the single source of truth.** Edit `VERSION` only; the pre-commit hook syncs `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` automatically. `/ace:doctor` verifies they match. To bump in a worktree-safe way (fetches origin and picks `max(local, origin) + patch+1`), run `scripts/version-bump.sh`.
- **QA vs Eval is a two-phase pattern, calibrated against ground truth.** `*-qa` skills capture transcripts + structural checks; `*-eval` skills judge them via LLM-as-Judge rubrics with hard-deduction rules and inflation guards, writing `verdicts/<skill>-<mode>.yaml`. Uniform verdict shape so `opp-eval` can aggregate any skill. Per-rubric calibration uses ground-truth catalogues, multi-run variance protocols, and detection-rate metrics — see `skills/eval-calibration/SKILL.md` and `skills/README.md` § QA vs Eval.
- **Archetypes are first-class.** PDDs declare `Archetype: atomic-visit | focus-group | multi-stage`; archetype-aware skills branch on it via a `## Archetypes` section. Adding a new archetype is purely additive (per-skill PRs). Default is `atomic-visit`.
- **Class-level preventers > instance-level fixes.** Recurring discipline across the OCS / Drive / env-drift / Connect fixes: when a silent-failure class surfaces, catch it at the boundary (MCP backend, doctor diff, schema pre-flight, HTTP probe) so every future instance is structurally impossible. Don't just patch the case in front of you. The 0.7.1 `ocs_shared_collection_team` doctor probe is the canonical example: 50ms HTTP request that turns "configured" into "configured correctly."

## Improvement cycles & canopy

This repo is dogfooded by the `canopy` plugin. **Per-run evidence lives in Drive (`ACE/<opp>/runs/<run-id>/run_state.yaml`, `verdicts/`, `gate-briefs/`, `comms-log/observations.md`, `eval-calibration/`); cross-opp strategy lives in `.claude/pm/runs/<date>-<lens>.md`.** The opp `observations.md` is the evidence log; the run log is the synthesis that cites it. ACE skills don't read run logs; canopy and humans do. (`run_state.yaml` was renamed from `state.yaml` in 0.11.3 to make per-run scope explicit; opp-level metadata lives in `ACE/<opp>/opp.yaml`.)

**Re-entering the project:** run `/canopy:pm-status` (or read the most recent file in `.claude/pm/runs/`) — it surfaces the current lens, backlog, and last cycle's findings. Don't ask the orchestrator "what should I do next?" — phase agents only see per-opp state.

**Writing a run log:** copy the structure of the most recent existing run log (Lens / Do it / Backlog / Closed / Skipped / Meta-observations). Write one whenever a session ships a PR, surfaces a deferred backlog item, or defines a reusable lens. Skip for one-off ops or pure research.

**Canopy commands:** `/canopy:pm-status` (re-entry), `/canopy:pm-scout` (run a scout cycle), `/canopy:improve` (full improve loop), `/canopy:patterns` (cross-session friction).

## Gotchas

- **`.gws-sa-key.json` is per-machine and gitignored.** Located at `${CLAUDE_PLUGIN_DATA}/gws-sa-key.json` (legacy fallback: plugin root). `ace-gdrive` won't start without it. `/ace:doctor` reports `GWS_KEY: MISSING` and prints the expected path.
- **`.env` is per-machine and gitignored.** Located at `${CLAUDE_PLUGIN_DATA}/.env` (legacy fallback: plugin root). To inspect env state, read that file directly — don't hunt through `cache/`, the worktree, or your shell. `/ace:doctor` reports `env_file` with the resolved path; the in-shell `$ACE_DRIVE_ROOT_FOLDER_ID` / `$ACE_E2E_AUTH_TOKEN` will normally be empty because the values are loaded into MCP-server subprocesses, not the parent shell.
- **OCS auth is session-based.** `/ace:ocs-login` drives a Playwright login and stores cookies. Every `ace-ocs` tool call needs a live session unless it's REST-backed. Same model for Connect: `/ace:connect-login` for MFA/SSO; `bin/ace-doctor` reports `connect_session` freshness.
- **Playwright backends are HTTP-only.** Both `mcp/ocs/backends/playwright.ts` and `mcp/connect/backends/playwright.ts` use `page.request` exclusively — no click-driving, no selectors. If a new atom looks like it needs UI automation, push back first.
- **OCS `{collection_index_summaries}` cross-field rule.** Required *iff* `collection_index_ids.length >= 2`; single-collection clones (the canonical per-opp case) must NOT include it. Enforced at the MCP boundary by `assertCollectionPromptInvariant`. Truth-table reproducer: `scripts/probe-n1-cross-test.ts`. Violating this fails the publish silently in older code paths.
- **Drive `parentFolderId` is required and must live on a Shared Drive.** `drive_create_file` / `drive_create_folder` no longer fall back to the SA's My Drive root (was a silent footgun — every subsequent write failed with a misleading "user storage quota exceeded"). `assertParentOnSharedDrive` runs one `files.get` probe before any write.
- **Drive metadata files (`~/.ace/*.json`) are hypotheses, not truths.** Stale snapshots have anchored multi-day investigations down wrong paths. Re-probe live state before acting on metadata older than ~7 days.
- **Plans use `- [ ]` syntax but are not live trackers.** Neither plan maintains checkbox state. Use PR history and code to determine what's shipped, not the checkboxes.
- **OCS shared-collection ID can exist on the wrong team.** Silent class of misconfig: `OCS_SHARED_COLLECTION_ID=350` may resolve to a real collection but live on a different team than `OCS_TEAM_SLUG`. Caught by the 0.7.1 `ocs_shared_collection_team` doctor probe (50ms HTTP GET); WARN-level, not FAIL.
- **Connect's invite UI is program-level, not opportunity-level.** `connect_send_llo_invite` takes a program UUID as its `opportunity_id` arg and the LLO workspace slug as `organization_name`. Awkward naming until Connect changes its data model — read it as "invite-to-program."
- **MCP-vs-skill-doc drift.** Skills that document atom field semantics inline can drift from the atom's actual schema. The 0.9.4 `connect-opp-setup` `location` fix is the canonical case: skill doc said "meters threshold," atom takes a boolean toggle. When you change an atom's signature, grep skills for inline references; when you write inline references in a skill, link them to the atom's tool description not your own paraphrase.
- **Connect-Labs MCP is HTTP, but ACE consumes it via a stdio proxy.** `mcp/connect-labs-server.ts` reads `LABS_MCP_TOKEN` from `${CLAUDE_PLUGIN_DATA}/.env` and forwards JSON-RPC frames to `https://labs.connect.dimagi.com/mcp/`. If the labs MCP gains first-class HTTP support in `plugin.json` later, the proxy can be removed in a single config change. Auth is per-user **PAT**, not OAuth on the wire — the OAuth bridge happens server-side inside labs's tool handlers (`require_connect_token(user)`).
- **`solicitation` and `selected_llo` are separate blocks in `opp.yaml`.** `solicitation` is the audit trail (URLs, deadline, status, awarded.* fields); `selected_llo` is the narrow contract Phase 7 reads (`org_slug`, `contact_email`, `source`, `response_id`). Only `solicitation-review` populates `selected_llo`. If `selected_llo.org_slug` is set without a corresponding `solicitation` block, that's a contract violation. Phase 7's `llo-onboarding` halts fast if `selected_llo.org_slug` is null.
