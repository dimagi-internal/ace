# ACE — Agent Guide

ACE (AI Connect Engine) is a Claude Code plugin that orchestrates the CRISPR-Connect lifecycle for Connect opportunities — idea → app build → deploy → LLO management → closeout. It follows the canopy plugin architecture: `agents/` (procedure docs + subagents), `skills/` (`SKILL.md` files, stateless), `mcp/` (external-system access).

## Agent topology

ACE has one architectural rule: **anything that calls `Agent` must run at level 0** (the top-level Claude Code session). The `Agent` tool is unavailable to subagents, so a node that needs to dispatch further work cannot itself be a subagent. Both procedure docs and subagents live under `agents/`; the wiring differs:

| Node | Calls `Agent`? | Form | Invoked how |
|------|----------------|------|-------------|
| `ace-orchestrator` | yes (dispatches phases + Nova) | procedure doc | `/ace:run` reads it and executes inline |
| `commcare-setup` (Phase 3) | yes — `/nova:autobuild` is a hidden Agent dispatch | procedure doc | orchestrator reads it and executes inline |
| `idea-to-design` (Phase 1) | no | subagent | `Agent(idea-to-design)` from level 0 |
| `scenarios-and-acceptance` (Phase 2) | no | subagent | `Agent(scenarios-and-acceptance)` from level 0 |
| `connect-setup` (Phase 4) | no | subagent | `Agent(connect-setup)` from level 0 |
| `ocs-setup` (Phase 5) | no | subagent | `Agent(ocs-setup)` from level 0 |
| `qa-and-training` (Phase 6) | no | subagent | `Agent(qa-and-training)` from level 0 |
| `synthetic-data-and-workflows` (Phase 7) | no | subagent | `Agent(synthetic-data-and-workflows)` from level 0 |
| `solicitation-management` (Phase 8) | no | subagent | `Agent(solicitation-management)` from level 0 |
| `execution-manager` (Phase 9) | no | subagent | `Agent(execution-manager)` from level 0 |
| `closeout` (Phase 10) | no | subagent | `Agent(closeout)` from level 0 |
| `ocs-tester` | no — leaf qa+eval pair | subagent | `Agent(ocs-tester)` ad-hoc |

Procedure docs retain frontmatter so `/ace:status`, `/ace:eval`, `/ace:doctor`, `/ace:docs` keep working; `/ace:run` and `/ace:step` execute them inline. Never two levels of `Agent` dispatch — that's the invariant. (Rule landed in 0.7.0 after Nova migration silently broke a level-2 `Agent` call.)

## Phases (current pipeline, 0.13.x)

1. idea-to-design → 2. scenarios-and-acceptance → 3. commcare-setup → 4. connect-setup → 5. ocs-setup → 6. qa-and-training → 7. synthetic-data-and-workflows → 8. solicitation-management → 9. execution-management → 10. closeout.

Phases 1–7 run end-to-end with zero LLO involvement. Phase 8 publishes a public solicitation (and emails PDD-named candidates if any). Phase 9 is the first 1-1 LLO contact, gated on `phases.solicitation-management.products.selected_llo.org_slug` in the current run's `run_state.yaml`. Phase 6 splits shallow (in `/ace:run`, ~5 LLM judges) vs deep (out-of-band via `/ace:qa-deep`, ~90 judges); `llo-launch` requires fresh deep verdicts. `app-multimedia-coverage` is a manual post-Phase-3 sibling of `commcare-form-patch`, invoked via `/ace:step`, not part of `/ace:run`.

Phase 1 produces the PDD (the formal design doc). Phase 2 derives test prompts (Q&A scenarios for OCS deep QA in Phase 5) and expected app journeys (UX-intent scenarios for app QA in Phase 6) from the approved PDD — both are AI interpretations of an AI-authored PDD, not ground truth.

## Layout

