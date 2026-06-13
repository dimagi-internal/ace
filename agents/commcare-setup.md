---
name: commcare-setup
description: >
  Phase 3 of the ACE lifecycle: translate the approved PDD into
  Learn and Deliver apps via Nova, deploy them to CommCare HQ, and test.
model: inherit
phase: commcare-setup
phase_display: CommCare Setup
phase_ordinal: 3
skills:
  - { name: pdd-to-learn-app,        has_judge: true,  eval_skill: pdd-to-learn-app-eval }
  - { name: pdd-to-deliver-app,      has_judge: true,  eval_skill: pdd-to-deliver-app-eval }
  - { name: app-connect-coverage,    has_judge: false }
  - { name: app-deploy,              has_judge: false }
  - { name: app-test-cases,          has_judge: false }
  - { name: app-release,             has_judge: true,  eval_skill: app-release-eval }
  - { name: app-release-qa,       has_judge: false }
---

# CommCare Setup (Phase 3 Procedure Document)

This file specifies Phase 3 of the ACE lifecycle: build and
deploy the CommCare-side apps.

**This file is read and executed inline by the top-level Claude Code
session — it is NOT dispatched as a subagent.** Step 1 invokes
`/nova:autobuild`, which itself dispatches `nova:nova-architect-autonomous`
via the `Agent` tool. `Agent` is only available at level 0; running
Phase 3 as a subagent would put Nova's dispatch at level 2 and fail.
See `agents/ace-orchestrator.md` § Agent Topology. The frontmatter is
retained for tooling that introspects agent metadata, not because Phase
2 is itself dispatched.

## Workflow

Execute these steps in order for the given opportunity:

### Step 0: Nova preconditions (HARD GATE — run before anything else)

Before dispatching any architect, verify Nova is bound to the expected
HQ project space. Skipping this step is the single biggest documented
time-sink in Phase 3 — see the turmeric-20260429-2330 e2e: the
architect produced apps under its own auth context that were invisible
to the user's Nova account, every `upload_to_hq` failed with "App not
found", and the apps had to be rebuilt from scratch (~30 min wasted,
plus a re-run of `validate_app`).

The architect-vs-user auth split is silent — no symptom appears until
upload_to_hq, by which point the architect has already burned its
budget. Catch it here.

#### Step 0a: Verify Nova auth liveness

Run `/ace:doctor` and confirm the `nova_auth` line passes:

    PASS nova_auth: ace-nova authed (POST initialize → HTTP 200)

If it fails:

- `nova_env: NOVA_API_KEY missing or unresolved` → operator hasn't
  minted a key yet. Mint at `https://commcare.app/settings` as the ACE
  Gmail identity, save to 1Password item `ACE - Nova` / field
  `api_key`, then run `/ace:setup --force-env`.
- `nova_auth: HTTP 401` → key invalid or revoked. Rotate at
  `commcare.app/settings`, update the 1Password item in place, then
  `/ace:setup --force-env`.
- `nova_shell_env: NOVA_API_KEY not in shell env` → operator hasn't
  sourced `~/.ace/env.sh` from their shell rc. Run the remediation
  command doctor prints (`echo 'source ~/.ace/env.sh' >> ~/.zshrc &&
  exec zsh`) and restart Claude Code so the Nova plugin re-reads the
  env.
- `nova_shell_env: stale user-scope nova: MCP override detected` →
  pre-1.1.0 setup carried over. `/ace:setup` removes it idempotently;
  if doctor still flags it, run `claude mcp remove nova --scope user`
  manually and restart Claude Code.

Halt Phase 3 until `nova_auth` and `nova_shell_env` are both green.
Authentication uses Nova plugin v1.1.0's PAT path (voidcraft-labs/nova-plugin#11
/ #13 / #16) — there is no OAuth refresh-token rotation, no per-session
sign-in, no needs-auth cache to manage, and Claude Code's
`~/.claude/.credentials.json` does not hold Nova credentials under this
path. The plugin's `headersHelper` reads `NOVA_API_KEY` from the
Claude Code parent shell's env.

