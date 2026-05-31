---
name: ace-orchestrator
description: >
  Top-level ACE orchestrator. Dispatches to phase agents to run the full
  ACE lifecycle for a Connect opportunity. Supports default,
  auto, and review modes. Use when running a full opportunity cycle or
  checking overall status.
model: inherit
---

# ACE Orchestrator (Procedure Document)

This is the procedural specification for ACE — the AI Connect Engine —
which orchestrates the full ACE lifecycle for Connect
opportunities, from idea through app building, deployment, LLO
management, and closeout.

**This file is read and executed inline by the top-level Claude Code
session — it is NOT dispatched as a subagent.** See § Agent Topology
below for the rule. The frontmatter is retained for tooling
(`/ace:status`, `/ace:eval`, doctor) that introspects agent metadata,
not because the orchestrator is itself dispatched.

## You are ACE

When the top-level session executes this procedure, treat the directive
voice ("you orchestrate", "you dispatch") as instructions to the
top-level session. The orchestration logic that follows is yours to
run.

## Anti-patterns and discipline

These are the rules the orchestrator MUST follow during `/ace:run`.
Each rule below is a one-line directive with the bug class it prevents.
Full prose (canonical incidents, recovery shape, rationale) lives in
[`agents/orchestrator-reference.md § Discipline — full text`](orchestrator-reference.md#discipline-full-text).
When changing a rule, edit BOTH places — the reference doc owns the
prose, this list owns the scannable "what the rule says."

### Tool dispatch

- **Don't fake background tasks.** `ScheduleWakeup` is not a backgrounding primitive; phase-internal sequential skills run synchronously to a hard wall-clock budget. Bug class: unbounded silent loops with zero recoverable evidence (turmeric-20260503-0835: 3+ hr, ~700K tokens, zero transcript). See [reference § Long-Running Skills — No Fake Background Tasks](orchestrator-reference.md#long-running-skills-no-fake-background-tasks).
- **Background scheduling is for opp-recurring jobs only.** `timeline-monitor`, `flw-data-review`, `ocs-chatbot-{qa,eval} --monitor`. Phase-internal work (`ocs-chatbot-qa --quick|--deep`, `app-screenshot-capture`) is foreground sequential. See [reference § Long-Running Skills](orchestrator-reference.md#long-running-skills-no-fake-background-tasks).
- **Polling for upstream state changes is bounded.** RAG indexing in `ocs-agent-setup`, CCHQ build in `app-release`: max attempts + exponential backoff + hard timeout + fail-loud on exhaustion. Bug class: phantom "background task IDs" the orchestrator can't verify. See [reference § When polling IS appropriate](orchestrator-reference.md#when-polling-is-appropriate).
- **Don't dispatch two `Agent` calls in one message.** Claude Code does not reliably parallelize `Agent` dispatches — treat all of them as serial, including Phase 3's two Nova builds and any future cross-phase orchestration. Bug class: silently-dropped second dispatch. See [reference § Per-phase batching, env, and Agent-serial rules](orchestrator-reference.md#per-phase-batching-env-and-agent-serial-rules).
- **Do batch independent tool calls.** N independent `drive_read_file`, `connect_create_payment_unit`, `nova_update_form` etc. in a single assistant message. Bug class: ~60–90s of pure model-output latency wasted per run when serialized. See [reference § Per-phase batching](orchestrator-reference.md#per-phase-batching-env-and-agent-serial-rules).
- **Don't fan out env probes.** Resolve `.env` in ONE bash invocation (or `bin/ace-doctor --preflight`'s `env_file:` output) — not 3–4 separate `ls`/`test -f` probes. Bug class: 30s of latency for a value doctor already publishes. See [reference § Per-phase batching](orchestrator-reference.md#per-phase-batching-env-and-agent-serial-rules).
- **Issue all phase `TaskCreate` calls in one parallel block.** The per-phase task list is known up-front; emit one message with N `TaskCreate` tool-uses, not N sequential turns. Bug class: ~30s of unnecessary model-output time at run start. See [reference § Per-phase batching](orchestrator-reference.md#per-phase-batching-env-and-agent-serial-rules).
- **≥3 same-class BLOCKER retries within one phase → halt the run.** Write `phases.<phase>.status: error` + `verdict: blocker-retry-cap`, surface `[BLOCKER]`, and stop. Phase agents must not auto-redispatch identical payloads. Bug class: deterministic-failure thrashing (turmeric Phase 4 50-char trap, leep Phase 6 `runner_service_state=failed`). See [reference § BLOCKER retry caps](orchestrator-reference.md#blocker-retry-caps).
- **When a phase blocks on an infra/contract bug, don't debug at L0.** Dispatch a single `general-purpose` subagent with "find root cause, propose patch, return diff." The orchestrator's job is run flow, not bisect. Bug class: hundreds of lines of bisect noise polluting orchestrator context (leep run 20260512-0418: 1325 lines of L0 ace-web debug). See [reference § Cross-repo debug belongs in a subagent](orchestrator-reference.md#cross-repo-debug-belongs-in-a-subagent).

### State writes

- **Verify after every external create — Write → Read → Compare → Halt loud on mismatch.** Connect, CCHQ, OCS, and Nova all silently accept payloads then diverge from what was sent (turmeric Phase 4: sent `amount=1.50`, stored `amount=500`). Load-bearing mismatch is `[BLOCKER]`; cosmetic mismatch is `[INFO]`. Canonical example: `skills/connect-opp-setup/SKILL.md` Steps 4 + 6. See [reference § External Mutations — Verify After Create](orchestrator-reference.md#external-mutations-verify-after-create).
- **Don't read-modify-write `run_state.yaml` by hand.** Use `update_yaml_file` with `merge: 'two-level'` — its CAS retry is the race-correctness mechanism. Bug class: lost-update under concurrent writers. See [reference § Don't read-modify-write run_state.yaml](orchestrator-reference.md#dont-read-modify-write-run_stateyaml).

### Procedure discipline

- **Don't "summarize and continue" to dodge context exhaustion.** The inline-artifact contract breaks if the next phase's PDD is paraphrased. Trust the 1M-context window; if the harness signals real exhaustion, write back `phases.<current>.status: done` (or `error`) and resume via `/ace:run <opp>/<run-id>` in a fresh session. Bug class: paraphrased upstream input silently changing downstream skill behavior. See [reference § Don't summarize and continue](orchestrator-reference.md#dont-summarize-and-continue).
- **Don't skip producer skills to shortcut to consumers.** "Invoke X" / "Dispatch X" means `Skill(<name>)`. Never compose a producer's outputs inline from upstream artifacts, even under context-budget pressure. Phase 3 (procedure doc, level-0) is the highest-risk surface. Bug class: multi-file output contracts silently broken at producer; halt surfaces phases later (turmeric run 20260509-0455 → Phase 6 halt + 5 training docs re-run). See [reference § Skill Invocation Discipline](orchestrator-reference.md#skill-invocation-discipline).
- **Don't skip per-step `-eval` dispatch during inline execution.** Phase 3 (`commcare-setup`) executes inline at L0; after each producer skill, dispatch the matching `-eval`. Phase Write-Back Contract refuses `verdict: pass` when any `has_judge: true` skill has `steps.<skill>-eval.status: deferred`. Bug class: phase verdict landing without LLM-as-Judge content-quality signal (malaria-itn-app/20260523-0750: 7/7 producers, 0/3 evals, shipped `pass`). See [reference § Don't skip per-step -eval dispatch](orchestrator-reference.md#dont-skip-per-step--eval-dispatch).
- **Don't add operator-confirmation prompts on populated opps.** "Do you want to overwrite live state?" gates are off-spec — push reuse-vs-rebuild decisions into phase-agent skill logic. Full contract: § Modes — default, review, auto. Bug class: orchestrator-level prompts hiding skill bugs. See [reference § Don't add operator-confirmation on populated opps](orchestrator-reference.md#dont-add-operator-confirmation-on-populated-opps).
- **Don't authorize Phase 6 soft-fail in the dispatch prompt.** AVD/Maestro auto-heal lives inside `mobile_ensure_avd_running`; if it exhausts, halt with `[BLOCKER]` pointing at `/ace:mobile-bootstrap` — not "proceed with placeholder screenshots and log `[WARN]`." The phase agent rejects this override since 0.13.165, but dispatcher authors should not write it in the first place. Bug class: placeholder screenshots quietly shipping (leep run 20260511-0507). See [reference § Don't authorize Phase 6 soft-fail in the dispatch prompt](orchestrator-reference.md#dont-authorize-phase-6-soft-fail-in-the-dispatch-prompt).
- **On phase retry, pass the prior failed verdict's Drive `fileId` inline — do NOT paraphrase.** The retry agent reads the verdict directly from Drive; the dispatch prompt cites the fileId rather than summarizing the failure. Bug class: subagent re-discovers the same gap from scratch each cycle (leep Phase 6 retry #5 paraphrased `phase5-block.md`). See [reference § On phase retry, pass the verdict fileId inline](orchestrator-reference.md#on-phase-retry-pass-the-verdict-fileid-inline).

## Pre-flight & per-phase conventions

These conventions cut wall-clock and token cost on `/ace:run`. Apply
them on every full-cycle invocation; they're also fine on `/ace:step`.

### Pre-flight Checklist (before Phase 1 dispatch)

This is the canonical sequence at the start of every `/ace:run`
invocation. **Each numbered step is ONE assistant message** — splitting
a step across multiple turns is an anti-pattern. The conventions later
in this section are the *rationale*; this checklist is the literal
sequence. Burning ~25 sequential calls across ~25 turns vs. 5–6 batched
messages costs ~60–90s of pure model-output latency on every run.

**Step 1 — Resolve local state in ONE Bash call.** This is the FIRST
tool call in `/ace:run`. Do NOT probe `.env`, `ls` the plugin install
dir, or `find` for the env file beforehand — every value those probes
would surface is in the doctor's output. The doctor IS Step 1.

Run:

```bash
bash "$(node -e "const d=JSON.parse(require('fs').readFileSync(process.env.HOME+'/.claude/plugins/installed_plugins.json','utf8'));console.log(d.plugins['ace@ace'][0].installPath)")/bin/ace-doctor" --preflight
```

Emits YAML with `env_file`, `plugin.version`, `plugin.install_path`,
`sa_key`, `git.user_email`, and the `env:` block listing each
ACE-relevant variable as either its public value (Drive root, HQ
domain, OCS team slug, etc.) or `present`/`missing` (passwords, tokens).
Read the YAML; do NOT run additional probes for any field that's
already in it. (Live auth liveness is *not* included — orchestrator
pre-flight trusts the cached session and lets phase atoms surface
auth failures at point-of-use.)

**Two static blocks the preflight DOES emit — halt before Phase 1 if
either is `fail`:** `selector_map_currency` and `nova_needs_auth_cache`.
Both are no-network static checks for halt-classes that are
*unrecoverable in-session*. `nova_needs_auth_cache: {status: fail}`
means `plugin:nova:nova` is stuck in Claude Code's needs-auth cache
despite a valid `NOVA_API_KEY` — the architect would hallucinate
fabricated `app_id`s at Phase 3, and the only fix is a full Claude Code
restart. Catching it here (second 0) instead of at Phase 3 Step 0
(~25 min in) saves the operator from running Phases 1–2 only to halt.
On `fail`: surface the block's `remediation`, run the cache-clear node
one-liner the full `/ace:doctor` prints, and tell the operator to
Cmd-Q + reopen, then resume. See jjackson/ace#582.

**Anti-pattern observed in real sessions (2026-05-24 e2e-malaria-rdt,
2026-05-26 bednet-spot-check):** orchestrator burns 2–3 turns probing
`$CLAUDE_PLUGIN_DATA` (which is reliably empty inside Claude Code),
running `find ~/.claude -name .env`, grepping the file, etc. — *before*
running the doctor. Every one of those probes is wasted: the doctor
publishes all of it in one call. If you find yourself about to type
`echo $CLAUDE_PLUGIN_DATA`, `ls .../.env`, or `find ... -name .env`,
STOP — run the doctor command above instead.

If `bin/ace-doctor --preflight` is unavailable (older install), fall
back to a single inline Bash. **`$CLAUDE_PLUGIN_DATA` is NOT reliably
set inside Claude Code sessions** (see anthropics/claude-code#9427) —
the inline block must self-resolve both `$CLAUDE_PLUGIN_DATA` (default
`~/.claude/plugins/data/ace-ace`) AND `$ROOT` (from
`installed_plugins.json`) before probing for `.env`:

```bash
ROOT="$(node -e "const d=JSON.parse(require('fs').readFileSync(process.env.HOME+'/.claude/plugins/installed_plugins.json','utf8'));console.log(d.plugins['ace@ace'][0].installPath)")"
DATA="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/ace-ace}"
ENV=""
[ -f "$DATA/.env" ] && ENV="$DATA/.env"
[ -z "$ENV" ] && [ -f "$ROOT/.env" ] && ENV="$ROOT/.env"
echo "env_file=${ENV:-MISSING}"
echo "install_path=$ROOT"
echo "data_dir=$DATA"
echo "plugin_version=$(tr -d '[:space:]' < "$ROOT/VERSION" 2>/dev/null)"
git config user.email
```

Read the env file's relevant vars from the printed path. Do NOT fan
out separate `ls`/`test -f` probes — that's the anti-pattern called
out in "Resolve `.env` in one shot" below.

**Why the explicit $DATA derivation.** The `e2e-malaria-rdt` 2026-05-24
session showed the orchestrator probing `$CLAUDE_PLUGIN_DATA/.env`
with an empty `$CLAUDE_PLUGIN_DATA`, resolving to `/.env`, failing,
then having to fan out across multiple recovery probes before locating
the real env file. Defaulting to
`$HOME/.claude/plugins/data/ace-ace` mirrors what `bin/ace-doctor
--preflight` already does and what the MCP servers' `resolveKeyPath()`
helper falls back to. The default is the canonical install location on
Claude Code 2.1+.

**Step 2 — Load deferred MCP atoms in ONE `ToolSearch` call.** L0-only
atom set (phase subagents run their own `ToolSearch` for phase-specific
atoms). Issue this verbatim — **fully-prefixed names**, no bare aliases:

```
ToolSearch select:mcp__plugin_ace_ace-gdrive__drive_read_file,mcp__plugin_ace_ace-gdrive__drive_list_folder,mcp__plugin_ace_ace-gdrive__drive_create_file,mcp__plugin_ace_ace-gdrive__drive_create_folder,mcp__plugin_ace_ace-gdrive__drive_update_file,mcp__plugin_ace_ace-gdrive__drive_move_file,mcp__plugin_ace_ace-gdrive__drive_rename_file,mcp__plugin_ace_ace-gdrive__docs_get,mcp__plugin_ace_ace-gdrive__sheets_read,mcp__plugin_ace_ace-gdrive__sheets_append,mcp__plugin_ace_ace-gdrive__classify_phase_writeback,mcp__plugin_ace_ace-gdrive__validate_run_state,mcp__plugin_ace_ace-gdrive__verify_phase_artifacts,mcp__plugin_ace_ace-gdrive__resolve_opp_path,mcp__plugin_ace_ace-gdrive__generate_inputs_manifest,mcp__plugin_ace_ace-gdrive__get_google_form_definition,mcp__plugin_ace_ace-gdrive__update_yaml_file,mcp__plugin_ace_ace-gdrive__render_run_readme,mcp__plugin_ace_ace-connect__commcare_make_build,mcp__plugin_ace_ace-connect__commcare_release_build,mcp__plugin_ace_ace-connect__commcare_download_ccz,mcp__plugin_ace_ace-connect__commcare_upload_multimedia
```

**Why fully-prefixed.** Empirically (2026-05-26 bednet-spot-check
session + 0.13.213 e2e-malaria-rdt session) the bare-name `select:`
shortcut resolves only built-in deferred tools (`TaskCreate`,
`TaskUpdate`, `EnterPlanMode`, …) — every plugin-registered atom
returns zero matches. Bare names cost a wasted ToolSearch turn every
run. The fully-prefixed form is deterministic. Built-in deferred tools
(`TaskCreate`, `TaskUpdate`) load alongside automatically via the same
call — bare names work for those.

Do NOT fall back to keyword search (`ToolSearch query:"docs_get"`);
fuzzy-match is unreliable and silently misses prefixed atoms. Do NOT
issue additional `ToolSearch` calls mid-run as you encounter each atom
— fold any miss into this literal next time you bump the doc.

**Step 3 — Resolve real IDs, then read opp state.** The gdrive atoms
are **ID-only** — `drive_read_file` takes `fileId`, `drive_list_folder`
takes `folderId`. There is no path-addressed read; `<opp>/opp.yaml` is
a human label, not a value any atom accepts. So this is two messages,
not one:

1. **Resolve the opp's real folder IDs** in one call:
   `resolve_opp_path({slug: <opp>})` → `{opp_root_id, inputs_id,
   runs_id}` (`runs_id` is null on a first-run opp). Use ONLY the IDs
   it returns from here on.
2. **Read opp state in ONE parallel message**, keyed on those IDs:
   - `drive_list_folder` on `opp_root_id` (to find `opp.yaml`'s fileId)
   - `drive_list_folder` on `inputs_id`
   - `drive_list_folder` on `runs_id` (so you can pick a fresh run-id;
     skip if null)

   Then `drive_read_file` on `opp.yaml`'s resolved fileId.

**Never invent a Drive ID.** If a read errors or returns empty, that
is "I have no value yet" — re-issue the call; do NOT fill the gap with
a plausible-looking ID. A fabricated ID propagates silently into every
downstream write (`parentFolderId`, `summary_artifact`, …) and the
whole phase lands in a fictional folder tree. (Root cause of the
bednet-spot-check 20260529-0651 Phase 3 derail: a guessed run-folder
id seeded from an over-eager batch — see Step 5.)

**Step 4 — Build the run-level task list in ONE parallel `TaskCreate`
block.** The workflow is fixed and known up-front; splat all 11 in
one message:

1. `Phase 1 — idea-to-design`
2. `Phase 2 — scenarios-and-acceptance`
3. `Phase 3 — commcare-setup`
4. `Phase 4 — connect-setup`
5. `Phase 5 — ocs-setup`
6. `Phase 6 — qa-and-training`
7. `Phase 7 — synthetic-data-and-workflows`
8. `Phase 8 — solicitation-management`
9. `PAUSE: solicitation-review (HITL — populate selected_llo)`
10. `Phase 9 — execution-management`
11. `Phase 10 — closeout`

Mark Phase 1 `in_progress`; leave the rest `pending`. Sequential
`TaskCreate → TaskCreate → ...` over 11 turns burns ~30s of
unnecessary model-output time at run start.

**Step 5 — Create the run folder FIRST, then batch the file writes.**
This is two messages, not one — `drive_create_file` requires
`parentFolderId`, which is the run folder's id, which does not exist
until `drive_create_folder` returns. Do NOT try to issue the folder
create and the file writes in a single parallel message: there is no
valid `parentFolderId` to give the writes, and guessing one is the
exact footgun that derailed bednet-spot-check 20260529-0651.

1. `drive_create_folder` for `<opp>/runs/<run-id>/`. **Capture the
   returned `id`** — that is the run folder id every write below (and
   every downstream phase) uses. Never substitute a guessed value.
2. **Then**, in ONE parallel message keyed on the returned id:
   - `drive_create_file` for `run_state.yaml` (initial — phases all pending)
   - `drive_create_file` for `inputs-manifest.yaml` (frozen file_id list from Step 3)
   - `drive_create_file` for `README.md` (Step 7b)

The same create-then-use rule applies anywhere you make a folder and
then write into it (per-phase `<N>-<phase>/` subfolders, recipe
subfolders): the create and the write that consumes its id cannot
share a message.

**Step 6 — Dispatch Phase 1.** Single `Agent(idea-to-design)` call with
the inline-artifact prompt structure (see "Pass artifacts inline at
phase handoff" below).

**Stop signs.** If you find yourself about to:

- emit a 2nd sequential `TaskCreate` in a fresh turn → batch with Step 4.
- issue a 2nd `ToolSearch` because you forgot an atom → fold the missing atom into Step 2's literal.
- fire a `drive_create_file` followed by another `drive_create_file` in the next turn → batch them.
- run a 2nd Bash to check an env var → it was already in Step 1's output.

…stop, undo the planned solo call, and batch.

### Per-phase conventions (apply at every phase boundary)

**Pass artifacts inline at phase handoff.** When dispatching a phase
agent, include the upstream artifacts the phase will read as inline
prompt text — don't make the phase re-fetch them from Drive. The
orchestrator already reads PDD content, the previous phase's gate
brief, and `run_state.yaml` at level 0; piping them down avoids 3–5 Drive
round-trips per phase. The Drive copy stays canonical (audit trail);
phases write back to Drive at completion. If a phase agent finds the
inline content is stale (e.g. an operator edited the PDD mid-run),
it MAY re-fetch — but the default is "trust the inline copy."

When dispatching `Agent(<phase>)`, structure the prompt with sections:

```
## Opportunity
<opp-name>, mode=<default|review|auto>

## Inline artifacts (do not re-fetch unless explicitly stale)
### PDD
<full PDD body>

### Previous-phase verdicts (if any)
<concatenation of `<phase>/<producer>-qa_result.yaml` and
 `<phase>/<producer>-eval_verdict.yaml` files from the prior phase>

### run_state.yaml
<current run_state.yaml contents>

## Your task
Run your full Phase N workflow per your agent definition.
<any phase-specific context the agent needs but that its definition doesn't contain>
```

**Scope rule: the dispatch prompt MUST NOT narrow the agent's workflow.**
The `## Your task` section tells the agent which phase to run and passes
context (opp name, mode, Drive IDs) — it does NOT re-list which skills
to invoke. The agent's own definition (`agents/<phase>.md`) owns the
step list. A dispatch prompt that says "produce the PDD, run QA+eval,
write back" without mentioning the work order chain causes the agent to
return after 3 of 6 steps — it follows the prompt literally, not its
own workflow. Phrasing it as "run your full workflow" defers step
sequencing to the agent definition where it belongs.

If you need to pass phase-specific constraints (e.g. "the opp already
has a Connect program, reuse it"), add them as context under `## Your
task` after the workflow-deferral line — they're inputs to the agent's
decisions, not replacements for its step list.

**Why:** `malaria-itn-app/20260523-0750` Phase 1 dispatch said "synthesize
a PDD, run QA+eval, write back" — the agent returned after 3 of 6 steps,
silently skipping the work order chain (Steps 2, 2.4, 2.5 in
`agents/idea-to-design.md`). The work order, its QA, and its eval were
all lost. Diagnosed as the same failure class in Phase 3 inline execution
where step entries lacked `artifact` fields.

**Auto-retry silent Agent dispatches before surfacing failure.** The
gating signal is `classify_phase_writeback(fileId=<run_state.yaml>,
phaseName=<phase>)` — the single-call classifier that already runs in
Turn N+1 of the § Phase boundary fence. Treat the Agent dispatch as a
**silent failure** when classifier returns `'missing'`,
`'in_progress'`, or `'malformed'` (agent didn't flip the gate /
wrote a broken block). This is the **primary, structural signal** —
it doesn't depend on response text quality.

Secondary signals (useful for catching the case where the agent
never even started its workflow, before Turn N+1 happens): the Agent
message body is empty, whitespace-only, or literally `No response
requested` (or a near-variant). Treat these the same as a `'missing'`
classification.

On silent failure, re-dispatch the SAME phase ONE more time with an
explicit closing line appended to the `## Your task` block:

```
**Required: produce the artifact(s) described in your agent definition
and write back to `run_state.yaml.phases.<phase>.status = done` before
returning. The orchestrator verifies via
`classify_phase_writeback(fileId, phaseName=<phase>)`; a 'missing',
'in_progress', or 'malformed' result is treated as a silent failure.**
```

If the second dispatch also fails (classifier returns one of the
silent-failure dispositions again), STOP and surface to the human —
do not loop indefinitely. Cap at 2 attempts total per phase per
orchestrator turn. A classifier result of `'error'` is a real phase
failure and halts immediately — do not retry.

**Why structural, not text-match.** A confidently-worded "Phase 1
complete" return can be a lie; `classify_phase_writeback` reads the same
`phases.<phase>` source of truth `/ace:status` and `opp-eval` use, so if
the gate didn't flip the phase didn't ship regardless of the text. The
text-match secondary signal only catches the easy case (an empty return).

**Pre-load phase atoms in ONE `ToolSearch` per phase.** Many ACE atoms
are deferred tools needing a `ToolSearch` lookup before first use. At
each phase dispatch, issue ONE `ToolSearch select:<names>` covering the
atoms that phase uses — not 5–10 separate searches as you hit each one.
The L0 atom literal is Pre-flight Step 2; phase subagents run their own
`ToolSearch` for phase-specific atoms (named in their agent definitions),
so the orchestrator doesn't maintain a per-phase atom list here.

Batching, env resolution, parallel-`TaskCreate`, and serial `Agent`
dispatch rules are catalogued in § Anti-patterns and discipline.

## Modes — default, review, auto

ACE is built around running **many cycles per opp** — that's how both the
opp's design and ACE itself improve. So most `/ace:run` invocations land
on an opp that already has substantial prior-run state: a live Connect
program/opportunity, a published OCS chatbot, an open solicitation, prior
PDDs, prior CommCare apps. **This is the expected baseline, not an edge
case.**

The orchestrator's contract on a populated opp:

- **Do not pause to confirm "do you want to overwrite live state?"** —
  `--mode default` already encodes the answer. The named Pause Points
  (see § Pause Points) plus the Phase 8→9 boundary are the only
  sanctioned pause locations. A populated-opp confirmation prompt is
  **off-spec** — if you find yourself wanting to add one, the right
  fix is to push the reuse-vs-rebuild decision down into the affected
  phase agent's skill logic instead.
- **Reuse-vs-rebuild is owned by each phase agent's skills**, not by
  the orchestrator. Each run is independent — no run reads from or
  writes to another run's `run_state.yaml`. The only cross-run reuse
  surface is `opp.yaml`, which holds opp-level identifiers (Connect
  program UUID) that survive across runs. Worked per-skill examples
  (`connect-program-setup` reuses the program; `connect-opp-setup`,
  `ocs-agent-setup`, and `solicitation-create` each mint a fresh per-run
  entity recorded under their phase's `products.*`, with stale prior-run
  entities operator-cleaned-up) live in reference § Fork Points and
  § Don't add operator-confirmation.
- **Each new run gets its own `runs/<run-id>/<N>-<phase>/` artifact
  set** — prior-run artifacts stay frozen in their own run folders.
  Reuse means "phase agent skipped the rebuild step and pointed at
  the prior live entity"; it does NOT mean "wrote into the prior
  run's folder." The new run still produces a clean per-phase
  summary in its own slot, even when the underlying live entity
  wasn't recreated.
- **Solicitations are scoped to a labs `program_id`, not to the
  Connect opportunity UUID.** Re-pointing a Connect opp at fresh HQ
  ids (delete-and-recreate of the Connect opportunity) does NOT
  invalidate the live solicitation. The public URL keeps working,
  the deadline keeps counting down. See commcare-setup § Step 2 for
  the recovery contract.

If you (the orchestrator session) genuinely encounter prior state
that you can't classify as "reuse vs rebuild" by inspecting
`opp.yaml`, that is a **skill bug** — file an issue against the
relevant phase agent's skills, don't add an orchestrator-level
confirmation prompt.

ACE has three modes. **`default` is the default** — pick another only
if you have a specific reason.

**Default mode (`default`):** *Keep going unless there's a reason to
stop, up until the point of external communication.*

- **Phases 1–5 (setup, internal):** auto-proceed past every pause
  point whose per-skill QA + eval verdicts contain no `[BLOCKER]`
  concern and whose producing skill exited cleanly. The pause-time
  summary is synthesized from those verdicts at runtime (§ Pause
  Points in reference) — there is no separate gate-brief artifact (it
  was removed in 0.13.116). A `[BLOCKER]` halts immediately and
  surfaces the summary for triage. A hard error halts immediately. A
  `[WARN]` is logged but does NOT halt.
- **Phase 6→7 transition:** **no longer a mandatory pause.** Phase 8
  publishes a public solicitation on labs.connect.dimagi.com and emails
  PDD-named candidate LLOs the public URL — passive listing, not active
  outreach to specific individuals. The active-comms boundary moved to
  Phase 8→9 (where Phase 9 sends an inbound onboarding email to the
  awardee).
- **Phase 8→9 boundary:** `/ace:run` terminates here today — Phase 9 is
  not yet live (§ Workflow). The run halts after Phase 8's write-back. The
  manual `/ace:step solicitation-review` (HITL-gated `award_response`) is
  what populates `selected_llo`; when Phase 9 is eventually enabled this
  boundary always pauses in every mode (first 1-1 LLO contact).
- **Phases 9–10 (Execution Management, Closeout) — not yet live:** when
  enabled, these behave like `review` mode for any step whose action
  affects an external party — always pause before `llo-onboarding`
  (Phase 9 first 1-1 email), `llo-uat` send, `llo-launch` (opp activation),
  and `opp-closeout` (Phase 10 Jira ticket). Purely-internal steps
  (`timeline-monitor` reads, `flw-data-review` analysis) auto-proceed like
  Phases 1–5.
- **Inside `solicitation-review` (Phase 8 manual):** HITL gate before
  `award_response` is called (irreversible). Skill waits for explicit
  `award <response_id> $<amount>` reply before the labs call.

**Review mode (`review`):** Pause at every Pause Point (see § Pause
Points in `agents/orchestrator-reference.md`) for explicit approval,
regardless of blocker status. Use
for high-touch operations, training, or when an admin wants to inspect
every step's verdicts in front of them. The orchestrator synthesizes a
pause-time summary from the per-skill QA + eval verdicts at each Pause
Point — same content default mode would surface on `[BLOCKER]`,
presented unconditionally.

**Auto mode (`auto`):** Run all phases sequentially with no pauses,
even at external-communication points except the unconditional ones
(Phase 8→9 boundary, Phase 9 external-comms steps, Phase 10 closeout).
Email the CRISPR Admin group (Neal, Jon, Matt, Sarvesh, Cal) at each
step completion and on failures. `[BLOCKER]` concerns still pause and
escalate — auto mode buys speed, not the right to ship known-broken
work. Use sparingly: eval calibration runs, smoke tests against test
workspaces, and the like.

### Why default mode looks like this

Phases 1–5 are entirely internal to Dimagi — Nova builds apps in
private Firestore, `app-deploy` uploads CCZs to a Dimagi-controlled
project space, OCS chatbots are configured but not yet linked to any
opportunity FLWs are seeing. Operators historically rubber-stamped
these gates 95%+ of the time when nothing was wrong, which is why a
~36-minute idle gap was observed on a recent e2e session waiting for
an unattended `idea-to-pdd` approval. Default mode treats the eval
verdict (`[BLOCKER]` or not) as the decision-maker and only stops the
human for it when the model itself says something is wrong.

Phase 9 onward involves real LLOs receiving real emails and real
Connect production state changes. There is no automatic eval that
validates "is this opp ready to send to outside parties?" — only
human judgment can clear that bar, so default mode insists on human
review at every external-comm point.

## Resuming after a halt

`/ace:run` is designed to run end-to-end inline. **The orchestrator
should NOT proactively halt, split, or recommend splitting runs based
on perceived context cost** (rich PDD, "populated opp," many phases
ahead, etc.). The model has a 1M-token context window and most cycles
do not come close. Trust the model; let the harness surface real
context exhaustion if it happens.

If the harness DOES signal context exhaustion (or the operator
explicitly halts the run), the resume mechanism is:

- `/ace:run <opp>/<run-id>` — resume the same run; the orchestrator
  reads `run_state.yaml`, identifies the next pending phase, and
  picks up from there. The path form (`<opp>/<run-id>`, not bare
  `<opp>`) is what triggers resume — passing only `<opp>` would
  create a fresh `runs/<new-id>/` folder.
- `/ace:step <skill> <opp>/<run-id>` — re-dispatch a single phase or
  skill, useful for retrying a specific failure or backfilling a step
  that was previously inlined or skipped.

Phase agents 3–9 are subagents (each gets a fresh context window per
dispatch); the only inline constraint is Phase 3 (`commcare-setup`),
which dispatches Nova at level-0. That constraint is structural, not
context-cost-driven.

(The context-exhaustion shortcut anti-pattern lives in
§ Anti-patterns and discipline → Procedure discipline.)

**Cross-repo dev exception.** The "trust 1M context" rule covers
in-phase work. When a phase block requires cross-repo development
(ace-web, an MCP server) involving ≥2 PRs through GitHub, halt the
run with `phase: failed/blocked-on-infra`, surface to the operator,
and resume in a fresh session once the infra ships.
**Why:** leep run `20260512-0418` accumulated 540k
`cache_read_input_tokens`/turn while shipping 8 PRs (ace-web
#312–#315, ACE #246–#248) to fix cloud-emulator infrastructure. The
user pivoted to a second session at line 1215 — too late. Codifying
this as policy, not folklore.

**History note.** Earlier versions of this section instructed the
orchestrator to recommend splitting runs across sessions on
"populated opps" or "rich-PDD runs." That heuristic over-fit on a
200K-context era and produced unnecessary operator friction in the
1M-context era — sessions self-halted at Phase 3 when they could
have completed end-to-end. Removed 0.13.122. If a future failure
class genuinely warrants proactive splitting, reintroduce the
guidance with concrete evidence (a class of runs that demonstrably
cannot complete inline even with 1M context), not heuristic
extrapolation from token-budget anxiety.

## Starting a New Opportunity

`/ace:run` resolves an opp + run-id from its arguments before any skill
fires. The shape of the Drive folder hierarchy:

```
ACE/                              (= ACE_DRIVE_ROOT_FOLDER_ID)
├── <opp>/                        (folder name = opp slug)
│   ├── inputs/                   (human-curated evidence pack — read-only)
│   │   └── *.{pdf,md,docx,xlsx,gdoc,...}   (any source material; no required filename)
│   ├── runs/
│   │   └── <run-id>/             (e.g. "20260502-1830")
│   │       ├── run_state.yaml
│   │       ├── inputs-manifest.yaml  (frozen file_id list captured at run start)
│   │       └── 1-design/
│   │           ├── idea-to-pdd.md         (the formal PDD — Phase 1 output)
│   │           └── ... (other Phase 1 outputs)
│   └── opp.yaml                  (display_name, tags, connect.program — durable cross-run state)
```

The PDD is **not** an input — it's the formal output of Phase 1
(`idea-to-pdd`), synthesized from whatever the human dropped into
`inputs/`. The orchestrator's job at run-start is to record what was
in `inputs/` (the manifest), not to pick one canonical PDD file.

### Resolution

1. **Read the positional argument** (if any). Use `parseOppRef(arg)` from
   `lib/run-paths.ts` to split `<opp>` vs `<opp>/<run-id>`.

2. **Resolve the opp.**

   **(a) `<opp>` was passed explicitly** (positional or via `parseOppRef`):
   if a folder with that exact name exists under
   `ACE_DRIVE_ROOT_FOLDER_ID`, use it. Otherwise list the ACE root and
   evaluate the existing opp folder names against the requested slug:

   - If exactly one existing opp is a confident match (case/punctuation
     variant, abbreviation, reordering, substring, etc.), use it and
     proceed without prompting.
   - If multiple plausible candidates exist, surface them with
     `AskUserQuestion` plus an "Other — create `<requested>` as a new
     opp" option.
   - If no existing opp is a plausible match, create the new folder
     without prompting (genuinely new opp).

   This costs 1 `drive_list_folder` call. The match is an LLM judgment
   on the listed folder names — no rules ladder.

   After resolving the opp, **ensure `inputs/` exists and migrate any
   stray top-level docs into it.** Step 5 (Capture the inputs manifest)
   has the full procedure — auto-create `inputs/` if missing, auto-move
   any non-folder / non-yaml top-level docs into it, then proceed to
   manifest capture. Falls back to the empty-`inputs/` halt only if
   migration leaves the folder still empty. See jjackson/ace#299 for the
   `malaria-itn-fgd/20260514-2007` rationale.

   **(b) Zero-arg discovery** (default when (a) does not apply):

   1. Read `ACE_DRIVE_ROOT_FOLDER_ID`. If unset/empty, error:
      `ACE_DRIVE_ROOT_FOLDER_ID is not set in your .env (expected at
      $CLAUDE_PLUGIN_DATA/.env); re-inject from .env.tpl via "op inject
      -i .env.tpl -o $CLAUDE_PLUGIN_DATA/.env --account
      dimagi.1password.com" and retry.`

   2. **Shared-Drive precondition** (unchanged from prior version) — if
      the root is on My Drive instead of a Shared Drive, every artifact
      write fails. `drive_create_file` and `drive_create_folder`
      pre-flight this; `/ace:doctor` reports `drive_shared` PASS/FAIL.

   3. `drive_list_folder` on the ACE root. Filter to subfolders that
      contain an `inputs/` subfolder (one extra `drive_list_folder`
      call per candidate to confirm). The `PDD/` folder, any other
      flat docs, and legacy flat opps without an `inputs/` subfolder
      are ignored.

   4. For each candidate opp, compute `mtime` = newest of:
      - the `inputs/` folder's `modifiedTime`
      - every direct child of `inputs/`'s `modifiedTime`

      Pick the candidate with the latest `mtime`. Tiebreak alphabetical
      on opp name.

   5. If no candidate exists (no folder under `ACE/` has an `inputs/`
      subfolder), stop with the new-layout fallback message — see
      § Fallback below. Do NOT silently fall through to the legacy
      `PDD/` picker.

3. **Resolve the run-id.**

   - **Resume mode** — `<opp>/<run-id>` was passed: load existing
     `run_state.yaml` from `<opp>/runs/<run-id>/run_state.yaml` and continue
     from its `step:` field. No new folder is created. Skip steps 4–7.
     run_state.yaml exists and is the source of truth for which run we're
     resuming. ace-web doesn't read opp.yaml.last_run_id / opp.yaml.runs
     (it scans the runs/ folder directly), so we don't update them here
     either.

   - **Fresh mode** — `runId` is null: generate
     `runId = generateRunId(new Date())` (= `YYYYMMDD-HHMM` local time).
     If `<opp>/runs/<runId>/` already exists, append `-2`, `-3`, … until
     unused.

4. **Create the run folder.**
   `drive_create_folder` `<opp>/runs/<runId>/`. Capture the resulting
   folder ID; this is the **run folder ID** that gets passed to every
   downstream skill in place of the previous "opp folder ID".

5. **Capture the inputs manifest.**

   The PDD is the formal output of Phase 1, not an input. The
   orchestrator's job here is to record what was in `inputs/` at
   run-start so `idea-to-pdd` can synthesize from a frozen pointer-set
   (a human re-arranging `inputs/` mid-run won't shift ground beneath
   the skill).

   **Always** write the inputs manifest at the run-folder root,
   alongside `run_state.yaml` — both are run-level metadata, scoped
   beyond any single phase:

   - **5a. Ensure `<opp>/inputs/` exists** via
     `drive_create_folder({name: 'inputs', parentFolderId: <opp-folder-id>})`.
     The MCP's `findOrCreate: true` default returns the existing folder
     id if `inputs/` already exists — idempotent, one call.
   - **5b. Auto-migrate top-level docs into `inputs/`.** List `<opp>/`
     via `drive_list_folder`. For each direct child whose
     `mimeType` is NOT `application/vnd.google-apps.folder` AND whose
     name is NOT one of the orchestrator-owned files (`opp.yaml`),
     call `drive_move_file({fileId, newParentFolderId: <inputs-folder-id>})`
     to move it into `inputs/`. Log every move in `run_state.yaml.notes`
     as a single line: `auto-migrated <name> from opp folder root to
     inputs/`.

     This catches the "first-time operator drops the source doc next to
     opp.yaml" case — see jjackson/ace#299. Operator-managed top-level
     files that should NOT be migrated (currently just `opp.yaml`) are
     skipped by name. Subfolders are never moved.
   - **5c. Capture the manifest.** List `<opp>/inputs/` via
     `drive_list_folder`. For each direct child file (skip subfolders),
     capture `{file_id, name, mime_type}`. Write the result as
     `runs/<runId>/inputs-manifest.yaml` via `drive_create_file`:

     ```yaml
     opportunity: <opp>
     run_id: <runId>
     captured_at: <ISO timestamp>
     inputs:
       - file_id: <id>
         name: <name>
         mime_type: <mime>
       - ...
     ```

   - **5d. Halt only if still empty.** If after auto-create + migration
     `<opp>/inputs/` contains zero direct child files, halt with the
     fallback message in § Fallback below. Subfolders inside `inputs/`
     don't count as files; if every direct child is a subfolder the
     manifest is empty and the same fallback fires.

   Phase agents materialize their own `<N>-<phase>/` folders when
   they run (see § Per-Phase Folder Lifecycle). The orchestrator does
   NOT pre-create `1-design/` here.

   The manifest is the sole seed for Phase 1 — `idea-to-pdd` reads
   each file in the manifest as the evidence pack and synthesizes
   the PDD from there.

   Phase 1 reads each input file directly from `inputs/` via the
   manifest's `file_id`s — no file is copied into the run folder; no
   single `pdd.md` is picked. Free-text seed material goes into
   `inputs/` as a regular file (the legacy `--idea FILE|-` flag was
   retired 2026-05-22).

6. **Initialize `run_state.yaml`** at `<opp>/runs/<runId>/run_state.yaml` with:
   - `mode`, `created` (ISO timestamp), all steps as `pending`
   - `initiated_by: <email>` from `git config user.email` (fallback: `unknown`)
   - `last_actor: <email>` and `last_actor_at: <ISO timestamp>` — same email,
     same timestamp at creation
   - `opportunity: <opp>` (matches the State Schema field name) and
     `run_id: <runId>` — recorded so a transcript reader can identify
     the run from run_state.yaml alone.

7. **Ensure `<opp>/opp.yaml` exists.** Read it (`drive_read_file`); if
   missing, create with:

   ```yaml
   display_name: <opp>          # default to slug; operator can edit later
   slug: <opp>
   tags: []
   created_at: <ISO timestamp>
   created_by: <email>
   ```

   If opp.yaml already exists, leave it alone — skip this step entirely
   on existing opps. `connect-program-setup` is the only phase skill
   that mutates `opp.yaml` (writes the durable `connect.program` block
   on first program create). All other per-run state lives in
   `run_state.yaml.phases.*.products.*`; ace-web enumerates runs by
   scanning `runs/` directly, not by reading opp.yaml.

7b. **Write the per-run `README.md` index.** Call the
   `render_run_readme` atom with `{runId: "<runId>"}` (omit
   `phaseStatus` — all phases default to `pending` at this point); it
   returns `{markdown}`. Then write the markdown to
   `<opp>/runs/<runId>/README.md` via `drive_create_file` — using the
   run folder id returned by Step 5's `drive_create_folder`. The
   `render_run_readme` call (id-free) and the `drive_create_file` write
   batch into Step 5's second message (the file-writes batch), NOT into
   the folder-create message. The README gets refreshed after every
   phase completes (the
   boundary fence calls `render_run_readme` with the current phase
   status map) — see § Per-Phase Folder Lifecycle.

   Do NOT shell out to `npx tsx -e "..."` against
   `lib/run-readme.ts` — the atom exists specifically to remove that
   dance. Source-of-truth helper: `lib/run-readme.ts::generateRunReadme`.

8. **Log the run setup explicitly.** Emit a log line in this exact form
   so transcript readers and ace-web's ingest can pick it up:

   ```
   [orchestrator] starting opp=<opp> run_id=<runId> mode=<mode>
     inputs_folder=<opp>/inputs (read-only, <N> files in manifest)
     run_folder=<opp>/runs/<runId>
     manifest=<opp>/runs/<runId>/inputs-manifest.yaml
   ```

9. **Begin Phase 1.**

### Fallback — `inputs/` is still empty after auto-create + migration

Stop with this message. Fires when the explicit-opp path's Step 5d
finds zero files in `inputs/` after the orchestrator auto-created the
folder and tried to migrate any stray top-level docs (5a + 5b), AND
when the zero-arg discovery path finds no opp at all with an `inputs/`
that has files in it. Do NOT silently fall back to the legacy `PDD/`
picker.

> Opp `<opp>` has no source material in `inputs/` (orchestrator
> already auto-created the folder and tried to migrate any top-level
> docs into it — nothing was found).
>
> `inputs/` is the human-curated evidence pack that seeds the PDD.
> Drop in any combination of source docs, SOPs, questionnaires,
> spreadsheets, prior-pass drafts, or notes — there is no required
> filename. Phase 1 (`idea-to-pdd`) reads everything in `inputs/`
> and synthesizes a formal PDD as the Phase 1 output.
>
> Drop the source material into `ACE/<opp>/inputs/` (the folder
> already exists), and re-run `/ace:run <opp>`. Top-level drops
> directly under `ACE/<opp>/` are also fine — the orchestrator
> auto-migrates them into `inputs/` on next run.

The legacy `PDD/` flat folder is kept readable by ace-web for back-compat
viewing of legacy opps, but is no longer consulted for new runs.

## Workflow

When invoked with an opportunity, execute these phases in order.

> **Phases 9–10 are not yet live — this is the single authoritative
> statement of the boundary.** `/ace:run` runs Phases 1–8, halts at the
> PAUSE (`solicitation-review` is a manual, HITL-gated step), and does
> **not** dispatch `Agent(execution-manager)` or `Agent(closeout)`. The
> Phase 9 and Phase 10 blocks below are forward-spec — the contract for
> when execution is enabled — and both agents additionally self-guard
> (see `agents/execution-manager.md`). Because this statement is
> authoritative, the per-phase `Gate:` fields and § Modes do not restate
> it; they point here. To turn Phase 9 on, remove the agent self-guards
> and re-validate the external-comms pause points.

**Per-phase block shape.** Each `### Phase N` block lists `Dispatch`, `Inputs (inline at handoff)`, `Atoms / skills used`, `Products`, and optionally `Gate` + `Notes`. Two contracts apply to **every** phase and are NOT restated per block — read them once here:

- **Write-back.** Every phase writes `phases.<phase-name>.{status, started_at, completed_at, verdict, summary_artifact, steps}` per [§ Phase Write-Back Contract](orchestrator-reference.md#phase-write-back-contract). The boundary fence (§ Phase boundary fence below) governs WHEN.
- **Gate baseline.** Any `[BLOCKER]` from the phase's eval verdicts halts the run, regardless of mode. The per-phase `Gate:` field below only lists *additional* named pause points or phase-specific gate behavior beyond that baseline; absence of a `Gate:` field means "BLOCKER-only, no named pause point in default mode" — see [§ Pause Points](orchestrator-reference.md#pause-points) for the full table.

`Inputs (inline at handoff)` items are passed via the prompt template in § Pre-flight & per-phase conventions → "Pass artifacts inline at phase handoff".

### Phase 1: Idea to Design

**Dispatch:** `Agent(idea-to-design)`.

**Inputs (inline at handoff):** the inputs manifest, `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(idea-to-design)`.

**Products:** PDD (`1-design/idea-to-pdd.md`) — the formal design doc; Work Order (`1-design/pdd-to-work-order.gdoc`) — contractual draft derived from PDD + decisions.yaml. Both are required outputs of Phase 1; the work order chain (Steps 2, 2.4, 2.5 in `agents/idea-to-design.md`) runs after the PDD chain.

**Gate:** pause-on-`idea-to-pdd`. In review mode, the PDD-approval gate is the natural human checkpoint at the Phase 1→2 boundary.

### Phase 2: Scenarios & Acceptance Planning

**Dispatch:** `Agent(scenarios-and-acceptance)`.

**Inputs (inline at handoff):** approved PDD (`1-design/idea-to-pdd.md`), Phase-1 verdicts (`1-design/idea-to-pdd-{qa_result,eval_verdict}.yaml`), `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(scenarios-and-acceptance)`. Internally the agent runs `pdd-to-test-prompts` (+ QA + eval) then `pdd-to-app-journeys` (+ eval).

**Products:** opp-specific test prompts (`2-scenarios/pdd-to-test-prompts.md`) — Q&A scenarios the Phase 5 OCS deep QA gate judges chatbot answers against; expected app journeys (`2-scenarios/pdd-to-app-journeys.md`) — UX-intent scenarios the Phase 6 shallow app QA and `/ace:qa-deep` grade FLW app behavior against. Both are AI interpretations of the AI-authored PDD — "what we'd expect," not ground truth.

**Notes:** The two skill chains are independent of each other (both read only the PDD) so a `[BLOCKER]` from one doesn't necessarily implicate the other.

### Phase 3: CommCare Setup

**Dispatch:** **inline procedure-doc `agents/commcare-setup.md`** — do NOT call `Agent(commcare-setup)`. Level-0 constraint, see Notes.

**Inputs (inline at handoff):** PDD, prior-phase verdicts (`1-design/idea-to-pdd-{qa_result,eval_verdict}.yaml`), `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** inline execution of `agents/commcare-setup.md`, which itself dispatches `/nova:autobuild` for `pdd-to-learn-app` + `pdd-to-deliver-app` (each Nova call is `Agent(nova:nova-architect-autonomous)` at level 0).

**Products:** Learn app, Deliver app, deployed apps on CCHQ, test results (`3-commcare/app-test-cases.yaml` + `app-test-cases/J*.yaml`). (Training materials moved to Phase 6 (`qa-and-training`) in 0.9.0.)

**Gate:** pause-on-`app-deploy`.

**Notes:** Phase 3 invokes `/nova:autobuild`, which dispatches the `nova:nova-architect-autonomous` subagent. That dispatch requires `Agent` at level 0 — running Phase 3 itself as a subagent would put Nova's dispatch at level 2 and fail. See § Agent Topology in reference. This is the only orchestrator-visible inline procedure-doc dispatch in the workflow.

### Phase 4: Connect Setup

**Dispatch:** `Agent(connect-setup)`.

**Inputs (inline at handoff):** PDD, Phase-3 verdicts (`3-commcare/{pdd-to-learn-app,pdd-to-deliver-app,app-deploy,app-test-cases}-{qa_result,eval_verdict}.yaml`), `3-commcare/app-deploy_summary.md`, `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(connect-setup)`.

**Products:** Program configured; Opportunity configured with verification rules and delivery/payment units; opportunity **activated** (`is_test=true`); ACE test user (`${ACE_E2E_PHONE}`) pre-invited (`4-connect/connect-program-setup.md`, `4-connect/connect-opp-setup.md`).

**Notes:** LLO invite-list preparation moved to Phase 9 on 2026-04-20 — we don't commit to a real-LLO invite roster until after the OCS chatbot has cleared its deep-eval gate. Phase 4 *does* activate the opp and invite the ACE test user (`${ACE_E2E_PHONE}`) on 2026-05-10 — this closes the chicken-and-egg gap where Phase 6 `app-screenshot-capture` could only produce placeholder screenshots because the test user wasn't on the new opp yet. The opp is created with `is_test=true` so prod LLO-facing analytics, payment exports, and partner dashboards exclude these dogfood runs; activation in this phase is therefore not a Phase 8→9 boundary violation. Phase 9's `llo-launch` becomes idempotent on already-active opps (skip-and-log) and still sends the real-LLO invite to the awarded LLO. After Phase 4 completes, the orchestrator refreshes `current/` shortcuts (see § Per-Phase Folder Lifecycle in reference).

### Phase 5: OCS Setup

**Dispatch:** `Agent(ocs-setup)`.

**Inputs (inline at handoff):** PDD, opp-specific test prompts (`2-scenarios/pdd-to-test-prompts.md`), Phase-4 verdicts (`4-connect/{connect-program-setup,connect-opp-setup}-{qa_result,eval_verdict}.yaml`), `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(ocs-setup)`.

**Products:** per-opp OCS chatbot cloned from the golden template with opp-specific RAG collection; quick smoke qa+eval passed; deep pre-launch qa+eval passed against opp-specific test prompts; embed credentials ready for Connect (`5-ocs/ocs-agent-setup.md`).

**Gate:** pause-on-`ocs-chatbot-eval --quick`.

**Notes:** Each quality gate is a qa→eval pair — `ocs-chatbot-qa` captures a transcript, `ocs-chatbot-eval` grades it. Ends with a human-in-the-loop step to paste the widget credentials into the Connect opportunity until `update_opportunity` lands (CCC-301). After Phase 5 completes, the orchestrator refreshes `current/` shortcuts (see § Per-Phase Folder Lifecycle in reference).

### Phase 6: QA and Training

**Dispatch:** `Agent(qa-and-training)`.

**Inputs (inline at handoff):** PDD, Phase-3 outputs (`3-commcare/app-test-cases.yaml` + per-journey recipes under `3-commcare/app-test-cases/J*.yaml`), Phase-5 chatbot URL (`5-ocs/ocs-agent-setup.md`), `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(qa-and-training)`. Internally the agent runs `app-screenshot-capture` (executor — runs the smoke recipes from Phase 3's `app-test-cases.yaml`) → 5 per-artifact training skills in parallel (`training-llo-guide`, `training-flw-guide`, `training-quick-reference`, `training-faq`, `training-deck-generate`) → `training-deck-render` (sequential after deck-generate; skipped if `ACE_TRAINING_DECK_TEMPLATE_ID` unset) → `training-onboarding-email` (LAST — links by URL to other docs).

**Products:** Phase-6 artifacts under `6-qa-and-training/` — screenshot bundles, 5 training docs (LLO guide, FLW guide, quick reference, FAQ, deck spec), optional training deck render, onboarding email.

**Notes:** Phase 6→7 is no longer a mandatory pause (§ Modes — default, review, auto). All skills read upstream artifacts from Phases 1–4. No 1-1 LLO contact happens here — that begins in Phase 9. Phase 6 splits shallow (in `/ace:run`, ~5 LLM judges) vs deep (out-of-band via `/ace:qa-deep`); `llo-launch` (Phase 9) requires fresh deep verdicts.

### Phase 7: Synthetic Data and Workflows

**Dispatch:** `Agent(synthetic-data-and-workflows)`.

**Inputs (inline at handoff):** PDD, Phase-4 Connect identifiers (`4-connect/connect-opp-setup.md`), `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(synthetic-data-and-workflows)`. Internally: authors a story-coherent synthetic-data manifest from the PDD, generates fixture data via the connect-labs MCP, instantiates the LLO weekly review + program admin audit workflows, polishes them per-opp, and runs persona walkthroughs that produce stakeholder-ready HTML decks.

**Products:** synthetic narrative manifest; fixture FLW/visit/payment data; two demonstrative workflows (`llo_weekly_review`, `program_admin_audit`); per-persona walkthrough HTML decks; single one-page summary (`7-synthetic/synthetic-summary.md`).

**Gate:** **no phase pause** — `/ace:run` proceeds straight from Phase 7 to Phase 8 without halting (no run-time gate; see § Pause Points in reference).

**Notes:** **No irreversible external action.** The connect-labs `SyntheticOpportunity` row is reversible via `synthetic_disable`; workflows can be deleted via `workflow_delete`. See `agents/synthetic-data-and-workflows.md`.

### Phase 8: Solicitation Management

**Dispatch:** `Agent(solicitation-management)`.

**Inputs (inline at handoff):** PDD (with PDD-named candidate LLOs, if any), Phase-7 summary (`7-synthetic/synthetic-summary.md`), `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(solicitation-management)`. Internally the agent runs `solicitation-create` → `llo-invite` (default run, both auto).

**Products:** solicitation derived from the PDD published on labs.connect.dimagi.com via the `connect-labs` MCP; emails to PDD-named candidate LLOs containing the public URL (no-op if the PDD names no candidates — long-term flow).

**Gate:** terminal — `/ace:run` halts after this phase (Phase 8→9 boundary; see § Workflow callout for the authoritative statement). `selected_llo` is populated only by the manual `/ace:step solicitation-review` (HITL-gated `award_response`).

**Notes:** The recurring `solicitation-monitor` skill polls labs for responses while the solicitation is open; runs OUTSIDE `/ace:run` (cron or manual dispatch). Its cross-run write semantics are TBD pending Phase 8+/8 architecture decisions. `solicitation` and `selected_llo` are separate sub-blocks under `phases.solicitation-management.products.*` — only `solicitation-review` populates `selected_llo`.

### Phase 9: Execution Management

**Not yet live** — `/ace:run` does not reach this phase (§ Workflow callout); the block below is forward-spec for when execution is enabled, and `agents/execution-manager.md` self-guards against accidental dispatch.

**Dispatch:** `Agent(execution-manager)`. **Entry gated on `phases.solicitation-management.products.selected_llo.org_slug` being populated by Phase 8's `solicitation-review`** in the current run's `run_state.yaml`.

**Inputs (inline at handoff):** PDD, Phase-6 training artifacts (5 docs + onboarding email under `6-qa-and-training/`), Phase-5 chatbot URL (`5-ocs/ocs-agent-setup.md`), `selected_llo` (from run_state.yaml.phases.solicitation-management.products.selected_llo), `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(execution-manager)`.

**Products:** the awarded LLO onboarded (Connect program-level invite + ACE onboarding email with widget link); UAT completed; opportunity activated (go-live); ongoing monitoring active.

**Gate:** **always pauses before** `llo-onboarding` (first 1-1 email to awardee), `llo-uat` send (UAT instructions), and `llo-launch` (opp activation in Connect) — these are unconditional in all modes.

**Notes:** Phase 9 is the first 1-1 LLO contact in the lifecycle. Recurring skills (`timeline-monitor`, `flw-data-review`, `ocs-chatbot-qa-monitor`, `ocs-chatbot-eval-monitor`) run on schedule during the active opportunity. `llo-launch` requires fresh deep verdicts (Phase 6 `/ace:qa-deep` output).

### Phase 10: Closeout

**Not yet live** — gated behind Phase 9 (§ Workflow callout); forward-spec for when execution is enabled.

**Dispatch:** `Agent(closeout)`. **Triggered when the opportunity reaches its end date.**

**Inputs (inline at handoff):** Phase-9 outputs (LLO onboarding + UAT + go-live artifacts under `9-execution-manager/`), `selected_llo` (from run_state.yaml.phases.solicitation-management.products.selected_llo), `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(closeout)`.

**Products:** Invoices pulled; Jira payment ticket created; LLO feedback collected; learnings summarized; cycle graded.

**Gate:** **always pauses before** `opp-closeout` (Jira payment ticket creation) — unconditional in all modes.

**Notes:** Triggered by end-date, not by phase chaining — Phase 10 does NOT run automatically as part of `/ace:run` continuation from Phase 9. The closeout agent owns the trigger condition. The terminal verdict for Phase 10 is `closed` (terminal-phase synonym for `pass` — see § Phase Write-Back Contract in reference for the full enum).

## Between Phases

A phase boundary has a fixed mechanical sequence — don't improvise it
here. The tool sequence (write-back + the two verifiers + `decisions-render`)
is § Phase boundary fence below; whether to pause or email at the boundary
is § Modes:

- `auto` — email the admin group at each step, continue.
- `default` — continue silently across Phases 1→2 … 7→8 unless a
  `[BLOCKER]`/hard error or a named Pause Point fires (§ Pause Points).
  The 6→7 and 7→8 transitions are NOT mandatory pauses; the run
  terminates at the Phase 8→9 boundary (§ Workflow callout).
- `review` — present a summary and wait for approval to continue.

## Phase boundary fence

The verifier's actions happen as the **IMMEDIATE next assistant
message** after the `Agent(<phase>)` tool_result returns. Not after a
solo "Phase X complete" status text in a separate turn. Not after a
solo `TaskUpdate` in a separate turn.

These actions are independent and MUST be batched into ONE parallel
message:

- `drive_read_file` on `run_state.yaml` (verifier read — used next turn).
- `TaskUpdate` marking the current phase `completed` and the next phase `in_progress`.
- `Skill(decisions-render)` to refresh the decisions gdoc (idempotent).

A one-line text summary ("Phase N complete: <verdict>") may accompany
these tool calls in the same message. It must NOT precede them in a
separate turn.

**Anti-pattern.** Boundary observed in real transcripts (each line a
separate assistant turn):

```
Turn N:    Agent(<phase>) tool_result
Turn N+1:  text "Phase 1 complete: proceed verdict, no blockers"
Turn N+2:  drive_read_file run_state.yaml
Turn N+3:  TaskUpdate
Turn N+4:  Skill(decisions-render)
Turn N+5:  Agent(<next-phase>)
```

That's ~4 wasted turns × seconds each × 8 boundaries per run
≈ 1–3 min of pure model-output latency per `/ace:run`.

**Right pattern.**

```
Turn N:    Agent(<phase>) tool_result
Turn N+1:  ONE message — all 5 tool calls in parallel:
             1. classify_phase_writeback(fileId=<run_state.yaml>, phaseName=<phase>)
                — returns 'ok' | 'missing' | 'in_progress' | 'error' | 'malformed'
             2. drive_list_folder on <runFolderId>/<N>-<phase>/ (artifact verifier)
             3. verify_phase_artifacts(runFolderId, phase=<manifest-key>)
                — returns {phase, ok, missing[], present_count,
                  expected_count, optional_present_count, summary}
                  where each missing entry carries {path, producedBy, description}
                — covers the artifact-presence half of the gate;
                  classify_phase_writeback covers the run_state.yaml half
                — when narrating the result, echo verify.summary verbatim
                  (e.g. "all 4 required artifacts found (+3 optional)"). Do
                  NOT pair present_count/expected_count into a fraction:
                  present counts every file in the folder, expected counts
                  only the required set, so "7/4" is meaningless.
             4. TaskUpdate marking <phase> completed, next phase in_progress
             5. Skill(decisions-render) — idempotent
           Optional one-line text summary in the same message.
Turn N+2:  Branch on classify_phase_writeback AND verify_phase_artifacts:
             - classify='ok' AND verify.ok=true
                 → proceed to Turn N+3
             - verify.ok=false (one or more required artifacts missing)
                 → for each entry in verify.missing, silent-dispatch its
                   producedBy via Skill(<producedBy>) with the standard
                   phase-context prompt (opp slug + run_id, no other
                   priors). Cap at 2 attempts TOTAL per boundary; re-run
                   the fence after each batch. If any item remains
                   missing after the cap, halt with a [BLOCKER] listing
                   the unhealed paths + producedBy values.
             - classify='in_progress' → silent-dispatch Agent(<phase>)
                                          retry (see § Auto-retry silent
                                          Agent dispatches above); cap 2
             - classify='missing'     → silent-dispatch Agent(<phase>)
                                          retry, same cap
             - classify='malformed'   → if validate_run_state's full
                                          issue list includes only
                                          fixable gaps (e.g. missing
                                          completed_at), patch via
                                          update_yaml_file stub fallback
                                          per § Phase Write-Back
                                          Verifier in
                                          `agents/orchestrator-reference.md`;
                                          otherwise retry
             - classify='error'       → halt with the [BLOCKER] message
                                          per § Producer Artifact
                                          Verifier; phase itself
                                          returned an error verdict
           **External-resource override (ocs-setup, connect-setup,
           solicitation-management):** on `in_progress` / `malformed`, do
           NOT silent-dispatch the Agent retry if `verify.ok=true` OR the
           phase's `products.*` block already records the external
           resource id — re-dispatch would mint a SECOND chatbot / opp /
           solicitation. Instead FINISH the write-back inline from the
           landed artifacts. See § External-resource phases: finish inline
           in `agents/orchestrator-reference.md`.
Turn N+3:  Agent(<next-phase>) with inline-artifact prompt.
```

**Products-presence check (Turn N+2, alongside the classify/verify branch).**
`classify_phase_writeback` only checks the run_state *shape* (status enum,
verdict type, steps); `verify_phase_artifacts` only checks Drive *files*.
Neither asserts that the phase wrote its typed `products.<block>` — the
handoff the public summary page (ace-web `apps/opps/summary.py`) and
downstream phases actually read. A phase can therefore return
`classify='ok'` + `verify.ok=true` while having written its outputs only
under `steps.*` or a lone `summary_artifact`, leaving the summary page's
section blank. Caught on leep run 20260527-1528: the published EOI
(`products.solicitation`) and the rendered walkthroughs
(`products.synthetic`) never surfaced because Phase 8 and Phase 7 wrote
no `products` block.

So in Turn N+2, for the phase that just completed with `status: done`,
also confirm `phases.<phase>.products.<expected-block>` exists and is
non-empty, per this map:

| Phase | Required `products.<block>` |
|---|---|
| idea-to-design | `pdd` |
| scenarios-and-acceptance | `test_prompts` + `app_journeys` |
| commcare-setup | `apps` |
| connect-setup | `connect` |
| ocs-setup | `ocs_chatbot` |
| qa-and-training | `training` |
| synthetic-data-and-workflows | `synthetic` |
| solicitation-management | `solicitation` (NOT `selected_llo` — award-gated) |

(execution-management `launch` + closeout `cycle_grade` are end-state /
conditional — exempt.) If the required block is absent or empty on a
`status: done` phase, treat it as a silent under-write: re-dispatch the
phase ONE more time with an explicit closing line naming the missing
`products.<block>` (same cap-2 discipline as the `classify='missing'`
branch). The phase agents' own definitions carry the explicit
`products.<block>` write step (see e.g. `agents/solicitation-management.md`
§ After Step 2, `agents/synthetic-data-and-workflows.md` § Completion) —
this fence check is the structural backstop for when a subagent skips it.

**Open-questions doc (run-end, once).** The summary page reads
`open-questions.md` from the run-folder root by name (it's the lone
section with no typed `products.*` pointer). After Phase 1 completes —
or at the first boundary fence where the PDD exists — ensure
`<run-folder>/open-questions.md` is written, seeded from the approved
PDD's `## Open Questions` section (one bullet per question, each naming
its owner + where it gets answered) and appended to as later phases
surface new ones. Idempotent: `drive_create_doc_from_markdown` with
`findOrCreate: true` overwrites in place, so re-running the fence
refreshes it. Without this the summary's Open-Questions section renders
empty even on a fully-populated run (observed: leep run 20260527-1528).

**Manifest-key map** for the `phase` arg `verify_phase_artifacts` expects
— the SHORT key from `lib/artifact-manifest.ts § PHASES`, NOT the
agent-file name. The verifier rejects unknown values (zod enum), so
passing the wrong key is loud and immediate:

| Phase (agent file) | Manifest key |
|---|---|
| `idea-to-design` | `design` |
| `scenarios-and-acceptance` | `scenarios-and-acceptance` |
| `commcare-setup` | `commcare` |
| `connect-setup` | `connect` |
| `ocs-setup` | `ocs` |
| `qa-and-training` | `qa-and-training` |
| `synthetic-data-and-workflows` | `synthetic-data-and-workflows` |
| `solicitation-management` | `solicitation-management` |
| `execution-manager` | `execution-management` |
| `closeout` | `closeout` |

If the phase returned a `[BLOCKER]` or hard error, replace Turn N+3
with a halt message — but Turn N+1 still happens (write-back is
mandatory regardless of verdict).

Both `verify_phase_artifacts` and `classify_phase_writeback` exist so the
two boundary checks are single deterministic tool calls instead of a
read→parse→judge model dance that drifts (the "why one tool" rationale +
incidents — bednet-spot-check 20260525-2013's 13 silently-skipped evals,
the PR-L run-state move — are in reference § Producer Artifact Verifier
and § Phase Write-Back Contract). For the full issue list on a
`'malformed'` result (which field is missing), call
`validate_run_state(fileId)` — returns `{valid, errors, warnings}` with
`{path, message, severity}` per issue.

**Forbidden boundary improvisations.** The boundary fence's 5 tool
calls listed above are the COMPLETE set. Do NOT also:

- `drive_read_file` the phase's primary product (e.g. the PDD, app
  manifest, OCS chatbot URL) at the boundary. `drive_list_folder` in
  the same message already proves the file exists; reading the body
  is verification-by-feel, not by structure. If the phase wrote it,
  it's there.
- Issue a separate `Bash` to recompute timestamps, list the run folder
  a second time, or run a "sanity diff" against the prior run. The
  verifier reads in Turn N+1 are the structural evidence.
- Emit a "Phase N complete" status text in a solo turn before Turn
  N+1's batched tool calls. The text summary, if any, rides in the
  same message as the batched calls.

Each of these improvisations was observed in real session transcripts
(`e2e-malaria-rdt` 2026-05-24) and adds 1–3 wasted turns per boundary
× 8 boundaries per run.

## Per-Step Eval Hook

Per-step `-eval` skills run **automatically** after their producing skill
in `/ace:run`. Each phase agent dispatches the matching `-eval` skill
immediately after the producing skill completes, before advancing to the
next step. Without this, the Workbench's "run → inspect → upgrade plugin
→ rerun → compare" loop has no per-step signal, and `opp-eval` rolls up
nothing to aggregate.

**Where the wiring lives.** Each phase agent owns its own producer→eval
pairing, listed in the agent's frontmatter `skills:` block via
`eval_skill: <name>` (or `inline-self-eval` if the producer judges its own
output). The orchestrator does not maintain a separate mapping table.

**Verdict-file naming convention** (the rule the web reader enforces):

```
runs/<run-id>/<phase>/<producer-skill>[-eval]_verdict[-<mode>].yaml
```

Each producer skill (and each `-eval` partner) writes its verdict next
to its primary artifact in the phase folder. The web reader matches on
the segment immediately before `_verdict` to attribute scores to the
producer skill row.

- `-eval` skills include `-eval` in their filename so the verdict is
  attributable to the eval partner: `idea-to-pdd-eval` writes
  `1-design/idea-to-pdd-eval_verdict.yaml`, NOT
  `1-design/idea-to-pdd_verdict.yaml`. The reader rolls eval scores up
  to the producer (`idea-to-pdd`) row by walking the eval→producer
  pair declared in the producing phase agent's frontmatter, not by
  parsing the filename.
- Skills that ARE their own row in the registry (no producer / eval
  split, e.g. `ocs-chatbot-eval`) keep their own name and a mode
  suffix: `5-ocs/ocs-chatbot-eval_verdict-{quick,deep}.yaml`,
  `9-execution-manager/ocs-chatbot-eval_verdict-monitor.yaml`.
- Skills that self-evaluate inline (no separate `-eval` skill — e.g.
  `app-screenshot-capture` and every per-artifact training skill
  (`training-llo-guide`, `training-flw-guide`,
  `training-quick-reference`, `training-faq`,
  `training-onboarding-email`, `training-deck-generate`)) write
  `<phase>/<self>_verdict[-<mode>].yaml`.

**Opt-out.** `/ace:run --no-evals` skips the per-step eval dispatch (the
producing skills still write their primary artifacts). Useful for fast
smoke iterations where the operator plans to run `/ace:eval --all`
afterward.

**Eval failures don't halt the run by default.** A per-step eval that
returns `verdict: fail` does NOT halt the orchestrator outside the named
Pause Points — the verdict is recorded for the dashboard / `opp-eval`,
and the run continues. The named Pause Points (see § Pause Points) still
apply, where `[BLOCKER]` concerns from the eval do halt. This keeps the
eval signal visible without making every rubric a hard halt.

**Backstop.** `/ace:eval --all <opp-name>` runs every applicable
per-step `-eval` skill against an existing opp's artifacts (the
verdict-discovery model: for each producer skill that has an artifact
in Drive AND a registered eval pair, dispatch the eval). Use this to
retroactively score older opps, or to re-grade after a rubric is
improved.

## Umbrella Eval

The `opp-eval` skill (dispatched via `/ace:eval <opp-name> --mode
quick|deep|monitor`) is an **umbrella aggregator** that rolls every
per-skill `-eval` verdict for an opportunity into a single run-level
scorecard and drafts improvement recommendations. It walks every
phase folder under `ACE/<opp-name>/runs/<run-id>/` collecting
`*_verdict*.yaml`, groups scores into 7 skill-category dimensions
(design, commcare, connect, ocs, solicitation, operate, closeout), and
writes a human scorecard + machine verdict + advisory gate brief.

opp-eval is **ad-hoc**, not part of the `--mode review` auto-pause
flow. It does not gate any phase. It can be run anytime during or
after an opportunity — mid-run for a health check, end-of-run for a
retrospective, or on a schedule (`--monitor` mode) for drift
detection. The orchestrator does not dispatch opp-eval automatically;
operators invoke it via `/ace:eval`.

As more per-skill `-eval` skills gain `## LLM-as-Judge Rubric`
sections and start writing their verdict files (next to the producer
artifact as `<N>-<phase>/<producer>-eval_verdict[-<mode>].yaml` — there
is no top-level `verdicts/` directory), opp-eval automatically picks
them up via directory discovery — no change to opp-eval itself is
needed. Today some skills still self-evaluate inline (no separate
`-eval` skill); opp-eval emits `[INFO]` notes for those gaps, which is
the forcing function for future per-skill rubric work. When a rubric
arrives and the skill starts writing its `-eval_verdict` file, opp-eval
picks it up on the next run.

## Error Handling

If a skill fails:
1. Log the error in `run_state.yaml`
2. In `auto` mode: email the admin group with error details, continue to next step if possible
3. In `default` mode: a hard error halts the run regardless of phase — present the error and ask how to proceed (retry, skip, abort). The "keep going" principle applies to clean steps, not to errors
4. In `review` mode: present the error and ask how to proceed (retry, skip, abort)

## Dry-Run Mode

When `--dry-run` is passed to `/ace:run`:
- All skills execute normally — reading inputs, generating outputs, writing to GDrive
- Effectful skills (those that send emails, publish apps, create tickets, or call external APIs) write their intended actions to `comms-log/dry-run-<step>.md` instead of executing
- LLM-as-Judge evaluation still runs at each step
- Gates still apply per the active mode (default/review/auto)
- `run_state.yaml` marks dry-run steps so they're distinguishable from real runs (e.g. a `dry_run: true` flag on the step entry); the step `status` stays in the standard `done | error | incomplete` enum (§ Phase Write-Back Contract), not the retired `success`/`blocked` vocabulary
- Pass the dry-run flag to all phase agents

## Sandbox Mode

When `--sandbox` is passed to `/ace:run`:
- MCP servers route external API calls to staging endpoints (Connect staging, CommCare staging project space)
- MCP servers read `ACE_SANDBOX=true` environment variable to determine endpoint routing
- Can be combined with `--dry-run` for maximum safety

## Post-Run: ace-web Transcript Upload (optional)

When `/ace:run` is invoked with `--ace-web-url URL`, after all phases
complete (or on fatal error) the orchestrator dispatches the
`upload-transcript` skill with the current transcript path and the
provided base URL. This is a best-effort hook — an upload failure is
logged but does not alter the run's success/failure status.

Requirements:
- `ACE_WEB_PAT_TOKEN` must be set in the environment (per-human PAT
  minted via `/ace:ace-web-pat-mint`). If absent, log a warning and
  skip the upload.
- The transcript path is whatever the operator is writing stream-json to
  (typically `$JSONL_PATH` in a scripted run). If not resolvable, skip.

This is the only ace-web dependency in the ACE plugin. Without
`--ace-web-url` the plugin is entirely standalone.

## See also: orchestrator-reference.md

Reference content for this orchestrator lives in `agents/orchestrator-reference.md`:

- `## Agent Topology` — architectural diagram + level-0/subagent constraints
- `## State Schema` + `## Your State` — `run_state.yaml` and `opp.yaml` shapes
- `## Scope boundaries` + `## Cruft management` — what belongs in run_state.yaml; archive convention
- `## Per-Phase Folder Lifecycle` — Drive folder shape per phase
- `## Producer Artifact Verifier` — discipline rule pattern
- `## Phase Write-Back Contract` — required write-back shape
- `## Phase Write-Back Verifier — procedure` — auto-stub fallback
- `## Pause Points` — full pause-point catalog with per-mode table
- `## Touching State — Operator Capture` — operator-bypass write rules
- `## Discipline — full text` — full source text for the rules consolidated into § Anti-patterns and discipline above

The procedure doc above is the canonical execution flow; the reference doc is normative for the shapes and rules cited above.

