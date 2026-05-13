---
name: synthetic-walkthrough-run
description: >
  Dispatch canopy:walkthrough for each persona spec, copy the resulting
  HTML slideshow + scored screenshots into the run folder.
disable-model-invocation: true
---

# Synthetic Walkthrough Run

Stage 2 of ACE Phase 7 (Plan B). Consumes the per-persona spec YAMLs
written by `synthetic-walkthrough-spec`, dispatches the
`canopy:walkthrough` skill once per persona, and uploads each resulting
HTML slideshow + scored screenshots to the run folder. Each invocation
appends to `phases.synthetic-data-and-workflows.products.synthetic.walkthroughs[]`
in the **current run's** `run_state.yaml`. Each run accumulates its
own walkthroughs list as personas are dispatched within that run; the
list does NOT chain across runs (every `/ace:run` is independent).
Operators reviewing walkthrough history across multiple runs look at
each run's state file separately or consult ace-web's run listing.

The `canopy:walkthrough` skill is the source of truth for the
walkthrough orchestration — scene loop, browse capture, deck
generation. As of canopy v0.2.79, per-scene scoring lives in
`canopy:visual-judge` (the Tough Judge methodology + walkthrough's
5-dimension rubric in `walkthrough/rubric.yaml`); walkthrough
dispatches `visual-judge` per scene and aggregates scores into the
HTML deck JSON. This ACE skill is a thin orchestrator that wires
walkthrough's inputs and outputs into the ACE convention — it does
not interact with `canopy:visual-judge` directly. (Polish-eval
DOES dispatch `canopy:visual-judge` directly, with a different
rubric — see `synthetic-workflow-polish-eval/SKILL.md` step 7.)

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 7 | `7-synthetic/synthetic-walkthrough-spec_<persona>.yaml` (one per persona) | the spec dispatched to canopy:walkthrough |
| Drive | `ACE/<opp>/opp.yaml` | `display_name`, `slug` |
| Current run's `run_state.yaml` | `phases.synthetic-data-and-workflows.products.synthetic.labs_opp_id` | walkthrough scope |
| Env | `${CLAUDE_PLUGIN_DATA}/.env` → `ACE_HQ_USERNAME` / `ACE_HQ_PASSWORD` | CommCareHQ creds for the headless OAuth-via-CCHQ flow used by `bin/ace-labs-walkthrough-login` (which reuses `mcp/connect/auth/hq-oauth-login.ts`) |
| Operator (CLI, optional) | `--persona <name>` | run a single persona instead of all |
| Operator (CLI, optional) | `--personas <comma-list>` | run a subset of personas |

## Products

- `7-synthetic/walkthroughs/<persona>-<YYYYMMDD-HHMMSS>/slideshow.html` — the HTML deck (per persona, per run, timestamped)
- `7-synthetic/walkthroughs/<persona>-<YYYYMMDD-HHMMSS>/scenes/scene_<n>.png` — per-scene screenshots
- `7-synthetic/walkthroughs/<persona>-<YYYYMMDD-HHMMSS>/eval.json` — per-scene scores from the canopy walkthrough's LLM-as-Judge
- `run_state.yaml.phases.synthetic-data-and-workflows.products.synthetic.walkthroughs[]` — appended (NOT overwritten) per persona run via read-modify-write within the current run. Per-run only — does not chain across runs.
- `run_state.yaml.phases.synthetic-data-and-workflows.synthetic-walkthrough-run.steps[<persona>]: done`

## Pre-flight

Before dispatching anything:

1. **Verify the canopy plugin is installed.** Run:

   ```bash
   ls ~/.claude/plugins/marketplaces/canopy/plugins/canopy/skills/walkthrough/SKILL.md
   ```

   If missing, halt with: "canopy plugin not installed. Run
   `/plugin install canopy@dimagi-claude-workflows` (or whatever
   marketplace ships canopy) and retry."

2. **Verify the `browse` binary is built.** The canopy walkthrough skill
   requires `~/.claude/skills/gstack/browse/dist/browse` (or a project-local
   copy). Run:

   ```bash
   B=~/.claude/skills/gstack/browse/dist/browse
   [ -x "$B" ] && echo READY || echo "NEEDS_SETUP: cd ~/.claude/skills/browse && ./setup"
   ```

   If `NEEDS_SETUP`, halt with the bootstrap instruction.