#### Step 0b: Probe HQ binding

Call Nova's `get_hq_connection` (no args). Since the
voidcraft-labs/nova-plugin#12 release it returns
`{ configured, available_domains: [{ name, displayName }, …] }` — the
set of project spaces the saved HQ API key can reach (no single bound
`domain.name` anymore; a key may reach several spaces). Branch on the
result:

- `{ configured: true }` **and `<ACE_HQ_DOMAIN>` appears in
  `available_domains[].name`** → **proceed to Step 1.** The key reaches
  the target space; Phase 3's uploads name `<ACE_HQ_DOMAIN>` explicitly,
  so a multi-space key is fine — no need for the key to be scoped to a
  single space.
- `{ configured: true }` but `<ACE_HQ_DOMAIN>` is NOT in
  `available_domains` → halt; the saved HQ API key can't reach the
  target space. Surface the reachable spaces (`available_domains`) and
  tell the operator to either fix `ACE_HQ_DOMAIN` or visit
  `https://commcare.app/settings` and paste an HQ API key that reaches
  `<ACE_HQ_DOMAIN>`, then re-run.
- `{ configured: false }` → halt; Nova has no HQ key bound. The
  operator needs to paste an HQ API key (generated under the ACE Gmail
  identity at `<ACE_HQ_BASE_URL>/account/api_keys/`) into Nova's
  settings page once. Note: this is independent from `NOVA_API_KEY` —
  that one authenticates ACE → Nova; this one binds Nova → CommCareHQ.

Do NOT dispatch the architect until `get_hq_connection` returns
`configured: true` with `<ACE_HQ_DOMAIN>` among `available_domains`.

**This call is ALSO the level-0 Nova-binding check — actually make it;
do not skip it or hand-wave it as "the architect subagent will
re-probe."** If the Nova tools won't load at level 0 at all (a
`ToolSearch` for a Nova tool name returns nothing, or `get_hq_connection`
errors as tool-unavailable rather than returning a `configured` payload),
the main session's Nova MCP connection failed at startup — a transient
where the plugin MCP times out at session start and Claude Code does NOT
retry it mid-session (and `/reload-plugins` does not respawn it). **HALT
immediately** with: "Nova MCP did not bind at level 0 this session — quit
and reopen Claude Code (a full restart, not just `/reload-plugins`), then
resume `/ace:run <opp>/<run-id>`." Do NOT proceed into Step 1 on the
assumption that the architect subagent's own connection covers Phase 3:
the architect *builds* work (each dispatch opens its own connection), but
the level-0-direct steps — `app-deploy`'s `/nova:upload_to_hq`, the
`pdd-to-*-app-eval` `get_app` reads, and `app-connect-coverage` — all
need the level-0 connection and are unrunnable without it. Catching this
at second 0 instead of mid-phase (~25 min in, after both apps are built)
is the whole point of Step 0. See jjackson/ace#659
(bednet-spot-check 20260601-1252).

#### Subagent inheritance

Apply the same gate at the start of any later subagent dispatch in
this phase that calls Nova tools (e.g. coverage retries) — but the
parent's auth state is what matters. Subagents inherit Nova's MCP
connection because the user-scope override registers it once for the
session; every subagent dispatch sees the same `get_hq_connection`
result.

### Step 1: PDD to Apps (sequential)

Invoke `pdd-to-learn-app`, then `pdd-to-deliver-app`. The Learn-app
shape varies by archetype — read `skills/pdd-to-learn-app/SKILL.md
§ Archetypes` for the per-archetype brief:

- **`atomic-visit` / `multi-stage`** — full Learn app (training
  curriculum); typically 10-15 min Nova build.
- **`focus-group`** — minimal sentinel Learn app (1 module, 1 form,
  ~7 fields, both Connect markers, doubles as an in-app readiness
  gate). Typically 1-2 min Nova build. The sentinel satisfies
  `connect_create_opportunity`'s `learn_app` requirement and gates
  attestation submissions on coordinator-confirmed practice-session-pass.
  See `docs/superpowers/specs/2026-05-15-focus-group-archetype-redefinition.md`
  for the sentinel rationale.

