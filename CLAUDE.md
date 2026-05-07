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
| `synthetic-data-and-workflows` (Phase 6) | no | subagent | `Agent(synthetic-data-and-workflows)` from level 0 |
| `solicitation-management` (Phase 7) | no | subagent | `Agent(solicitation-management)` from level 0 |
| `execution-manager` (Phase 8) | no | subagent | `Agent(execution-manager)` from level 0 |
| `closeout` (Phase 9) | no | subagent | `Agent(closeout)` from level 0 |
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

- `agents/` — 11 agents total. Two are procedure docs (`ace-orchestrator`, `commcare-setup`); nine are subagents (`design-review`, `connect-setup`, `ocs-setup`, `qa-and-training`, `synthetic-data-and-workflows`, `solicitation-management`, `execution-manager`, `closeout`, `ocs-tester`). See § Agent topology above for the rule. Phases 1–6 run end-to-end with zero LLO involvement; Phase 8 is where LLOs first hear from ACE 1-1 (Phase 7 publishes a public solicitation but does not contact specific LLOs unless the PDD names preferred candidates).
- `skills/` — 66 skills, one directory per skill, each with a single `SKILL.md`. Skills are stateless; opportunity state lives in Google Drive under `ACE/<opp-name>/`. See `skills/README.md` for the author contract, including the `## QA vs Eval — the two-phase pattern` section that governs `-qa` / `-eval` skill pairs and the `opp-eval` umbrella-aggregator pattern. Per-skill `-eval` rubrics are calibrated against ground-truth catalogues — see `skills/eval-calibration/SKILL.md`.

  **Phase 5 per-artifact training split (0.10.79–0.10.89):** the previous `training-materials` monolith was decomposed into one skill per artifact: `training-llo-guide`, `training-flw-guide`, `training-quick-reference`, `training-faq`, `training-onboarding-email`, `training-deck-outline`. Plus `training-deck-build` which renders the deck-outline markdown into a real Google Slides deck. The umbrella was removed entirely in 0.10.89; Phase 5 dispatches each per-artifact skill directly. See `playbook/integrations/slides-integration.md` for the Slides API contract + gotchas.

  **Phase 5 shallow/deep QA split (0.13.x):** `/ace:run` is now shallow-by-default (~5 LLM judge calls vs ~90 prior). Deep QA runs out-of-band via `/ace:qa-deep`; `llo-launch` requires fresh deep verdicts before activation. New artifact-producing skills feed the executor: `pdd-to-app-journeys` (Phase 1) and `app-test-cases` (Phase 2); new evaluator `app-ux-eval` runs over screenshots + journeys.