3. **Verify `ACE_HQ_USERNAME` / `ACE_HQ_PASSWORD` are set.** Read
   `${CLAUDE_PLUGIN_DATA}/.env`. If either is unset:

   "CommCareHQ creds are not configured. Inject from 1Password via
   `op inject -i .env.tpl -o $CLAUDE_PLUGIN_DATA/.env --account dimagi.1password.com`
   (or `/ace:setup --force-env`) and retry. The labs walkthrough login
   uses these creds to drive the headless OAuth-via-CCHQ flow."

4. **Verify `bin/ace-labs-walkthrough-login` is reachable.** Run:

   ```bash
   ls ~/.claude/plugins/cache/ace/ace/$(cat ~/.claude/plugins/marketplaces/ace/VERSION)/bin/ace-labs-walkthrough-login
   ```

   If missing, the installed plugin cache is stale. Run `/ace:update`
   and retry. (This script reuses `mcp/connect/auth/hq-oauth-login.ts`
   for the Connect side and `mcp/connect-labs/auth/labs-oauth-login.ts`
   for the labs OAuth click-through — same Playwright session lib used
   by every other ACE login flow.)

## Process

For each selected persona (canned + opp-overlay set, optionally filtered
by `--persona` / `--personas`):

1. **Read the spec.** Load
   `7-synthetic/synthetic-walkthrough-spec_<persona>.yaml` from Drive
   via `drive_read_file`. If the file is missing, skip the persona with
   a `[WARN]` and continue (don't halt — partial decks are better than
   none).

2. **Stage the spec locally.** `canopy:walkthrough` reads specs from
   `docs/walkthroughs/<name>.yaml` in the current repo. Write the spec
   body to:

   ```
   ./docs/walkthroughs/<spec.name>.yaml
   ```

   …where `<spec.name>` is the YAML's `name` field (e.g.,
   `turmeric-funder-walkthrough`). Create the directory if needed.

   This is a transient local artifact — gitignored on a per-repo basis.
   Operators running this skill from outside an ace checkout will have
   their cwd's `docs/walkthroughs/` polluted; document that in the
   skill output if it happens.

3. **Dispatch `canopy:walkthrough`.** Invoke:

   ```
   /canopy:walkthrough <spec.name>
   ```

   The canopy skill handles auth (via the spec's `auth.command` block —
   which calls `bin/ace-labs-walkthrough-login`, since canopy v0.2.79
   walkthroughs targeting labs URLs use ACE's labs-OAuth helper, not
   ace-web's `/auth/e2e-login/` shared-secret bypass), browser setup,
   scene capture, per-scene `canopy:visual-judge` dispatch (5-dim
   Tough Judge scoring per scene), deck generation, and writes:

   - `screenshots/walkthroughs/<spec.name>.html` (deck)
   - `screenshots/walkthroughs/<spec.name>.json` (sidecar with scores)
   - `/tmp/walkthrough-screenshots/<name>-<timestamp>/scene_*.png`
     (per-scene PNGs)

   Capture the dispatch's exit status. If non-zero (auth failed, browse
   crashed, AI judge returned malformed output), surface the failure
   verbatim and skip to the next persona.

4. **Stage outputs into the run folder.**

   For each successful run, build:

   ```
   7-synthetic/walkthroughs/<persona>-<YYYYMMDD-HHMMSS>/
     slideshow.html
     scenes/
       scene_1.png ... scene_N.png
     eval.json
   ```

   Upload via:
   - `drive_create_folder` (find-or-create) for the per-persona folder
   - `drive_upload_binary` for each `.png` (mimeType `image/png`)
   - `drive_create_file` for `slideshow.html` (find-or-update; the
     gdrive MCP converts to a Google Doc — this is fine; viewers
     download to view as HTML)
   - `drive_create_file` for `eval.json`

   On any upload failure, halt this persona's run, leave partial state
   in Drive, and continue to the next persona. Surface the failure in
   the run summary.