**Run the builds sequentially, not in parallel.** An earlier note here
claimed they could batch in a single assistant message; that was
incorrect — Claude Code does not reliably parallelize `Agent`
dispatches the way it parallelizes regular tool calls, and Nova's
`/nova:autobuild` cannot be parallelized in this environment today.
Dispatch Learn, await its result, then dispatch Deliver.

The two builds are otherwise independent — Learn reads the PDD's
learning objectives (or the sentinel spec for focus-group), Deliver
reads the visit / session-attestation spec, neither depends on the
other's `nova_app_id`.

If the Learn build fails, halt before dispatching Deliver — re-running
both wastes time and the failure is usually deterministic (PDD spec
issue, not transient).

#### Turn-0 halt detection (defensive)

After **each** Nova `Agent` dispatch returns, verify an app was created:

1. Inspect the Agent's return string for a `nova_app_id`. The return
   message reliably includes the canonical `**App Name** (app_id)` line.
   Fall back to `list_apps` (filter by `created` within the last few
   minutes and name match) if the return string is malformed.
2. If no new app is present, **re-dispatch up to two more times** (3
   total attempts).
3. If the third attempt also produces no app, surface a hard error.

Apply this check after the Learn dispatch and again after the Deliver
dispatch — they fail independently.

- Input: approved PDD from GDrive
- Output:
  - app JSON/CCZ files + summaries written to `ACE/<opp-name>/app-summaries/`
  - From `pdd-to-deliver-app`: appended `deliver-unit-count`, `one-form-per-module-workaround`, `multimedia-coverage-strategy` rows in `decisions.yaml` (merge-only; rows are emitted only when they meet the bar criterion in `skills/idea-to-pdd/SKILL.md § Decisions Log Convention` — the list is a working catalog, not a required set).
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `pdd-to-learn-app-eval` after the Learn build and
  `pdd-to-deliver-app-eval` after the Deliver build. Each writes
  `runs/<run-id>/3-commcare/pdd-to-learn-app-eval_verdict.yaml` and
  `runs/<run-id>/3-commcare/pdd-to-deliver-app-eval_verdict.yaml`
  respectively. A `verdict: fail` here does not halt Phase 3 on its
  own; the Phase 3→4 gate uses the per-skill verdict files
  (`runs/<run-id>/3-commcare/pdd-to-{learn,deliver}-app-eval_verdict.yaml`
  + `app-release-eval_verdict.yaml`); the orchestrator synthesizes any
  pause-time summary from those at runtime (gate-briefs removed in
  0.13.116 — see `agents/orchestrator-reference.md § Pause Points`).

### Step 1.5: Connect-marker coverage (verify + auto-fix)
Invoke the `app-connect-coverage` skill **once per app** (Learn, Deliver).
- Input: `nova_app_id` from each app summary; PDD for context
- Output: `ACE/<opp-name>/app-coverage/{learn,deliver}-connect-coverage.md`
  reporting before/after state per form. The Nova app on Firestore is
  mutated in place — every form's `connect` block (`learn_module` /
  `assessment` / `deliver_unit` / `task`) is set per the form's purpose.
- **Why before deploy:** Connect's `Sync Deliver Units` reads markers
  from the released CCZ. If markers are missing, the opp gets stuck
  silently at Phase 4 Step 2 (no deliver units → no payment unit).
  Fixing on the Nova side before upload avoids round-tripping HQ
  builds.
- **Why before eval:** the existing `pdd-to-{learn,deliver}-app-eval`
  judges grade Connectify wiring (25% weight). Running coverage first
  means evals score the auto-fixed app, not whatever Nova happened to
  emit.
