# Changelog

All notable changes to the ACE plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the plugin follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## 0.5.12 — 2026-04-20

Archetype audit closes the Phase 5 LLO-facing trio: `llo-launch` gets
per-archetype readiness checks and go-live semantics. "Your
opportunity is live — FLWs can now use the apps" is exactly the wrong
email for a focus-group pilot whose first artifact is a scheduled
Session 1, not a downloadable app. Same Connect activation action;
different readiness criteria, notification subject, and launch-record
shape per archetype.

### Added

- **`## Archetypes` section in `skills/llo-launch/SKILL.md`.**
  `atomic-visit` (default) keeps Learn/Deliver app-build verification
  and the "You Are Live!" subject. `focus-group` replaces
  app-readiness with **Session 1 readiness** — venue, recording gear
  tested, audio-upload path verified, participant recruitment at
  target, consent practiced — and flips the subject to "Session 1 is
  on the calendar!" (not "You Are Live," which is FLW-deployment
  coded). `multi-stage` pins activation to Stage 1's protocol; each
  stage gets its own `llo-launch` invocation and `launch-record-stage-N.md`
  so per-stage history is preserved.
- **Gate-brief "What to Check" item 3** now swaps in the archetype-matched
  delivery-surface bullet instead of hardcoding "All apps built and
  downloadable."
- **Launch-record `archetype_details`** captured per archetype so
  `timeline-monitor` keys off the right cadence and milestones (session
  schedule for FGD, first-delivery date for atomic-visit,
  stage-transition window for multi-stage).

### Why

Third archetype-branching PR of this session. Closes the Phase 5
LLO-facing trio:
- `llo-onboarding` (0.5.10) — first email
- `llo-uat` (0.5.11) — UAT checklist
- `llo-launch` (0.5.12) — go-live ← this release

Any Phase 5 opp under any archetype now gets archetype-appropriate
LLO-facing artifacts end-to-end. Remaining atomic-visit-biased Phase
5 skill: `llo-feedback` (potential stretch — not blocking go-live).

Archetype-aware skill count: 11 → 12.

## 0.5.11 — 2026-04-20

Archetype audit continues: `llo-uat` gets per-archetype UAT checklists.
FGD LLOs aren't testing a CommCare app — they're dry-running a
facilitation session. Atomic-visit "download the Learn app and test
every module" instructions to a focus-group LLO produce confused
recipients and silent UAT stalls.

### Added

- **`## Archetypes` section in `skills/llo-uat/SKILL.md`.**
  `atomic-visit` (default) keeps the existing Learn-app / Deliver-app
  checklist. `focus-group` replaces "test the apps" with **"dry-run a
  facilitation session"**: question-guide walk-through, recording
  workflow, consent flow, session-note template fit, venue/logistics
  check. Sign-off criterion flips to "you could run Session 1
  tomorrow." Specifically surfaces dry-run duration as a must-flag
  signal (session-length mismatches are the first thing dry-runs
  expose and the hardest to fix mid-study). `multi-stage` uses
  per-stage UAT — full checklist for Stage 1, reference-only for
  later stages with their own dedicated UAT windows.
- **Step 2 of the Process** now reads the PDD's `archetype:` field and
  routes to the appropriate subsection. UAT results file records the
  archetype so `llo-launch` applies matching go-live criteria.

### Why

Third shipping archetype-branching PR this session. Pairs with:
- `llo-onboarding` (0.5.10) — email framing
- `llo-uat` (0.5.11) — UAT checklist ← this release

Archetype-aware skill count: 10 → 11.

## 0.5.10 — 2026-04-20

Archetype audit: `llo-onboarding` adds per-archetype email framing.
First LLO-facing artifact of the entire pipeline. Atomic-visit language
("your FLWs will start collecting deliveries") lands as obviously wrong
to an org that's running focus groups, and corrodes trust before the
first session. Branch the welcome framing, the "getting started" step
list, material emphasis, and timeline cadence by the PDD's `archetype:`
field.

### Added

- **`## Archetypes` section in `skills/llo-onboarding/SKILL.md`.**
  `atomic-visit` (default) keeps the existing FLW-download-app flow.
  `focus-group` addresses the recipient as a facilitator-owning org,
  leads with question guide + audio upload, and uses session-count
  cadence language ("N sessions over T weeks"). `multi-stage`
  front-loads Stage 1 content and names the stage transition explicitly.
- **Step 3 of the Process** now reads the PDD's `archetype:` field and
  routes to the appropriate subsection.

### Why

The 2026-04-19 iteration loop established archetype branching as a
"one skill, one PR" unit of work. `pdd-to-test-prompts` (0.4.1) and
`llo-invite` (0.4.2) shipped that way. `llo-onboarding` is the next
high-leverage skill because its output is the **first thing an
external LLO sees from ACE** — getting the framing wrong there is the
largest bad-send risk in the pipeline. PM log 2026-04-19 carried
"Archetype coverage audit (P4)" as standing backlog.

Archetype-aware skill count: 9 → 10.

## 0.5.9 — 2026-04-20

Close the class of silent-MCP-stall that 0.5.7 fixed for one server.
`/ace:doctor` now statically verifies that every MCP server which reads
`$CLAUDE_PLUGIN_DATA/.env` via dotenv also has `CLAUDE_PLUGIN_DATA`
in its `.mcp.json` env block. If it doesn't, the subprocess spawns with
an empty env, dotenv silently falls back to the wrong cwd, every secret
reads as undefined, and the failure surfaces as opaque 401/403s on the
first tool call — exactly the pattern that stalled turmeric Phase 4.

### Added

- **`mcp_env_passthrough` check in `bin/ace-doctor`.** For each entry
  in `.mcp.json`, parses the referenced `.ts`/`.js` source, detects the
  dotenv + `CLAUDE_PLUGIN_DATA` pattern, and WARNs if the `.mcp.json`
  env block for that server omits `CLAUDE_PLUGIN_DATA`. Verified it
  catches the pre-0.5.7 `ace-ocs` state and passes on current main.

### Why

