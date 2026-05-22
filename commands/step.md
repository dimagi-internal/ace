---
description: Run a single step of the CRISPR-Connect process for an opportunity
argument-hint: [<skill-name> <opp>[/<run-id>]]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:step

Run a single skill for an opportunity without running the full lifecycle.

## Arguments
- `<skill-name>` — name of the skill to invoke (e.g., `idea-to-pdd`, `app-deploy`)
- `<opp>` or `<opp>/<run-id>` — opportunity, optionally pinned to a specific run.
  - Bare `<opp>` (e.g., `malaria-itn-app`): target the opp's current run
    (resolved via `opp.yaml.last_run_id`).
  - `<opp>/<run-id>` (e.g., `malaria-itn-app/20260517-1829`): target that
    specific historical run. The skill reads + writes
    `ACE/<opp>/runs/<run-id>/run_state.yaml` directly without touching
    `opp.yaml.last_run_id`. Mirrors `/ace:run` and `fork-run`'s slash
    convention. Use this to re-dispatch a single skill against a frozen
    upstream run without disturbing the opp's pointer to its current
    head — useful for verifying a code fix against the exact run that
    surfaced the bug, or for ad-hoc forensic re-runs.

## Process

1. **Parse arguments.** Split the second positional on `/`:
   - Single token → `opp = <token>`, `runId = <opp.yaml.last_run_id>` (resolved at step 4).
   - `<opp>/<run-id>` → `opp = <opp>`, `runId = <run-id>` (pinned).

   Run-id pinning is **read+write scoped** for the rest of this
   dispatch: prerequisite checks, the skill's own artifact reads, and
   the final `run_state.yaml` write all resolve against
   `ACE/<opp>/runs/<runId>/`. `opp.yaml.last_run_id` is NOT touched
   when a run-id was pinned explicitly — leaving the opp's head
   pointer wherever it was before.

2. Verify the opportunity folder exists in GDrive (`ACE/<opp>/`).
3. **Prerequisite check against the artifact manifest.** Before dispatching
   the skill, confirm all of its required prior artifacts are present
   under the resolved run folder (`ACE/<opp>/runs/<runId>/` for run-scoped
   paths, `ACE/<opp>/` for opp-scoped paths — the manifest's path field
   declares scope implicitly). See "Prerequisite check" below. If any
   are missing, stop with an actionable error — do not invoke the skill.
4. **Ensure `run_state.yaml` exists at the resolved run path, then update
   operator identity.** If `ACE/<opp>/runs/<runId>/run_state.yaml` is
   missing (orchestrator was bypassed — typical when an admin runs
   `/ace:step idea-to-pdd <opp>` without a prior `/ace:run`), initialize
   it first using the schema in `agents/ace-orchestrator.md § State
   Schema` and the identity-capture logic in `§ Starting a New
   Opportunity` step 3. Then set:
   - `last_actor: <git config user.email>` (fallback: `unknown`)
   - `last_actor_at: <ISO timestamp>`

   When the run-id was pinned explicitly via `<opp>/<run-id>`, the run
   folder MUST already exist — if not, halt with:

   ```
   /ace:step <skill> <opp>/<run-id>: run not found at ACE/<opp>/runs/<run-id>/.

   Pinned-run-id targets only work against existing runs. Either drop
   the run-id to start a fresh run via /ace:run, or use /ace:fork-run
   to create a new run forked from an existing one.
   ```

   See `agents/ace-orchestrator.md` § Touching State — Operator Capture
   and § Defensive `run_state.yaml` init on bypass paths. Defensive init
   runs on every `/ace:step` call so the bypass path is robust and
   `/ace:status` shows accurate hand-off attribution even when admins
   skip the orchestrator.
5. Invoke the specified skill with the opportunity context (and resolved
   `runId`). Skills run inline at top-level (this `/ace:step`
   invocation IS the top-level session) so `Agent` is available —
   required for any skill that invokes `/nova:autobuild` (Phase 3's
   `pdd-to-learn-app` / `pdd-to-deliver-app`) or otherwise dispatches a
   subagent. See `CLAUDE.md` § Agent topology.
6. Update `ACE/<opp>/runs/<runId>/run_state.yaml` with the result
   (per-phase nested map, 8-phase schema).

## Prerequisite check

The canonical artifact manifest (`lib/artifact-manifest.ts`) declares which
files each skill consumes. Use `artifactsConsumedBy(skillName)` to enumerate
them and then check each one is present at the resolved path.

Implementation steps the agent (or a thin Bash wrapper) must perform:

1. Read `lib/artifact-manifest.ts` (or its compiled output) and look up the
   skill's entry via `artifactsConsumedBy(<skill-name>)`.
