# 2026-05-10 — Orchestrator perf lens

## Lens

`/ace:run` wall-clock perf, focused on phases 1+2 + the pre-flight before
Phase 1. Two e2e runs in flight (`leep`, `turmeric`) had been going
~1 hour and were only mid-Phase-2/4. Goal: find quality-safe perf wins
that compound across many opps, plus opportunistic input-hash caching for
iteration loops.

## Evidence

Source transcripts (live as of analysis):
- `~/.claude/projects/-Users-jjackson-emdash-worktrees-ace-emdash-e2e-leep-i6qqd/dfe1727d-84a1-4d22-b078-416bf3eb3cad.jsonl`
- `~/.claude/projects/-Users-jjackson-emdash-worktrees-ace-emdash-e2e-turmeric-5aeux/6160cb0f-2e58-46ff-9cf5-d075a0f5c3cf.jsonl`

Per-phase wall-clock (turmeric, the further-along run):

| Phase | Duration |
|---|---|
| Pre-flight | 9.4 min (inflated by in-run plugin upgrade + interrupted retry) |
| Phase 1 design-review | 18.3 min |
| Phase 2 commcare-setup | 19.4 min |
| Phase 3 connect-setup | 6.5 min |

Phases 1+2 ≈ 70% of total elapsed. Real pre-flight on `leep` (no upgrade,
no retry) was **3min 41sec** with ~50% spent in model "thinking" gaps.

## Do it

### PR 0a — Pre-flight Checklist in `agents/ace-orchestrator.md`

Single-file edit. Add `## Pre-flight Checklist (before Phase 1 dispatch)`
section consolidating existing scattered Performance Conventions into a
literal 6-step numbered list with copy-paste artifacts:

1. ONE Bash to resolve local state (env_file, plugin version, git email).
2. ONE `ToolSearch select:...` with the literal L0 atom string baked in.
3. ONE message of parallel Drive reads (opp.yaml + inputs/ list + runs/ list).
4. ONE message of all `TaskCreate` calls (literal 10-item list in doc).
5. ONE message of run-folder Drive creates (folder + run_state.yaml + idea.md + manifest).
6. Dispatch Phase 1.

Each step says "ONE assistant message" explicitly. The conventions in
lines 543–644 stay as the "why" — the checklist is the "what to do."

Expected savings: ~60–90s per run from collapsing ~25 sequential calls to
~5–6 batched messages, plus ~30–60s of removed think-gaps. Total ~1.5–2.5
min off every run, applies to all opps, zero quality risk because the
doc *already says* this is the desired behavior — model just isn't
honoring it because it's prose, not a checklist.

### PR 0b — `bin/ace-doctor --preflight` mode

Doctor at `bin/ace-doctor` (1589 lines) already does ~90% of pre-flight's
local probes: env_file resolution, plugin version, env var presence,
auth liveness HTTP probes per MCP. Don't write a separate
`bin/ace-preflight` — extend doctor with a `--preflight` (or `--json`)
mode that emits a tight YAML/JSON snapshot of the same probes.

Refactor doctor's informal section blocks into named shell functions
(`probe_env_file`, `probe_env_vars`, `probe_node_toolchain`,
`probe_auth_liveness_drive`, etc.) so `--preflight` runs only the
pre-flight subset. Cache auth-liveness in `~/.ace/last-doctor-auth.json`
with timestamp; pre-flight reads if <30 min old.

Orchestrator's pre-flight step 1 (PR 0a) becomes one bash call →
paste YAML into context. New env vars added to doctor flow to
pre-flight automatically.

### PR 0c — Orchestrator structural split (doc refactor)

Today's `agents/ace-orchestrator.md` is 1573 lines and mixes reference
(State Schema, Cruft Management, Phase Write-Back Contract) with
procedure (Workflow, Per-Phase Folder Lifecycle). Reading order ≠
execution order — Performance Conventions are at line 543, behind 540
lines of state/scope content. Pre-flight content (`## Starting a New
Opportunity`) lives at line 1261, far below Workflow (line 770).

Split into:
- `agents/ace-orchestrator.md` — pure procedure, top-of-file = top-of-execution-flow.
- `agents/orchestrator-reference.md` — state schema, cruft mgmt, write-back contract.
- Hoist scattered anti-patterns into a single ANTI-PATTERNS section near the top.
- Uniform phase-block template (Inputs → Skills/Atoms → Outputs → Write-back fields → Gate).

