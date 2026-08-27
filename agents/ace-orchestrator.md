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
- **Don't skip producer skills to shortcut to consumers.** "Invoke X" / "Dispatch X" means `Skill(<name>)`. Never compose a producer's outputs inline from upstream artifacts, even under context-budget pressure. Phase 3 was the highest-risk surface while it ran inline at level 0 under the orchestrator's context pressure; it is a subagent with its own context as of 0.13.1018, which removes the pressure but not the rule. Bug class: multi-file output contracts silently broken at producer; halt surfaces phases later (turmeric run 20260509-0455 → Phase 6 halt + 5 training docs re-run). See [reference § Skill Invocation Discipline](orchestrator-reference.md#skill-invocation-discipline).
- **Don't skip per-step `-eval` dispatch.** Phase 3 (`commcare-setup`) dispatches its own `-eval` after each producer skill; it runs as a subagent as of 0.13.1018, so the orchestrator sees only the written verdicts and cannot backfill a skipped one. Phase Write-Back Contract refuses `verdict: pass` when any `has_judge: true` skill has `steps.<skill>-eval.status: deferred`. Bug class: phase verdict landing without LLM-as-Judge content-quality signal (malaria-itn-app/20260523-0750: 7/7 producers, 0/3 evals, shipped `pass`). See [reference § Don't skip per-step -eval dispatch](orchestrator-reference.md#dont-skip-per-step--eval-dispatch).
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

**Three blocks the preflight DOES emit — halt before Phase 1 if any is
`fail`:** `selector_map_currency`, `nova_needs_auth_cache`, and
`ocs_generation`. The first two are no-network static checks for
halt-classes unrecoverable in-session. On `fail`: surface the block's
`remediation`, run the cache-clear node one-liner the full `/ace:doctor`
prints, and tell the operator to Cmd-Q + reopen, then resume. (Rationale
+ jjackson/ace#582: see orchestrator-reference.md § Pre-flight rationale.)

`ocs_generation` is different in two ways and must not be lumped in with
them. It is the ONE **live** probe in preflight — it asks OCS to generate
a single token through the golden template — so it can legitimately
report a `skip` verdict (no OCS session on this machine, env unset,
`--no-live` passed). A `skip` is not a halt; it means the check could not
run, and `ocs_auth` in the full `/ace:doctor` says why. And its
remediation is **not** a restart: fix the team's GENERATION provider key
in OCS / 1Password (the block names the exact
`/a/<team>/service_providers/llm/<pk>/` page — note that is *not* the id
`OCS_LLM_PROVIDER_ID` holds, which is embeddings), then re-run
`/ace:run`. No Claude Code restart needed, unlike the other two. Halt on
`fail` because no OCS-dependent phase can pass with a dead generation
provider, and the only other place it surfaces is Phase 5 — after Phases
1-4 and 6 have already run (dimagi-internal/ace#1516). A `fail` with
`class: timeout` already means TWO consecutive 25s round-trips returned
nothing — the probe retries that one transient class itself, so there is
never anything to re-run by hand (ace#1628).

**Do NOT probe `.env` before running the doctor** — no `echo
$CLAUDE_PLUGIN_DATA`, no `ls .../.env`, no `find ... -name .env`. Every
value those probes would surface is in the doctor's one-call output.
(Anti-pattern incidents: see orchestrator-reference.md § Pre-flight rationale.)

**In-session plugin-MCP binding is NOT something the doctor can probe.**
Whether a given plugin MCP (`ace-mobile`, `ace-decisions`, Nova, …) bound
in *this* Claude Code session is per-process state the doctor CLI
subprocess cannot observe — it can only confirm the server *can* start.
**Whenever you halt for a restart, write a handoff first (ace#1093).** A
restart-required halt is the one session boundary ACE *chooses*: it knows it is
about to be replaced, it knows what it already established, and it knows the
exact next command. Session `d9eefb36` halted correctly here and the
post-restart session six minutes later redid ~30 context calls it could not see
had been made — including re-flailing the same `gog` flags, one guessing
`--max` and the other `--limit`.

Before printing the halt, write the brief:

```bash
"$ACE_ROOT/node_modules/.bin/tsx" -e "
  import { writeHandoff } from '$ACE_ROOT/lib/session-handoff.ts';
  writeHandoff({
    written_at: new Date().toISOString(),
    reason: '<why this session must be restarted>',
    established: ['<fact 1>', '<fact 2>'],   // the calls the next session must NOT repeat
    artifacts: ['<paths / Drive ids / branch>'],
    next_command: '<the literal command to run first>',
    run: '<opp>/<run-id>',                    // when it is run work
  });
"
```

The next session's preflight prints it back under
`handoff_from_previous_session` and is told not to re-derive it. It expires
after two hours, and a stale one is reported as stale rather than hidden —
silence would read as "the mechanism never ran". Consume it (`clearHandoff`)
once you have acted on it, so a third session does not act on context two
boundaries old.

The preflight's `selector_map_currency` block is a STATIC file check; a
green `selector_map_currency` says nothing about whether `ace-mobile`
bound. MCP subprocesses bind at session start and are NOT respawned by
`/reload-plugins`, so a binding miss is unrecoverable in-session (needs a
full Claude Code restart). The structural guard is therefore an
**in-session atom-resolvability check**, never a doctor field — and it
lives in TWO places, both load-bearing:

1. **At L0, as Step 2a below** — read Step 2's `ToolSearch` result and
   halt before the first `Agent` dispatch if a `pending` phase's server
   didn't bind. This is what stops a seeded run from spending its only
   dispatch, and Phase 6 from burning the single-use Learn precondition,
   to rediscover an unbound server.
2. **At the point of use, in the phase agent** — Nova has
   `commcare-setup` § Step 0 (`get_hq_connection`), and Phase 6 has
   `qa-and-training` § Pre-flight checklist (`ace-mobile` binding). These
   remain the backstop for `/ace:step`, for phases dispatched outside
   `/ace:run`, and for a server that dies mid-session. **Both are
   SESSION-SCOPED: they re-run on every entry into their phase, including a
   mid-phase resume that steps over already-`done` steps.** A `done` marker
   in `run_state.yaml` was written by a *previous session* and says nothing
   about this session's bindings, so it never satisfies them
   (dimagi-internal/ace#1604).

The same class can silently force a decisions-log hand-write
when `ace-decisions` is unbound (jjackson/ace#782) — if a `decisions_*`
atom won't resolve, treat it as unbound and follow the hand-write
fallback in `idea-to-pdd/SKILL.md § Schema and write semantics` rather
than guessing the file shape. (jjackson/ace#784.)

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
out separate `ls`/`test -f` probes. (Why the explicit `$DATA`
derivation: see orchestrator-reference.md § Pre-flight rationale.)

**Step 2 — Load deferred MCP atoms in ONE `ToolSearch` call.** L0-only
atom set (phase subagents run their own `ToolSearch` for phase-specific
atoms). Issue this verbatim — **fully-prefixed names**, no bare aliases:

```
ToolSearch select:mcp__plugin_ace_ace-gdrive__drive_read_file,mcp__plugin_ace_ace-gdrive__drive_list_folder,mcp__plugin_ace_ace-gdrive__drive_create_file,mcp__plugin_ace_ace-gdrive__drive_create_folder,mcp__plugin_ace_ace-gdrive__drive_update_file,mcp__plugin_ace_ace-gdrive__drive_move_file,mcp__plugin_ace_ace-gdrive__drive_rename_file,mcp__plugin_ace_ace-gdrive__docs_get,mcp__plugin_ace_ace-gdrive__sheets_read,mcp__plugin_ace_ace-gdrive__sheets_append,mcp__plugin_ace_ace-gdrive__classify_phase_writeback,mcp__plugin_ace_ace-gdrive__validate_run_state,mcp__plugin_ace_ace-gdrive__verify_phase_artifacts,mcp__plugin_ace_ace-gdrive__verify_phase_products,mcp__plugin_ace_ace-gdrive__resolve_opp_path,mcp__plugin_ace_ace-gdrive__generate_inputs_manifest,mcp__plugin_ace_ace-gdrive__get_google_form_definition,mcp__plugin_ace_ace-gdrive__update_yaml_file,mcp__plugin_ace_ace-gdrive__render_run_readme,mcp__plugin_ace_ace-connect__commcare_make_build,mcp__plugin_ace_ace-connect__commcare_release_build,mcp__plugin_ace_ace-connect__commcare_download_ccz,mcp__plugin_ace_ace-connect__commcare_upload_multimedia
```

**Use the fully-prefixed form** — the bare-name `select:` shortcut
resolves only built-in deferred tools (`TaskCreate`, `TaskUpdate`,
…), not plugin-registered atoms. Do NOT fall back to keyword search
(`ToolSearch query:"docs_get"`); fuzzy-match silently misses prefixed
atoms. Do NOT issue additional `ToolSearch` calls mid-run as you
encounter each atom — fold any miss into this literal next time you
bump the doc. (Rationale + incidents: see orchestrator-reference.md
§ Pre-flight rationale.)

**Step 2a — Assert the atoms actually resolved (MCP binding fence).**
Step 2 is also the only place L0 can observe **which plugin MCPs bound
in this session**. Read its result: every name in the literal that comes
back is bound; any name that does NOT come back means its server did not
attach. Do NOT treat a miss as "I'll search again later" — re-searching
returns nothing, because MCP subprocesses bind at session start and are
NOT respawned by `/reload-plugins`. A binding miss is **unrecoverable
in-session**.

Then assert, against the run's shape (fresh = all phases; resume = every
phase whose status is `pending` **or** `in_progress` in the loaded
`run_state.yaml`), that the atoms those phases need are present:

| A `pending` / `in_progress` phase of… | requires resolvable |
|---|---|
| `commcare-setup` | `commcare_*` (`ace-connect`) + Nova (`get_hq_connection`) |
| `connect-setup` | `connect_*` (`ace-connect`) |
| `ocs-setup` | `ocs_*` (`ace-ocs`) |
| `qa-and-training` | `mobile_ensure_avd_running` (`ace-mobile`) |

On a miss, **halt before the first `Agent` dispatch** with a `[BLOCKER]`:

> `<opp>/<run-id>`: `<server>` did not bind in this Claude Code session,
> so `<atom>` is unresolvable and phase `<N>` cannot run. This is a
> session-level bind miss, not a config or code defect — confirm with
> `npx tsx mcp/<server>-server.ts` against the install path (it will
> answer `initialize` + `tools/list` normally). MCP subprocesses bind at
> session start and are not respawned by `/reload-plugins`: **quit and
> reopen Claude Code**, then resume `/ace:run <opp>/<run-id>`.

**`in_progress` counts, and that is the whole point on a resume
(dimagi-internal/ace#1604).** What this fence tests is per-SESSION (which MCP
servers, and which principal, bound at startup); what it reads is per-RUN
state that outlives the session. Gating on `pending` alone excludes the one
phase a resume is about to execute — the `in_progress` one — so the fence is
absent from exactly the entry it is needed for. Observed on
`spark-facilitator/20260820-0817`: Phase 3 resumed `in_progress`, the fence
did not cover it, and the first Nova call answered `App not found` for an app
the previous session had built the day before.

**For `commcare-setup`, resolvability is not the assertion — the PRINCIPAL
is (ace#1604).** Nova's atoms can resolve perfectly while the connection is
bound to a different principal than `NOVA_API_KEY` names. Every read answers
normally; it answers about a different account's apps. A resolvability check
is structurally blind to that. So, for a `pending`/`in_progress`
`commcare-setup`, run one addressed check:

- If the run records
  `phases.commcare-setup.products.apps.{learn,deliver}.nova_app_id` → call
  Nova `list_apps` and assert **both ids are in the result**.
- If no app ids are recorded yet (a fresh run that has built nothing) → the
  assertion is `get_hq_connection` returning `configured: true`; there is
  nothing else to compare against.

On a miss, halt with the same `[BLOCKER]` shape as a bind miss — MCP auth
also binds at connection time, so a wrong principal is equally unrecoverable
in-session:

> `<opp>/<run-id>`: the Nova MCP bound a different principal than
> `NOVA_API_KEY` names — `list_apps` does not show this run's apps
> (`<learn-id>`, `<deliver-id>`). Do NOT rebuild them; they exist, under a
> principal this session is not talking to. **The credential on disk is
> almost certainly fine — do not go re-diagnosing it.** Confirm with one
> direct call, `curl https://mcp.commcare.app/mcp` bearing the key from
> `~/.ace/env.sh`: if that returns this run's apps, the key is correct and
> only the binding is wrong. **A plain restart is NOT sufficient for the
> principal case — it has been tried and it did not clear
> (dimagi-internal/ace#1614).** The cause is a stored OAuth token
> outranking the `headersHelper` PAT (voidcraft-labs/nova-plugin#52). Run
> `/mcp`, select `nova`, choose **`Clear authentication`** — NOT
> `Authenticate` — then **quit and reopen Claude Code**, and resume
> `/ace:run <opp>/<run-id>`.
>
> Verify with TWO calls before resuming: `list_projects` must return the
> PAT's project, and `get_hq_connection` must return `configured: true`.
> `list_apps` alone is not sufficient — re-authenticating as the right
> account fixes the identity while leaving you on OAuth, where
> `get_hq_connection` still answers `scope_missing: nova.hq.read`.

**`Clear authentication`, never `Authenticate`.** They sit next to each
other in the same `/mcp` menu and the wrong one reports success, which is
why this needs saying. `Authenticate` mints a *new* OAuth token — so if you
sign in as the right account the principal assertion above starts passing
and the run proceeds while still on the wrong credential, missing
`nova.hq.read`, and Phase 3 dies later at `upload_app_to_hq` instead. Only
`Clear authentication` removes the token and lets the PAT bind. It drops the
Nova connection outright rather than falling back live, which is why the
restart is part of the remedy rather than an alternative to it.

**Do not collapse the two failures into one remedy.** A *bind miss* (the
server never attached) IS cleared by quitting and reopening Claude Code — that
is the remedy above this block, and it stays. A *wrong principal* is a
connection that attached fine and authenticated as somebody else, so a restart
just re-establishes it: measured on `spark-facilitator/20260820-0817`, where
the second halt came from a claude process started **after** the first halt
and bound exactly the same wrong principal. Prescribing a restart there sends
the operator around a loop that produces no new information and costs a
session each lap. `nova` is a `type: http` server whose `headersHelper` reads
`$NOVA_API_KEY` from Claude Code's own process env; when the key is verifiably
present there (`ps -Eww -p <claude-pid>`) and a direct `curl` with it returns
the right apps, what is left is the connection's stored OAuth credential,
which only `Clear authentication` removes. Do NOT probe the macOS Keychain to
confirm that — `security(1)` hangs forever on a GUI prompt in a
non-interactive shell.

Full mechanism, the three non-fixes, and why every PAT-side health check
reports green throughout: `playbook/integrations/nova-integration.md`
§ Auth history → the nova-plugin#52 entry.

`bin/ace-doctor`'s `nova_needs_auth_cache` cannot stand in for this. It is a
static check of a cache FILE plus the key's PRESENCE — it reported a green
`pass` verdict throughout the incident above, which is why the block now
carries an explicit `scope:` line saying what it does not cover.

Halting *here* rather than at point-of-use is the whole value: the phase
agents do carry their own binding guards (`commcare-setup` § Step 0,
`qa-and-training` § Pre-flight Step 0), but reaching them costs a full
`Agent` dispatch, and on a **seeded** run whose only `pending` phase is
the unbound one that dispatch is the entire run. Worse, Phase 6's mobile
walk consumes the single-use Learn-completion precondition (one-way per
`(test user, opportunity)`), so dispatching into a half-bound MCP surface
risks burning the opp — whose only restore is a fresh `/ace:run`. The
doctor cannot cover this: it runs as a subprocess and structurally cannot
see this session's bindings. (jjackson/ace#784; live recurrence
bednet-spot-check/20260729-1239, where `ace-connect`/`ace-ocs`/`ace-mobile`
all silently failed to attach while `ace-gdrive`/`ace-decisions` bound.)

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
whole phase lands in a fictional folder tree.

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

**Run shape is structural, not flag-driven.** A fresh `/ace:run <opp>` always
starts all 11 phases `pending` and runs them in order (above) — there is no
`--only` / `--seed-from` flag. To start mid-pipeline with a frozen upstream
prefix (the iteration-loop case), the run is **pre-seeded on Drive and then
resumed** via the resume path
([§ Resuming after a halt → Run shape on resume](#resuming-after-a-halt)),
which honors phase statuses structurally — no flag interpretation. The
control that forks-then-resumes is `agents/iterate-loop.md`; the copy mechanic
is the `fork-run` skill. (Rationale + jjackson/ace#672: see
orchestrator-reference.md § Run shape rationale.)

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

**Write artifacts to Drive incrementally — do NOT batch all writes to
phase end.** A phase agent should write each artifact (recipe,
screenshot verdict, training doc, eval verdict, …) to Drive **the moment
it is produced**, and do the Phase Write-Back Contract as its final
step. The orchestrator dispatch prompt should say so explicitly. Bug
class: an interrupted phase (API socket drop, context exhaustion,
operator halt) that batched its Drive writes to the end persists
**nothing** — a re-dispatch redoes the entire phase from scratch.
Incremental writes also let the boundary fence's
`verify_phase_artifacts` show real partial progress so the orchestrator
can heal only the missing artifacts (see § Auto-retry silent Agent
dispatches); both assume each artifact lands on Drive independently.
(Canonical incident malaria-rdt/20260602-1409: see
orchestrator-reference.md § Incremental writes rationale.)

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

**Inline the artifact BODY, never a placeholder for it.** Before
sending the dispatch, re-read the prompt's `## Inline artifacts`
section and confirm each `<full … body>` slot holds the actual
artifact text — not a template token (`PDD_BODY_PLACEHOLDER`,
`<full PDD body>`, `{{PDD}}`) left unsubstituted. A stub that survives
to dispatch silently inverts the contract: the prompt says "do not
re-fetch" while carrying nothing to read, and large artifacts (a 68 KB
PDD) exceed the MCP `drive_read_file` result cap, so the agent's
fallback fetch is degraded too. Phase-agent side of the same guard: if
an inline block is a bare placeholder token, treat the artifact as NOT
inlined and read it from Drive (targeted reads under the result cap)
before proceeding. (Live incident hh-poverty-targeting/20260730-2210
Phase 2; jjackson/ace#1103.)

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
decisions, not replacements for its step list. (Why, + the
malaria-itn-app/20260523-0750 incident: see orchestrator-reference.md
§ Dispatch-scope rationale.)

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
failure and halts immediately — do not retry. (Why structural, not
text-match: see orchestrator-reference.md § Silent-dispatch rationale.)

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

ACE runs **many cycles per opp**, so most `/ace:run` invocations land on
an opp that already has substantial prior-run state (live Connect
program/opportunity, published OCS chatbot, open solicitation, prior
PDDs/apps). **This is the expected baseline, not an edge case.** The
orchestrator's contract on a populated opp:

- **Do not pause to confirm "do you want to overwrite live state?"** —
  `--mode default` already encodes the answer. The named Pause Points
  (see § Pause Points) plus the Phase 8→9 boundary are the only
  sanctioned pause locations. A populated-opp confirmation prompt is
  **off-spec** — push the reuse-vs-rebuild decision down into the
  affected phase agent's skill logic instead.
- **Reuse-vs-rebuild is owned by each phase agent's skills**, not by
  the orchestrator. Each run is independent — no run reads from or
  writes to another run's `run_state.yaml`. The only cross-run reuse
  surface is `opp.yaml` (Connect program UUID). Each new run gets its
  own `runs/<run-id>/<N>-<phase>/` artifact set; reuse means "phase
  agent skipped the rebuild step and pointed at the prior live entity,"
  NOT "wrote into the prior run's folder."

If you genuinely encounter prior state you can't classify as "reuse vs
rebuild" by inspecting `opp.yaml`, that is a **skill bug** — file an
issue, don't add an orchestrator-level confirmation prompt. (Worked
per-skill examples + the solicitation-scoping note: see
orchestrator-reference.md § Fork Points and § Populated-opp contract.)

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
  publishes a passive public solicitation, not active outreach.
  **Phase 8 is publish-only by default: it does NOT email PDD-named
  candidate LLOs.** Candidate-invite email (`llo-invite`) is OFF unless
  the operator explicitly opts in (`/ace:run --invite-candidates`, or
  `ACE_SOLICITATION_INVITE_CANDIDATES=1`). Without that signal the
  orchestrator must NOT email candidates and must NOT pause to ask —
  proceed publish-only and note the skip. The active-comms boundary is
  Phase 8→9 (standing operator directive 2026-05-31).
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

**In auto mode, NEVER end a turn with a question.** An auto run is
normally headless (`claude -p`), so there is no operator on the other
end — the question IS the halt, and it costs every phase that would
have followed. The rule above governs the *enumerated* Pause Points;
this one governs the **unexpected** case, which is where it actually
bites: a dispatch that errors, a tool result you can't parse, a step
with two defensible next moves. Decide using the standing rules,
record the decision and its rationale in `run_state.yaml`, and
proceed. Halt loud — typed error, write-back, exit — only when a phase
precondition is genuinely unreachable. *"I don't know which of two
reasonable things the operator wants"* is not unreachable: pick the
one consistent with the run's own contract and note that you did.

Measured (dimagi-internal/ace#1248): a `mode: auto` iterate run
finished Phase 3 with every step `pass`, hit an interrupted eval
dispatch, and ended its turn asking *"Want me to resume, or skip the
evals and take the partial?"* — burning the run's remaining phases on
a question nobody could answer. This is the same lesson CLAUDE.md
records for gating hooks ("interactive 'ask' prompts stall autonomous
runs — the hal lesson"), one layer up.

### Why default mode looks like this

See orchestrator-reference.md § Why default mode looks like this.

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
  reads `run_state.yaml` and continues per the **structural run-shape
  rule** (§ Resolve the run-id → Resume mode → *Run shape on resume*):
  run the next `pending` phase, step over `skipped`, end when no
  `pending` phase remains. The path form (`<opp>/<run-id>`, not bare
  `<opp>`) is what triggers resume — passing only `<opp>` would
  create a fresh `runs/<new-id>/` folder. This same path is how a
  **seeded** mid-pipeline run executes: the seeding (fork golden →
  write the shaped `run_state.yaml`) happens outside `/ace:run`, then a
  plain resume drives it (jjackson/ace#672).
- `/ace:step <skill> <opp>/<run-id>` — re-dispatch a single phase or
  skill, useful for retrying a specific failure or backfilling a step
  that was previously inlined or skipped.

Phase agents 3–9 are subagents (each gets a fresh context window per
dispatch), Phase 3 (`commcare-setup`) included as of 0.13.1018 — it had
been inline only because subagents could not reach Nova, and that
constraint is gone. The remaining inline node in the run is Phase 7
(`synthetic-data-and-workflows`), which keeps the `canopy:ddd` →
`canopy:visual-judge` chain inside the depth budget.

(The context-exhaustion shortcut anti-pattern lives in
§ Anti-patterns and discipline → Procedure discipline.)

**Cross-repo dev exception.** The "trust 1M context" rule covers
in-phase work. When a phase block requires cross-repo development
(ace-web, an MCP server) involving ≥2 PRs through GitHub, halt the
run with `phase: failed/blocked-on-infra`, surface to the operator,
and resume in a fresh session once the infra ships. (Why, + the leep
20260512-0418 incident: see orchestrator-reference.md § Cross-repo dev
exception rationale.)

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
   - If multiple plausible candidates exist, **pick the
     most-recently-touched one** (by `inputs/` mtime) and record the
     choice plus the rejected candidates in the run's decisions log. Do
     not prompt. This is the same tiebreak zero-arg `/ace:run` already
     uses (`commands/run.md § Smart-default UX`), so ambiguity resolves
     the same way whether or not a slug was passed. Reuse beats a second
     rule: an operator who meant the other opp forks the run, which is
     cheaper than a blocked run.
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
     per the structural run-shape rule below. No new folder is created. Skip
     steps 4, 6 and 7 — but **run step 5 (capture the inputs manifest)
     unconditionally** (see the next paragraph). run_state.yaml exists and is
     the source of truth for which run we're resuming. ace-web doesn't read opp.yaml.last_run_id / opp.yaml.runs
     (it scans the runs/ folder directly), so we don't update them here
     either.

     **Step 5 still runs on resume — unconditionally (dimagi-internal/ace#1234).**
     Skipping it is correct for a run `/ace:run` itself created (it captured
     the manifest at run-init) and WRONG for a run whose folder was seeded
     from outside `/ace:run` — which is now the documented, first-class way to
     start mid-pipeline (§ Run shape is structural; `agents/iterate-loop.md
     § --new-golden`). Observed live on `bednet-check-2-visit/20260813-1639`:
     the run folder held exactly one file (`run_state.yaml`), so Phase 1 had
     no declared evidence pack to inline and produced a PDD grounded in less
     than the operator staged — the `No inferred backstory` class through the
     back door, and silent (Phase 1 still emits a PDD).

     **Restore, don't adapt** (CLAUDE.md § Phase preconditions are restored,
     not adapted): do NOT probe for `inputs-manifest.yaml` first and branch.
     `generate_inputs_manifest` is idempotent and `drive_create_file` is
     find-or-update, so an unconditional call is a no-op on a run that already
     has one — one extra atom call per resume, and the branch disappears.
     Halting instead would be worse: the manifest is trivially derivable from
     `inputs/` at any time, so a halt makes the operator do by hand what the
     orchestrator can just do.

     **Run shape on resume (the one rule that drives execution).** The phase
     execution order is *derived from `run_state.yaml.phases.*.status`*, not
     from any flag or the markdown phase list:

     - `pending` → run it (in ordinal order).
     - `skipped` → step over it; never dispatch, never pause, never fence.
     - `done` / `complete` (incl. `verdict: seeded`) → already satisfied; skip.
     - `error` / `blocked` → halt and surface (do not auto-advance past).

     **The run is complete when no `pending` phase remains.** This is what
     gives a seeded mid-pipeline run its stop-after behavior for free: a run
     seeded as `{1,2: done, 3,4,6: pending, 5,7,8,9,10: skipped}` runs 3 → 4 →
     (5 skipped) → 6, then finds no `pending` phase left and ends — no flag, no
     special stop logic. The same rule is how a normal full run ends after
     Phase 8 (the PAUSE) when 9–10 are not yet live.

     **Surface the run-summary URL as the run's first-class output (every
     completion AND every pause).** ACE's canonical shareable deliverable is the
     ace-web run-summary page — a clean per-run summary plus the live links (HQ
     apps, Connect opportunity, chatbot, demo video + dashboards, training docs),
     served from `run_state.yaml` products read live from Drive. It is
     **derivable from ACE's own config** — do not spelunk the ace-web DB for it:
     ```
     ${ACE_WEB_BASE_URL}/opps/${ACE_WEB_WORKSPACE}/<opp>/runs/<run-id>/summary
     ```
     (`.env` defaults: `ACE_WEB_BASE_URL=https://labs.connect.dimagi.com/ace`,
     `ACE_WEB_WORKSPACE=dimagi-team`.) At the end of the run and at every pause
     point: (1) write it to `run_state.yaml` top-level as `ace_web_summary_url`;
     (2) **Audit it before presenting** — invoke `run-surface-audit` (runs
     `scripts/audit-run-surface.ts <opp> <run-id> --render --run-state <path>`),
     which probes the page as an anonymous outsider: every link by class, the
     payload's own shape contract, confidentiality, every artifact the run
     actually produced, each published document's rendering, and the rendered
     page in a headless browser. Fix every **broken** and **misleading** finding
     at its source before sharing — a page that states something untrue costs
     more than a page with a dead link, and that is the tier that shipped
     undetected on `spark-facilitator/20260813-2126`. Then run
     `run-surface-audit-eval` for the judged half; and
     (3) lead the operator-facing close-out with that URL. This is the link an
     operator shares; it should never be reconstructed by hand or left unverified.

     **(4) If `run_state.yaml.triggered_by.thread_id` is set, draft the
     close-out reply (ace#1057).** A run dispatched from a turn is a promise to
     a person, and the summary URL above only reaches the operator *in this
     session* — if the session ends, or the run is long, the counterpart who
     asked learns nothing. Call `pendingCloseoutNotice`
     (`lib/triggering-thread.ts`), write the draft into the run's comms-log,
     and surface it as an explicit **pending outbound** in the close-out
     report. Three rules:

     - **Drafted, never sent.** Outbound stays approval-gated and
       `bin/ace-email` remains the only send path. This adds a visible parked
       item, not an autonomous send.
     - **A HALTED run still drafts.** Silence is the failure mode, not bad
       news — "Phase 8 is waiting on LLO selection" serves the counterpart far
       better than days of nothing.
     - **Nothing mid-run.** A progress ping is noise, and noise is how a real
       notice gets ignored.

     Measured cost of not doing this: thread `19f86579142e6ba5`, 2026-07-29 —
     *"Just checking if ACE is still working on this?"*, sent while the run had
     been running two days and had completed its last phase hours earlier.

     **Rebuild the TaskList from the loaded statuses** (one parallel
     `TaskCreate` block, as in Step 4): `done`/`skipped` → `completed`
     (skipped phases carry a one-word "skipped" note), every `pending` phase →
     `pending`, and the **first** `pending` phase → `in_progress`.

     **Structural precondition check (before dispatching each `pending`
     phase).** Confirm the phase's required input artifacts (per
     `lib/artifact-manifest.ts` `artifactsConsumedBy`) are present — produced
     by a `done`/`seeded` phase or an earlier `pending` phase in this run. If a
     required input is missing AND its producer is `skipped` (or absent), halt
     loud — a seeded run was shaped wrong:

     > resume `<opp>/<run-id>`: phase <N> needs `<artifact>` produced by phase
     > <M>, which is `skipped`/absent in this run's run_state. The run was
     > seeded with the wrong shape — re-seed including phase <M>.

   - **Fresh mode** — `runId` is null: generate
     `runId = generateRunId(new Date())` (= `YYYYMMDD-HHMM` local time).
     If `<opp>/runs/<runId>/` already exists, append `-2`, `-3`, … until
     unused.

4. **Create the run folder.**
   `drive_create_folder` `<opp>/runs/<runId>/`. Capture the resulting
   folder ID; this is the **run folder ID** that gets passed to every
   downstream skill in place of the previous "opp folder ID".

   Fresh mode always initializes all 11 phases `pending` (Step 4) and runs
   from Phase 1. **There is no in-orchestrator seed step** — a mid-pipeline
   start with a frozen upstream prefix is created *outside* `/ace:run`
   (`agents/iterate-loop.md` or the ace-web `seeded-run` action forks the
   golden via `fork-run`, writes the pre-seeded `run_state.yaml`, then
   dispatches a plain **resume** `/ace:run <opp>/<new-run-id>`). The
   orchestrator never interprets a `--seed-from`/`--only` flag
   (jjackson/ace#672); it just resumes a run whose shape is already on Drive
   (§ Resolve the run-id → Resume mode, and § Resuming after a halt → Run
   shape on resume).

5. **Capture the inputs manifest.** Record what was in `inputs/` at
   run-start so `idea-to-pdd` synthesizes from a frozen pointer-set
   (a human re-arranging `inputs/` mid-run won't shift ground beneath
   the skill). **Always** write the manifest at the run-folder root,
   alongside `run_state.yaml`:

   - **5a. Ensure `<opp>/inputs/` exists** via
     `drive_create_folder({name: 'inputs', parentFolderId: <opp-folder-id>})`.
     The MCP's `findOrCreate: true` default returns the existing folder
     id if `inputs/` already exists — idempotent, one call.
   - **5b. Auto-migrate top-level docs into `inputs/`.** List `<opp>/`
     via `drive_list_folder`. For each direct child whose
     `mimeType` is NOT `application/vnd.google-apps.folder` AND whose
     name is NOT ACE-owned (see skip-list below),
     call `drive_move_file({fileId, newParentFolderId: <inputs-folder-id>})`
     to move it into `inputs/`. Log every move in `run_state.yaml.notes`
     as a single line: `auto-migrated <name> from opp folder root to
     inputs/`.

     **Skip-list — the ACE-owned opp-root registry.** The exemption
     set is `lib/opp-root-files.ts`
     (`isAceOwnedOppRootEntry(name)`); `/ace:doctor`'s stray-file check
     imports the SAME registry, so the two cannot drift, and
     `test/lib/opp-root-files.test.ts` fails if this list omits an
     entry. Never migrate:

     | Entry | Owner | Moving it breaks |
     |---|---|---|
     | `opp.yaml` | connect-program-setup | the durable Connect program reference every run reuses |
     | `open-questions.md` | Phase 1 | the ace#1201 durable-questions loop — the read half looks at the opp ROOT, so a migrated file silently stops being found while a fresh one keeps being written (#1325) |
     | `iterate-state.yaml` (and `iterate-state-legacy-*.yaml`) | `/ace:iterate` | the campaign: golden pointer, pass streak and kill switch all reset (#1282) |
     | `*_comms-log*` | email-communicator / inbox-triage | Gmail `thread_id` routing, as well as poisoning the evidence pack (ace#929) |
     | `inputs` / `runs` / `current` / `eval-calibration` / `feedback` | ACE | folders are never moved anyway; listed so doctor doesn't call them cruft |

     Every one of these is a file ACE ITSELF writes to the opp root, so
     migrating it feeds ACE's own prior output back in as curated
     source evidence — the `no-inferred-backstory` class through a
     self-referential back door. Subfolders are never moved. (The
     migrate itself catches the "operator drops the source doc next to
     opp.yaml" case — jjackson/ace#299.)

     **Writing a new durable per-opp file?** Register it in
     `lib/opp-root-files.ts` in the same PR, or Step 5b will migrate it
     and the skill will stop finding it on the next run. Per-RUN state
     belongs under `runs/<run-id>/`.
   - **5c. Capture the manifest — files AND the ids of the subfolders you
     did not descend into.** List `<opp>/inputs/` via `drive_list_folder`.
     For each direct child FILE, capture `{file_id, name, mime_type}` under
     `inputs:`. For each direct child SUBFOLDER, capture
     `{folder_id, name}` under `subfolders_not_listed:` — **mandatory, not
     optional** (ace#1648). Also record `source_folder_id`, the `inputs/`
     folder's own id. No extra call is needed for the subfolders:
     `generate_inputs_manifest` already returns them in `files[]` carrying
     `mime_type: application/vnd.google-apps.folder` — it is this step that
     used to drop them on the floor. Write the result as
     `runs/<runId>/inputs-manifest.yaml` via `drive_create_file`:

     ```yaml
     opportunity: <opp>
     run_id: <runId>
     captured_at: <ISO timestamp>
     source_folder_id: <inputs-folder-id>
     inputs:
       - file_id: <id>
         name: <name>
         mime_type: <mime>
       - ...
     subfolders_not_listed:        # ALWAYS present; `[]` when there are none
       - folder_id: <id>
         name: <name>
       - ...
     ```

     **Why the folder ids are mandatory.** `inputs[]` stays direct-child
     FILES only — its job is to freeze the evidence set Phase 1 synthesizes
     from, and widening it would change what counts as evidence. But a
     published instrument bundle is naturally a SUBFOLDER of `inputs/` (a
     vendor download), and `pdd-to-deliver-app` Step 4k resolves the
     `[FIXED]` source instrument FROM THIS MANIFEST. With no folder id
     recorded, that workbook is unaddressable, 4k used to skip silently, and
     the run reported green having verified no constants at all — the
     `hh-poverty-targeting` failure class (9 of 17 scorecard point values
     wrong, 101 lookup values invented). Recording the id lets 4k walk it one
     level; it is NOT permission to compose a path by name.

   - **5d. Halt only if still empty.** If after auto-create + migration
     `<opp>/inputs/` contains zero direct child files, halt with the
     fallback message in § Fallback below. Subfolders inside `inputs/`
     don't count as files; if every direct child is a subfolder the
     manifest's `inputs[]` is empty and the same fallback fires — their ids
     are still recorded under `subfolders_not_listed` per 5c, but a manifest
     with no evidence files is not a Phase-1 seed.

   Phase agents materialize their own `<N>-<phase>/` folders when
   they run (see § Per-Phase Folder Lifecycle); the orchestrator does
   NOT pre-create `1-design/` here. The manifest is the sole seed for
   Phase 1 — `idea-to-pdd` reads each file via the manifest's
   `file_id`s as the evidence pack (no file is copied into the run
   folder; no single `pdd.md` is picked). Free-text seed material goes
   into `inputs/` as a regular file.

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
   the folder-create message. **This is the ONLY place you call
   `render_run_readme`.** From here on the README refreshes itself: the
   boundary fence's `verify_phase_artifacts` call derives the phase-status
   map from `run_state.yaml` and rewrites `README.md` on every phase
   completion, reporting `readme_refreshed` — see § Per-Phase Folder
   Lifecycle in `agents/orchestrator-reference.md`.

   Do NOT shell out to `npx tsx -e "..."` against `lib/run-readme.ts`
   — the `render_run_readme` atom exists specifically to remove that dance.

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

**Inputs (inline at handoff):** the inputs manifest, `run_state.yaml`, and
**`<opp>/open-questions.md` (opp-root, durable across runs) when it exists AND
§ Two bounds below allows it** — pass its `file_id` alongside the manifest.
The bounds are not optional trimming: on a fixture opp the file is not passed
at all (dimagi-internal/ace#1487).

Why it is listed separately: the manifest enumerates `<opp>/inputs/` **only**
(it is generated by `generate_inputs_manifest(inputs_id)`), and
`open-questions.md` lives at the opp ROOT, so it is structurally invisible to
Phase 1 otherwise. ACE writes durable open questions every run and then never
read them back — the write half of a loop with no read half. On
`hh-poverty-targeting/20260812-1613` that cost rediscovery of questions already
recorded and, worse, a fresh answer that **contradicted** one a prior run had
verified, with no signal to the run that the contradiction existed
(dimagi-internal/ace#1201).

Phase 1 must state, for each pre-existing open question, whether this run
**resolves / carries forward / contradicts** it — and a contradiction is loud
(surface it at the Phase 1→2 pause, not only in the file). Do NOT widen
`generate_inputs_manifest` to include opp-root files: the manifest's job is to
freeze `inputs/`, and overloading it blurs per-opp vs per-run state. (Step 5c's
`subfolders_not_listed` is not a widening of this kind: it records the ids of
folders INSIDE `inputs/` that `inputs[]` deliberately does not list, so a
downstream step can address them. `inputs[]` — the evidence set Phase 1
synthesizes from — stays direct child files only.)

**Two bounds on that inline (dimagi-internal/ace#1487).** The #1201 read above
was unconditional and unscoped, and the durable ledger is append-only, so it
grew without limit and Phase 1's mandated per-question read-back grew with it.
Both bounds NARROW the read; neither removes it, and the #1201 rationale above
stands unchanged. The classifier is `classifyOpenQuestionsInline` in
`lib/open-questions-inline.ts` — pure, imported by
`test/lib/open-questions-inline.test.ts`, and the source of truth if this prose
ever disagrees with it.

- **FIXTURE SKIP.** When the opp root carries `iterate-state.yaml` (the
  `/ace:iterate` campaign-state file, per the registry in
  `lib/opp-root-files.ts` — this is the fixture signal; do NOT add a `fixture:`
  field to `opp.yaml`), do **NOT** pass `open-questions.md` at all, at any
  size. A fixture opp's brief is the whole intended input, and its regression
  baseline must not absorb accumulated run history — that is ace#1325's hazard
  (ACE reading its own prior output as Phase 1 source evidence) arriving
  through the sanctioned inline path. Say so **once** in the run notes, citing
  dimagi-internal/ace#1487; do not repeat it per phase.
- **BOUNDED INLINE.** Otherwise pass the durable doc's **`## Open` section
  only** — `## Archive` is never read back and never inlined (see
  `skills/idea-to-pdd/SKILL.md` for the two-section shape). Above
  `OPEN_QUESTIONS_INLINE_CAP_CHARS` (8,000 chars, exported from
  `lib/open-questions-inline.ts`), pass the `file_id` plus the most recent open
  rows rather than the whole section, and **name the truncation at the Phase
  1→2 pause** so the run states what it did not read. Tripping the cap is
  itself a signal the ledger needs pruning — resolved rows belong under
  `## Archive`.

Each branch's `reason` string is written to be pasted straight into the Phase
1→2 pause summary.

**How to READ it — the export shape is load-bearing.** The durable ledger is a
human-facing prose doc, published as a **converted** Google Doc
(`drive_create_doc_from_markdown` — a `run-surface-audit` flagged the
un-converted form as `DOC-LITERAL-MARKDOWN`, raw `##` and pipe tables shown to
the reader). Read it with **`drive_read_file(..., exportAs: 'text/markdown')`**,
the same way the PDD is re-read. `drive_read_file`'s DEFAULT `text/plain`
export of a converted doc **strips the `##` markers** (`## Open` arrives as a
bare `Open`) and flattens every pipe table to one cell per line, so the section
stops resolving and the question rows run together — measured against a
converted probe doc, 2026-08-26. Pass the read through `extractOpenSection`
(`lib/open-questions-inline.ts`): it returns the `## Open` section with
`## Archive` structurally excluded, and on a heading-stripped read it returns
`needs-markdown-export` and names the remedy rather than guessing at a section
whose rows have already run together.

**Atoms / skills used (orchestrator-visible only):** `Agent(idea-to-design)`.

**Products:** PDD (`1-design/idea-to-pdd.md`) — the formal design doc; Work Order (`1-design/pdd-to-work-order.gdoc`) — contractual draft derived from PDD + decisions.yaml. Both are required outputs of Phase 1; the work order chain (Steps 2, 2.4, 2.5 in `agents/idea-to-design.md`) runs after the PDD chain.

**Gate:** checkpoint-on-`idea-to-pdd` — a `[BLOCKER]` halts the run with `status: blocked` and no prompt (`default`/`auto`). In `review` mode this is the natural human checkpoint at the Phase 1→2 boundary.

### Phase 2: Scenarios & Acceptance Planning

**Dispatch:** `Agent(scenarios-and-acceptance)`.

**Inputs (inline at handoff):** approved PDD (`1-design/idea-to-pdd.md`), Phase-1 verdicts (`1-design/idea-to-pdd-{qa_result,eval_verdict}.yaml`), `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(scenarios-and-acceptance)`. Internally the agent runs `pdd-to-test-prompts` (+ QA + eval) then `pdd-to-app-journeys` (+ eval).

**Products:** opp-specific test prompts (`2-scenarios/pdd-to-test-prompts.md`) — Q&A scenarios the Phase 5 OCS deep QA gate judges chatbot answers against; expected app journeys (`2-scenarios/pdd-to-app-journeys.md`) — UX-intent scenarios the Phase 6 shallow app QA and `/ace:qa-deep` grade FLW app behavior against. Both are AI interpretations of the AI-authored PDD — "what we'd expect," not ground truth.

**Notes:** The two skill chains are independent of each other (both read only the PDD) so a `[BLOCKER]` from one doesn't necessarily implicate the other.

### Phase 3: CommCare Setup

**Dispatch:** `Agent(commcare-setup)`.

**Inputs (inline at handoff):** PDD, prior-phase verdicts (`1-design/idea-to-pdd-{qa_result,eval_verdict}.yaml`), `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(commcare-setup)`, which itself dispatches `/nova:autobuild` for `pdd-to-learn-app` + `pdd-to-deliver-app` (each Nova call is `Agent(nova:nova-architect-autonomous)`, landing at depth 2).

**Products:** Learn app, Deliver app, deployed apps on CCHQ, test results (`3-commcare/app-test-cases.yaml` + `app-test-cases/J*.yaml`). (Training materials moved to Phase 6 (`qa-and-training`) in 0.9.0.)

**Gate:** checkpoint-on-`app-deploy` — a `[BLOCKER]` halts with `status: blocked`, no prompt, in `default`/`auto`; pauses in `review`.

**Notes:** Phase 3 became a subagent in 0.13.1018. It had been an inline procedure doc solely because Claude Code withheld `Agent` from subagents, which would have made its `/nova:autobuild` dispatch unreachable; nesting has been allowed since v2.1.219 and the chain fits at depth 2. Dispatching it recovers a fresh context window for the heaviest phase in the run — but a subagent inherits nothing, so **Inputs** above must be complete at handoff. See `CLAUDE.md § Agent topology`.

### Phase 4: Connect Setup

**Dispatch:** `Agent(connect-setup)`.

**Inputs (inline at handoff):** PDD, Phase-3 verdicts (`3-commcare/{pdd-to-learn-app,pdd-to-deliver-app,app-deploy,app-test-cases}-{qa_result,eval_verdict}.yaml`), `3-commcare/app-deploy_summary.md`, `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(connect-setup)`.

**Products:** Program configured; Opportunity configured with verification rules and delivery/payment units; opportunity **activated** (`is_test=true`); ACE test user (`${ACE_E2E_PHONE}`) pre-invited (`4-connect/connect-program-setup.md`, `4-connect/connect-opp-setup.md`).

**Notes:** Phase 4 activates the opp and invites the ACE test user (`${ACE_E2E_PHONE}`) so Phase 6 `app-screenshot-capture` has a real signed-in user (not placeholder screenshots). The opp is created with `is_test=true` so prod LLO-facing analytics/payment exports/partner dashboards exclude these dogfood runs; activation here is therefore not a Phase 8→9 boundary violation. Phase 9's `llo-launch` is idempotent on already-active opps (skip-and-log) and still sends the real-LLO invite to the awarded LLO. LLO invite-list prep is deferred to Phase 9. After Phase 4 completes, the orchestrator refreshes `current/` shortcuts (see § Per-Phase Folder Lifecycle in reference).

### Phase 5: OCS Setup

**Dispatch:** `Agent(ocs-setup)`.

**Inputs (inline at handoff):** PDD, opp-specific test prompts (`2-scenarios/pdd-to-test-prompts.md`), Phase-4 verdicts (`4-connect/{connect-program-setup,connect-opp-setup}-{qa_result,eval_verdict}.yaml`), `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(ocs-setup)`.

**Products:** per-opp OCS chatbot cloned from the golden template with opp-specific RAG collection; quick smoke qa+eval passed; deep pre-launch qa+eval passed against opp-specific test prompts; embed credentials ready for Connect (`5-ocs/ocs-agent-setup.md`).

**Gate:** checkpoint-on-`ocs-chatbot-eval --quick` — a `[BLOCKER]` halts with `status: blocked`, no prompt, in `default`/`auto`; pauses in `review`.

**Notes:** Each quality gate is a qa→eval pair — `ocs-chatbot-qa` captures a transcript, `ocs-chatbot-eval` grades it. Ends with a human-in-the-loop step to paste the widget credentials into the Connect opportunity until `update_opportunity` lands (CCC-301). After Phase 5 completes, the orchestrator refreshes `current/` shortcuts (see § Per-Phase Folder Lifecycle in reference).

### Phase 6: QA and Training

**Dispatch:** `Agent(qa-and-training)`.

**Inputs (inline at handoff):** PDD, Phase-3 outputs (`3-commcare/app-test-cases.yaml` + per-journey recipes under `3-commcare/app-test-cases/J*.yaml`), Phase-5 chatbot URL (`5-ocs/ocs-agent-setup.md`), `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(qa-and-training)`. Internally the agent runs `app-screenshot-capture` (executor — runs the smoke recipes from Phase 3's `app-test-cases.yaml`) → 5 per-artifact training skills in parallel (`training-llo-guide`, `training-flw-guide`, `training-quick-reference`, `training-faq`, `training-deck-generate`) → `training-deck-render` (sequential after deck-generate; skipped if `ACE_TRAINING_DECK_TEMPLATE_ID` unset) → `training-onboarding-email` (LAST — links by URL to other docs).

**Products:** Phase-6 artifacts under `6-qa-and-training/` — screenshot bundles, 5 training docs (LLO guide, FLW guide, quick reference, FAQ, deck spec), optional training deck render, onboarding email.

**Notes:** Phase 6→7 is no longer a mandatory pause (§ Modes). No 1-1 LLO contact happens here — that begins in Phase 9. Phase 6 splits shallow (in `/ace:run`, ~5 LLM judges) vs deep (out-of-band via `/ace:qa-deep`); `llo-launch` (Phase 9) requires fresh deep verdicts. **App-QA-only mode:** when `phases.ocs-setup.status == skipped` in the loaded `run_state.yaml` (a seeded run that skipped Phase 5 — the iteration-loop case), add a context line to the dispatch — "Phase 5 (OCS) was skipped this run; run app-QA-only mode per your agent definition" — so the agent runs only the mobile app-QA walk and marks the OCS-dependent training skills `skipped` (`agents/qa-and-training.md § Mode: app-QA-only`). A normal full run always runs Phase 5 first, so this never fires there.

### Phase 7: Synthetic Data and Workflows

**Dispatch:** **inline procedure-doc `agents/synthetic-data-and-workflows.md`** — do NOT call `Agent(synthetic-data-and-workflows)`. Level-0 constraint, see Notes.

**Inputs (inline at handoff):** PDD, Phase-4 Connect identifiers (`4-connect/connect-opp-setup.md`), `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** read + execute `agents/synthetic-data-and-workflows.md` inline. Internally: authors a story-coherent synthetic-data manifest from the PDD, generates fixture data via the connect-labs MCP, instantiates the LLO weekly review + program admin audit workflows, polishes them per-opp, and runs persona walkthroughs that produce stakeholder-ready HTML decks.

**Products:** synthetic narrative manifest; fixture FLW/visit/payment data; two demonstrative workflows (`llo_weekly_review`, `program_admin_audit`); per-persona walkthrough HTML decks; single one-page summary (`7-synthetic/synthetic-summary.md`).

**Gate:** **no phase pause** — `/ace:run` proceeds straight from Phase 7 to Phase 8 without halting (no run-time gate; see § Pause Points in reference).

**Notes:** **Depth constraint — Phase 7 is a procedure doc, not a subagent.** Its Step 3 dispatches `Agent(canopy:ddd)`, which fans out per-scene judges of its own: the deepest chain in ACE. Running Phase 7 inline puts that chain at depth 2 inside a budget of 3. When `spark-facilitator/20260813-2126` ran it as a subagent, the nested dispatch was unreachable under the Claude Code of the time, so only a single render+judge pass executed — no loop, no convergence rule, no stopping rule — and a human halted it after four hand-driven iterations. Nesting is permitted now, but the failure mode is worse: past the budget the `Agent` tool is silently withheld and the per-scene judging collapses into one context while still emitting full verdicts. Keep it inline unless `lib/agent-depth.ts` says the chain still fits. Same reasoning as Phase 3.

**No irreversible external action.** The connect-labs `SyntheticOpportunity` row is reversible via `synthetic_disable`; workflows can be deleted via `workflow_delete`. See `agents/synthetic-data-and-workflows.md`.

### Phase 8: Solicitation Management

**Dispatch:** `Agent(solicitation-management)`.

**Inputs (inline at handoff):** PDD (with PDD-named candidate LLOs, if any), Phase-7 summary (`7-synthetic/synthetic-summary.md`), `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(solicitation-management)`. Internally the agent runs `solicitation-create` (always) → `llo-invite` (**publish-only by default — `llo-invite` is a no-op unless the operator opts in via `--invite-candidates` / `ACE_SOLICITATION_INVITE_CANDIDATES`**).

**Products:** solicitation derived from the PDD published on labs.connect.dimagi.com via the `connect-labs` MCP. **Candidate-invite emails are OFF by default (publish-only).** When the operator explicitly opts in, the agent emails PDD-named candidate LLOs the public URL (no-op if the PDD names no candidates). The dispatch prompt MUST carry the publish-only override unless opt-in is set — see § Modes → Phase 6→7 transition.

**Gate:** terminal — `/ace:run` halts after this phase (Phase 8→9 boundary; see § Workflow callout for the authoritative statement). `selected_llo` is populated only by the manual `/ace:step solicitation-review` (HITL-gated `award_response`).

**Notes:** The recurring `solicitation-monitor` skill polls labs for responses while the solicitation is open; runs OUTSIDE `/ace:run` (cron or manual dispatch). Its cross-run write semantics are TBD pending Phase 8+/8 architecture decisions. `solicitation` and `selected_llo` are separate sub-blocks under `phases.solicitation-management.products.*` — only `solicitation-review` populates `selected_llo`.

### Phase 9: Execution Management

**Not yet live** — `/ace:run` does not reach this phase (§ Workflow callout); the block below is forward-spec for when execution is enabled, and `agents/execution-manager.md` self-guards against accidental dispatch.

**Dispatch:** `Agent(execution-manager)`. **Entry gated on `phases.solicitation-management.products.selected_llo.org_slug` being populated by Phase 8's `solicitation-review`** in the current run's `run_state.yaml`.

**Inputs (inline at handoff):** PDD, Phase-6 training artifacts (5 docs + onboarding email under `6-qa-and-training/`), Phase-5 chatbot URL (`5-ocs/ocs-agent-setup.md`), `selected_llo` (from run_state.yaml.phases.solicitation-management.products.selected_llo), `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(execution-manager)`.

**Products:** the awarded LLO onboarded (Connect program-level invite + ACE onboarding email with widget link); UAT completed; opportunity activated (go-live); ongoing monitoring active.

**Gate:** specification only — Phase 9 is not live (`agents/execution-manager.md` halts before any step). When enabled, the `llo-onboarding` / `llo-uat` / `llo-launch` external-comms gates need a mechanism that is not `AskUserQuestion`, which is withheld from subagents. See § Pause Points in reference.

**Notes:** Phase 9 is the first 1-1 LLO contact in the lifecycle. Recurring skills (`timeline-monitor`, `flw-data-review`, `ocs-chatbot-qa-monitor`, `ocs-chatbot-eval-monitor`) run on schedule during the active opportunity. `llo-launch` requires fresh deep verdicts (Phase 6 `/ace:qa-deep` output).

### Phase 10: Closeout

**Not yet live** — gated behind Phase 9 (§ Workflow callout); forward-spec for when execution is enabled.

**Dispatch:** `Agent(closeout)`. **Triggered when the opportunity reaches its end date.**

**Inputs (inline at handoff):** Phase-9 outputs (LLO onboarding + UAT + go-live artifacts under `9-execution-manager/`), `selected_llo` (from run_state.yaml.phases.solicitation-management.products.selected_llo), `run_state.yaml`.

**Atoms / skills used (orchestrator-visible only):** `Agent(closeout)`.

**Products:** Invoices pulled; Jira payment ticket created; LLO feedback collected; learnings summarized; cycle graded.

**Gate:** specification only — unreachable while Phase 9 is not live. When enabled, the `opp-closeout` Jira payment ticket needs the same non-prompt mechanism as the Phase 9 gates.

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

**Anti-pattern** (each a separate assistant turn — ~4 wasted turns ×
8 boundaries ≈ 1–3 min latency per `/ace:run`): a solo "Phase N
complete" text turn, then `drive_read_file`, then `TaskUpdate`, then
`Skill(decisions-render)`, then `Agent(<next-phase>)` — all in separate
turns instead of one batched message.

**Right pattern.**

```
Turn N:    Agent(<phase>) tool_result
Turn N+1:  ONE message — all 6 tool calls in parallel:
             1. classify_phase_writeback(fileId=<run_state.yaml>, phaseName=<phase>)
                — returns 'ok' | 'missing' | 'in_progress' | 'error' | 'malformed'
             2. drive_list_folder on <runFolderId>/<N>-<phase>/ (artifact verifier)
             3. verify_phase_artifacts(runFolderId, phase=<manifest-key>)
                — returns {phase, ok, missing[], present_count,
                  expected_count, optional_present_count, summary,
                  readme_refreshed}
                  where each missing entry carries {path, producedBy, description}
                — covers the artifact-presence half of the gate;
                  classify_phase_writeback covers the run_state.yaml half
                — ALSO refreshes <run-folder>/README.md from run_state.yaml
                  (derived, not passed). `readme_refreshed:false` + a
                  `readme_note` means the index is stale — mention it, but it
                  never gates the phase.
                — when narrating the result, echo verify.summary verbatim
                  (e.g. "all 4 required artifacts found (+3 optional)"). Do
                  NOT pair present_count/expected_count into a fraction:
                  present counts every file in the folder, expected counts
                  only the required set, so "7/4" is meaningless.
             4. verify_phase_products(fileId=<run_state.yaml>, phase=<phase>)
                — returns {phase, status, ok, mode, issues[]}. Covers the
                  THIRD half of the gate: the typed `products.<block>` handoff
                  the ace-web summary + downstream phases read. `mode:complete`
                  (phase done → shape + required-key completeness),
                  `mode:fragment` (in-flight → shape only), `mode:skipped`
                  (phase has no products contract). Takes the run_state phase
                  name (like classify_phase_writeback), NOT the manifest key.
             5. TaskUpdate marking <phase> completed, next phase in_progress
             6. Skill(decisions-render) — idempotent
           Optional one-line text summary in the same message.
Turn N+2:  Branch on classify_phase_writeback AND verify_phase_artifacts
           AND verify_phase_products:
             - classify='ok' AND verify.ok=true AND products.ok=true
                 → proceed to Turn N+3
             - verify.ok=false (one or more required artifacts missing)
                 → for each entry in verify.missing, silent-dispatch its
                   producedBy via Skill(<producedBy>) with the standard
                   phase-context prompt (opp slug + run_id, no other
                   priors). Cap at 2 attempts TOTAL per boundary; re-run
                   the fence after each batch. If any item remains
                   missing after the cap, halt with a [BLOCKER] listing
                   the unhealed paths + producedBy values.
             - products.ok=false (mode='complete' — the done phase's typed
               `products.<block>` is missing a required handoff key or has a
               drifted shape; `issues[]` names the path)
                 → re-dispatch the producing phase/skill ONE more time with an
                   explicit closing line naming the offending `products` path
                   from `issues[]` (same cap-2 discipline). For the external-
                   resource phases honor the override below (finish inline
                   rather than re-mint). If still not ok after the cap, halt
                   with a [BLOCKER] quoting `issues[]` — the summary page would
                   render a blank section otherwise (jjackson/ace#705).
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
Turn N+3:  Self-heal sweep (§ below) — one BACKGROUND fix-and-ship
           dispatch per self-healable issue this phase filed. Never
           blocks; the run does not wait on it.
           Agent(<next-phase>) with inline-artifact prompt, in the SAME
           message as the sweep dispatches.
```

**Products-presence check (Turn N+2 — the `verify_phase_products` atom).**
`classify_phase_writeback` only checks the run_state *shape*;
`verify_phase_artifacts` only checks Drive *files*. Neither asserts that
the phase wrote its typed `products.<block>` in the shape the public
summary page (ace-web `apps/opps/summary.py`) and downstream phases
actually read. A phase can return `classify='ok'` + `verify.ok=true`
while having written outputs only under `steps.*` or a lone
`summary_artifact` (leep run 20260527-1528: Phase 8's EOI + Phase 7's
walkthroughs never surfaced because no `products` block was written), OR
having written the block in a *drifted* shape — `products.opportunity`
instead of `products.connect.opportunity`, the deck under
`products.training_materials` instead of `products.training.deck` — which
renders the summary section blank (malaria-rdt/20260604-1604,
jjackson/ace#705).

`verify_phase_products(fileId, phase)` (call #4 in Turn N+1) is the
single deterministic check for this, replacing the old hand-maintained
"required `products.<block>`" map. It validates against
`lib/phase-products-schema.ts` — the cross-repo single source of truth
(generated to `docs/phase-products-schema.json`, which ace-web reads). On
a `status: done` phase (`mode:complete`) it asserts BOTH the block's shape
AND that every required handoff key is present
(`REQUIRED_PRODUCT_KEYS` — e.g. `connect.opportunity.url` + `connect.domain` +
`connect.ace_test_user.invite_row_present`,
`qa-and-training`'s `training.docs.onboarding_email`); on an in-flight
phase (`mode:fragment`) it shape-checks only, so incremental writes pass;
`mode:skipped` for phases with no products contract
(`scenarios-and-acceptance`, `execution-management`, `closeout` end-state
blocks are exempt). Branch on `products.ok` per the Turn N+2 list above.

The write-time guard (`update_yaml_file`'s `validateAs:{kind:'phase-products',
phase}`) stops *shape* drift at the source for skills that write via
`update_yaml_file`; this fence check is the backstop that also catches a
required handoff key that was *never written at all* (e.g. a dropped
subagent that never reached its deck/onboarding write) and the multi-writer
`drive_update_file` paths the write-time guard doesn't sit on. The phase
agents' own definitions carry the explicit `products.<block>` write step
(see e.g. `agents/solicitation-management.md` § After Step 2,
`agents/synthetic-data-and-workflows.md` § Completion) — this is the
structural backstop for when a subagent skips it.

### Self-heal sweep (Turn N+3, one dispatch per issue, never blocking)

`CLAUDE.md § Self-heal a filed issue when you can, then close it` (Jon,
2026-07-22) has been an unenforced prose rule: it appears twice in
CLAUDE.md and **zero times** in this file, so compliance depended on the
model remembering it mid-run. Measured 2026-08-18 over 119 issues filed
since 08-11: **58%** of issues filed by a live run were fixed the same
day, against **71%** for issues filed retrospectively by a review
session. The gap is the rule losing to the phase loop — exactly what
CLAUDE.md predicts of prose ("invariants are hooks, not memory — prose
relies on the model choosing to comply, which fails under load"). Seven
issues sat open from two days of runs; three of them (ace#1484, #1485,
#1486) were static edits inside one skill directory.

So the decision is a fence step, not a memory. **At Turn N+3, for every
ACE issue this phase filed**, classify it once:

| | Test | Action |
|---|---|---|
| **self-healable** | root cause understood AND the fix is bounded, low-risk, and lands in the ACE repo (a skill/doc/recipe/atom/contract edit) | dispatch it (below) |
| **not** | it makes a **device-truth** claim with no recorded evidence, needs human product/legal/taste judgment, is a risky cross-cutting refactor, or you cannot validate it this session | leave open; comment ONE line saying which of those it is |

For each self-healable issue, dispatch **one background subagent** per
§ Fix-and-ship subagent template in `agents/orchestrator-reference.md`
— it runs `skills/shipping` end to end and closes the issue referencing
its PR. Batch the dispatches into the SAME message as
`Agent(<next-phase>)`.

Three rules make this safe to run inside a live `/ace:run`:

1. **It never blocks the run.** The dispatches are backgrounded and the
   next phase starts in the same message. A self-heal that fails, stalls,
   or needs a device costs the run nothing — the issue simply stays open,
   which is where it already was.
2. **One issue per dispatch, no bundling.** A subagent that fans out
   across several issues is how a phase boundary becomes a build session.
3. **The run DOES consume its own fix — take the update at the next phase
   boundary, never mid-phase.** Standing operator directive (Jon,
   2026-08-18): *"`/ace:run` should always try to be the most up to date; we
   are always improving ACE."* A run that finishes on code we already knew
   was wrong spends hours proving a stale premise. So when a self-heal
   merges — or when the boundary currency check below reports drift — run
   `/ace:update` at the **next phase boundary**, in the same message as the
   fence, and say in the run notes which version the remaining phases are
   on.

   The boundary is the whole of the safety margin: it is the one point where
   no phase is in flight, so nothing is hot-swapped underneath a running
   skill. Do NOT update in the middle of a phase, and do NOT kill a phase in
   flight to take an update — **`qa-and-training` in particular consumes a
   one-way precondition** (Learn completion is one-way per `(test user,
   opportunity)`), so an interrupted walk cannot be re-run without a fresh
   opportunity, which costs a fresh Phase 4.

   Know what each action actually does, because only one of them is
   `/ace:update`'s job:

   | Action | Takes effect on | Who can run it |
   |---|---|---|
   | `/ace:update` | disk + registry only — **new sessions**, and reads off disk. Skills already bound in THIS session keep resolving to the pre-update `installPath` | the orchestrator |
   | `/reload-plugins` | skills, agents, commands, hooks already bound | the operator |
   | full Claude restart | **MCP subprocesses** — nothing else respawns them | the operator |

   **`/ace:update` does not change which skill code this session executes.**
   Every skill this session loads after an update still comes off the
   pre-update `installPath`. Measured on `spark-facilitator/20260820-0817` —
   an update at a phase boundary moved installed 0.13.1003 → 0.13.1008, and
   the very next skill load printed `Base directory for this skill:
   …/cache/ace/ace/0.13.1003/skills/demo-data-setup`, then stayed on 1003 for
   the rest of the session. Only `/reload-plugins` rebinds skills, and per row
   2 that is the **operator's** command — the orchestrator cannot run it
   (ace#1729).

   So the update is real for the registry, real for the next session, and
   **inert for the phases still to run in this one**. Never report an update
   as having changed what the remaining phases execute; see § Plugin currency
   at the boundary for what to do about it.

   When the update reports `MCP_CHANGED: yes`, the remaining phases still run
   on the OLD MCP code until the operator restarts. Say so explicitly rather
   than implying the update fixed it, and write a handoff (§ Pre-flight Step
   1) before recommending the restart so the resumed session does not
   re-derive what this one established.

**Attempting the fix is itself the premise check, and that is half the
value.** Filing costs nothing and touches no artifact, so an unverified
claim survives into a filed issue; ace#1481 asserted "grep for `MSA` —
all zero hits" when the clause is at `templates/work-order-template.md:147`
and in both documents it cited, and a follow-up comment then claimed to
have confirmed the absence. A self-heal attempt opens that file and the
issue dies on sight. If the fix attempt refutes the issue, **close it
`--reason "not planned"` with the evidence** — that is a successful sweep,
not a failed one.

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
empty even on a fully-populated run.

**Manifest-key map** for the `phase` arg `verify_phase_artifacts` expects
— the SHORT key from `lib/artifact-manifest.ts § PHASES`, NOT the
agent-file name. The verifier rejects unknown values (zod enum).
**Canonical source: the `PHASE_DEFS` table in `lib/artifact-manifest.ts`;
this table mirrors it for human reference — if they disagree, `PHASE_DEFS`
wins.**

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

`verify_phase_artifacts` and `classify_phase_writeback` make the two
boundary checks single deterministic tool calls instead of a
read→parse→judge model dance that drifts (rationale + incidents: reference
§ Producer Artifact Verifier and § Phase Write-Back Contract). For the
full issue list on a `'malformed'` result, call
`validate_run_state(fileId)` — returns `{valid, errors, warnings}` with
`{path, message, severity}` per issue.

**Plugin currency at the boundary (the 7th call).** Add ONE Bash call to
Turn N+1's batched message. `bin/ace-doctor --preflight` reports
`plugin.version` once, at run start; on a repo that merges ~9x/day that
reading has a shelf life of minutes, and a full `/ace:run` is multi-hour. So
re-check it where the run is already stopped:

```bash
node -e "const d=JSON.parse(require('fs').readFileSync(process.env.HOME+'/.claude/plugins/installed_plugins.json','utf8'));console.log('installed',d.plugins['ace@ace'][0].version)"
ps -eo ppid,command | awk -v c="$PPID" '$1==c' | grep -o "ace/ace/0\.[0-9.]*" | sort -u   # live MCP children
```

Four outcomes, and they are NOT the same:

- **installed == live MCP == origin/main** → current; say nothing.
- **installed < origin/main** → run `/ace:update` here, per rule 3 above.
- **live MCP < installed** → the session's MCP subprocesses are stale.
  `/ace:update` does NOT fix this and `/reload-plugins` does NOT respawn
  them. Report the gap, name the changed `mcp/` files, and let the operator
  decide whether to restart now or at run end.
- **an update was taken in THIS session** → the remaining phases still
  execute the OLD skills. This one is new, it is the easiest to miss, and it
  is not covered by any of the three above. See § Bound skills after a
  mid-run update, immediately below.

### Bound skills after a mid-run update

`/ace:update` writes disk + registry; it does **not** rebind `Skill()` in
this session (§ Self-heal sweep currency table, ace#1729). So the moment the
boundary takes an update, the phases still to run are executing skill code
from the version this session **started** on, and saying nothing about that
is what made it invisible for months.

The orchestrator has **no** runtime handle on `Skill()` resolution — the
resolved path appears only inside `Skill()` tool output, and only where the
orchestrator itself invokes a skill. So this is not a check on the binding.
It IS a deterministic check on the consequence that matters, because both
install trees are on disk:

```bash
BOUND=<the version this session STARTED on — from `bin/ace-doctor --preflight` at run start,
       or `cat ~/.ace/just-upgraded-from` if this session took exactly one update>
INSTALLED=$(node -e "const d=JSON.parse(require('fs').readFileSync(process.env.HOME+'/.claude/plugins/installed_plugins.json','utf8'));console.log(d.plugins['ace@ace'][0].version)")
diff -rq ~/.claude/plugins/cache/ace/ace/$BOUND/skills \
         ~/.claude/plugins/cache/ace/ace/$INSTALLED/skills 2>/dev/null
```

`BOUND` is the session-start version, NOT a `ps` reading — anchor it on what
pre-flight recorded and on the updates this orchestrator itself ran. (`ps`
is the wrong anchor here: children younger than their session, on a newer
`installPath`, have been observed after a `/reload-plugins`, so the `$PPID`
version set can misdescribe the live surface — the open question ace#1684
left on the record.) `BOUND` changes only when the **operator** runs
`/reload-plugins`; when they confirm they have, re-anchor it to `INSTALLED`.

Then act on the diff — do not just print it:

- **No changed files** → say "remaining phases unaffected" in one line.
- **Changed files, none owned by a PENDING phase** → record in the run notes
  that the remaining phases run on `$BOUND` skill code, and continue. Name
  the changed files anyway; a later phase may pick one up.
- **Changed files owned by a PENDING phase** → **halt and ask the operator
  for `/reload-plugins`.** Name the phase, the skill, and what changed. This
  is the case that nearly published a broken public artifact: on
  `spark-facilitator/20260820-0817` the bound `skills/solicitation-create`
  differed from installed, and the bound copy would have published a
  partner-facing solicitation page stating that work starts ~2 weeks before
  applications close (ace#1685). The fixed skill was on disk and would not
  have run.

Silence is the failure mode. Whichever branch fires, the run notes must say
which version the remaining phases' skills are actually on — never imply the
update changed them.

**A stale MCP child is worse than stale compiled code for recipes.**
CLAUDE.md says `mcp/mobile/recipes/*.yaml` are re-read from disk per call —
true, but they are re-read from **the version directory the subprocess was
launched from**. A session bound at 0.13.915 keeps reading 0.13.915's
recipes no matter how current the disk is. That reads as hot-patchable and
is not, which is exactly how a Phase 6 device walk runs against superseded
selectors while every version file on disk says the run is current.

Measured (ace#1500), `bednet-check-2-visit/20260817-1720`: bound at
0.13.915, ran to Phase 6 while main reached 0.13.930 — 13 changed files
under `mcp/`, 21 under `skills/` + `agents/`. Two costs. A premise retired
as false that same day (`a9e4ff06`, HQ uploads update in place) was
propagated verbatim into the Phase 4 dispatch; and five static mobile
recipes changed under a device walk already in flight.

**Forbidden boundary improvisations.** Aside from the currency check above,
the boundary fence's 6 tool calls listed earlier are the COMPLETE set. Do
NOT also:

- Call `render_run_readme` or write `README.md`. `verify_phase_artifacts`
  already refreshed it from `run_state.yaml`; a hand-assembled status map is
  the exact contract that left a finished run's README all-`pending`.

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

opp-eval picks up verdict files via directory discovery (next to the
producer artifact as `<N>-<phase>/<producer>-eval_verdict[-<mode>].yaml`
— there is no top-level `verdicts/` directory), so new per-skill
`-eval` rubrics need no change to opp-eval itself. Skills that still
self-evaluate inline get `[INFO]` gap notes until a rubric arrives.

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
- `run_state.yaml` marks dry-run steps so they're distinguishable from real runs (e.g. a `dry_run: true` flag on the step entry); the step `status` stays in the standard `done | error | incomplete` enum ([reference § Phase Write-Back Contract](orchestrator-reference.md#phase-write-back-contract)), not the retired `success`/`blocked` vocabulary
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

