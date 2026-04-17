---
description: Run a single step of the CRISPR-Connect process for an opportunity
argument-hint: [<skill-name> <opp-name>]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:step

Run a single skill for an opportunity without running the full lifecycle.

## Arguments
- `<skill-name>` — name of the skill to invoke (e.g., `idea-to-pdd`, `app-test`)
- `<opp-name>` — name of the opportunity

## Process

1. Parse arguments.
2. Verify the opportunity folder exists in GDrive (`ACE/<opp-name>/`).
3. **Prerequisite check against the artifact manifest.** Before dispatching
   the skill, confirm all of its required prior artifacts are present in
   `ACE/<opp-name>/`. See "Prerequisite check" below. If any are missing,
   stop with an actionable error — do not invoke the skill.
4. **Update operator identity in `state.yaml`** before dispatching:
   - `last_actor: <git config user.email>` (fallback: `unknown`)
   - `last_actor_at: <ISO timestamp>`

   See `agents/ace-orchestrator.md` § Touching State — Operator Capture.
   This runs on every `/ace:step` call so `/ace:status` shows accurate
   hand-off attribution even when admins bypass the orchestrator.
5. Invoke the specified skill with the opportunity context.
6. Update `state.yaml` with the result (per-phase nested map, 6-phase schema).

## Prerequisite check

The canonical artifact manifest (`lib/artifact-manifest.ts`) declares which
files each skill consumes. Use `artifactsConsumedBy(skillName)` to enumerate
them and then check each one is present in the opportunity folder.

Implementation steps the agent (or a thin Bash wrapper) must perform:

1. Read `lib/artifact-manifest.ts` (or its compiled output) and look up the
   skill's entry via `artifactsConsumedBy(<skill-name>)`.
2. For each consumed artifact with `required: true`:
   - Use `drive_list_folder` (or the live `ACE/<opp-name>/` listing) to check
     that `path` exists.
3. If any required artifact is missing, print an error of the form:

   ```
   /ace:step <skill> <opp>: cannot run — missing required inputs.

   Missing:
     - ACE/<opp>/<path>    (produced by: <producer-skill>)
     - ACE/<opp>/<path>    (produced by: <producer-skill>)

   Run the upstream skills first, or use /ace:run to execute the full
   pipeline in order.
   ```

4. Exit without invoking the skill. The user fixes the gap and retries.

**Why this exists.** Without the check, `/ace:step ocs-chatbot-qa my-opp --deep`
silently fails when `test-prompts.md` hasn't been produced yet (because
`pdd-to-test-prompts` hasn't run). Per ACE's fail-loudly contract: skills
that read upstream-produced artifacts must error when those artifacts are
missing, not improvise content. The check belongs in `/ace:step` so any
bypass of the orchestrator (which otherwise runs skills in dependency order)
still enforces the contract.

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
  → Reads idea.md (required, producedBy: external). OK → invoke skill.

/ace:step ocs-chatbot-qa my-opp
  → Required: test-prompts.md. Missing.
  → Error: "cannot run — missing required inputs: test-prompts.md
    (produced by: pdd-to-test-prompts)."

/ace:step connect-opp-setup my-opp
  → Required: program.md, pdd.md, deployment-summary.md. All present.
  → OK → invoke skill.
```

Useful for re-running a specific step, testing a skill in isolation,
or manually advancing through the process.