0.5.7 fixed one instance of the bug; 0.5.9 prevents the next one.
Any future MCP server that hits this pattern (e.g. a new `ace-foo`
subprocess reading a new secret from `.env`) is flagged by
`/ace:doctor` before the operator hits an opaque 401 in production.

## 0.5.8 — 2026-04-20

Adoption-blocker follow-through: the env-drift class closed in 0.5.4
left one unaudited subclass — `.env.tpl` declaring variables that no
code actually reads. Operators went through the ceremony of injecting
them and pasting them into `.env` for no runtime benefit. This release
deletes the dead vars, reframes the bootstrap output to keep 1Password
as the source of truth, drops `.env.example` (redundant with `.env.tpl`),
and adds a class-level preventer so future dead-var additions get
caught automatically.

### Removed

- **4 dead environment variables deleted from `.env.tpl`.** None of
  these had any consumer in `mcp/`, `lib/`, `scripts/`, `skills/`,
  `bin/`, `hooks/`, `agents/`, `commands/`, or `test/`:
  - `OCS_GOLDEN_TEMPLATE_PUBLIC_ID` — printed by bootstrap and pasted
    into `.env` per README, but the per-opp `ocs-agent-setup` skill
    retrieves its own public_id via `ocs_get_chatbot_embed_info` after
    cloning. The golden template's value was never used at runtime.
  - `OCS_GOLDEN_TEMPLATE_EMBED_KEY` — same pattern, same dead code
    path.
  - `OCS_PROD_TEAM_SLUG` — declared, injected from 1Password, zero
    consumers anywhere.
  - `ACE_SESSION_STATE_DIR` — declared with value `~/.ace`, but every
    consumer hardcodes `path.join(os.homedir(), '.ace', ...)` rather
    than reading this var.
- **`.env.example` deleted.** Two-file pattern (`.env.tpl` for
  `op inject`, `.env.example` for manual setup) was a holdover from
  pre-1Password setup. `.env.example` was already drifting from
  `.env.tpl` (missing `ACE_DRIVE_ROOT_FOLDER_ID` and `OCS_PROD_TEAM_SLUG`).
  `.env.tpl` is now the single canonical template.

### Added