5. **Append to
   `phases.synthetic-data-and-workflows.products.synthetic.walkthroughs[]`**
   in the current run's `run_state.yaml` via read-modify-write:

   1. `drive_read_file` on the current run's `run_state.yaml`;
      extract the existing `products.synthetic` block (this run's own
      writes only — there's no cross-run chain).
   2. Append the new entry to `walkthroughs[]`; keep sibling sub-keys
      (`enabled`, `current_*`, `workflows`, etc.) intact:

      ```yaml
      synthetic:
        # preserved siblings...
        walkthroughs:
          - persona: <persona>
            spec_artifact: <Drive ID of the spec YAML>
            slideshow_artifact: <Drive ID>
            eval_artifact: <Drive ID>
            scene_count: <int>
            eval_score: <float — average across scenes>
            run_at: <ISO>
      ```
   3. `update_yaml_file` with `merge: 'two-level'` on the full
      `phases.synthetic-data-and-workflows.outputs` payload.

   **No write to `opp.yaml.synthetic` — synthetic state is per-run only.**

   Within a run, re-runs of this skill (per-persona) APPEND new
   entries; never overwrite existing ones. The list grows within
   the run's walkthrough history.

6. **Update `run_state.yaml`.** Read-merge-write the per-persona step:

   ```yaml
   phases:
     synthetic-data-and-workflows:
       steps:
         synthetic-walkthrough-run:
           status: <done|partial>   # partial if any persona failed
           personas:
             <persona>:
               status: done
               eval_score: <float>
               run_at: <ISO>
               artifacts:
                 slideshow: <Drive ID>
                 eval: <Drive ID>
   ```

## MCP Tools Used

- Skill dispatch: `Skill(canopy:walkthrough)` (one per persona)
- `mcp__plugin_ace_ace-gdrive__drive_read_file`
- `mcp__plugin_ace_ace-gdrive__drive_create_folder`
- `mcp__plugin_ace_ace-gdrive__drive_create_file` (HTML deck + eval.json)
- `mcp__plugin_ace_ace-gdrive__drive_upload_binary` (screenshots)
- `mcp__plugin_ace_ace-gdrive__drive_update_file` (opp.yaml + run_state read-merge-write)
- Filesystem: read `personas/`; write `docs/walkthroughs/`; read canopy outputs

## Mode Behavior

- **Default:** run every persona for which a spec exists.
- **`--persona <name>`:** run a single persona. New timestamped folder;
  the previous run for that persona is retained in the
  `walkthroughs[]` list.
- **`--personas <comma-list>`:** run a subset.

## Dry-Run Behavior

`--dry-run` skips the `canopy:walkthrough` dispatch. It still stages the
spec to `docs/walkthroughs/`, writes a placeholder
`slideshow.html` to Drive (with content "DRY-RUN — no live browser
capture made"), and stamps `run_state` as `dry-run-success`. Useful for
flow-testing without browser load.

## Failure Modes

| Failure | Detection | Recovery |
|---|---|---|
| canopy plugin not installed | pre-flight halt | Install canopy plugin and retry. |
| `browse` binary missing | pre-flight halt | Run `cd ~/.claude/skills/browse && ./setup` and retry. |
| `ACE_HQ_USERNAME`/`PASSWORD` unset | pre-flight halt | Inject from 1Password via `op inject` (or `/ace:setup --force-env`). |
| Persona spec missing | step 1 warn → skip persona | Run `synthetic-walkthrough-spec` first or check that the persona name matches a written spec. |
| `canopy:walkthrough` returns non-zero (browser crash, auth failed, AI judge malformed) | step 3 surface + skip persona | Read the canopy output verbatim; common cases are stale browse session (kill and retry) or expired token (re-mirror). |
| One persona fails but others succeed | step 4 partial | Run summary marks `status: partial` and lists which personas need a retry. Re-run with `--persona <name>` to fix individually. |
| `walkthroughs[]` write race | step 5 revision_conflict | Read-merge-write retries once; on second conflict, halt and ask the operator to retry single-persona. |

## Related skills

- `synthetic-walkthrough-spec` — produces the per-persona specs this
  skill consumes.
- `canopy:walkthrough` — the upstream skill this dispatches; consult
  its `SKILL.md` for the full browser/AI contract.
- `synthetic-summary` — bundles links to each persona slideshow from
  the current run's `phases.synthetic-data-and-workflows.products.synthetic.walkthroughs[]`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-06 | Initial Stage 2 skill — canopy:walkthrough orchestration with per-persona append-only history | ACE team (Plan B Stage 2) |
| 2026-05-07 | Refresh prose to reflect canopy v0.2.79's `canopy:visual-judge` extraction: per-scene scoring is now via the visual-judge dispatch (not inline Tough Judge methodology). Note that polish-eval dispatches `canopy:visual-judge` directly with a different rubric — this skill itself stays a thin orchestrator that doesn't interact with `visual-judge` directly (canopy:walkthrough handles that internally per scene). | ACE team |