2. For each consumed artifact with `required: true`:
   - Resolve the full path: opp-scoped entries (e.g. `opp.yaml`,
     `inputs/`, `eval-calibration/known-issues.md`) resolve to
     `ACE/<opp>/<path>`. Run-scoped entries (anything under
     `1-design/`, `2-scenarios/`, … `8-execution/`, plus
     `run_state.yaml`, `inputs-manifest.yaml`, `decisions.yaml`)
     resolve to `ACE/<opp>/runs/<runId>/<path>`.
   - Use `drive_list_folder` (or the live Drive listing) to check that
     the resolved path exists.
3. If any required artifact is missing, print an error of the form:

   ```
   /ace:step <skill> <opp>[/<run-id>]: cannot run — missing required inputs.

   Missing:
     - ACE/<opp>/runs/<run-id>/<path>    (produced by: <producer-skill>)
     - ACE/<opp>/<path>                  (produced by: <producer-skill>)

   Run the upstream skills first, or use /ace:run to execute the full
   pipeline in order.
   ```

4. Exit without invoking the skill. The user fixes the gap and retries.

**Why this exists.** Without the check, `/ace:step ocs-chatbot-qa my-opp --deep`
silently fails when `2-scenarios/pdd-to-test-prompts.md` hasn't been
produced yet (because `pdd-to-test-prompts` hasn't run), and
`/ace:step ocs-chatbot-eval my-opp --deep` silently fails when no
`5-ocs/ocs-chatbot-qa_transcript-deep.md` exists yet (because
`ocs-chatbot-qa --deep` hasn't run). Per ACE's fail-loudly contract:
skills that read upstream-produced artifacts must error when those
artifacts are missing, not improvise content. The check belongs in
`/ace:step` so any bypass of the orchestrator (which otherwise runs
skills in dependency order) still enforces the contract.

**What NOT to check:**
- Dated / recurring artifacts (paths containing `YYYY-MM-DD`) — these are
  produced on a schedule and may legitimately not exist yet.
- `required: false` artifacts — the skill can handle their absence.
- `producedBy: 'external'` artifacts — those are the human-supplied inputs
  that the orchestrator captures via `AskUserQuestion` in "Starting a New
  Opportunity." If one is missing, the orchestrator is supposed to have
  prompted for it; the user can also add it manually to the Drive folder
  before retrying.

## Examples

```text
/ace:step idea-to-pdd my-opp
  → Bare opp. Resolves runId from opp.yaml.last_run_id.
  → Required: inputs-manifest.yaml at the run root (produced by
    ace-orchestrator at run start). OK → invoke skill.

/ace:step app-screenshot-capture malaria-itn-app/20260517-1829
  → Pinned run-id. Targets ACE/malaria-itn-app/runs/20260517-1829/
    explicitly. opp.yaml.last_run_id is NOT touched.
  → Reads run_state.yaml + 6-qa-and-training/app-test-cases.yaml at
    that pinned path. OK → invoke skill. Verdict writes back into the
    pinned run's run_state.yaml only.

/ace:step ocs-chatbot-qa my-opp
  → Required: 2-scenarios/pdd-to-test-prompts.md (run-scoped).
  → Resolves to ACE/my-opp/runs/<last_run_id>/2-scenarios/... — Missing.
  → Error: "cannot run — missing required inputs:
    ACE/my-opp/runs/<last_run_id>/2-scenarios/pdd-to-test-prompts.md
    (produced by: pdd-to-test-prompts)."

/ace:step ocs-chatbot-eval my-opp/20260517-1829 --deep
  → Required: 5-ocs/ocs-chatbot-qa_transcript-deep.md at the pinned run.
  → Resolves to ACE/my-opp/runs/20260517-1829/5-ocs/... — Missing.
  → Error names the exact pinned path so it's obvious whether the
    upstream skill ran in THIS run vs. some other run.

/ace:step connect-opp-setup my-opp
  → Required: 4-connect/connect-program-setup.md, inputs/pdd.md,
    3-commcare/app-deploy_summary.md. All present at the resolved run.
  → OK → invoke skill.

/ace:step app-screenshot-capture malaria-itn-app/2025-doesnt-exist
  → Pinned run-id not on Drive.
  → Error: "run not found at ACE/malaria-itn-app/runs/2025-doesnt-exist/.
    Pinned-run-id targets only work against existing runs."
```

Useful for re-running a specific step, testing a skill in isolation,
manually advancing through the process, or **re-dispatching a single
skill against a frozen historical run** (the `<opp>/<run-id>` form —
matches `/ace:run`'s resume syntax and `fork-run`'s slash convention).
