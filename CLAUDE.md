# ACE — Agent Guide

ACE (AI Connect Engine) is a Claude Code plugin that orchestrates the ACE lifecycle for Connect opportunities — idea → app build → deploy → LLO management → closeout. It follows the canopy plugin architecture: `agents/` (procedure docs + subagents), `skills/` (`SKILL.md` files, stateless), `mcp/` (external-system access).

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
| `sweep` | no — orphan triage | subagent | `Agent(sweep)` via `/ace:sweep` |

Procedure docs retain frontmatter so `/ace:status`, `/ace:eval`, `/ace:doctor`, `/ace:docs` keep working; `/ace:run` and `/ace:step` execute them inline. Never two levels of `Agent` dispatch — that's the invariant. (The rule exists because a Nova migration once silently broke a level-2 `Agent` call.)

## Phases (current pipeline)

1. idea-to-design → 2. scenarios-and-acceptance → 3. commcare-setup → 4. connect-setup → 5. ocs-setup → 6. qa-and-training → 7. synthetic-data-and-workflows → 8. solicitation-management → 9. execution-management → 10. closeout.

Phases 1–7 run end-to-end with zero LLO involvement. Phase 8 publishes a public solicitation (and emails PDD-named candidates if any). Phase 9 is the first 1-1 LLO contact, gated on `phases.solicitation-management.products.selected_llo.org_slug` in the current run's `run_state.yaml`. Phase 6 splits shallow (in `/ace:run`, ~5 LLM judges) vs deep (out-of-band via `/ace:qa-deep`, ~90 judges); `llo-launch` requires fresh deep verdicts. `app-multimedia-coverage` is a manual post-Phase-3 step invoked via `/ace:step`.

Phase 1 produces the PDD (the formal design doc). Phase 2 derives test prompts (Q&A scenarios for OCS deep QA in Phase 5) and expected app journeys (UX-intent scenarios for app QA in Phase 6) from the approved PDD — both are AI interpretations of an AI-authored PDD, not ground truth.

## Layout

