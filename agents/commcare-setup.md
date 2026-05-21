---
name: commcare-setup
description: >
  Phase 4 of the CRISPR-Connect lifecycle: translate the approved PDD into
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
  - { name: commcare-form-patch,     has_judge: false }
---

# CommCare Setup (Phase 3 Procedure Document)

This file specifies Phase 3 of the CRISPR-Connect lifecycle: build and
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

Call Nova's `get_hq_connection` (no args). Branch on the result:

- `{ configured: true, domain.name === <ACE_HQ_DOMAIN> }` → **proceed
  to Step 1.**
- `{ configured: true, domain.name !== <ACE_HQ_DOMAIN> }` → halt; Nova
  is bound to the wrong project space. Tell the operator to visit
  `https://commcare.app/settings` and update the active HQ API key so
  it targets `<ACE_HQ_DOMAIN>`, then re-run.
- `{ configured: false }` → halt; Nova has no HQ key bound. The
  operator needs to paste an HQ API key (generated under the ACE Gmail
  identity at `<ACE_HQ_BASE_URL>/account/api_keys/`) into Nova's
  settings page once. Note: this is independent from `NOVA_API_KEY` —
  that one authenticates ACE → Nova; this one binds Nova → CommCareHQ.

Do NOT dispatch the architect until `get_hq_connection` returns
`configured: true` against `<ACE_HQ_DOMAIN>`.

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

#### Turn-0 halt detection (defensive — Nova issue #2)

Nova's `/nova:autobuild` occasionally returns from
`nova:nova-architect-autonomous` having taken zero tool actions — no
`create_app`, no scaffold, no error, just a prose response. When this
happens the `Agent` call appears to "succeed" but no Nova app exists.
Filed as `voidcraft-labs/nova-plugin#2`; the right fix is upstream
(autobuild refusing to return without ≥1 tool call). Until that lands,
defend against it on the ACE side:

After **each** Nova `Agent` dispatch returns, before treating its
output as authoritative:

1. Inspect the Agent's return string for a `nova_app_id` (or call
   `list_apps` and look for an app whose
   `created` is within the last few minutes and whose name matches
   the spec just submitted).
2. If no new app is present, the dispatch halted at turn 0. **Re-dispatch
   up to two more times** (so up to **3 total attempts**) with the same
   spec. Empirically (turmeric-20260429-2330): two halts in a row, third
   attempt completed cleanly — bumping the budget caps wasted wall-clock
   at ~30 sec per halted attempt while preserving the "don't loop forever"
   discipline.
3. If the third attempt also produces no app, surface a hard error
   with `nova-plugin#2` in the message — at that point the failure is
   no longer plausibly transient; let the operator decide whether to
   wait for upstream or escalate.

Apply this check after the Learn dispatch and again after the Deliver
dispatch — they fail independently. Apply the same retry policy to
**any** `nova:nova-architect-autonomous` dispatch elsewhere in this
phase (e.g., the `app-connect-coverage` verification dispatches in
Step 1.5), since `nova-plugin#2` affects every architect dispatch
identically — not just builds.

- Input: approved PDD from GDrive
- Output: app JSON/CCZ files + summaries written to `ACE/<opp-name>/app-summaries/`
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `pdd-to-learn-app-eval` after the Learn build and
  `pdd-to-deliver-app-eval` after the Deliver build. Each writes
  `runs/<run-id>/3-commcare/pdd-to-learn-app-eval_verdict.yaml` and
  `runs/<run-id>/3-commcare/pdd-to-deliver-app-eval_verdict.yaml`
  respectively. A `verdict: fail` here does not halt Phase 3 on its
  own; the Phase 3→4 gate uses
  `runs/<run-id>/3-commcare/app-deploy_gate-brief.md`.

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
  - **`blocked` with `voidcraft-labs/nova-plugin#1` (Bug 2 — empty
    `entity_id`/`entity_name` re-injected on `update_form`
    `deliver_unit`):** halt Phase 3. The malformed bind will fail
    CCHQ's build at `app-release`, and the eventual released CCZ
    won't carry the markers Connect needs. Wait for upstream fix.
  - **Coverage's architect dispatch can't get past `nova-plugin#2`
    (bootstrap halts on all 3 attempts):** **do NOT halt Phase 3.**
    Coverage is the upstream safety net; `app-release` (Step 2.7,
    0.10.5+) is the actual wall — its Step 6 downloads the released
    CCZ and greps for `<learn:deliver>` / `<learn:module>` element
    counts, which catches Bug 2 escapes cleanly. Log the coverage
    skip into `run_state.yaml` (`app-connect-coverage-{learn,deliver}:
    skipped-nova2`), write a stub coverage report noting the skip
    + reliance on app-release verification, and proceed to Step 2.
    Rationale: Nova's autobuild path doesn't go through `update_form`
    for the initial connect block, so a clean autobuild build report
    almost always means clean markers; the only risk is a silent
    Nova-internal regression that `app-release`'s grep catches anyway.

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
  uninterrupted. The recovery is one `connect_delete_opportunity` +
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
(`3-commcare/app-test-cases/J*.yaml`) which Phase 6's
`app-screenshot-capture` requires for pre-flight. An inline-composed
master file with no per-recipe siblings will halt Phase 6 at
pre-flight (real failure mode from turmeric run 20260509-0455). See
`agents/ace-orchestrator.md § Skill Invocation Discipline`.

- Reads: pdd-to-app-journeys.md, both app summaries, Nova blueprints
- Writes: app-test-cases.yaml + recipes/J*.yaml under app-test-cases/
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
  `app-release-eval` after release. Writes `verdicts/app-release.yaml`.