- `commands/` — 16 slash commands: `run`, `step`, `status`, `eval`, `qa-deep`, `docs`, `setup`, `update`, `doctor`, `ocs-login`, `connect-login`, `nova-login`, `labs-login`, `labs-token-mint`, `mobile-bootstrap`, `ocs-bootstrap-template`.
- `mcp/` — 5 MCP servers wired inline in `.claude-plugin/plugin.json` under `mcpServers` (4 first-party + 1 stdio proxy). They moved inline in 0.5.16 from a plugin-root `.mcp.json` to work around [anthropics/claude-code#9427](https://github.com/anthropics/claude-code/issues/9427) — `${CLAUDE_PLUGIN_DATA}` / `${CLAUDE_PLUGIN_ROOT}` substitution is broken in plugin-root `.mcp.json` but works inline:
  - `google-drive-server.ts` → `ace-gdrive` (Drive + Docs + Slides + Sheets tooling). Slides atoms (`slides_get`, `slides_batch_update`, `slides_copy_template`) shipped 0.10.78; back the `training-deck-build` skill. See `playbook/integrations/slides-integration.md` for the durable-knowledge gotcha record (SA can't `presentations.create`, `createImage` needs anyone-with-link, etc.).
  - `ocs-server.ts` → `ace-ocs` (composite Open Chat Studio backend, 23 atoms — Authoring 11 + Observation 12). Source under `mcp/ocs/` — `capability-map.ts`, `client.ts`, `types.ts`, `backends/{composite,rest,playwright,pipeline-patch}.ts`, `auth/`, `logging.ts`, `errors.ts`.
  - `connect-server.ts` → `ace-connect` (composite backend on `connect.dimagi.com`, 21 Connect atoms — Programs, Opportunities, verification flags, payment units, deliver units, activation, LLO program-applications, FLW invites, invoices). 8 of the 11 authoring atoms route to the REST automation API ([commcare-connect#1135](https://github.com/dimagi/commcare-connect/pull/1135), since 0.10.47); the rest still drive HTML form pages via Playwright. The same MCP also exposes 5 `commcare_*` atoms (`download_ccz`, `make_build`, `patch_xform`, `release_build`, `upload_multimedia`) via `backends/commcare.ts` for `app-release` and `app-multimedia-coverage`. Source under `mcp/connect/` mirrors the OCS shape.
  - `mobile-server.ts` → `ace-mobile` (Maestro + AVD, 11 atoms — Mac-only local Android emulation for Phase 5 `qa-and-training`). Source under `mcp/mobile/` mirrors the OCS shape: `capability-map.ts`, `client.ts`, `types.ts`, `errors.ts`, `logging.ts`, `backends/{avd,maestro,recipe-generator}.ts`, plus `recipes/static/*.yaml`. The legacy `auth/fetch-otp.ts` Playwright OTP-scraping atom was removed in 0.13.27 — the `+7426` demo-bypass path skips OTP entry entirely.
  - `connect-labs-server.ts` → `connect-labs` (stdio MCP proxy forwarding JSON-RPC to `https://labs.connect.dimagi.com/mcp/`, injecting `LABS_MCP_TOKEN` as `Authorization: Bearer`). Backs Phase 7 (Solicitation Management) — exposes 9 atoms from labs (`create_solicitation`, `list_solicitations`, `get_solicitation`, `update_solicitation`, `list_responses`, `get_response`, `award_response`, `create_review`, `list_reviews`). When Claude Code's `plugin.json` gains first-class HTTP MCP support, the proxy is one config swap to delete.
- `playbook/integrations/` — integration reference: `ocs-integration.md`, `nova-integration.md`, `connect-api.md`, `commcare-api.md`, `mobile-integration.md`, `slides-integration.md`. Each describes what exists today vs. what still needs to be built, plus the durable-knowledge gotcha record for that integration.
- `docs/superpowers/specs/` — design specs (see Key Docs).
- `docs/superpowers/plans/` — implementation plans (see Key Docs).
- `docs/examples/` — PDD examples + stress-test observations.
- `docs/generated/playbook.md` — human-readable process flow, regenerated by `/ace:docs` from agent + skill definitions. Derived; not a source of truth.
- `templates/` — `pdd-template.md`, `onboarding-email-template.md`.
- `lib/artifact-manifest.ts` — canonical definition of every artifact in `ACE/<opp-name>/`, which skill produces it, and which skills consume it. Used by fixture validation tests and future ace:doctor checks. Companion: `lib/verdict-schema.ts` (uniform `-eval` verdict shape) and `lib/plugin-data-dir.ts`.
- `test/` — `vitest` suites under `test/mcp/ocs/` and `test/mcp/connect/` (unit, integration, and E2E tests), `test/eval/` for PDD evals, `test/fixtures/` with partial-coverage manifest-validation fixtures (`CRISPR-Test-001` atomic-visit, `CRISPR-Test-002` focus-group, `CRISPR-Test-004-Solicitation` Phase 7, `CRISPR-Test-005-KMC-multimedia` Phase 2 multimedia) plus `test/fixtures/connect-html/` HTML scrape fixtures, `test/fixtures/artifact-manifest.test.ts` validates fixtures against the manifest. The previous all-8-phase synthetic fixture (`CRISPR-Test-003-Turmeric`) was retired in 0.13.25 — its content was stale (0.3.x era), explicitly fake (`PRG-TURMERIC-SYN-0001`, "do not visit"), and structurally incomplete for the current 9-phase pipeline. A real replay fixture is being designed separately.
- `scripts/` — `bootstrap-ocs-golden-template.ts` (backing `/ace:ocs-bootstrap-template`), `sync-version.sh` (called by pre-commit hook), `version-bump.sh` (worktree-safe bumper: fetches origin and picks `max(local, origin) + patch+1`, then delegates to `sync-version.sh`), `hooks/pre-commit` (git hook for version sync), plus 25 `probe-*.ts` scripts and 2 `test-sa-*.ts` — executable investigation scripts that document live OCS / Connect contract probes (kept under `scripts/` as durable reproducers; safe to re-run).
- `hooks/hooks.json` — native Claude Code plugin hook: runs `bin/ace-update-check` on `SessionStart`.
- `.env.tpl` — 1Password-injectable template for OCS, Connect-HQ, Gmail, and Labs secrets. Installed `.env` lives at `${CLAUDE_PLUGIN_DATA}/.env` (legacy fallback: plugin root). Regenerate with `op inject -i .env.tpl -o "$CLAUDE_PLUGIN_DATA/.env" --account dimagi.1password.com`. **1Password is the source of truth**; never paste values into `.env` directly — they get blown away on the next `op inject`. Local-only (non-`.env.tpl`) keys are preserved across `op inject` since 0.13.34.
- `bin/ace-doctor` — bash-driven diagnostic script behind `/ace:doctor`. Checks deps, version sync, env-var drift (`.env.tpl` ↔ installed `.env`), MCP wiring, OCS/Drive/Connect readiness, the live `ocs_shared_collection_team` HTTP probe, mobile (AVD/Maestro/Playwright) readiness, and an `[Auth liveness]` block that runs one live HTTP call per MCP and names the exact remediation command per failure.
- `bin/ace-update-check` — background update-check shim (borrowed from gstack).
- `migrations/` — version-to-version migration scripts for breaking changes. See `migrations/README.md`.

## Current state

- **Plugin is installable and self-updating.** `/ace:setup`, `/ace:update`, `/ace:doctor` shipped (0.1.0, PRs #11, #13). See `CHANGELOG.md`.
- **Google Drive MCP is live.** `ace-gdrive` wired inline in `.claude-plugin/plugin.json` `mcpServers` (moved in 0.5.16; PR #6 originally landed it; PR #25 added shortcut resolution). Requires a service-account key at `${CLAUDE_PLUGIN_DATA}/gws-sa-key.json` (or `.gws-sa-key.json` in the plugin root as legacy fallback). Slides authoring atoms shipped in 0.10.78.
- **OCS MCP is mature and contract-hardened.** `ace-ocs` with 23 atomic capabilities and composite + REST + Playwright backends (PRs #9, #10, #14). E2E integration tests (PR #22, PR #24) cover full clone → configure → embed → chat against live OCS. The `ocs-tester` agent + `ocs-chatbot-qa` / `ocs-chatbot-eval` pair provide LLM-as-Judge quality evaluation. Contract-hardening fixes drove the turmeric dogfood validation composite from 6.5 to 9.1: 0.5.1 publish pre-flight, 0.5.18 Drive Shared-Drive guard, 0.6.1 `experiment_id` contract + `attach_knowledge` pre-flight, 0.6.4 transactional `set_chatbot_pipeline`, 0.6.9 HTMX-scrape `experiment_id` recovery, 0.6.10 `{collection_index_summaries}` cross-field rule. The OCS plan `docs/superpowers/plans/2026-04-08-ace-ocs-chatbot-buildout.md` shipped end-to-end through 0.6.10; ongoing fixes live in PR history. Authenticate with `/ace:ocs-login` before calling tools that hit live OCS. Default base URL is `https://www.openchatstudio.com` (was `chatbots.dimagi.com`, migrated in PR #26).
- **Connect MCP shipped (0.8.0–0.10.38), automation-API adoption in 0.10.47.** `ace-connect` mirrors the `ace-ocs` pattern — composite backend over `connect.dimagi.com`, authenticated as `ace@dimagi-ai.com` via OAuth-with-CommCareHQ. 21 Connect atoms today: 8 authoring atoms go through the REST automation API ([commcare-connect#1135](https://github.com/dimagi/commcare-connect/pull/1135) — `create_program`, `create_opportunity`, `create_payment_unit`/`create_payment_units`, `activate_opportunity`, `send_llo_invite`, `accept_program_application`, `send_flw_invite`); the remaining atoms still drive HTML pages via Playwright. The same MCP exposes 5 `commcare_*` atoms via `mcp/connect/backends/commcare.ts` for app-release + multimedia. Both backends share the same authenticated session — DRF's `SessionAuthentication` accepts the same Django sessionid + CSRF that the Playwright OAuth flow produces. Five Phase-3/5/8 skills that previously shipped `## Current Workaround` blocks (`connect-program-setup`, `connect-opp-setup`, `llo-onboarding`, `llo-launch`, `opp-closeout`) are atom-driven and HITL-free. Authenticate with `/ace:connect-login` (covers MFA/SSO via headed browser). Plan: `docs/superpowers/plans/2026-04-28-ace-connect-mcp.md`. Key contract notes: Connect has TWO invite atoms — `connect_send_llo_invite` is **program-level** (takes a `program_id` UUID and a target LLO workspace `organization` slug); `connect_send_flw_invite` is **opportunity-level** and takes an array of `+<country><digits>` phones. The `/invite_users/` endpoint requires the opp to be `active`, so call `connect_activate_opportunity` first. The previous `register_hq_api_key` and `finalize_opportunity` atoms were removed in 0.10.47 — `create_opportunity` now folds both jobs server-side.
- **Mobile MCP shipped (0.10.0).** `ace-mobile` mirrors the `ace-ocs` pattern — 11 atomic capabilities driving a local Mac AVD via Maestro + adb. Backs the new Phase 5 `qa-and-training` agent and its `app-screenshot-capture` skill. Mac-only, dev-machine-only — no cloud device farms. Static Maestro recipes in `mcp/mobile/recipes/static/` ship as scaffolds with `REPLACE_*` selectors that need filling via `maestro studio` against the Connect Android APK before live runs. The legacy `fetch-otp` atom was removed in 0.13.27 — the `+7426` demo-bypass path skips OTP entry entirely. Plan: `docs/superpowers/plans/2026-04-28-ace-mobile-emulation.md`. Bootstrap with `/ace:mobile-bootstrap`.
- **Connect-Labs MCP integration via stdio proxy (0.12.0).** `connect-labs` covers the *grants pipeline* (solicitations, reviews, awards, funds) and runs as a remote HTTP MCP at `https://labs.connect.dimagi.com/mcp/`. ACE consumes it via `mcp/connect-labs-server.ts` (thin stdio proxy that forwards JSON-RPC and injects `LABS_MCP_TOKEN`). Phase 7 (Solicitation Management) consumes 9 atoms: `create_solicitation`, `list_solicitations`, `get_solicitation`, `update_solicitation`, `list_responses`, `get_response`, `award_response`, `create_review`, `list_reviews`. (Earlier 0.12.0 docs claimed a 10th `generate_criteria` atom — the endpoint exists in connect-labs HTTP but is **not** exposed as an MCP tool; the skill generates criteria locally from PDD content. Corrected in 0.13.3.) CommCare's MCP also lives in `connect-labs`. Skills depending on CommCare APIs still ship `## Current Workaround` sections and degrade to human-in-the-loop.
- **Orchestration runs 9 phases as of 0.13.x.** Phase order: (1) design-review → (2) commcare-setup → (3) connect-setup → (4) ocs-setup → (5) qa-and-training → (6) **synthetic-data-and-workflows** (NEW in 0.13.45 onward — story-coherent demo data + persona walkthroughs; no irreversible external action) → (7) solicitation-management (publishes a solicitation + invites PDD-named candidates; halts at the external-comms boundary) → (8) execution-management (onboards the awarded LLO; entry gated on `opp.yaml.selected_llo.org_slug`) → (9) closeout. Phase 8 is the first 1-1 LLO contact. The "8 phases" / "Phase 8 = closeout" framing in older docs reflects the 0.12.0 → 0.13.45 window before the synthetic-data phase landed.
- **Self-improving eval framework (0.8.0 → 0.9.11).** The `opp-eval` umbrella (0.4.0) gained ground-truth catalogues, multi-run variance protocol, inflation guards, and coverage-aware verdicts. Per-opp ground truth lives at `ACE/<opp>/eval-calibration/known-issues.md`; rubric audit trails live at `ACE/<opp>/eval-calibration/<rubric>-runs.md`. `opp-eval` produced its **first real PASS verdict** (not coverage-capped) on `smoke-20260428-1242` in 0.9.3; cross-opp validation in 0.9.11 confirmed 3 of 4 calibrated rubrics generalize. Methodology in `skills/eval-calibration/SKILL.md` and `docs/eval-calibration-learnings.md`.
- **Nova plugin is live end-to-end.** Nova ships as its own Claude Code plugin (`voidcraft-labs/nova-marketplace`). ACE consumes Nova as a sibling — install once with `/plugin install nova@nova-marketplace`, OAuth on first use, and `pdd-to-learn-app` / `pdd-to-deliver-app` / `app-deploy` invoke its slash commands. End-to-end smoke test passed 2026-04-28 (PR #62). Three known upstream Nova bugs (Connect markers, `deliver_unit` runtime injection, `add_fields` partial persistence) — see `docs/learnings/2026-04-29-nova-connect-marker-bugs.md`. ACE-side mitigations in `pdd-to-{learn,deliver}-app` (explicit Connect language in autobuild brief) and `app-release` (pre-flight markers check + post-release CCZ verification).
- **`app-multimedia-coverage` — manual post-Phase-2 multimedia attach (0.13.15).** Sibling of `commcare-form-patch`. LLM-judges each Nova-built field (criterion: would the FLW use it OR show it to a client?), calls Dimagi's Content Generator API for the chosen ones, patches form XML with `<image>` itext entries, uploads PNGs via `commcare_upload_multimedia`, and re-builds + re-releases. **Not part of `/ace:run`** — invoked manually with `/ace:step app-multimedia-coverage <opp>`. Spec at `docs/superpowers/specs/2026-05-05-app-multimedia-coverage-design.md`; delete when Nova ships first-class field-level multimedia (`voidcraft-labs/nova-plugin#8`) per the removal criteria in the SKILL.md.
- **ace-web is a sibling repo, not a submodule.** Removed in commit `b7ccf35`. Browser-harness work happens in the `ace-web` checkout; this repo owns the design spec, `ace-web` owns implementation plans 1A–1D.
- **Doctor is the class-level preventer for silent misconfigs.** 0.5.4 closes `.env-drift`; 0.5.9 detects MCP env-passthrough gaps; 0.5.18 catches Drive Shared-Drive misconfig; 0.7.1 adds `ocs_shared_collection_team` (50ms HTTP probe that catches an `OCS_SHARED_COLLECTION_ID` living on a *different* OCS team than `OCS_TEAM_SLUG`). Doctor also reports `connect_env`/`connect_session` freshness, a `[Mobile]` section, and an `[Auth liveness]` block per MCP (0.10.0–0.13.27).
- **Email skill shipped.** `email-communicator` (PR #20) uses GOG CLI to send from `ace@dimagi-ai.com`. Config via `.env.tpl` / `.env`.
- **CI version-bump check.** PR #23 verifies VERSION is bumped on PRs.

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

All five MCPs (gdrive, ocs, connect, mobile, connect-labs proxy) auto-register via the `mcpServers` block in `.claude-plugin/plugin.json` when the plugin is installed.

## Key docs

**Design specs (`docs/superpowers/specs/`):**
- `2026-04-01-ace-design.md` — full ACE architecture and rationale. The anchor doc.
- `2026-04-07-ace-web-harness-design.md` — browser harness + transcript library (implemented in the `ace-web` sibling repo).
- `2026-04-08-ace-ocs-chatbot-buildout-design.md` — ACE↔OCS integration layer.
- `2026-04-28-ace-connect-mcp-design.md` — ACE↔Connect integration layer (mirrors OCS pattern).
- `2026-04-28-ace-mobile-emulation-design.md` — Mac-local AVD + Maestro design behind `ace-mobile`.
- `2026-05-02-ace-run-multi-run-revival-design.md` — `inputs/` + `runs/<id>/` Drive layout per opp.
- `2026-05-03-run-folder-readability-design.md` — per-run folder structure for human re-entry.
- `2026-05-04-ace-solicitations-phase-design.md` — Phase 7 (Solicitation Management) design.
- `2026-05-04-shallow-deep-qa-split-design.md` — `/ace:run` shallow-by-default + `/ace:qa-deep` design.
- `2026-05-05-app-multimedia-coverage-design.md` — manual post-Phase-2 multimedia attach.
- `2026-05-06-skills-audit-findings.md` — Stage 1 audit of all skill descriptions + body structure.

**Plans (`docs/superpowers/plans/`):**
- `2026-04-01-ace-plugin.md` — initial plugin scaffold + skills + commands. Substantially shipped across PRs #1–#7.
- `2026-04-08-ace-ocs-chatbot-buildout.md` — OCS composite backend + 23 atoms. **Shipped through 0.6.10.**
- `2026-04-28-ace-connect-mcp.md` — `ace-connect` MCP, 21 atoms; v1 shipped in 0.8.0/0.8.1, finalize + FLW invite added in 0.10.35/0.10.38.
- `2026-04-28-ace-mobile-emulation.md` — `ace-mobile` v1 in 0.10.0; OTP fetcher removed 0.13.27.
- `2026-05-02-ace-run-multi-run-revival.md` — multi-run-per-opp + canonical input pack (0.11.0).
- `2026-05-03-run-folder-readability.md` — per-run folder layout (0.11.3).
- `2026-05-04-ace-solicitations-phase.md` — Phase 7 (Solicitation Management) — 0.12.0.
- `2026-05-04-shallow-deep-qa-split.md` — Phase 5 split, new `/ace:qa-deep` (0.13.x).
- `2026-05-05-app-multimedia-coverage.md` — post-Phase-2 multimedia attach (0.13.15).

**Integration reference (`playbook/integrations/`):**
- `ocs-integration.md` — atoms, backends, how to run.
- `nova-integration.md` — what exists vs. what needs exploration.
- `connect-api.md` — `ace-connect` atom inventory + connect-labs reference.
- `commcare-api.md` — connect-labs CommCare tools (lives in a different repo).
- `mobile-integration.md` — Maestro recipes + AVD lifecycle.
- `slides-integration.md` — Slides API contract + gotchas (SA can't `presentations.create`, etc.).

**Examples (`docs/examples/`):**
- `pdd-stress-test-observations.md` — worked-through PDD validation with two sample PDDs.
- `pdd-vaccine-hesitancy.md`, `pdd-turmeric-market-survey.md` — full sample PDDs used in stress testing and evals.

**Learnings (`docs/learnings/`):**
- `2026-04-28-mcp-vs-skill-doc-drift.md` — class-level pattern of skills paraphrasing atom schemas instead of linking to the live tool description.
- `2026-04-29-nova-connect-marker-bugs.md` — three Nova upstream bugs (autobuild Connect markers, `deliver_unit` runtime injection, `add_fields` partial persistence) and ACE-side mitigations.

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
- **SKILL.md naming.** Skill directory name is kebab-case verb phrases (`idea-to-pdd`, `app-test-cases`, `llo-onboarding`) and must match the frontmatter `name:` field exactly. See `skills/README.md`.
- **MCP servers run direct from TypeScript.** ESM + `npx tsx`, no build step.
- **MCP capabilities are atomic.** Each atom in `mcp/{ocs,connect,mobile}/capability-map.ts` (and the `mcp/connect/backends/commcare.ts` CommCare additions) routes to REST or Playwright; skill code never knows which. When the upstream service ships a real API for a Playwright-backed atom, it becomes a one-line routing change.
- **VERSION is the single source of truth.** Edit `VERSION` only; the pre-commit hook syncs `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` automatically. `/ace:doctor` verifies they match. To bump in a worktree-safe way (fetches origin and picks `max(local, origin) + patch+1`), run `scripts/version-bump.sh`.
- **Phase agents write back per the Phase Write-Back Contract** in `agents/ace-orchestrator.md § Phase Write-Back Contract` (codified in 0.13.53 / issue #116). Every phase MUST write a uniform `phases.<phase>.{status, verdict, completed_at, summary_artifact, steps}` block to `run_state.yaml` on completion and flip the matching `gates.<gate>` entry. The orchestrator stub-fills + warns if a phase forgot. Without this, `/ace:status` misreports the run, `opp-eval` rollups walk empty, and resume-after-interrupt can't tell which phases shipped.
- **QA vs Eval is a two-phase pattern, calibrated against ground truth.** `*-qa` skills capture transcripts + structural checks; `*-eval` skills judge them via LLM-as-Judge rubrics with hard-deduction rules and inflation guards, writing `verdicts/<skill>-<mode>.yaml`. Uniform verdict shape so `opp-eval` can aggregate any skill. Per-rubric calibration uses ground-truth catalogues, multi-run variance protocols, and detection-rate metrics — see `skills/eval-calibration/SKILL.md` and `skills/README.md` § QA vs Eval. Shallow runs in `/ace:run`; deep runs out-of-band via `/ace:qa-deep`.
- **Archetypes are first-class.** PDDs declare `Archetype: atomic-visit | focus-group | multi-stage`; archetype-aware skills branch on it via a `## Archetypes` section. Adding a new archetype is purely additive (per-skill PRs). Default is `atomic-visit`.
- **Class-level preventers > instance-level fixes.** Recurring discipline across the OCS / Drive / env-drift / Connect fixes: when a silent-failure class surfaces, catch it at the boundary (MCP backend, doctor diff, schema pre-flight, HTTP probe) so every future instance is structurally impossible. Don't just patch the case in front of you. The 0.7.1 `ocs_shared_collection_team` doctor probe is the canonical example: 50ms HTTP request that turns "configured" into "configured correctly."

## Improvement cycles & canopy

This repo is dogfooded by the `canopy` plugin. **Per-run evidence lives in Drive (`ACE/<opp>/runs/<run-id>/run_state.yaml`, `verdicts/`, `gate-briefs/`, `comms-log/observations.md`, `eval-calibration/`); cross-opp strategy lives in `.claude/pm/runs/<date>-<lens>.md`.** The opp `observations.md` is the evidence log; the run log is the synthesis that cites it. ACE skills don't read run logs; canopy and humans do. (`run_state.yaml` was renamed from `state.yaml` in 0.11.3 to make per-run scope explicit; opp-level metadata lives in `ACE/<opp>/opp.yaml`.)

**Re-entering the project:** run `/canopy:pm-status` (or read the most recent file in `.claude/pm/runs/`) — it surfaces the current lens, backlog, and last cycle's findings. Don't ask the orchestrator "what should I do next?" — phase agents only see per-opp state.

**Writing a run log:** copy the structure of the most recent existing run log (Lens / Do it / Backlog / Closed / Skipped / Meta-observations). Write one whenever a session ships a PR, surfaces a deferred backlog item, or defines a reusable lens. Skip for one-off ops or pure research.

**Canopy commands:** `/canopy:pm-status` (re-entry), `/canopy:pm-scout` (run a scout cycle), `/canopy:improve` (full improve loop), `/canopy:patterns` (cross-session friction).

## Auth model: per-machine vs 1Password-backed

ACE has two classes of credential state, and confusing them is the #1 source of friction when working across multiple workstations. The split is intentional — session cookies are bound to TLS fingerprints and CSRF rotation, so copying them between machines is *worse* than re-login (intermittent, hard to debug). Don't try to sync `~/.ace/` via 1Password or git.

**1Password-backed (set up once per machine, then static):**
- `${CLAUDE_PLUGIN_DATA}/.env` — every key declared in `.env.tpl` (most `ACE_*`, `OCS_*`, `CONNECT_*`, `LABS_MCP_TOKEN`, etc.). Source of truth lives in 1Password vault `AI-Agents`. Rotate values there and re-run `op inject -i .env.tpl -o $CLAUDE_PLUGIN_DATA/.env --force` (or `/ace:setup --force-env`) to propagate.
- `${CLAUDE_PLUGIN_DATA}/gws-sa-key.json` — Google service-account key for `ace-gdrive`. Static (SA keys don't expire). Drop it once via `/ace:setup`.

**Local-only secrets in `${CLAUDE_PLUGIN_DATA}/.env` (preserved across op inject since 0.13.34):**
- `ACE_E2E_AUTH_TOKEN` — shared automation token for labs's `/auth/e2e-login/` shared-secret path. Mirror from `~/emdash/repositories/ace-web/deploy/aws/task-definition.json` (or AWS Secrets Manager) into `.env` once. Not stored in 1Password by convention — it's a deploy secret, not a per-user credential.
- Any other key an operator adds to `.env` that isn't in `.env.tpl` will be preserved automatically. `bin/ace-setup` snapshots non-template keys before each `op inject` and re-appends them in a marker block (`# --- ACE local-only secrets ...`) at the end of the regenerated `.env`. Keys that appear in `.env.tpl` always take precedence (1P is authoritative for declared keys).

**Per-machine (re-login required on each workstation):**
- `~/.ace/ocs-session-<team>.json` — OCS Playwright cookies. Auto-relogin from `OCS_USERNAME/PASSWORD` if those are in `.env`; otherwise `/ace:ocs-login`.
- `~/.ace/connect-session.json` — Connect + CCHQ Playwright cookies (separate cookie jars in one storageState). Auto-relogin from `ACE_HQ_USERNAME/PASSWORD`; manual fallback `/ace:connect-login`.
- `~/.ace/playwright-userdata/` — chromium persistent profile used by mobile-bootstrap step 6 for Connect probe scripts. Re-seed via `scripts/seed-connect-cookies.ts`.
- AVD state, `~/.android/avd/`, registered-test-user snapshots — driven by `/ace:mobile-bootstrap` (only do mobile work that needs them).

**Single check that surfaces what's missing:** `/ace:doctor`'s `[Auth liveness]` block runs one live HTTP call per MCP and names the exact remediation command per failure. Run this first when picking up work on a new machine — it answers "which logins do I need to redo here?" in one screen.

**Two-machine workflow (typical recipe):**
1. On each machine: `/ace:setup` (installs deps, fetches `.env` + SA key from 1Password).
2. On each machine: `/ace:doctor` → look at `[Auth liveness]` → run the `fix:` command for any WARN.
3. Mobile work only: `/ace:mobile-bootstrap` per machine (creates AVD, registers test user, seeds Playwright cookies).

## Gotchas

- **`.gws-sa-key.json` is per-machine and gitignored.** Located at `${CLAUDE_PLUGIN_DATA}/gws-sa-key.json` (legacy fallback: plugin root). `ace-gdrive` won't start without it. `/ace:doctor` reports `GWS_KEY: MISSING` and prints the expected path.
- **`.env` is per-machine and gitignored.** Located at `${CLAUDE_PLUGIN_DATA}/.env` (legacy fallback: plugin root). To inspect env state, read that file directly — don't hunt through `cache/`, the worktree, or your shell. `/ace:doctor` reports `env_file` with the resolved path; the in-shell `$ACE_DRIVE_ROOT_FOLDER_ID` / `$ACE_E2E_AUTH_TOKEN` will normally be empty because the values are loaded into MCP-server subprocesses, not the parent shell.
- **OCS auth is session-based.** `/ace:ocs-login` drives a Playwright login and stores cookies. Every `ace-ocs` tool call needs a live session unless it's REST-backed. Same model for Connect: `/ace:connect-login` for MFA/SSO; `bin/ace-doctor` reports `connect_session` freshness.
- **Playwright backends are HTTP-only.** Both `mcp/ocs/backends/playwright.ts` and `mcp/connect/backends/playwright.ts` use `page.request` exclusively — no click-driving, no selectors. If a new atom looks like it needs UI automation, push back first.
- **OCS `{collection_index_summaries}` cross-field rule.** Required *iff* `collection_index_ids.length >= 2`; single-collection clones (the canonical per-opp case) must NOT include it. Enforced at the MCP boundary by `assertCollectionPromptInvariant`. Truth-table reproducer: `scripts/probe-n1-cross-test.ts`. Violating this fails the publish silently in older code paths.
- **Drive `parentFolderId` is required and must live on a Shared Drive.** `drive_create_file` / `drive_create_folder` no longer fall back to the SA's My Drive root (was a silent footgun — every subsequent write failed with a misleading "user storage quota exceeded"). `assertParentOnSharedDrive` runs one `files.get` probe before any write.
- **Drive metadata files (`~/.ace/*.json`) are hypotheses, not truths.** Stale snapshots have anchored multi-day investigations down wrong paths. Re-probe live state before acting on metadata older than ~7 days.
- **Plans use `- [ ]` syntax but are not live trackers.** Use PR history and code to determine what's shipped, not the checkboxes.
- **OCS shared-collection ID can exist on the wrong team.** Silent class of misconfig: `OCS_SHARED_COLLECTION_ID=350` may resolve to a real collection but live on a different team than `OCS_TEAM_SLUG`. Caught by the 0.7.1 `ocs_shared_collection_team` doctor probe (50ms HTTP GET); WARN-level, not FAIL.
- **Connect's invite UI is program-level, not opportunity-level.** `connect_send_llo_invite` takes a program UUID as its `opportunity_id` arg and the LLO workspace slug as `organization_name`. Awkward naming until Connect changes its data model — read it as "invite-to-program."
- **MCP-vs-skill-doc drift.** Skills that document atom field semantics inline can drift from the atom's actual schema. The 0.9.4 `connect-opp-setup` `location` fix is the canonical case: skill doc said "meters threshold," atom takes a boolean toggle. When you change an atom's signature, grep skills for inline references; when you write inline references in a skill, link them to the atom's tool description not your own paraphrase. See `docs/learnings/2026-04-28-mcp-vs-skill-doc-drift.md`.
- **Connect-Labs MCP is HTTP, but ACE consumes it via a stdio proxy.** `mcp/connect-labs-server.ts` reads `LABS_MCP_TOKEN` from `${CLAUDE_PLUGIN_DATA}/.env` and forwards JSON-RPC frames to `https://labs.connect.dimagi.com/mcp/`. Auth is per-user **PAT**, not OAuth on the wire — the OAuth bridge happens server-side inside labs's tool handlers (`require_connect_token(user)`). The proxy correctly distinguishes JSON-RPC notifications (no `id`) from requests; replying to a notification gets the host to disable tool discovery (issue #106 finding 8).
- **`solicitation` and `selected_llo` are separate blocks in `opp.yaml`.** `solicitation` is the audit trail (URLs, deadline, status, awarded.* fields); `selected_llo` is the narrow contract Phase 8 reads (`org_slug`, `contact_email`, `source`, `response_id`). Only `solicitation-review` populates `selected_llo`. If `selected_llo.org_slug` is set without a corresponding `solicitation` block, that's a contract violation. Phase 8's `llo-onboarding` halts fast if `selected_llo.org_slug` is null.
- **Nova has three known upstream bugs.** Autobuild sometimes skips Connect markers on vague specs; `update_form` `deliver_unit` runtime auto-fills broken `entity_id`/`entity_name`; `add_fields` partial persistence on first call. Mitigations: explicit Connect language in `pdd-to-{learn,deliver}-app` briefs; `app-release` pre-flight checks markers and post-release greps the CCZ for `<learn:deliver>` / `<learn:module>` counts. See `docs/learnings/2026-04-29-nova-connect-marker-bugs.md`.