- **`bin/ace-doctor` `unused_env_keys` check.** For each `KEY=` in
  `.env.tpl`, greps `mcp/ lib/ scripts/ skills/ bin/ hooks/ agents/
  commands/ test/` for consumers. WARNs with the list of keys that
  have no code consumer, and the fix hint ("drop them from .env.tpl,
  or wire them into a consumer"). Informational (WARN) — dead vars
  don't break the install, they just add first-run friction. Class-
  level preventer, so future template additions without a real
  consumer get surfaced automatically.

### Changed

- **Bootstrap output reframed: 1Password is source of truth, not
  local `.env`.** `scripts/bootstrap-ocs-golden-template.ts` no
  longer prints "Add to your ACE .env:" with paste-this values.
  Instead it prints the two commands operators should actually run:
  `op item edit "ACE - Open Chat Studio" "Config.golden_template_id[text]=<new_id>" --vault AI-Agents` to update the vault, then `op inject -i .env.tpl -o ~/.claude/plugins/data/ace-ace/.env` to regenerate the local `.env`. Closes the drift hole the 2026-04-20 "vault values are hypotheses too" learning identified: a pasted value silently reverts on the next `op inject` if the vault wasn't updated in lockstep.
- **README First-Run step 6** and
  **`commands/ocs-bootstrap-template.md`** updated to match the new
  bootstrap output. First-run walkthrough now has a coherent single
  workflow (update vault, re-inject, reload) instead of two
  contradictory ones (paste to `.env` + also re-inject rewrites
  `.env`).
- **`playbook/integrations/ocs-integration.md`** now points at
  `.env.tpl` instead of the deleted `.env.example`.

### Why

The 2026-04-20 adoption-blockers cycle closed the "keys declared in
`.env.tpl` but missing from the installed `.env`" class via a doctor
diff (`env_drift`). What wasn't audited: the inverse class — keys in
`.env.tpl` that are dead cruft. A fresh install's first-run
walkthrough currently tells the operator to paste three values into
`~/.claude/plugins/data/ace-ace/.env` after bootstrap. Two of those
three are never read anywhere. The third (`OCS_GOLDEN_TEMPLATE_ID`)
would silently revert on the next `op inject` because `.env.tpl`
declares it as an `op://` reference. Fixing all three sources of
friction in one release keeps the story coherent.

## 0.5.7 — 2026-04-20

Silent auth failure caught during turmeric Phase 4 resume: every
`ace-ocs` tool call returned 401 with an empty Bearer token. Root
cause: the `.mcp.json` entry for `ace-ocs` had no `env:` block, so the
subprocess didn't inherit `CLAUDE_PLUGIN_DATA`. `ocs-server.ts` uses
that var to locate the `.env` holding `OCS_API_TOKEN`; without it,
dotenv silently fell back to `./.env` (wrong cwd) and the token came
back `undefined`. `ace-gdrive` worked because its `env:` block
substitutes `${CLAUDE_PLUGIN_DATA}` at spawn time.

### Fixed

- **`.mcp.json` now passes `CLAUDE_PLUGIN_DATA` through to `ace-ocs`.**
  One-line env-block addition so the OCS MCP subprocess can locate
  `$CLAUDE_PLUGIN_DATA/.env` the same way `ocs-server.ts` expects.
  Existing `.env` content (managed by `op inject` via `.env.tpl`) is
  unchanged.

### Why

Every future resume that hits Phase 4 without this fix would have
stalled the same way, with the only tell being a 401 response buried
in tool-call output and no clear diagnostic. Single-line fix; no
surface area other than that one MCP subprocess's env.

## 0.5.6 — 2026-04-20

Move `llo-invite` from Phase 3 (Connect Setup) to Phase 5 (LLO
Management) as the first step. Don't commit to an invite roster or
burn a review-mode gate on one before the OCS chatbot has cleared its
deep-eval quality gate in Phase 4. The 5 review gates stay at 5 —
`llo-invite`'s gate just shifts its placement inside the sequence.

### Changed

- `agents/connect-setup.md` — drop `llo-invite` from skills + workflow.
- `agents/llo-manager.md` — add `llo-invite` as Step 1 (monitoring
  renumbered to Step 5).
- `agents/ace-orchestrator.md` — state.yaml schema example, gate
  description, phase summaries updated.
- `lib/artifact-manifest.ts` — move `connect-setup/invites.md` and
  `gate-briefs/llo-invite.md` from `connect` phase to `operate`.
- `skills/llo-invite/SKILL.md` — rewrite preamble + gate-brief context
  + changelog entry.

### Compat

Artifact paths kept as `connect-setup/invites.md` and
`gate-briefs/llo-invite.md` (not renamed) so existing opps don't
orphan their prior invite files. Only the manifest phase attribution
changes. ace-web picks up the new placement automatically on next
deploy via the dynamic skill registry (no ace-web code change).

## 0.5.5 — 2026-04-20

Follow-up to 0.5.4: `.env.tpl` itself had a 1Password reference
`op inject` couldn't parse, which meant 0.5.4's new `env_drift` WARN
directed users at a command that always failed. This release patches
the template so the hint actually works.

### Fixed

- **`.env.tpl` `OCS_API_TOKEN` reference now uses item UUID.** The
  original reference `op://AI-Agents/ACE - OCS REST API Key
  (connect-ace)/credential` has parentheses in the item name, which
  `op inject`'s parser silently truncates at (`invalid secret
  reference 'op://AI-Agents/ACE - OCS REST API Key': too few '/'`).
  Percent-encoding does not help. UUID-based reference
  `op://AI-Agents/ccfc36cyidvecda5tzhseuouie/credential` resolves
  cleanly. Inline comment in the template explains the tradeoff.

### Why

0.5.4 shipped the `env_drift` WARN with a `op inject -i .env.tpl -o ...`
fix hint. First operator to follow the hint (the author, right after
shipping 0.5.4) hit the opaque `invalid secret reference` error. The
adoption-blockers lens had correctly identified the class but missed
the hint itself was unreachable.

## 0.5.4 — 2026-04-20

Adoption-blocker cleanup: close the `.env` drift class that silently
broke 0.5.3's smart-default PDD picker on any install that hadn't
re-injected `.env` since the var was added.

### Added

- **`bin/ace-doctor` env-drift diff.** New `env_drift` check diffs the
  `KEY=` set in the installed `.env` against `.env.tpl` and WARNs on
  any key present in the template but absent from the install. Fix
  hint emits the exact `op inject` command. Catches every future
  `.env.tpl` addition automatically, not just today's.
- **`bin/ace-doctor drive_root` check.** Explicit WARN when
  `ACE_DRIVE_ROOT_FOLDER_ID` is unset — the variable 0.5.3's
  smart-default PDD picker depends on.
- **`bin/ace-doctor ocs_shared_collection` check.** Explicit WARN when
  any of `OCS_SHARED_COLLECTION_ID`, `OCS_LLM_PROVIDER_ID`, or
  `OCS_EMBEDDING_MODEL_ID` is unset — the triple per-opp bot clones
  need for Connect-knowledge RAG (2026-04-20 P1 backlog).

### Changed

- **`/ace:run` PDD picker fails loudly on missing
  `ACE_DRIVE_ROOT_FOLDER_ID`** rather than silently falling through
  to the inline/paste fallback. `agents/ace-orchestrator.md` §
  Starting a New Opportunity step 2(c).0 now stops with an actionable
  error pointing at `op inject` (or `--idea FILE|-` to bypass).
- **README First-Run Walkthrough + Quick Start + `/ace:doctor` next-step
  hint** updated to zero-arg `/ace:run` as the primary example,
  matching the 0.5.3 smart-default flow.

### Why

On 2026-04-20 the installed `.env` on the author's machine was missing
8 keys from `.env.tpl`, including `ACE_DRIVE_ROOT_FOLDER_ID` (required
by 0.5.3) and the shared-collection triple (required for post-clone
RAG). Doctor reported `STATUS: COMPLETE` regardless — it only
validated 3 of 16 keys. Any admin who injected `.env` before these
vars were added hits silent failures on the happy path: the picker
falls through with no signal of why, and per-opp bots publish with
empty RAG. Doctor is the one place that catches this preventively;
the use-site pre-flight catches it at invocation time for operators
who skip doctor.

## 0.5.3 — 2026-04-20

Feature: `/ace:run` smart defaults — zero-arg happy path.

### Added

- **Auto-generated slug** when `<opp-name>` is omitted:
  `smoke-<YYYYMMDD-HHMM>`. Lets `/ace:run` (no args) do the right
  thing in a throwaway-smoke context.
- **Auto-discover PDD on Drive** when `--idea` is not provided. The
  orchestrator's "Starting a New Opportunity" flow now lists files in
  the PDDs folder under `ACE_DRIVE_ROOT_FOLDER_ID`, sorts by
  slug-stem match + recency, and presents the top 5 via
  `AskUserQuestion`. Confirmation is always required (even with a
  single match) to guard against domain-mismatched PDDs.
- **`--ace-web-url` default** to `https://labs.connect.dimagi.com/ace`
  when `ACE_E2E_AUTH_TOKEN` is set in the environment. Skipped
  silently when the env var is absent (so local-only dev still works).
  Explicit `--ace-web-url ''` force-disables.

### UX

`/ace:run` (zero args) now picks a sensible slug, asks the operator
to pick a PDD from Drive, and uploads the transcript to labs if the
E2E token is present. One command end-to-end.

## 0.5.2 — 2026-04-20

Docs: PM run log for the 2026-04-20 collection-clone-and-mcp-preflight
cycle (`.claude/pm/runs/2026-04-20-collection-clone-and-mcp-preflight.md`).
Covers the Path C cross-team verification, Iter 8 subagent clone of
collection 135 (ccc-support) → 350 (connect-ace), and the 0.5.1 MCP
pre-flight + upload-chunking fixes. Appends four durable preferences to
`learnings.md`: OCS team-scoping enforcement, pipeline-save dual error
shapes, metadata files as hypotheses, and Django form silent-accept
failure modes. Two canopy-skills self-improvement candidates noted
inline.

No code changes.

## 0.5.1 — 2026-04-20

MCP robustness: `publishChatbotVersion` pre-flight + `uploadCollectionFiles`
chunk-params. Both fixes surfaced during Iter 8 of the cosmetics-fgd-pilot
iteration loop (the collection-clone from ccc-support → connect-ace).

### Fixed

- **`publishChatbotVersion` now pre-flights the pipeline.** Before hitting
  `/versions/create`, the backend round-trips the current graph through
  `/pipelines/data/<pid>/` to surface any node-level validation errors.
  This catches the entire silent-publish-block class of bug — where Django
  re-renders the version form with HTTP 200 and no errorlist because the
  errors originated on the pipeline, not the version form. Before this
  fix, the only signal was the opaque "form re-rendered without redirect"
  message. Now the caller gets a real `PipelineValidationError` naming
  the exact node and field that broke.
- **`extractPipelineErrors` helper** handles the two observed response
  shapes: top-level string array (`{ errors: ["..."] }`) and nested
  per-node (`{ errors: { node: { "<id>": { "<field>": "<msg>" } } } }`).
  The nested shape is what hid the 2026-04-19 phantom-collection bug —
  the top-level array was empty while the real error lived under
  `errors.node.LLMResponseWithPrompt-*.collection_index_ids`.
  `patchLlmNodeParams` now uses the same extractor (previously it only
  checked the top-level shape).
- **`uploadCollectionFiles` sends `chunk_size` + `chunk_overlap`.**
  Django's `add_collection_files` form requires these. Omitting them
  caused a "successful" upload (form validated, file accepted) with zero
  chunks produced — retrieval silently never worked. Defaults 800/400
  match the upstream NM Bot collection source. Tool schema exposes
  both as optional overrides. Invalid values (overlap ≥ size) throw
  before the HTTP call.

### Why

The first defense was in `scripts/bootstrap-ocs-golden-template.ts`
(0.4.4). That caught the specific case of `OCS_SHARED_COLLECTION_ID`
pointing at a missing collection. This is the generalization: the MCP
layer now refuses to publish any pipeline with validation errors,
regardless of source. Covers `ocs-agent-setup`'s per-opp bot creation,
future collection swaps, manual pipeline edits through the UI, and
anything else that could leave the pipeline in a published-but-invalid
state. Item 2 of the prior backlog ("ocs-agent-setup pre-flight") is
redundant with this and is dropped from the backlog.

### Tests

- 12 new tests: 4 for `extractPipelineErrors` (null/empty/string-array/
  nested/non-string-value), 3 for `validatePipeline` (happy path,
  nested errors, GET failure), 1 for `patchLlmNodeParams` nested-errors,
  2 for `uploadCollectionFiles` chunk-params (custom values, validation
  error), 1 for `publishChatbotVersion` pre-flight blocking, 1
  regression for the existing publish-failure path.
- All 89 tests pass (up from 77).

## 0.5.0 — 2026-04-20

Feature: scripted end-to-end runs with optional ace-web transcript upload.

### Added

- **`/ace:run --idea FILE|-`** — pre-seed `idea.md` from a file path or
  stdin, skipping the interactive `AskUserQuestion` prompt in the
  "Starting a New Opportunity" flow. Enables fully non-interactive
  lifecycle runs (smoke tests, CI-style invocations, scripted demos).
- **`/ace:run --ace-web-url URL`** — after the orchestrator returns,
  upload the run's stream-json transcript to `<URL>/api/ingest/upload`
  so the deployed ace-web can render it as a chat Session. Requires
  `ACE_E2E_AUTH_TOKEN` in the environment. No-op if the flag is absent;
  the plugin remains standalone.
- **`skills/upload-transcript/`** — new skill encapsulating the
  e2e-login + `/api/ingest/upload` flow. Invoked by `--ace-web-url`;
  can also be called directly for ad-hoc transcript uploads.

### Rationale

Part of the ace-web drop-multi-run refactor. The two new flags let us
retire three turmeric-specific bash setup scripts
(`turmeric_cli_setup.sh`, `turmeric_auth_login.sh`,
`turmeric_auth_check.sh`) in favor of generic, composable primitives.
See ace-web `docs/plans/2026-04-20-drop-multi-run-simplify.md`.

## 0.4.5 — 2026-04-19

Docs: PM run log for the 2026-04-19 qa-eval-iteration-loop cycle
(`.claude/pm/runs/2026-04-19-qa-eval-iteration-loop.md`). Covers Iters
1/3/6/7 (PRs #33/#34/#35/#36, versions 0.4.1–0.4.4) + the 0.3.5 qa/eval
split + 0.4.0 umbrella opp-eval skill as the foundation. Meta-observations,
confidence levels, backlog priorities, and three canopy-skills
self-improvement candidates. Appends five durable preferences to
`learnings.md` and fixes stale agent/skill/command counts in `context.md`.

No code changes.

## 0.4.4 — 2026-04-19

Fix: `bootstrap-ocs-golden-template.ts` now validates
`OCS_SHARED_COLLECTION_ID` exists on the team before attaching.

### Fixed

- **Golden template silent-publish bug.** The 2026-04-19 iteration loop
  discovered that the live golden template (experiment 11792) was
  stuck at v1 (empty post-clone state) and serving vanilla-LLM responses
  — scored 3.84/10 FAIL on `ocs-chatbot-qa --quick`. Root cause:
  `OCS_SHARED_COLLECTION_ID` pointed at collection id 718, which did
  not exist on the `connect-ace` team. The clone's `ocs_attach_knowledge`
  call silently succeeded at the pipeline-patch layer, but then blocked
  every subsequent `publishChatbotVersion` attempt with the opaque UI
  message *"Unable to create a new version when the pipeline has
  errors."* The draft ended up correctly configured, but v1 stayed the
  default version forever and the embedded widget served a bare LLM.
- **Fix**: pre-flight validate that the configured
  `OCS_SHARED_COLLECTION_ID` exists on the team before attaching. Skip
  attachment with a loud, actionable warning if missing. Prevents the
  silent publish-block from reoccurring when
  `/ace:ocs-bootstrap-template` is run with a stale env var.
- **Side effect of the fix**: golden template re-published with the
  canonical system prompt (PDD not IDD, `ace@dimagi-ai.com`,
  emoji-discouraged tone guidance). Score went from **3.84/10 FAIL**
  → **8.2/10 PASS**. Remaining `[WARN]`: `source_usage: 5.0` because no
  Connect shared knowledge collection exists on team `connect-ace`
  (team-infrastructure work, backlogged).

### Backlogged (from this fix)

- OCS MCP: add `ocs_list_collections` — `bootstrap-ocs-golden-template.ts`
  had to scrape the edit page because the REST API doesn't expose it.
- OCS MCP: `publishChatbotVersion` should pre-flight POST the current
  graph through `/pipelines/data/` first and surface any
  `errors.node` entries as a `PipelineValidationError` before attempting
  version creation. The silent-publish-block bug above was hidden by
  exactly this gap.
- `ocs-agent-setup` SKILL: add a pre-flight check on
  `OCS_SHARED_COLLECTION_ID` — every clone the skill produces hits the
  same silent-block risk.
- `$CLAUDE_PLUGIN_DATA/.env` mismatch: once a real Connect shared
  knowledge collection is created on team `connect-ace`, set
  `OCS_SHARED_COLLECTION_ID`, `OCS_LLM_PROVIDER_ID`,
  `OCS_EMBEDDING_MODEL_ID` — they're documented in
  `ocs-chatbot-qa` / `ocs-agent-setup` but not currently in the env.

## 0.4.3 — 2026-04-19

Contract cleanup + orchestrator hardening, all surfaced from the
first real-content exercise of the 0.3.5 qa/eval split and the 0.4.0
opp-eval aggregator.

### Changed

- **Verdict YAML contract formalized.** `skills/README.md § QA vs Eval`
  now declares `per_item:` as the canonical per-item list key (skills
  previously drifted between `per_prompt` and `per_item`). Each entry
  may carry domain-specific subkeys (e.g., `prompt:` for chatbot evals,
  `session_id:` for FGD evals) but the canonical identifier key is
  `ref`. Aggregators read by `ref` and ignore domain extras.
- **`auto_surfaced:` is now an optional top-level verdict field.**
  Promoted from eval-skill-local to framework-level so opp-eval can
  concatenate auto-surfaced lines from every per-skill verdict into the
  run-level brief. `ocs-chatbot-eval` already emitted this block; now
  it's contract.
- **`ocs-chatbot-eval` aligned to canonical keys.** `per_prompt` →
  `per_item` with `prompt:` as a domain-specific subkey inside each
  entry.
- **qa/eval split golden-template fallback.** Both `ocs-chatbot-qa`
  and `ocs-chatbot-eval` now document `ACE/golden-template/` as the
  canonical path root for no-opp runs. Previously the qa skill said
  "stdout" and the eval skill said "fail loudly if missing" — hard
  break on any template smoke test.
- **`ocs-chatbot-qa` env-source explicit.** Env vars like
  `OCS_GOLDEN_TEMPLATE_ID` live at `$CLAUDE_PLUGIN_DATA/.env`, not the
  shell env. Step 1 now says this so programmatic dispatches can find
  them.
- **`ocs-chatbot-qa` transport guidance.** The MCP tool
  `ocs_send_test_message` returns only `response` and misses the
  `cited_files` / `tags` / `session_id` / `elapsed_ms` that the
  transcript schema needs. Step 3 (raw widget HTTP) is load-bearing;
  the skill now explicitly warns against substituting the MCP tool.
- **`opp-eval` quick-mode scorecard template** now renders the
  `Unexpected:` row (skill was already finding unexpected files, the
  template just hadn't shown them), tightens Notes wording with
  concrete examples, and specifies the stdout summary format
  including unexpected count.
- **Orchestrator state-schema example** upgraded from abstract to
  concrete, covering all 6 phases with the qa/eval split step keys
  (`ocs-chatbot-qa-{quick,deep,monitor}` +
  `ocs-chatbot-eval-{quick,deep,monitor}`). Previously the example
  stopped at `design-review > idea-to-pdd`.
- **Orchestrator: defensive `state.yaml` init on bypass paths.** New
  `§ Touching State` subsection documents the rule: every entry path
  that touches state must tolerate a missing `state.yaml` and
  initialize it first. `/ace:step` owns the defensive init for its
  path (covered in `commands/step.md`).
- **`/ace:step` step 4** upgraded to ensure-then-update: initialize
  `state.yaml` from the orchestrator schema if missing, then set
  `last_actor` + `last_actor_at`. This closes the bug I hit myself in
  the cosmetics-fgd-pilot iteration loop where I bypassed `/ace:run`
  and the opp never got a state file.

### Why

This whole set was surfaced by Iter 4 + 5 of the iteration loop —
running `ocs-chatbot-qa` + `ocs-chatbot-eval` against the golden
template and `opp-eval --quick` against the partial cosmetics-fgd-pilot
opp. Rubrics, contracts, and orchestrator assumptions all held up
under load *except* at these seams. Each fix is surgical; none change
behavior for existing opps that went through `/ace:run`.

## 0.4.2 — 2026-04-19

Iteration-loop polish: `llo-invite` now archetype-aware.

### Changed

- **`llo-invite` is now archetype-aware.** Added `## Archetypes` section.
  `atomic-visit` retains geographic + capacity criteria. `focus-group`
  shifts selection to qualitative research experience (or training
  willingness), language/cultural fit for sensitive topics,
  audio-recording capability, facilitator time budgeting, and a
  **small-N bias** (1–2 LLOs, not 3–5). A weaker LLM recruiting FGD
  LLOs against the old prompt would likely pick by "geographic match"
  alone and miss facilitation fit.
- **Gate brief** gains an FGD-specific WARN: flags when count > 2
  without multi-site justification, or when rationale is silent on
  facilitation capability.
- **Archetype-aware skill count** 8 → 9 in `skills/README.md`.

### Why

Backlog item P2 from the cosmetics-fgd-pilot recon. Field-level
enforcement (gate brief WARNs) ensures the shift lands even under
weaker dispatches.

## 0.4.1 — 2026-04-19

Iteration-loop polish shaken out of the cosmetics-fgd-pilot Phase 1
reconnaissance run.

### Changed

- **`pdd-to-test-prompts` is now archetype-aware.** Added `## Archetypes`
  section with per-archetype category lists: `atomic-visit` keeps
  visit-flow / eligibility / GPS / duplicate-handling; `focus-group`
  gets session-flow / recruitment-and-venue / consent-and-recording /
  question-guide-sequencing / facilitation-technique / output-spec /
  audio-and-evidence; `multi-stage` mixes per-stage and adds a
  stage-gate-transition category. Previously the skill was atomic-visit-
  worded throughout its examples, forcing LLMs running the skill against
  an FGD PDD to remap categories on the fly — a weak-signal failure mode
  where a less-grounded run would produce atomic-visit prompts that then
  fail in the `ocs-chatbot-eval --deep` gate as false-positives.
- **Archetype-aware skill count** updated from 7 to 8 in
  `skills/README.md`.

### Why

Surfaced during the cosmetics-fgd-pilot Phase 1 reconnaissance
(2026-04-19). The subagent running the skill had to manually remap every
category — "home visit" → "session flow", "GPS per delivery" → "audio
duration ≥ 45 min", "photo validity" → "product-photo standardization
+ attendance photo". The manual remapping worked, but a weaker LLM
without that context-inference ability could easily miss it.

## 0.4.0 — 2026-04-19

Umbrella eval agent — the "one overview judge/review agent that we
can apply to overall runs" capability that was missing. opp-eval
aggregates every per-skill `-eval` verdict for an opportunity into a
single run-level scorecard and drafts improvement recommendations.
Minor bump because this adds a new user-visible capability (new skill,
new slash command) on top of the 0.3.5 qa/eval split.

### Added

- **New skill: `opp-eval`.** Umbrella judge. Three modes:
  - `--quick` — structural artifact check only (walk the manifest,
    confirm every required non-dated artifact for the opp's current
    phase exists in Drive). No LLM cost.
  - `--deep` — structural check **plus** aggregation: walks every
    `verdicts/*.yaml` file in the opp folder, rolls scores into 6
    skill-category dimensions (design, commcare, connect, ocs,
    operate, closeout) with renormalized weights when categories are
    empty, classifies a run-level verdict (pass ≥ 7 / warn 4–6 /
    fail < 4), and drafts improvement recommendations for every
    `warn`/`fail` verdict and every dimension scoring < 6.0.
  - `--monitor` — same as `--deep` plus appends a one-liner to
    `scorecards/trend.md` for run-over-run drift visibility.

  Writes `scorecards/YYYY-MM-DD-opp-eval-<mode>.md` (human),
  `verdicts/opp-eval-<mode>.yaml` (machine, uniform verdict shape from
  `skills/README.md § QA vs Eval`), and `gate-briefs/opp-eval-deep.md`
  (advisory; does not gate a phase today — contract uniformity so
  future automation can consume it without a special case). YAML
  parsing tolerates missing fields — surfaces gaps as `[INFO]` notes
  rather than crashing, since partial opps are explicitly supported.

- **New slash command: `/ace:eval <opp-name> [--mode
  quick|deep|monitor]`.** Thin wrapper that dispatches to the
  `opp-eval` skill. See `commands/eval.md`.

- **7 new manifest entries in `lib/artifact-manifest.ts`.**
  `scorecards/YYYY-MM-DD-opp-eval-{quick,deep,monitor}.md`,
  `scorecards/trend.md`, `verdicts/opp-eval-{deep,monitor}.yaml`,
  `gate-briefs/opp-eval-deep.md`. All `required: false` (opp-eval is
  opt-in, not part of the default 6-phase pipeline), all tagged
  `phase: closeout`.

- **`skills/README.md § QA vs Eval` canonical-examples list.**
  opp-eval added as the canonical **umbrella eval** example, distinct
  from per-skill `-eval` skills.

- **`agents/ace-orchestrator.md § Umbrella Eval`.** New section
  explaining that opp-eval is ad-hoc (not part of `--mode review`
  auto-pause), does not gate any phase, and automatically picks up
  new per-skill verdicts via directory discovery as rubric work
  lands on the rest of the skills.

### Why this release

The 0.3.5 qa/eval split established the uniform `verdicts/<skill>-<mode>.yaml`
contract that every future `-eval` skill will write. That set up
opp-eval to exist: an aggregator that reads the verdicts/ directory
without per-skill knowledge. Today only `ocs-chatbot-eval` writes
verdicts; opp-eval emits `[INFO]` notes for skills without rubrics —
which is the forcing function that motivates future rubric work
across the other 22 skills. The recommendations feature directly
answers the operator's original ask ("make its own recommendations on
how to improve") without redesigning per-skill judges.

## 0.3.5 — 2026-04-19

QA/Eval split refactor — establishes the two-phase evaluation contract
that future `-eval` skills and the umbrella `opp-eval` agent will follow.

### Added

- **New skill: `ocs-chatbot-eval`.** Split out from `ocs-chatbot-qa` as
  the judge half of the qa/eval pair. Reads a captured transcript from
  `qa-captures/`, runs the 4-dimension LLM-as-Judge rubric, writes a
  machine-readable verdict YAML to `verdicts/`, a human-readable report
  to `eval-reports/`, and (for `--deep` mode) the Phase 4→5 gate brief.
  Three modes (`--quick` / `--deep` / `--monitor`) mirror the qa skill
  so each capture has a matching judgment pass.
- **`skills/README.md § QA vs Eval — the two-phase pattern`.** Codifies
  the separation: `-qa` skills exercise the artifact and produce
  structured evidence (transcript, audio capture, structural checks);
  `-eval` skills read evidence and apply LLM-as-Judge. Includes the
  uniform artifact-path contract (`qa-captures/`, `verdicts/`,
  `eval-reports/`, `gate-briefs/`) and the shared verdict-YAML shape
  that future `-eval` skills and the umbrella `opp-eval` aggregator
  will consume.
- **6 new manifest entries.** `qa-captures/YYYY-MM-DD-ocs-chat-{quick,deep,monitor}.md`
  (produced by `ocs-chatbot-qa`, consumed by `ocs-chatbot-eval`);
  `verdicts/ocs-chatbot-eval-{quick,deep,monitor}.yaml` and
  `eval-reports/YYYY-MM-DD-ocs-eval.md` + `eval-reports/trend.md`
  (produced by `ocs-chatbot-eval`).
- **New gate-brief path.** `gate-briefs/ocs-chatbot-eval-deep.md`
  (renamed from `ocs-chatbot-qa-deep.md`; the gate sits on the
  judgment, not the capture).

### Changed

- **`ocs-chatbot-qa` slimmed to capture + structural checks.** No more
  LLM-as-Judge. Writes to `qa-captures/` and returns structural pass
  rate. Modes (`--quick` / `--deep` / `--monitor`) now describe suite
  size only; judgment depth is the eval skill's responsibility.
- **Consumers dispatch qa → eval pairs.** `agents/ocs-setup.md` (Phase
  4 Steps 2 and 3), `agents/llo-manager.md` (recurring monitor), and
  `agents/ocs-tester.md` now invoke the capture skill and the judge
  skill as a pair. `agents/ace-orchestrator.md`'s gate-brief list
  updated to point at `ocs-chatbot-eval-deep.md`.
- **`state.yaml` step keys split.** Phase 4 now tracks
  `ocs-chatbot-qa-{quick,deep}` and `ocs-chatbot-eval-{quick,deep}`
  separately; Phase 5 recurring adds `ocs-chatbot-eval-monitor`. Gate
  renamed from `ocs-chatbot-qa-deep` → `ocs-chatbot-eval-deep`. Fixtures
  `CRISPR-Test-001` and `CRISPR-Test-003-Turmeric` updated to the new
  schema. Older fixtures without the split keys still parse; the next
  skill invocation adds them.

### Why this refactor

Decoupling lets us re-grade an old transcript when a rubric improves
without re-chatting with the bot; lets a human-captured evidence
artifact (FGD audio + notes) flow through the same `-eval` machinery as
a machine-captured one; and establishes the uniform verdict-YAML shape
that the upcoming umbrella `opp-eval` agent will aggregate across every
skill's judgment.

## 0.3.3 — 2026-04-17

Admin-group coordination polish based on an internal-Dimagi-users scout.
Targets the seams between the 6-phase pipeline and a 5-person admin group
(Matt, Neal, Jon, Sarvesh, Cal) who will run multiple opportunities in
parallel: triage legibility, hand-off attribution, and gate-review
context. All three changes are state-schema + command spec edits; no
runtime code changes.

### Added

- **`/ace:status` computes per-opp status tags.** List view now derives
  one of `ACTION NEEDED` / `RUNNING` / `IDLE` / `ERROR` / `DONE` per opp
  from `state.yaml` (gate pending, step error, recurring-only remaining,
  etc.) and sorts `ACTION NEEDED` to the top. Adds a `Blocked on`
  column (`gate: <name>` / `error: <skill>` / `input: <file>`) so an
  admin sees next-action without opening the opp. `--mine` filters to
  the current operator's `git config user.email`; `--all` shows `IDLE`
  and `DONE`. `Mode` column drops from the default view. See
  `commands/status.md`.
- **Operator identity in `state.yaml`.** New fields `initiated_by`,
  `last_actor`, `last_actor_at` — all emails, ISO-timestamped. Set once
  at opp creation (`initiated_by`), updated on every skill invocation
  (`last_actor` / `last_actor_at`) by both `/ace:run` and `/ace:step`.
  Pulls from `git config user.email`; falls back to `unknown` if unset.
  Drives `/ace:status`'s "last touched by X, N days ago" column and
  `--mine`. See `agents/ace-orchestrator.md § State Schema` and
  `§ Touching State — Operator Capture`.
- **Gate-brief contract.** Each of the 5 review-mode gates now has a
  uniform brief at `ACE/<opp-name>/gate-briefs/<gate-name>.md` produced
  by the gate-owning skill before the orchestrator pauses. Required
  shape: artifact under review (path + one-line summary), what-to-check
  checklist (3–5 imperative items), auto-surfaced concerns tagged
  `[BLOCKER]` / `[WARN]` / `[INFO]`, and a recommended disposition.
  Orchestrator must read the brief and display it verbatim before any
  `AskUserQuestion` approval prompt; missing brief = fail loudly. 5
  skills emit briefs: `idea-to-pdd`, `app-deploy`, `ocs-chatbot-qa`
  (only in `--deep` mode), `llo-invite`, `llo-launch`. See
  `agents/ace-orchestrator.md § Gate Brief Contract` and each skill's
  new `## Gate Brief` section.
- **5 new required artifacts in `lib/artifact-manifest.ts`.** One entry
  per gate brief, each consumed by `ace-orchestrator`. `CRISPR-Test-003-Turmeric`
  ships stub gate briefs for all 5; `CRISPR-Test-001` is a partial
  fixture and the 3 design/commcare/connect gate briefs are marked in
  `expectedMissing`.

### Changed

- **`state.yaml` schema extended.** Pre-0.3.3 fixtures without the three
  ownership fields still parse; `/ace:status` renders `Last touched:
  <unknown>, <timestamp>` for them. The orchestrator and `/ace:step`
  both add the fields on first touch. No migration script needed.

## 0.3.2 — 2026-04-16

End-to-end workflow hardening based on a core-workflow scout. Targets the gap
between "install works" (0.3.1) and "full pipeline actually runs end to end":
fixture drift, silent prerequisite failures, and phase-4-to-6 test coverage.

### Added

- **`CRISPR-Test-003-Turmeric` fixture.** Complete end-to-end test fixture
  seeded from `docs/examples/pdd-turmeric-market-survey.md` with synthetic
  stubs for every required artifact across all 6 phases. Replaces the
  "partial-fixture-only" testing posture and lets CI catch manifest drift
  in phases 4–6 (OCS, operate, closeout) that `CRISPR-Test-001` /
  `CRISPR-Test-002` can't see.
- **Artifact-manifest test spans the full lifecycle.** `artifact-manifest.test.ts`
  now validates `CRISPR-Test-003-Turmeric` `upToPhase: 'closeout'` with zero
  unexpected and zero missing required artifacts. Manifest-renames or new
  required artifacts in any phase now trip the existing `npm test` suite.
- **`/ace:step` prerequisite check.** `commands/step.md` now specifies a
  manifest-driven input check: before invoking a skill, look up
  `artifactsConsumedBy(skill)` in `lib/artifact-manifest.ts` and fail loudly
  if any required prior artifact is missing from the opportunity folder.
  Closes the silent-failure bypass path on `/ace:step ocs-chatbot-qa` (and
  anything else that depends on upstream outputs).
- **`test/fixtures/validation-2026-04-16.md`.** Fresh desk-trace of
  `/ace:run CRISPR-Test-001 --dry-run` against the current (post-0.2.0)
  6-phase orchestrator and PDD terminology. Supersedes the 2026-04-08
  validation doc.

### Changed

- **`CRISPR-Test-001/state.yaml` refreshed to the 6-phase schema.** The flat
  19-skill list predated the 0.2.0 phase restructure. Now a phases → skills
  nested map covering all 22 skills (including the three `ocs-chatbot-qa`
  modes) and the five actual review-mode gates.

## 0.3.1 — 2026-04-16

First-run UX hardening based on an end-to-end adoption-blocker scout. Targets
the specific failure modes a fresh user hits when trying to go idea → deployed
program without a Dimagi engineer on the line.

### Added

- **Orchestrator captures `idea.md` before Phase 1.** `ace-orchestrator.md`'s
  "Starting a New Opportunity" section now checks for `ACE/<opp-name>/idea.md`
  and prompts the user for the brief (inline paste or Drive URL) if it's
  missing. No more silent failure or improvised ideas when `/ace:run` starts
  with an empty folder.
- **`idea-to-pdd` fail-fast error.** If the skill runs via `/ace:step` without
  `idea.md` present, it now stops with an actionable error pointing at
  `/ace:run` or explicit file creation — it no longer invents an idea.
- **README first-run walkthrough.** New section in `README.md` with the full
  ordered first-run checklist: install → setup → GWS key → `op inject` .env
  → `/ace:ocs-login` → `/ace:ocs-bootstrap-template` → `/ace:doctor` →
  `/ace:run --dry-run`.
- **`/ace:doctor` runtime readiness checks.** `bin/ace-doctor` now also
  checks (WARN-level) for `.env` presence, `OCS_BASE_URL` /
  `OCS_TEAM_SLUG` / `OCS_GOLDEN_TEMPLATE_ID`, `ACE_GMAIL_ACCOUNT`, and a
  `~/.ace/ocs-session-<team>.json` session file (with a > 30 days old
  freshness warning). Unresolved `op://…` references are treated as
  missing. Each warning includes a concrete fix hint.

### Fixed

- **Stale architecture counts in README.** `6 agents` / `21 skills` →
  `8 agents` / `22 skills`; phase agent list updated to the current 6
  phases.

## 0.3.0 — 2026-04-15

**Breaking rename:** "Intervention Design Document" / IDD is now "Program
Design Document" / PDD everywhere — full phrase, acronym, filename
(`idd.md` → `pdd.md`), skill names, docs, fixtures, and manifest entries.

### Changed

- **Four skills renamed:** `idea-to-idd` → `idea-to-pdd`,
  `idd-to-learn-app` → `pdd-to-learn-app`, `idd-to-deliver-app` →
  `pdd-to-deliver-app`, `idd-to-test-prompts` → `pdd-to-test-prompts`.
  Any external callers referencing these names must be updated.
- **Opportunity artifact renamed:** `ACE/<opp-name>/idd.md` →
  `ACE/<opp-name>/pdd.md`. Likewise `closeout/new-idd.md` →
  `closeout/new-pdd.md`. Done now while no opportunities are mid-flight.
- **Template + examples renamed:** `templates/idd-template.md` →
  `pdd-template.md`; `docs/examples/idd-*.md` → `pdd-*.md`;
  `test/sample-idd.md` → `sample-pdd.md`;
  `test/eval/sample-idds/` → `sample-pdds/`; fixture `idd.md` → `pdd.md`.
- **Agent frontmatter updated** to reference the new skill names
  (`design-review` and `commcare-setup`).
- Section headings inside PDDs that describe the *content* (e.g.
  `## Intervention Design` — a section that documents how the intervention
  works) are preserved; only document-name references were renamed.
- Historical session logs in `.claude/pm/` are left intact — they record
  what happened at a point in time and shouldn't be rewritten.

## 0.2.1 — 2026-04-14

Phase metadata moved into agent frontmatter. Each phase agent now declares
its phase name, display name, ordinal position in the lifecycle, and the
ordered list of skills it orchestrates. This is the structured twin of the
existing Workflow prose, and is consumed by external tools (e.g. ace-web's
System Overview tab) that need to reason about the pipeline without parsing
markdown.

Also clarifies that every skill is human-reviewable — the previous implicit
"gate" concept was misleading. Review-mode human approval is available on
every step, not just a few.

### Added

- `phase`, `phase_display`, `phase_ordinal`, and `skills` frontmatter on
  the six phase agents (`design-review`, `commcare-setup`, `connect-setup`,
  `ocs-setup`, `llo-manager`, `closeout`). `llo-manager` additionally
  declares `recurring_skills` for `timeline-monitor` and `flw-data-review`.
- Each skill entry declares `has_judge` and `primary_output`.

### Changed

- The orchestration data model no longer distinguishes "gate skills" from
  non-gate skills.

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
  `idea-to-pdd` + new `pdd-to-test-prompts`) and `commcare-setup`
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

- **`pdd-to-test-prompts` skill** (Phase 1 Step 2) — derives opp-specific
  Q&A pairs with expected-answer summaries from the PDD. Produces
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
  fixtures with idea, PDD, state, deployment summary, and app summaries.
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