- **Failure modes:**
  - **`blocked` (empty `entity_id`/`entity_name` on re-fetch):**
    halt Phase 3. The malformed bind will fail CCHQ's build at
    `app-release`.
  - **Coverage dispatch can't produce an app (all 3 attempts fail):**
    **do NOT halt Phase 3.** `app-release` (Step 2.7) is the actual
    wall — its Step 6 downloads the released CCZ and greps for
    `<learn:deliver>` / `<learn:module>` element counts. Log the
    coverage skip into `run_state.yaml`, write a stub coverage
    report, and proceed to Step 2.

### Step 2: Deploy Apps
Invoke the `app-deploy` skill.
- Input: app JSON/CCZ files from GDrive
- Output: apps uploaded to CCHQ as **draft builds** (Nova does not release
  by design — see Step 2.7)
- **Gate (review mode):** Present app deployment summary for verification
- **HQ-id stability requirement (added 2026-04-30):** every `nova_upload_to_hq`
  call creates a **fresh** HQ application document with a new id (CCHQ has no
  atomic update API for app uploads). If Phase 3 has to re-upload an app for
  ANY reason after the first deploy — XForm escape fixes, Connect-marker
  patches, build-rejection iteration — the HQ ids in
  `3-commcare/app-deploy_summary.md` must be updated, and Phase 4
  (`connect-opp-setup`) MUST run against the FINAL post-iteration ids.
  Phase 4's `connect_create_opportunity` writes the HQ ids into the opp's
  app-wire fields at create time, and Connect's edit form does NOT expose
  those fields — so re-pointing a wired opp at new HQ ids requires
  delete-and-recreate **of the Connect opportunity** (CCC-301 will
  eventually expose `update_opportunity({learn_app, deliver_app})` and
  retire this dance). The orchestrator's Phase 3→4 transition MUST
  verify `3-commcare/app-deploy_summary.md.released_at >= 3-commcare/app-deploy_summary.md.uploaded_at`
  AND that no subsequent re-upload happened, before dispatching Phase 4.

  **What delete-and-recreate of the Connect opportunity does NOT touch:**
  any labs solicitation already published for this opp. Per
  `skills/solicitation-create/SKILL.md`, solicitations are scoped to a
  labs `program_id`, NOT to a specific Connect opportunity UUID — the
  `connect_opportunity_id` field under the current run's
  `phases.solicitation-management.products.solicitation` is ACE-side
  bookkeeping that records ACE's intended target, not a labs-side
  foreign key. The public solicitation URL keeps working, the deadline
  keeps counting down, candidate LLO views and applications continue
  uninterrupted. The recovery is manual deletion in the Connect web UI
  (no connect-delete-opportunity atom yet — see
  `skills/sweep-connect/SKILL.md § Implementation notes`) followed by
  `connect_create_opportunity` against canonical HQ ids + a
  `connect_opportunity_id` bookkeeping update in the current run's
  `run_state.yaml`. **Repointing the Connect opp pre-Phase-9 is
  therefore a low-cost recovery, not a destructive one.** Phase 9
  onboarding then targets the new opp UUID. Surfaced 2026-04-30
  (turmeric-20260429-2330) and re-confirmed cheaply 2026-05-07
  (turmeric-20260507-1733).

### Step 2.6: Generate app-test-cases.yaml

Invoke `app-test-cases` via `Skill(app-test-cases)` (or `/ace:step
app-test-cases <opp>/<run-id>` from a fresh session). **Do NOT compose
its outputs inline.** This skill's contract is multi-file: it emits a
master `3-commcare/app-test-cases.yaml` AND per-journey recipe files
(`3-commcare/recipes/journey-*.yaml`) which Phase 6's
`app-screenshot-capture` requires for pre-flight. An inline-composed
master file with no per-recipe siblings will halt Phase 6 at
pre-flight (real failure mode from turmeric run 20260509-0455). See
`agents/ace-orchestrator.md § Skill Invocation Discipline`.

- Reads: pdd-to-app-journeys.md, both app summaries, Nova blueprints
- Writes:
  - app-test-cases.yaml + recipes/journey-*.yaml under 3-commcare/recipes/
  - Appended `test-scenario-count`, `test-archetype-coverage` rows in `decisions.yaml` (merge-only; rows use `phase: 3-commcare` matching this dispatch site; bar criterion per `skills/idea-to-pdd/SKILL.md § Decisions Log Convention`).