Note: the `app-test` skill was retired in the shallow/deep QA split
(0.11.10). Phase 3's QA contribution is now Step 2.6's
`app-test-cases.yaml`; the actual smoke runs happen in Phase 6
(`app-screenshot-capture`) and the deep grading runs from
`/ace:qa-deep` (`app-ux-eval`). Spec:
`docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md`.

Note: `training-materials` no longer runs in Phase 3. As of 0.9.0 it lives
in Phase 6 (`qa-and-training`), where it consumes the screenshots produced
by `app-screenshot-capture` alongside the app summaries.

### Step 2.8: Strip Connect wrappers from Learn forms

Invoke the `commcare-form-patch` skill (default `targets: auto`,
`patch_class: assessment-removal`, `app: learn`). For `focus-group`
archetype, the Learn app is the minimal sentinel (one form, one
assessment) — `commcare-form-patch` runs as a safe no-op or single-form
patch depending on whether Nova's `compile_app` emitted Connect
wrappers in the sentinel's form XML. The skill is idempotent and
`targets: auto` handles both cases without operator override.

Background: Nova's `compile_app` emits `<module xmlns="…connect…">` /
`<assessment xmlns="…connect…">` wrapper elements in Learn-app form
XML. Connect's HQ-side sync (`opportunity/app_xml.py:extract_modules`
+ `opportunity/tasks.py:sync_learn_modules_and_deliver_units`) reads
namespaced `<learn:module>` / `<learn:deliver>` elements via stdlib
ElementTree on in-memory strings — **the in-form wrappers are benign
for Phase 4 sync**, regardless of count. (Verified against
commcare-connect main on 2026-05-12: the parser is pure in-memory
iteration with no DB queries, HTTP fetches, or locks per-block.) An
earlier comment here claimed "Connect's `/opportunity/init/` *now*
tolerates these (post-2026-04 server fix), so Phase 4 succeeds" — that
was wrong about provenance. There was no Connect server fix; prior
Phase 4 successes happened because the payload's `short_description`
happened to be ≤ 50 chars (the actual DB-enforced cap). The deterministic
Phase 4 500 trap is a serializer/model schema mismatch on
`short_description`, NOT in-form wrappers; bisected 2026-05-12 against
`e62dcb06-...` (49 chars → 201, 51 chars → 500). See
`mcp/connect-server.ts` `connect_create_opportunity.short_description`
description for the full account.

**But the AVD's CommCare runtime still chokes on the wrappers at Learn-app
launch time** — the user sees a "Failed to start learning" banner with
no diagnostic, which blocks Phase 6 (`app-screenshot-capture`). That is
the load-bearing reason this skill exists; it has nothing to do with
Phase 4. Tracking: jjackson/ace#115 finding 1, voidcraft-labs/nova-plugin#7.

The skill is **idempotent + safe to run unconditionally**: `targets:
auto` scans the released Learn CCZ for wrapper-bearing forms; if zero
match (e.g. Nova fix has shipped, or this opp's Learn app was never
broken), the skill no-ops with an `[INFO]` log. When wrappers are
present, the skill patches the form XML, re-builds, and re-releases —
producing a Connect-runtime-compatible Learn CCZ that Phase 6 can
launch. **Apply to Learn apps only** — patching Deliver forms via
`edit_form_attr` triggers a CCHQ "Cannot use Case Management UI if you
already have a case block" build error.

Removal criteria: when nova-plugin#7 ships and a clean `/ace:run` end-
to-end produces zero wrapper refs in the released Learn CCZ, drop
this step + the entire `commcare-form-patch` skill (per its own
SKILL.md § Removal criteria).

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
`status: deferred` in `/ace:run`, meaning the gate flipped to
`passed` while the LLM-as-Judge content quality had not been graded.

That pattern bit Phase 2 on turmeric run 20260513-0616 — the
commcare-form-patch over-stripping bug shipped to a "gates.commcare-setup:
passed" phase because nothing in the inline run looked at the released
CCZ's structural state. The eval verdicts are not the right tool for
catching CCZ-marker drops (that's the structural assertion the patcher
skill now mandates per its Step 7b), but the more general principle
holds:

**Do NOT flip `gates.commcare-setup: passed` when any `has_judge: true`
skill has `steps.<skill>-eval.status: deferred`.** Either:

- **Run the eval inline** (preferred — write the verdict to
  `<phase>/<skill>-eval_verdict.yaml` and gate the phase on its
  verdict). The orchestrator's Per-Step Eval Hook is supposed to do
  this automatically; if it didn't, the phase write-back's `status`
  should be `partial` (not `complete`), `verdict` should be
  `passed-with-deferred-evals` (not `pass`), and `gates.commcare-setup`
  should be `partial` (not `passed`).
- **OR explicitly opt out** via a top-level `--no-evals` flag on
  `/ace:run` (operator-asserted decision), in which case the phase
  status reflects the opt-out (`partial-evals-skipped` /
  `gates.commcare-setup: partial`).

The legacy `status: deferred + rationale: backfill via /ace:eval --all`
shape is still useful for opp-level retroactive grading, but it MUST
NOT coexist with `gates.commcare-setup: passed` in the same write-back.
Catch this in the Phase Write-Back Verifier — if any step in the
phase has `status: deferred` on a `has_judge: true` producer, downgrade
the gate to `partial` before writing.

This rule applies to every phase agent, not just `commcare-setup`. The
canonical implementation is the Phase Write-Back Verifier procedure in
`agents/orchestrator-reference.md`; this file documents the contract
for the procedure-doc form of the agent (Phase 2 / Phase 3).