- `agents/` — two procedure docs (`ace-orchestrator`, `commcare-setup`) executed inline + the phase subagents; `orchestrator-reference.md` is the reference companion to `ace-orchestrator.md` (state schemas, write-back contract, pause-points catalog).
- `skills/` — one dir per skill (`SKILL.md`); `ls skills/ | wc -l` for the live count. Stateless; per-opp state lives in Drive `ACE/<opp-name>/`. See `skills/README.md` for the author contract, the `## QA vs Eval` two-phase pattern, and `opp-eval` aggregator. Per-skill `-eval` rubrics calibrated against ground truth — see `skills/eval-calibration/SKILL.md`.
- `commands/` — slash commands. Core: `run`, `step`, `status`, `eval`, `qa-deep`, `docs`, `setup`, `update`, `doctor`. Auth/setup: `ocs-login`, `connect-login`, `labs-login`, `labs-token-mint`, `mobile-bootstrap`, `mobile-backend`, `ocs-bootstrap-template`, `ace-web-pat-mint`. Specialized flows: `sweep`, `program-update`, `video-from-program-page`, `interview-cohort-create`, `interview-domain-bootstrap`, `interview-opp-verify`.
- `mcp/` — 5 MCP servers wired inline in `.claude-plugin/plugin.json` `mcpServers` (inline to work around [anthropics/claude-code#9427](https://github.com/anthropics/claude-code/issues/9427)). Atom signatures live in `docs/atom-schemas.md` (generated, always-accurate) — grep there rather than trusting counts:
  - `ace-gdrive` (`google-drive-server.ts`) — Drive + Docs + Slides + Sheets + Forms. Cross-surface helpers worth flagging: `resolve_opp_path` (one-call ACE-root → opp → inputs/runs lookup), `generate_inputs_manifest` (typed manifest from a Drive folder), `get_google_form_definition` (Forms API question schema), `validate_run_state` + `classify_phase_writeback` (Phase Write-Back Verifier wrapped as atoms).
  - `ace-ocs` (`ocs-server.ts`) — Open Chat Studio composite (Authoring + Observation atoms). Source under `mcp/ocs/`.
  - `ace-connect` (`connect-server.ts`) — `connect.dimagi.com` composite: `connect_*` atoms (authoring via the REST automation API [commcare-connect#1135](https://github.com/dimagi/commcare-connect/pull/1135), rest via Playwright) + `commcare_*` atoms (CommCare HQ — domain creation, app build/release, multimedia, lookup tables, users, motech, UCR expressions, inbound APIs) via `backends/commcare.ts`. Source under `mcp/connect/`.
  - `ace-mobile` (`mobile-server.ts`) — Mac-local AVD + Maestro. Static recipe palette + `${SELECTOR:...}` map (default APK 2.63.0) + structural recipe-defect linting; full detail in `playbook/integrations/mobile-integration.md`. Source under `mcp/mobile/`.
  - `connect-labs` — native `type: "http"` entry in `plugin.json` pointing at `https://labs.connect.dimagi.com/mcp/`; Claude Code handles transport, and a `headersHelper` (`scripts/labs-auth-headers.mjs`, node-only) injects `Authorization: Bearer <LABS_MCP_TOKEN>` at connection time. Exposes every labs atom (funds, reviews, solicitations, workflows, pipelines, synthetic, mbw). Requires Claude Code ≥ 2.1.141. See `playbook/integrations/connect-labs.md`.
- `playbook/integrations/` — per-MCP integration reference + durable gotcha records: `ocs-integration.md`, `nova-integration.md`, `connect-api.md`, `connect-labs.md`, `commcare-api.md`, `mobile-integration.md`, `slides-integration.md`.
- `docs/superpowers/specs/` + `docs/superpowers/plans/` — design specs and plans. Date-stamped; browse the directories for the current set. PR history is more reliable than plan checkboxes for shipped state.
- `docs/examples/` — PDD examples + stress-test observations.
- `docs/learnings/` — durable cross-session learnings (Nova bugs, MCP-vs-skill drift, demo-user OTP mechanics, Phase 6 validation arc, etc.).
- `docs/atom-schemas.md` — auto-generated catalog of every registered MCP atom + Zod parameter schema. Regenerate via `npx tsx scripts/dump-atom-schemas.ts`; staleness gated by `test/scripts/dump-atom-schemas.test.ts`. The single source skills should grep against rather than paraphrasing atom signatures inline.
- `docs/generated/playbook.md` — derived process flow regenerated by `/ace:docs`. Not a source of truth.
- `templates/` — `pdd-template.md`, `onboarding-email-template.md`.
- `lib/` — pure helpers consumed by MCP servers + skills. Load-bearing: `artifact-manifest.ts` (canonical artifact registry), `verdict-schema.ts` (uniform `-eval` shape), `plugin-data-dir.ts` (workaround for the `${CLAUDE_PLUGIN_DATA}` env-expansion bug), `run-state-validator.ts` (Phase Write-Back Contract validator + `classifyPhaseWriteBack`), `transient-retry.ts` (shared network-error retry envelope used by gdrive + ocs), `atlas-drift.ts` (pure helpers behind `scripts/probe-atlas-drift.ts` — closes the consume half of `docs/learnings/2026-05-14-atlas-side-channel-capture.md`). See `ls lib/*.ts` for the live list.
- `test/` — `vitest` suites under `test/mcp/{gdrive,ocs,connect}/` (unit + integration + E2E), `test/lib/` (pure-helper tests including run-state-validator + transient-retry), `test/eval/` PDD evals, `test/fixtures/` partial-coverage manifest fixtures (`ACE-Test-001`/`002`/`004`/`005`) validated by `artifact-manifest.test.ts`, `test/scripts/` (script staleness gates), plus `test/mcp/registration-coverage.test.ts` (cross-server tool-registration snapshot) and `test/skill-atom-references.test.ts` (skill→MCP atom rename/remove drift detector).
- `scripts/` — `bootstrap-ocs-golden-template.ts`, `sync-version.sh`, `version-bump.sh` (worktree-safe), `dump-atom-schemas.ts` (regenerates `docs/atom-schemas.md`), `hooks/pre-commit`, plus `probe-*.ts` durable contract probes (including `probe-atlas-drift.ts` — read-only harvester that diffs Phase 6 ui-dump XMLs against the active selector map and surfaces candidate new logical-selector rows).
- `bin/ace-doctor` — diagnostic behind `/ace:doctor`. Includes `[Auth liveness]` block per MCP that names the exact remediation command per failure.
- `bin/ace-update-check` — background update-check shim (borrowed from gstack).
- `hooks/hooks.json` — runs `bin/ace-update-check` on `SessionStart`.
- `.env.tpl` — 1Password-injectable template. Installed `.env` lives at `${CLAUDE_PLUGIN_DATA}/.env`. **1Password is source of truth** — never paste values into `.env` directly. Local-only keys preserved across `op inject`.
- `migrations/` — version-to-version migration scripts. See `migrations/README.md`.

**Sibling repo:** `ace-web` is a sibling repo, not a submodule. Browser-harness work happens in the `ace-web` checkout; its design spec lives there.

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

This repo uses emdash. If you're in a worktree (`git rev-parse --git-dir` contains `/worktrees/`), the `main` branch is checked out in a sibling worktree — typically `~/emdash/repositories/ace/` or `~/emdash/worktrees/ace/emdash/<some-branch>` whose tip is the latest merge to main. Run `git worktree list` from any worktree to find the exact path on this machine. You CANNOT `git checkout main` from a worktree that doesn't already have it.

**`main` is branch-protected** (`clean-install` status check required) — direct push is rejected. Ship via PR: `bash scripts/version-bump.sh`, commit, `git push -u origin <branch>`, `gh pr create`, then arm auto-merge with `gh pr merge <pr> --auto --merge`. The PR lands itself once `clean-install` passes (no manual review gate). Wait for the merge to land, then run `/ace:update` + `/reload-plugins` in this session.

Version-collision recipe (multiple worktrees bumped in parallel — common): `bash scripts/version-bump.sh --rebase-first` then `git push --force-with-lease`. The flag fetches origin/main, rebases, auto-resolves conflicts in the 4 version files (`--ours`), then recomputes the next version against the freshly-rebased base. Aborts cleanly if any non-version-file conflict surfaces (those need human review).

## Plugin updates — NEVER locally patch

**CRITICAL: Never copy, rsync, or write files into `~/.claude/plugins/cache/` or edit `~/.claude/plugins/installed_plugins.json` by hand.** Local patching bypasses the plugin system, creates version mismatches, and makes bugs hard to diagnose. If you feel the urge, STOP — use `/ace:update` instead.

### Update workflow (the ONLY way)
1. Make changes in the repo.
2. Bump version. **Recommended (worktree-safe):** run `scripts/version-bump.sh` — fetches `origin/main` and picks `max(local, origin) + patch+1`, writing all 4 files atomically. Removes the deterministic VERSION/plugin.json/marketplace.json/package.json rebase conflict that hits when several worktrees bump in parallel. Manual fallback: edit `VERSION` only; pre-commit hook syncs `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`.
3. Commit on the worktree branch, push, open a PR, arm auto-merge with `gh pr merge <pr> --auto --merge` (or check the auto-merge box in the PR UI). The PR lands itself once `clean-install` passes — no manual review gate. (`main` is branch-protected — direct push is rejected.) See § Git worktrees and merging to main for the canonical block, including the version-collision rebase recipe.
4. **IMMEDIATELY after the PR merges**, run `/ace:update` in the current session. Mandatory — without it, this session runs stale code while new sessions get the bump on startup. (Auto-merge means the merge is asynchronous; watch with `gh pr view <pr> --json state,mergedAt` or `gh run watch` if you need to block.)

**Dispatching a fix-and-ship subagent?** Use the canonical poll-loop template in `agents/orchestrator-reference.md § Fix-and-ship subagent template`. Returning before the merge confirms is the #1 source of "PR queued but actually stuck" handoffs.

Hook setup if needed: `git config core.hooksPath scripts/hooks`. Two hooks ship: `pre-commit` (syncs VERSION → JSON when VERSION is staged) and `pre-push` (refuses direct pushes to `main` — server-side protection already blocks them, but this catches muscle-memory pushes before the roundtrip; bypass with `git push --no-verify` if ever needed).

Cache dir is keyed by version: `~/.claude/plugins/cache/ace/ace/<version>/`. On session start, Claude Code pulls the marketplace repo, compares `plugin.json` version against the installed version, and re-installs if different.

### MCP changes need a full Claude restart (not just `/reload-plugins`)

Editing MCP code in `mcp/` (or a new schema deploying upstream — e.g. labs publishes a new `tools/list`) does NOT take effect in the current Claude Code session via `/ace:update` + `/reload-plugins` alone. **MCP subprocesses bind their tool list, schemas, and module code at subprocess startup** — that's tied to the parent Claude Code process, not to plugin reloads. After:

- Editing anything under `mcp/` (atom handlers, capability maps, backend wiring, `tools/list` shape) and merging the change
- An upstream MCP server (labs, OCS, Connect) deploying a new schema while your session was running
- `/ace:update` bumping the plugin to a version whose MCP code differs

…the running MCP subprocess is still holding the OLD code/schema. `/reload-plugins` reloads agents + skills + hooks; it does NOT respawn MCP subprocesses. **Quit and reopen Claude Code (full process restart)** to pick up the new MCP behavior.

Symptom of skipping this: payloads that match the documented schema get `INVALID_SCHEMA` rejections; new atoms don't appear in `ToolSearch`; deprecated atoms still resolve. The on-disk code is right; the running subprocess is just stale. (Seen live on the `solicitation-create` schema-drift class, where ACE read a pre-PR-#211 `{data: {...}}` shape weeks after the live schema went flat.)

When in doubt, validate by curling the live MCP's `tools/list` directly (e.g. `curl ... https://labs.connect.dimagi.com/mcp/ -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`) — that response is the canonical contract. If it disagrees with what `ToolSearch` shows you in-session, restart Claude.

## Conventions

- **Skills are stateless.** Per-opportunity state lives in Drive `ACE/<opp-name>/`. Don't introduce local state in `SKILL.md` files.
- **SKILL.md naming.** Skill dir is kebab-case verb phrase (`idea-to-pdd`, `app-test-cases`); must match frontmatter `name:` exactly.
- **MCP servers run direct from TypeScript.** ESM + `npx tsx`, no build step.
- **MCP capabilities are atomic.** Each atom in `mcp/{ocs,connect,mobile}/capability-map.ts` (and `mcp/connect/backends/commcare.ts`) routes to REST or Playwright; skill code never knows which. When upstream ships a real API for a Playwright-backed atom, it's a one-line routing change.
- **VERSION is the single source of truth.** Edit `VERSION` only; pre-commit hook syncs the other files. `/ace:doctor` verifies. Worktree-safe bump: `scripts/version-bump.sh`.
- **Phase Write-Back Contract.** Every phase MUST write `phases.<phase>.{status, verdict, completed_at, summary_artifact, steps}` to `run_state.yaml` on completion (no separate `gates.<gate>` flip step — pause-point status is derived from the phase block + per-skill verdict files). The orchestrator's `classify_phase_writeback` atom is the structural runtime check used by the Phase boundary fence; `validate_run_state` returns the full issue list when the classifier says `'malformed'`. Implementation: `lib/run-state-validator.ts`. See `agents/orchestrator-reference.md § Phase Write-Back Contract`. Without it `/ace:status` misreports, `opp-eval` rollups walk empty, and resume-after-interrupt can't tell which phases shipped.
- **QA vs Eval is a two-phase pattern, calibrated against ground truth.** `*-qa` skills capture transcripts + structural checks; `*-eval` skills judge via LLM-as-Judge with hard-deduction rules and inflation guards, writing per-run `<N>-<phase>/<skill>-eval_verdict[-<mode>].yaml` next to the producer artifacts (no top-level `verdicts/` directory; no `gate-briefs/` — the orchestrator synthesizes pause summaries from verdict files at runtime). Uniform shape so `opp-eval` aggregates any skill. Shallow runs in `/ace:run`; deep runs out-of-band via `/ace:qa-deep`. Per-rubric calibration uses ground-truth catalogues (`ACE/<opp>/eval-calibration/known-issues.md`, opp-level — shared across runs) and multi-run variance protocols.
- **Archetypes are first-class.** PDDs declare `Archetype: atomic-visit | focus-group | multi-stage`; archetype-aware skills branch via `## Archetypes` sections. Adding a new archetype is purely additive (per-skill PRs). Default is `atomic-visit`.
- **Class-level preventers > instance-level fixes.** When a silent-failure class surfaces, catch it at the boundary (MCP backend, doctor probe, schema pre-flight, HTTP probe) so future instances are structurally impossible. Don't just patch the case in front of you. The `ocs_shared_collection_team` doctor probe is the canonical example: a 50ms HTTP request that turns "configured" into "configured correctly."
- **Close the loop to the source of truth — don't guess at what another system owns.** When a bug is really "ACE is guessing at a value another system is authoritative about," *observe the real value from that system once* and lock it behind a test — never ship another plausible guess. Two shapes: (1) **live-device truth** — calibrate a selector map / Maestro recipe against a live `mobile_capture_ui_dump` *and run it on-device to confirm it navigates*; don't transcribe from a sibling APK version (the 2.63.0 selector drift, jjackson/ace#591/#593, was copied unverified from 2.62.0 and only caught when Phase 6 burned wall-clock). (2) **contract truth** — get the authoritative answer from the upstream validator/runtime (Nova `validate_app`, Connect budget check) rather than trial-and-erroring values through it (#586's `entity_id` cycled three failing guesses). **When you change recipe/selector logic, validate it live before shipping** — unvalidated branches recreate the class you're fixing. If you can't reach a surface this session, encode what evidence confirms and mark the residual precisely. New-APK-version maps are calibrated against a live device as a first-class step, not discovered wrong in production.
- **For an external state transition, attempt the transition and treat the conflict as the skip — never let a read-back flag stand in for it.** Distinguish two kinds of "is this already done?" pre-check: (a) a **cost-skip** that avoids redundant work but is re-validated live downstream (`ocs-agent-setup` reads its run-local state file to skip a re-clone, but Step 10 still does a live embed round-trip) — fine; (b) a **correctness-skip** that reads one system's flag and *decides not to perform a state transition another path depends on* — a footgun, because the flag may not mean what you think. `connect-opp-setup` read the managed-opp create endpoint's side-effect `active: true` and skipped the `/activate/` call — but that flag is NOT the `/activate/` transition `invite_users/` requires, so invites failed (jjackson/ace#624). The safe shape: call the transition unconditionally and catch the "already done" error as the skip signal; branch on the *call result*, not a read-back flag. A correctness-skip is only safe when its guard is the very state the dependent step reads (or it re-validates live). Sibling of "restore, don't adapt" and "close the loop to the source of truth."
- **File ACE issues mid-run the moment you've confirmed one — don't just narrate.** Navigating around a broken script/recipe/atom to keep a run moving is expected. But once you've *confirmed* a defect or concrete improvement (root cause + how ACE should change), **immediately `gh issue create` against `jjackson/ace`** — one issue per finding (title + root cause + run/repro + a "fix lands here: `path`" pointer) — then keep going. Don't defer to run-end (you'll lose the precise repro) or fix-in-place silently (the class-level fix gets lost). Bar: file when you'd bet it's real — false positives are cheap to close, lost findings are not. **Report every issue filed in the run summary.** Pairs with "class-level preventers": the issue is how the preventer gets tracked.
- **No inferred backstory.** Skills must work from inputs that exist in `ACE/<opp>/inputs/` or the run state — never invent context (claimed populations, partner relationships, historical pilots) that the source material doesn't contain. PDD drafts that fabricate plausible-sounding details poison every downstream phase. See `docs/learnings/2026-05-12-no-inferred-backstory.md`.

## Phase preconditions are restored, not adapted

Each phase has a known precondition (the state it expects). Recovery is **restore to that precondition**, not **detect-and-adapt to whatever state is in front of us.** Already implicit elsewhere in ACE (run independence; fresh Connect opp per run; fresh OCS chatbot clone per opp; Nova builds from scratch per run). Made explicit after a Phase 6 misstep that introduced state-classification logic instead of restoration.

The pattern:

1. **Precondition declared.** "Phase 6 expects: AVD at Connect home, test user signed in to PersonalID, opp tile reachable."
2. **Restore unconditionally.** Don't probe-first. Don't decide-then-act. Run the restore operation every time. Deterministic starting state, deterministic recovery path.
3. **Verify post-restore.** A classifier earns its keep ONLY as a verification step after restore — if the restore *should* have produced the precondition but didn't, the classifier names which precondition is still violated. That's the only path a classifier is the right tool.
4. **Fail loud.** If restore can't reach the precondition, throw a typed error with the precise class. Don't ship placeholders, don't soft-fail with `verdict: incomplete`.

Canonical implementation: the mobile heal funnel (`mobile_ensure_avd_running`) — **always full cold-boot per dispatch**, never warm-state reuse, ~60-90s steady-state. Full step-by-step (cold-boot sequence, the failure classes it eliminates, the verify-only classifier) + debug-arc context in `playbook/integrations/mobile-integration.md` and `docs/learnings/2026-05-14-phase6-validation-arc.md` (+ `2026-05-14-demo-user-no-otp.md` for the `+7426` demo-user OTP-skip).

The server-side `${ACE_E2E_PHONE}` invite check (CONNECT-ID-3F precondition) is structurally satisfied within `/ace:run` by Phase 4's `connect-opp-setup` running before Phase 6 — no operator action required mid-run.

**Cloud backend equivalent:** `/api/mobile/ensure-running` cold-boots from AMI and runs registration recipes — same contract, different mechanism. The AMI's baked registration scripts produce a fresh demo user on every cold-boot; ace-mobile MCP doesn't have a local snapshot-load that could go stale.

Each phase's heal lives in one place and funnels through the matching `mobile_ensure_avd_running` / `connect_*_setup` / `ocs_*_setup` atom.

**Anti-pattern: tolerance for "whatever starting state we find."** That's complexity in service of a question the phase shouldn't be asking. If you find yourself writing a state-classifier as the primary recovery mechanism, you're solving the wrong problem — flip it to "always restore; classify only on verification failure."

## Improvement cycles & canopy

This repo is dogfooded by the `canopy` plugin. **Per-run evidence lives in Drive at `ACE/<opp>/runs/<run-id>/`: `run_state.yaml` (the source of truth for every piece of state produced in that run — Connect opportunity, OCS chatbot, solicitation, selected_llo, synthetic — under `phases.<phase>.products.*`) plus per-phase `<N>-<phase>/<skill>_*` files (verdicts, transcripts, comms-logs). Each `/ace:run` is independent: no run reads from or writes to another run's `run_state.yaml`. Per-opp state — shared across every run — lives at `ACE/<opp>/`: `opp.yaml` (identity + the durable Connect program reference at `connect.program.{id, url, connect_int_id}`, written once and reused by every run; `connect-program-setup` is the only skill that mutates it), `inputs/`, `eval-calibration/known-issues.md`, `open-questions.md`. Cross-opp strategy lives in `.claude/pm/runs/<date>-<lens>.md`.** ACE skills don't read run logs; canopy and humans do. (State consolidation retired `connect-state.yaml` into `run_state.yaml.phases.<phase>.products.*`; cross-run inheritance was tried via a seed step and reverted for run independence. Full per-opp vs per-run table + forking recipes in `agents/orchestrator-reference.md § Fork Points`.)

**Re-entering the project:** run `/canopy:pm-status` (or read the most recent `.claude/pm/runs/` file) — surfaces current lens, backlog, last cycle's findings. Don't ask the orchestrator "what next?" — phase agents only see per-opp state.

**Writing a run log:** copy the structure of the most recent existing one (Lens / Do it / Backlog / Closed / Skipped / Meta-observations). Write whenever a session ships a PR, surfaces a deferred backlog item, or defines a reusable lens. Skip for one-off ops or pure research.

**Canopy commands:** `/canopy:pm-status`, `/canopy:pm-scout`, `/canopy:improve`, `/canopy:patterns`.

**Running canopy improvement alongside `/ace:run`:** see `playbook/opp-run-with-canopy.md` for the per-opp sequence — fire `perf` lens in-session at a gate (capture only); fire `judge` / `production` / `qa-eval-system` lenses off-session against run artifacts; implement captured proposals in a separate session to avoid VERSION + worktree churn. One opp at a time.

## Auth model: per-machine vs 1Password-backed

ACE has two classes of credential state — confusing them is the #1 source of friction across workstations. Session cookies are bound to TLS fingerprints + CSRF rotation; copying them between machines is *worse* than re-login (intermittent, hard to debug). **Don't sync `~/.ace/` via 1Password or git.**

**1Password-backed (set up once per machine, then static):**
- `${CLAUDE_PLUGIN_DATA}/.env` — every key in `.env.tpl` (most `ACE_*`, `OCS_*`, `CONNECT_*`, `LABS_MCP_TOKEN`, etc.). Source of truth: 1Password vault `AI-Agents`. Rotate there and re-run `op inject -i .env.tpl -o $CLAUDE_PLUGIN_DATA/.env --force` (or `/ace:setup --force-env`).
- `${CLAUDE_PLUGIN_DATA}/gws-sa-key.json` — Google SA key. Static (SA keys don't expire).

**Local-only secrets in `.env` (preserved across `op inject`):** `ACE_WEB_PAT_TOKEN` (per-human, minted via `/ace:ace-web-pat-mint`) and any other key not in `.env.tpl`. `bin/ace-setup` snapshots non-template keys before each `op inject` and re-appends them in a marker block (`# --- ACE local-only secrets ...`). Template keys always win — 1P is authoritative for declared keys.

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
- **OCS shared-collection ID can exist on the wrong team.** `OCS_SHARED_COLLECTION_ID` may resolve to a real collection on a different team than `OCS_TEAM_SLUG`. Caught by the `ocs_shared_collection_team` doctor probe (WARN, not FAIL).
- **Connect's invite UI is program-level, not opportunity-level.** `connect_send_llo_invite` takes a program UUID as `opportunity_id` and the LLO workspace slug as `organization_name`. Read it as "invite-to-program."
- **`/invite_users/` requires the opp to be `active`.** Call `connect_activate_opportunity` first.
- **Connect's 50-char trap on `short_description` and opp slug.** Connect silently truncates both fields at 50 characters server-side, then later API calls keyed by slug fail with confusing 404s. Skills must enforce a 50-char ceiling at the input boundary. See `docs/learnings/2026-05-12-connect-opp-short-description-50-char-trap.md` + `2026-05-17-connect-slug-length-50-char-trap.md`.
- **MCP-vs-skill-doc drift.** Skills paraphrasing atom schemas inline drift from the actual schema (canonical case: the `connect-opp-setup` `location` field — skill said "meters threshold," atom takes a boolean toggle). Two detectors now ship in CI: `test/skill-atom-references.test.ts` catches the rename/remove half deterministically (fails when a skill mentions an atom-shaped token that isn't registered + isn't allowlisted); `docs/atom-schemas.md` (regenerated by `scripts/dump-atom-schemas.ts`, staleness-gated by `test/scripts/dump-atom-schemas.test.ts`) makes semantic schema changes visible as doc diffs in PR review. Skill authors should grep `docs/atom-schemas.md` for atom signatures rather than paraphrasing. See `docs/learnings/2026-04-28-mcp-vs-skill-doc-drift.md`.
- **`scripts/dump-atom-schemas.ts` is comment-unaware.** A bare apostrophe in a JS line comment inside any `mcp/*-server.ts` (e.g. `// Maestro's parser`) opens a phantom string that silently drops every later `server.tool(...)` from `docs/atom-schemas.md` — the staleness gate fails with atoms missing from one server. Fix: rephrase the comment to drop the apostrophe (structural parser fix deferred). See `docs/learnings/2026-05-25-recipe-static-preventer-suite.md`.
- **Connect-Labs MCP is a native `type: "http"` entry + `headersHelper`.** Auth is per-user **PAT**, not OAuth on the wire — the OAuth bridge happens server-side inside labs's handlers. `scripts/labs-auth-headers.mjs` (the `headersHelper`) emits `Authorization: Bearer <LABS_MCP_TOKEN>`; it's node-only, self-derives the plugin-data dir (around the unexpanded `${CLAUDE_PLUGIN_DATA}`, #9427), and reads the token from env → `<data-dir>/.env` → dev-root `.env`. Requires Claude Code ≥ 2.1.141. See `playbook/integrations/connect-labs.md`.
- **Multiple open solicitations on the same Connect program is correct, expected behavior** — not a bug to fix. Every `/ace:run` publishes a fresh solicitation; only one (the chosen release-candidate run's) gets launched to candidate LLOs; the others live in the labs portal as run-scoped audit trails until operator-cleaned-up via `connect-labs delete_solicitation` or the labs UI. The same pattern applies to per-run Connect opportunities and OCS chatbots. See `skills/solicitation-create/SKILL.md § Per-run solicitations are expected, not a bug`.
- **`solicitation` and `selected_llo` are separate `run_state.yaml.phases.solicitation-management.products.*` sub-blocks** (per-run only). `solicitation` is the audit trail (URLs, deadline, status, awarded.* fields); `selected_llo` is the narrow contract Phase 9 reads (`org_slug`, `contact_email`, `source`, `response_id`). Only `solicitation-review` populates `selected_llo`. If `selected_llo.org_slug` is set without a corresponding `solicitation` block, that's a contract violation. Phase 9's `llo-onboarding` halts fast if `selected_llo.org_slug` is null in the current run.
- **No known Nova upstream bugs.** `update_form` correctly clears nullable properties and exposes `entity_id`/`entity_name` on `deliver_unit`; architect has case-list-config tools; XForm entity-encoding and Connect block ID validation are handled at save time; PAT auth with 250-turn cap and reliable return message. ACE-side defensive checks (`app-connect-coverage`, `app-release` CCZ verification, `commcare-setup` turn-0 retry) remain as safety nets. See `playbook/integrations/nova-integration.md`.
- **`update_yaml_file` `two-level` merge replaces a phase child WHOLESALE — use `deep` for nested patches.** `two-level` only protects top-level-key *children*; a partial patch of `phases.<phase>` (e.g. just `{status}`, just one step under `steps`, or just `products`) **silently drops the rest of that phase block** (the lost-update footgun). When patching a nested path without resending the entire phase block, pass `merge: 'deep'` (recursive, preserves siblings at every depth — added after bednet-spot-check/20260529-1124 corrupted `phases.commcare-setup` + `phases.connect-setup` this way; see jjackson/ace#572). Only use `two-level` when you resend the phase's COMPLETE child block.
- **Connect Learn-completion is one-way per `(test user, opportunity)`.** Once the test user completes Learn on an opp, Connect routes "Continue Learning" to the Deliver gate, not the Learn home — the Learn flow can't be re-walked on that opp+user. Phase 6's Learn-walk smoke therefore needs a Learn-NOT-complete opp; a consumed one is NOT a recoverable blocker (the only restore is a fresh opportunity, i.e. a fresh `/ace:run`). Never complete Learn out-of-band to "diagnose" a recipe — that consumes the precondition. `connect-claim-opp.yaml` branches on the Deliver gate (already-complete) and `app-screenshot-capture` Step 2.7 records `satisfied-by-prior-completion` + proceeds to Deliver. See `docs/learnings/2026-05-18-connect-gates-deliver-on-learn-completion.md` + jjackson/ace#568/#570.
- **Connect shares ONE `DeliverUnit` across opps wired to the same released Deliver app (cc_app_id).** `get_or_create(DeliverApp, slug)` returns the same `DeliverUnit` PK, which is permanently bound to the first opp's payment unit — so a fresh per-run opp that reuses the same released Deliver app **cannot create a payment unit** (`Invalid or already-assigned deliver unit IDs`). A mid-run Phase-4 re-mint must pair a fresh opp with a fresh Deliver release (new `cc_app_id`); the clean path for a fully-fresh precondition is a new `/ace:run`. No `connect_delete_payment_unit` atom exists yet. See jjackson/ace#573.
- **Score-gated Learn quizzes have a TWO-screen finalize (`nav_btn_finish`), not `nav_btn_next` auto-finalize.** A single-question quiz with a score-conditional result label advances (answer → result-label screen) and only submits/syncs on the result screen's FINISH button. The `form-submit.yaml` palette + `form-nav-finish` selector handle this; the old "Learn forms always auto-finalize via `nav_btn_next`" assumption is false for score-gated quizzes. See jjackson/ace#569.