- Halts on missing inputs or recipe-validation failure

Phase 6 shallow runs the smoke recipes; /ace:qa-deep runs them all.

This step runs **after** `app-deploy` (so the Nova blueprints are
finalized and the HQ ids are stable) and **before** `app-release` (so
the recipes are in place by the time Phase 6 needs them, and so the
journey-to-form bindings are captured against the apps as built — not a
later re-build). Nova builds are uploaded via `app-deploy`, so the
blueprint IDs we read here are the same ones the released CCZ will
carry; `app-release` is when we can no longer rebuild the apps cheaply,
so it's the natural cutoff for "the apps are now what they are."

### Step 2.7: Release Apps
Invoke the `app-release` skill.
- Input: HQ app ids from `3-commcare/app-deploy_summary.md`
- Output: each app has a new released build; Connect's `Sync Deliver Units`
  can now read the form schema. Without this step, Phase 4
  (`connect-opp-setup`) creates the opp shell but cannot configure
  payment units (deliver-units list comes back empty).
- **Prerequisite:** the user backing `ACE_HQ_USERNAME` needs a role with
  `edit_apps` on the target project space; the standard `Admin` role
  includes it. The skill includes an empirical probe procedure for the
  underlying CCHQ endpoints — they're internal UI routes, not stable
  public APIs.
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `app-release-eval` after release. Writes
  `3-commcare/app-release-eval_verdict.yaml`.

Note: the `app-test` skill was retired in the shallow/deep QA split
(0.11.10). Phase 3's QA contribution is now Step 2.6's
`app-test-cases.yaml`; the actual smoke runs happen in Phase 6
(`app-screenshot-capture`) and the deep grading runs from
`/ace:qa-deep` (`app-ux-eval`). Spec:
`docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md`.

Note: `training-materials` no longer runs in Phase 3. As of 0.9.0 it lives
in Phase 6 (`qa-and-training`), where it consumes the screenshots produced
by `app-screenshot-capture` alongside the app summaries.

### Step 2.8: CommCare CCZ structural smoke

Invoke the `app-release-qa` skill. This step is a lightweight,
AVD-free structural check on the just-released Learn + Deliver CCZs:
download each via `commcare_download_ccz`, parse the zip + suite.xml +
form XMLs, and verify form counts + Connect-marker presence match the
Nova blueprint. Halts loud on mismatch.

**Position rationale.** Prior versions of this file tried to put
`app-screenshot-capture` (a full AVD smoke walk) at the end of Phase
3 to surface recipe-authoring + AVD infrastructure failures at the
source. That move was reverted because the live AVD smoke requires a
Connect opportunity + ACE-test-user invite (Phase 4 outputs); Phase 3
is upstream of those preconditions. `app-release-qa` is a tighter
CommCare-side-only check that DOES belong here: it catches
CCZ-marker drops, form-count drift vs. Nova blueprint, and XForm
parse errors that would otherwise only surface in Phase 4's Connect
Sync Deliver Units or Phase 6's `app-screenshot-capture`. Full AVD
smoke stays in Phase 6 where Connect state is available.

- Inputs:
  - `3-commcare/app-deploy_summary.md` (HQ app ids + released build ids)
  - Nova `get_app({app_id})` blueprints for each app (for the structural cross-reference)
- Outputs:
  - `3-commcare/app-release-qa_result.yaml` — structural verdict