- `agents/` — 12 agents + 1 reference doc. Two procedure docs (`ace-orchestrator`, `commcare-setup`); ten subagents; `orchestrator-reference.md` is the reference companion to `ace-orchestrator.md` (state schemas, write-back contract, pause-points catalog).
- `skills/` — 66 skills, one dir per skill (`SKILL.md`). Stateless; per-opp state lives in Drive `ACE/<opp-name>/`. See `skills/README.md` for the author contract, the `## QA vs Eval` two-phase pattern, and `opp-eval` aggregator. Per-skill `-eval` rubrics calibrated against ground truth — see `skills/eval-calibration/SKILL.md`.
- `commands/` — 15 slash commands: `run`, `step`, `status`, `eval`, `qa-deep`, `docs`, `setup`, `update`, `doctor`, `ocs-login`, `connect-login`, `labs-login`, `labs-token-mint`, `mobile-bootstrap`, `ocs-bootstrap-template`.
- `mcp/` — 5 MCP servers wired inline in `.claude-plugin/plugin.json` `mcpServers` (inline since 0.5.16 to work around [anthropics/claude-code#9427](https://github.com/anthropics/claude-code/issues/9427)):
  - `ace-gdrive` (`google-drive-server.ts`) — Drive + Docs + Slides + Sheets.
  - `ace-ocs` (`ocs-server.ts`) — Open Chat Studio composite, 23 atoms (Authoring 11 + Observation 12). Source under `mcp/ocs/`.
  - `ace-connect` (`connect-server.ts`) — `connect.dimagi.com` composite, 21 atoms; 8 authoring atoms via REST automation API ([commcare-connect#1135](https://github.com/dimagi/commcare-connect/pull/1135)), rest via Playwright. Same MCP exposes 5 `commcare_*` atoms (`download_ccz`, `make_build`, `patch_xform`, `release_build`, `upload_multimedia`) via `backends/commcare.ts`. Source under `mcp/connect/`.
  - `ace-mobile` (`mobile-server.ts`) — Mac-local AVD + Maestro, 11 atoms. Static recipes in `mcp/mobile/recipes/static/` ship as scaffolds with `REPLACE_*` selectors that must be filled via `maestro studio` against the Connect APK before live runs. Source under `mcp/mobile/`.
  - `connect-labs` (`connect-labs-server.ts`) — stdio proxy forwarding JSON-RPC to `https://labs.connect.dimagi.com/mcp/`, injecting `LABS_MCP_TOKEN`. 9 atoms back Phase 8. One-line config swap to delete when Claude Code gains first-class HTTP MCP support.
- `playbook/integrations/` — per-MCP integration reference + durable gotcha records: `ocs-integration.md`, `nova-integration.md`, `connect-api.md`, `connect-labs.md`, `commcare-api.md`, `mobile-integration.md`, `slides-integration.md`.
- `docs/superpowers/specs/` + `docs/superpowers/plans/` — design specs and plans. Anchor doc: `specs/2026-04-01-ace-design.md`. Browse the directories for the rest; PR history is more reliable than plan checkboxes for shipped state.
- `docs/examples/` — PDD examples + stress-test observations.
- `docs/learnings/` — durable cross-session learnings (Nova bugs, MCP-vs-skill drift, etc.).
- `docs/generated/playbook.md` — derived process flow regenerated by `/ace:docs`. Not a source of truth.
- `templates/` — `pdd-template.md`, `onboarding-email-template.md`.
- `lib/` — `artifact-manifest.ts` (canonical artifact registry), `verdict-schema.ts` (uniform `-eval` shape), `plugin-data-dir.ts`.
- `test/` — `vitest` suites under `test/mcp/{ocs,connect}/` (unit + integration + E2E), `test/eval/` PDD evals, `test/fixtures/` partial-coverage manifest fixtures (`CRISPR-Test-001`/`002`/`004`/`005`) validated by `artifact-manifest.test.ts`.
- `scripts/` — `bootstrap-ocs-golden-template.ts`, `sync-version.sh`, `version-bump.sh` (worktree-safe), `hooks/pre-commit`, plus `probe-*.ts` durable contract probes.
- `bin/ace-doctor` — diagnostic behind `/ace:doctor`. Includes `[Auth liveness]` block per MCP that names the exact remediation command per failure.
- `bin/ace-update-check` — background update-check shim (borrowed from gstack).
- `hooks/hooks.json` — runs `bin/ace-update-check` on `SessionStart`.
- `.env.tpl` — 1Password-injectable template. Installed `.env` lives at `${CLAUDE_PLUGIN_DATA}/.env`. **1Password is source of truth** — never paste values into `.env` directly. Local-only keys preserved across `op inject` since 0.13.34.
- `migrations/` — version-to-version migration scripts. See `migrations/README.md`.

**Sibling repo:** `ace-web` is a sibling repo, not a submodule. Browser-harness work happens in the `ace-web` checkout; this repo owns the design spec (`docs/superpowers/specs/2026-04-07-ace-web-harness-design.md`).

## Running tests

```bash
npm test                                                          # vitest unit suites
npm run test:watch                                                # watch mode
OCS_INTEGRATION=1 npm run test:integration                        # hits live OCS; requires ocs-login
CONNECT_INTEGRATION=1 npm test -- test/mcp/connect/integration/   # requires connect-login
LABS_INTEGRATION=1 npm test -- test/mcp/connect-labs/integration/ # requires LABS_MCP_TOKEN
npm run eval                                                      # PDD evals via test/eval/run-eval.ts
```

## Running MCP servers standalone

```bash
npm run mcp:gdrive    # npx tsx mcp/google-drive-server.ts
npm run mcp:ocs       # npx tsx mcp/ocs-server.ts
npm run mcp:connect   # npx tsx mcp/connect-server.ts
```

All five MCPs auto-register via `mcpServers` in `.claude-plugin/plugin.json` when the plugin is installed.

## Git worktrees and merging to main

This repo uses emdash. If you're in a worktree (`git rev-parse --git-dir` contains `/worktrees/`), `main` is checked out at `~/emdash-projects/ace/` (run `git worktree list` from any worktree to confirm the exact path on this machine). You CANNOT `git checkout main` from a worktree.

**`main` is branch-protected** (`clean-install` status check required) — direct push is rejected. Ship via PR: `bash scripts/version-bump.sh`, commit, `git push -u origin <branch>`, `gh pr create`, then arm auto-merge with `gh pr merge <pr> --auto --merge`. The PR lands itself once `clean-install` passes (no manual review gate). Wait for the merge to land, then run `/ace:update` + `/reload-plugins` in this session.

Version-collision recipe (multiple worktrees bumped in parallel — common): `bash scripts/version-bump.sh --rebase-first` then `git push --force-with-lease`. The flag fetches origin/main, rebases, auto-resolves conflicts in the 4 version files (`--ours`), then recomputes the next version against the freshly-rebased base. Aborts cleanly if any non-version-file conflict surfaces (those need human review).

## Plugin updates — NEVER locally patch

**CRITICAL: Never copy, rsync, or write files into `~/.claude/plugins/cache/` or edit `~/.claude/plugins/installed_plugins.json` by hand.** Local patching bypasses the plugin system, creates version mismatches, and makes bugs hard to diagnose. If you feel the urge, STOP — use `/ace:update` instead.

### Update workflow (the ONLY way)
1. Make changes in the repo.
2. Bump version. **Recommended (worktree-safe):** run `scripts/version-bump.sh` — fetches `origin/main` and picks `max(local, origin) + patch+1`, writing all 4 files atomically. Removes the deterministic VERSION/plugin.json/marketplace.json/package.json rebase conflict that hits when several worktrees bump in parallel. Manual fallback: edit `VERSION` only; pre-commit hook syncs `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`.
3. Commit on the worktree branch, push, open a PR, arm auto-merge with `gh pr merge <pr> --auto --merge` (or check the auto-merge box in the PR UI). The PR lands itself once `clean-install` passes — no manual review gate. (`main` is branch-protected — direct push is rejected.) See § Git worktrees and merging to main for the canonical block, including the version-collision rebase recipe.
4. **IMMEDIATELY after the PR merges**, run `/ace:update` in the current session. Mandatory — without it, this session runs stale code while new sessions get the bump on startup. (Auto-merge means the merge is asynchronous; watch with `gh pr view <pr> --json state,mergedAt` or `gh run watch` if you need to block.)

Hook setup if needed: `git config core.hooksPath scripts/hooks`. Two hooks ship: `pre-commit` (syncs VERSION → JSON when VERSION is staged) and `pre-push` (refuses direct pushes to `main` — server-side protection already blocks them, but this catches muscle-memory pushes before the roundtrip; bypass with `git push --no-verify` if ever needed).

Cache dir is keyed by version: `~/.claude/plugins/cache/ace/ace/<version>/`. On session start, Claude Code pulls the marketplace repo, compares `plugin.json` version against the installed version, and re-installs if different.

## Conventions

- **Skills are stateless.** Per-opportunity state lives in Drive `ACE/<opp-name>/`. Don't introduce local state in `SKILL.md` files.
- **SKILL.md naming.** Skill dir is kebab-case verb phrase (`idea-to-pdd`, `app-test-cases`); must match frontmatter `name:` exactly.
- **MCP servers run direct from TypeScript.** ESM + `npx tsx`, no build step.
- **MCP capabilities are atomic.** Each atom in `mcp/{ocs,connect,mobile}/capability-map.ts` (and `mcp/connect/backends/commcare.ts`) routes to REST or Playwright; skill code never knows which. When upstream ships a real API for a Playwright-backed atom, it's a one-line routing change.
- **VERSION is the single source of truth.** Edit `VERSION` only; pre-commit hook syncs the other files. `/ace:doctor` verifies. Worktree-safe bump: `scripts/version-bump.sh`.
- **Phase Write-Back Contract.** Every phase MUST write `phases.<phase>.{status, verdict, completed_at, summary_artifact, steps}` to `run_state.yaml` on completion and flip the matching `gates.<gate>` entry. The orchestrator stub-fills + warns if a phase forgot. See `agents/orchestrator-reference.md § Phase Write-Back Contract` (codified 0.13.53 / issue #116). Without it `/ace:status` misreports, `opp-eval` rollups walk empty, and resume-after-interrupt can't tell which phases shipped.
- **QA vs Eval is a two-phase pattern, calibrated against ground truth.** `*-qa` skills capture transcripts + structural checks; `*-eval` skills judge via LLM-as-Judge with hard-deduction rules and inflation guards, writing per-run `<N>-<phase>/<skill>-eval_verdict[-<mode>].yaml` next to the producer artifacts (no top-level `verdicts/` directory; `gate-briefs/` removed in 0.13.116 — orchestrator synthesizes pause summaries from verdict files at runtime). Uniform shape so `opp-eval` aggregates any skill. Shallow runs in `/ace:run`; deep runs out-of-band via `/ace:qa-deep`. Per-rubric calibration uses ground-truth catalogues (`ACE/<opp>/eval-calibration/known-issues.md`, opp-level — shared across runs) and multi-run variance protocols.
- **Archetypes are first-class.** PDDs declare `Archetype: atomic-visit | focus-group | multi-stage`; archetype-aware skills branch via `## Archetypes` sections. Adding a new archetype is purely additive (per-skill PRs). Default is `atomic-visit`.
- **Class-level preventers > instance-level fixes.** When a silent-failure class surfaces, catch it at the boundary (MCP backend, doctor probe, schema pre-flight, HTTP probe) so future instances are structurally impossible. Don't just patch the case in front of you. The 0.7.1 `ocs_shared_collection_team` doctor probe is the canonical example: 50ms HTTP request that turns "configured" into "configured correctly."

## Phase preconditions are restored, not adapted

Each phase has a known precondition (the state it expects). Recovery is **restore to that precondition**, not **detect-and-adapt to whatever state is in front of us.** Already implicit elsewhere in ACE (run independence; fresh Connect opp per run; fresh OCS chatbot clone per opp; Nova builds from scratch per run). Made explicit in 0.13.202 after a misstep in Phase 6 that introduced state-classification logic instead of restoration.

The pattern:

1. **Precondition declared.** "Phase 6 expects: AVD at Connect home, test user signed in to PersonalID, opp tile reachable."
2. **Restore unconditionally.** Don't probe-first. Don't decide-then-act. Run the restore operation every time. Deterministic starting state, deterministic recovery path.
3. **Verify post-restore.** A classifier earns its keep ONLY as a verification step after restore — if the restore *should* have produced the precondition but didn't, the classifier names which precondition is still violated (snapshot corruption, APK drift, etc.). That's the only path a classifier is the right tool.
4. **Fail loud.** If restore can't reach the precondition, throw a typed error with the precise class. Don't ship placeholders, don't soft-fail with `verdict: incomplete`.

Canonical implementation: `MobileClient.restoreDeviceUserState` in `mcp/mobile/client.ts`. Single path — **always deterministic bootstrap** (refactored 2026-05-14, see `docs/learnings/2026-05-14-demo-user-no-otp.md`):

1. **Wipe Connect's per-app data** via `pm clear org.commcare.dalvik` (~0.5s; no root needed). Removes the prior dispatch's Connect Token, cached opp list, and sqlite DBs without touching the APK install.

2. **Ensure APK is installed.** Persists across emulator restarts in the AVD's userdata disk image — so on a warm AVD this is just a `listPackages` probe (~0.5s). Re-install only on fresh AVD; the host-side cache at `<tmp>/ace-mobile-apk-cache/` avoids re-downloading from GitHub release.

3. **`registerTestUser`** with the `+7426` demo-user prefix (CRITICAL — demo users skip OTP server-side; see the dedicated learning doc). ~15-25s end-to-end via Maestro.

4. **Verify post-bootstrap.** Classifier names the precondition class on failure (`needs-personal-id`, `commcare-not-installed`, etc.). Throws `DeviceUserStateError` with the precise label.

**Total steady-state cost: ~20-30s on a warm AVD.** Fresh-machine first dispatch is ~60-100s (one-time AVD boot + APK install + register). After that, every dispatch pays the same ~20-30s. Worth it — guaranteed clean state, never relying on stale cached snapshots.

**No snapshot-load fast path.** The previous design used `loadSnapshot('registered-test-user')` as a ~3s tier-1, fall-through-to-bootstrap as tier-2. That fast path had a recurring failure class: snapshots silently age (wall-clock + cached Connect Token both freeze at capture; post-load API calls 401). The clock-sync in PR #281 was a band-aid for one symptom. The 2026-05-14 refactor drops the snapshot from the heal path entirely. `saveSnapshot` is preserved as a manual MCP atom for ad-hoc debugging captures — heal flow never loads from snapshot.

The server-side `${ACE_E2E_PHONE}` invite check (CONNECT-ID-3F precondition) is structurally satisfied within `/ace:run` by Phase 4's `connect-opp-setup` running before Phase 6 — no operator action required mid-run.

**Cloud backend equivalent:** `/api/mobile/ensure-running` cold-boots from AMI and runs registration recipes — same contract, different mechanism. The AMI's baked registration scripts produce a fresh demo user on every cold-boot; ace-mobile MCP doesn't have a local snapshot-load that could go stale.

Each phase's heal lives in one place and funnels through the matching `mobile_ensure_avd_running` / `connect_*_setup` / `ocs_*_setup` atom.

**Anti-pattern: tolerance for "whatever starting state we find."** That's complexity in service of a question the phase shouldn't be asking. If you find yourself writing a state-classifier as the primary recovery mechanism, you're solving the wrong problem — flip it to "always restore; classify only on verification failure."

## Improvement cycles & canopy

This repo is dogfooded by the `canopy` plugin. **Per-run evidence lives in Drive at `ACE/<opp>/runs/<run-id>/`: `run_state.yaml` (the source of truth for every piece of state produced in that run — Connect opportunity, OCS chatbot, solicitation, selected_llo, synthetic — under `phases.<phase>.products.*`) plus per-phase `<N>-<phase>/<skill>_*` files (verdicts, transcripts, comms-logs). Each `/ace:run` is independent: no run reads from or writes to another run's `run_state.yaml`. Per-opp state — shared across every run — lives at `ACE/<opp>/`: `opp.yaml` (identity + the durable Connect program reference at `connect.program.{id, url, labs_int_id}`, written once and reused by every run; `connect-program-setup` is the only skill that mutates it), `inputs/`, `eval-calibration/known-issues.md`, `open-questions.md`. Cross-opp strategy lives in `.claude/pm/runs/<date>-<lens>.md`.** ACE skills don't read run logs; canopy and humans do. (State-consolidation refactor 2026-05-10/11: `connect-state.yaml` retired; per-run blocks moved into `run_state.yaml.phases.<phase>.products.*`. Initial implementation tried cross-run inheritance via a seed step; reverted in favor of run independence — see `docs/superpowers/specs/2026-05-10-state-consolidation.md`. `run_state.yaml` was renamed from `state.yaml` in 0.11.3; `gate-briefs/` removed 0.13.116; full per-opp vs per-run table + forking recipes in `agents/orchestrator-reference.md § Fork Points`.)

**Re-entering the project:** run `/canopy:pm-status` (or read the most recent `.claude/pm/runs/` file) — surfaces current lens, backlog, last cycle's findings. Don't ask the orchestrator "what next?" — phase agents only see per-opp state.

**Writing a run log:** copy the structure of the most recent existing one (Lens / Do it / Backlog / Closed / Skipped / Meta-observations). Write whenever a session ships a PR, surfaces a deferred backlog item, or defines a reusable lens. Skip for one-off ops or pure research.

**Canopy commands:** `/canopy:pm-status`, `/canopy:pm-scout`, `/canopy:improve`, `/canopy:patterns`.

## Auth model: per-machine vs 1Password-backed

ACE has two classes of credential state — confusing them is the #1 source of friction across workstations. Session cookies are bound to TLS fingerprints + CSRF rotation; copying them between machines is *worse* than re-login (intermittent, hard to debug). **Don't sync `~/.ace/` via 1Password or git.**

**1Password-backed (set up once per machine, then static):**
- `${CLAUDE_PLUGIN_DATA}/.env` — every key in `.env.tpl` (most `ACE_*`, `OCS_*`, `CONNECT_*`, `LABS_MCP_TOKEN`, etc.). Source of truth: 1Password vault `AI-Agents`. Rotate there and re-run `op inject -i .env.tpl -o $CLAUDE_PLUGIN_DATA/.env --force` (or `/ace:setup --force-env`).
- `${CLAUDE_PLUGIN_DATA}/gws-sa-key.json` — Google SA key. Static (SA keys don't expire).

**Local-only secrets in `.env` (preserved across `op inject` since 0.13.34):** `ACE_WEB_PAT_TOKEN` (per-human, minted via `/ace:ace-web-pat-mint`) and any other key not in `.env.tpl`. `bin/ace-setup` snapshots non-template keys before each `op inject` and re-appends them in a marker block (`# --- ACE local-only secrets ...`). Template keys always win — 1P is authoritative for declared keys.

**Per-machine (re-login required per workstation):**
- `~/.ace/ocs-session-<team>.json` — OCS Playwright cookies. Auto-relogin via `OCS_USERNAME/PASSWORD`; manual: `/ace:ocs-login`.
- `~/.ace/connect-session.json` — Connect + CCHQ cookies. Auto-relogin via `ACE_HQ_USERNAME/PASSWORD`; manual: `/ace:connect-login`.
- `~/.ace/playwright-userdata/` — chromium profile for Connect probes. Re-seed via `scripts/seed-connect-cookies.ts`.
- AVD state, `~/.android/avd/` — driven by `/ace:mobile-bootstrap` (mobile work only).

**Single check that surfaces what's missing:** `/ace:doctor`'s `[Auth liveness]` block runs one live HTTP call per MCP and names the exact remediation command per failure. Run first when picking up work on a new machine.

## Gotchas

- **`.gws-sa-key.json` and `.env` are per-machine and gitignored.** At `${CLAUDE_PLUGIN_DATA}/`. To inspect env state, read `${CLAUDE_PLUGIN_DATA}/.env` directly — values are loaded into MCP subprocesses, not the parent shell, so `$ACE_*` in your shell will normally be empty.
- **OCS / Connect auth is session-based.** Every Playwright-backed `ace-ocs` / `ace-connect` call needs a live session. `bin/ace-doctor` reports `connect_session` freshness.
- **Playwright backends are HTTP-only.** Both `mcp/ocs/backends/playwright.ts` and `mcp/connect/backends/playwright.ts` use `page.request` exclusively — no click-driving, no selectors. If a new atom looks like it needs UI automation, push back first.
- **OCS `{collection_index_summaries}` cross-field rule.** Required *iff* `collection_index_ids.length >= 2`; single-collection clones (the canonical per-opp case) must NOT include it. Enforced by `assertCollectionPromptInvariant`. Reproducer: `scripts/probe-n1-cross-test.ts`.
- **Drive `parentFolderId` is required and must live on a Shared Drive.** `drive_create_file` / `drive_create_folder` no longer fall back to SA's My Drive root (silent footgun — every subsequent write failed with a misleading "user storage quota exceeded"). `assertParentOnSharedDrive` runs one `files.get` probe before any write.
- **Drive metadata files (`~/.ace/*.json`) are hypotheses, not truths.** Stale snapshots have anchored multi-day investigations down wrong paths. Re-probe live state before acting on metadata older than ~7 days.
- **OCS shared-collection ID can exist on the wrong team.** `OCS_SHARED_COLLECTION_ID` may resolve to a real collection on a different team than `OCS_TEAM_SLUG`. Caught by 0.7.1 `ocs_shared_collection_team` doctor probe (WARN, not FAIL).
- **Connect's invite UI is program-level, not opportunity-level.** `connect_send_llo_invite` takes a program UUID as `opportunity_id` and the LLO workspace slug as `organization_name`. Read it as "invite-to-program."
- **`/invite_users/` requires the opp to be `active`.** Call `connect_activate_opportunity` first.
- **MCP-vs-skill-doc drift.** Skills paraphrasing atom schemas inline drift from the actual schema (canonical case: 0.9.4 `connect-opp-setup` `location` field — skill said "meters threshold," atom takes a boolean toggle). When you change an atom, grep skills for inline references; when writing inline references, link to the atom's tool description, not your own paraphrase. See `docs/learnings/2026-04-28-mcp-vs-skill-doc-drift.md`.
- **Connect-Labs MCP is HTTP, ACE consumes via stdio proxy.** `mcp/connect-labs-server.ts` reads `LABS_MCP_TOKEN` from `.env` and forwards JSON-RPC frames. Auth is per-user **PAT**, not OAuth on the wire — OAuth bridge happens server-side inside labs's tool handlers. The proxy correctly distinguishes JSON-RPC notifications (no `id`) from requests; replying to a notification disables tool discovery.
- **`solicitation` and `selected_llo` are separate `run_state.yaml.phases.solicitation-management.products.*` sub-blocks** (per-run only). `solicitation` is the audit trail (URLs, deadline, status, awarded.* fields); `selected_llo` is the narrow contract Phase 9 reads (`org_slug`, `contact_email`, `source`, `response_id`). Only `solicitation-review` populates `selected_llo`. If `selected_llo.org_slug` is set without a corresponding `solicitation` block, that's a contract violation. Phase 9's `llo-onboarding` halts fast if `selected_llo.org_slug` is null in the current run.
- **Nova has three known upstream bugs.** Autobuild sometimes skips Connect markers on vague specs; `update_form` `deliver_unit` runtime auto-fills broken `entity_id`/`entity_name`; `add_fields` partial persistence on first call. Mitigations: explicit Connect language in `pdd-to-{learn,deliver}-app` briefs; `app-release` pre-flight checks markers and post-release greps the CCZ for `<learn:deliver>` / `<learn:module>` counts. See `docs/learnings/2026-04-29-nova-connect-marker-bugs.md`.
- **Plans use `- [ ]` syntax but are not live trackers.** Use PR history and code to determine what's shipped, not the checkboxes.