### PR 0d — Phase-boundary write-back fence

Today's "Phase Write-Back Contract" (line 929) says every phase MUST
write `run_state.yaml` but doesn't say WHEN. Add: "After every
`Agent(<phase>)` tool_result, your VERY NEXT message MUST be one
parallel block of `drive_update_file run_state.yaml` +
`drive_create_file gate-brief.md`." Eliminates the "did I write back?"
think-gap between phases.

### Backlog (deferred — not this PR series)

- **Parallelize Phase 1's three skill chains** (`agents/design-review.md`).
  `pdd-to-test-prompts` and `pdd-to-app-journeys` both consume the
  approved PDD and don't depend on each other. Three `*-eval` LLM judges
  are also fully independent. Est: 5–8 min off Phase 1 wall-clock.
- **Re-test Phase 2 Learn vs Deliver Nova-autobuild parallelism.**
  Currently forbidden by `agents/commcare-setup.md:107–114` citing
  Claude Code Agent-parallelism unreliability. If Claude Code now does
  this reliably (worth verifying), the two builds share zero state. Est:
  2–5 min off Phase 2.
- **Run `pdd-to-learn-app-eval` *during* Deliver autobuild** (Phase 2).
  They're independent. `agents/commcare-setup.md` ~lines 154–160. Est:
  30–90s.
- **Batched Drive create atom** (`mcp/google-drive-server.ts`).
  `assertParentOnSharedDrive` runs per write today; Phase 0 and Phase 2
  do 15+ sequential creates with ~7s round-trip each. Est: 60–120s/run.
- **Widen `app-connect-coverage` skip path** when autobuild emits clean
  Connect markers. `agents/commcare-setup.md:140–180`. Est: 60–180s
  when applicable.
- **Phase 1 input-hash cache gate** (the user's iteration use case).
  Cache key = `sha256(sorted(inputs-manifest entries' file_id +
  Drive revisionId) + idea.md content + design-review skill version)`.
  Lands in `agents/ace-orchestrator.md` § "Starting a New Opportunity"
  as a "Step 0: prior-run reuse probe" before run-id pick. Est: ~15–18
  min saved per identical-input iteration.

## Closed

(none yet — PR 0a in flight)

## Skipped

- **Separate `bin/ace-preflight` script** — would duplicate ~90% of
  `bin/ace-doctor`. Replaced with PR 0b (extend doctor).
- **Pre-bake pre-flight into `/ace:run` slash command body** — tempting
  but reduces flexibility (different opps have different preconditions).
  Keep the command body thin, push richness into the orchestrator doc +
  doctor.

## Meta-observations

1. **Doc as procedure ≠ doc as reference.** The orchestrator violates its
   own conventions (lines 543–644) because they're written as prose
   advice that the model has to synthesize into action. A literal
   numbered checklist with copy-paste artifacts gets followed; prose
   with "do X, batch Y" gets approximated. Generalizes: any time we
   document a perf rule, also write the literal artifact (bash command,
   tool-call select string, batched message template) so the model can
   copy it verbatim instead of synthesizing.

2. **Doctor and pre-flight should share, not duplicate.** Whenever a new
   probe class is added (env var, auth check, prerequisite tool), it
   belongs in `bin/ace-doctor` first — pre-flight just reads doctor's
   structured output. New probes flow to pre-flight automatically.

3. **Reading order matters for ~1500-line agent docs.** Top of file gets
   followed; line 543 gets paraphrased; line 1261 gets re-discovered
   each session. Procedure content belongs early; reference content
   late or in a sibling doc.

4. **~50% of pre-flight time is model "thinking" gaps**, not tool
   execution. Eliminating ambiguity in the procedure (literal checklist)
   should compress thinking too, not just tool-call latency.

5. **User-interrupted retries inflate apparent timing.** The ~10.5 min
   pre-flight on `leep` was actually 3.5 min of real pre-flight + a
   user `/ace:update` detour + a 6 min idle gap. Watch for this when
   reading session transcripts — `[Request interrupted by user]` is a
   timing landmine.