- **Halts loud on structural mismatch.** Per
  `skills/app-release-qa/SKILL.md § Step 4`, any of:
  - Released CCZ download fails or yields non-zip bytes
  - Form count in released CCZ doesn't match Nova blueprint form count
  - Any Learn quiz form is missing `<learn:assessment>` or any Learn
    content form is missing `<learn:module>` (Nova maintainer #7
    closure: these wrappers are REQUIRED for Connect's sync)
  - Deliver form `du_poc_visit` missing `<learn:deliver>` namespace
  - XForm XML in any form fails to parse via stdlib ElementTree

  …is a `[BLOCKER]`. The skill writes a structured verdict with the
  specific mismatch class so the operator can decide whether to
  re-run `app-release` (transient build issue) or re-run
  `pdd-to-{learn,deliver}-app` (Nova emitted a structurally broken
  build).

**Why this is honest scope.** `app-release-qa` does NOT verify
the apps install + launch on a real device — that's the AVD smoke
in Phase 6 (`app-screenshot-capture`). What it DOES verify is that
the released CCZ artifact carries the structural markers Connect's
HQ→Connect sync requires. The single failure mode this catches in
isolation is "Nova built fine, validate_app passed, build released,
but a downstream consumer (Connect Sync or AVD runtime) finds the
released CCZ structurally broken" — historically the canonical
trigger for `commcare-form-patch` regressions (now removed; this
step exists in part as the structural watcher that would have caught
the form-patch over-stripping incident at Phase 3 instead of Phase 6).

### Completion
Write phase summary to `ACE/<opp-name>/runs/<run-id>/3-commcare/commcare-setup_summary.md`,
then write the `phases.commcare-setup` block per `agents/ace-orchestrator.md
§ Phase Write-Back Contract`. Phase 3 is a procedure doc executed by the
top-level orchestrator session inline (see § Agent Topology), so the
orchestrator owns this write. Required top-level keys on the patch:
`phases`, `last_actor`, `last_actor_at`. (0.13.116: legacy `gates.app-deploy`
flip dropped — derived from phases.commcare-setup.status + per-skill verdicts.)

#### Verdict-gate rule for `-eval` skills (since 0.13.207)

The skills frontmatter declares which producers have a paired `-eval`
skill (`has_judge: true` rows). Three of those — `pdd-to-learn-app-eval`,
`pdd-to-deliver-app-eval`, `app-release-eval` — historically ran
`status: deferred` in `/ace:run`, meaning the phase verdict landed on
`pass` while the LLM-as-Judge content quality had not been graded.

That pattern bit Phase 2 on turmeric run 20260513-0616 — the
(then-active, since-deleted) `commcare-form-patch` over-stripping bug
shipped to a `verdict: pass` phase because nothing in the inline run
looked at the released CCZ's structural state. The lesson generalizes:
eval verdicts are not the right tool for catching CCZ-marker drops,
that's a structural assertion. The general principle holds:

**Do NOT set `phases.commcare-setup.verdict: pass` when any
`has_judge: true` skill has `steps.<skill>-eval.status: deferred`.**
Either:

- **Run the eval inline** (preferred — write the verdict to
  `<phase>/<skill>-eval_verdict.yaml` and gate the phase on its
  verdict). The orchestrator's Per-Step Eval Hook is supposed to do
  this automatically; if it didn't, the phase write-back's `status`
  should be `partial` (not `done`) and `verdict` should be
  `passed-with-deferred-evals` (not `pass`).
- **OR explicitly opt out** via a top-level `--no-evals` flag on
  `/ace:run` (operator-asserted decision), in which case the phase
  status reflects the opt-out (`verdict: partial-evals-skipped`).

The legacy `status: deferred + rationale: backfill via /ace:eval --all`
shape is still useful for opp-level retroactive grading, but it MUST
NOT coexist with `verdict: pass` in the same write-back.
Catch this in the Phase Write-Back Verifier — if any step in the
phase has `status: deferred` on a `has_judge: true` producer, downgrade
the verdict to `partial` before writing. (Pre-0.13.116 this was framed
as "flip `gates.commcare-setup` to `partial`"; gates removed —
`phases.commcare-setup.verdict` carries the same signal now.)

This rule applies to every phase agent, not just `commcare-setup`. The
canonical implementation is the Phase Write-Back Verifier procedure in
`agents/orchestrator-reference.md`; this file documents the contract
for the procedure-doc form of the agent (Phase 2 / Phase 3).
