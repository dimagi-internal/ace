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

## Closed (this session)

| PR | # | Type | What |
|---|---|---|---|
| 0a | [#202](https://github.com/jjackson/ace/pull/202) | doc | Pre-flight Checklist — 6-step literal sequence in `agents/ace-orchestrator.md` with Stop Signs subsection. |
| 0b | [#203](https://github.com/jjackson/ace/pull/203) | code | `bin/ace-doctor --preflight` YAML mode (extends doctor, doesn't duplicate). |
| 0c | [#210](https://github.com/jjackson/ace/pull/210) | doc | Orchestrator structural split — procedure (`ace-orchestrator.md`) vs reference (`orchestrator-reference.md`). Executed by parallel session via the writing-plans handoff doc at `docs/superpowers/plans/2026-05-10-orchestrator-structural-split.md`. |
| 0d | [#204](https://github.com/jjackson/ace/pull/204) | doc | Phase Boundary Fence — WHEN write-back happens + worked anti-pattern/right-pattern transcript example. |
| 0e | [#207](https://github.com/jjackson/ace/pull/207) | doc | `agents/design-review.md` — trust subagent context across steps; batch Step 1 manifest reads. |
| 0g | [#211](https://github.com/jjackson/ace/pull/211) | code + tests | `mcp/google-drive-server.ts` — inflight-dedupe + 30s TTL cache on `assertParentOnSharedDrive`. 4 new tests. |
| 0h | [#209](https://github.com/jjackson/ace/pull/209) | doc | `skills/app-connect-coverage` Step 3 — batch per-form `get_form` reads in one parallel message. |
| 0i | [#212](https://github.com/jjackson/ace/pull/212) | code | `mcp/ocs/backends/playwright.ts` — `Promise.all` for `waitForCollectionIndexing` per-file status probes. |
| 0j | [#213](https://github.com/jjackson/ace/pull/213) | doc | 3 Phase 1 eval skills — prefer in-context inputs over re-reading from Drive. |
| 0k | [#216](https://github.com/jjackson/ace/pull/216) | doc | Orchestrator stale-`below`-references cleanup — 6 cross-refs after the structural split. |
| 0l | [#217](https://github.com/jjackson/ace/pull/217) | doc | OCS opp-level chatbot reuse via Step 0.5 + `opp.yaml.ocs_chatbot`. **REVERTED in #221** — see below. |

**Reverted:**
- PR 0l was reverted in [#221](https://github.com/jjackson/ace/pull/221) after the user clarified the architectural target: opp.yaml should be thin identity only, with all evolving state in `run_state.yaml`. PR 0l moved in the opposite direction by adding rich blocks to opp.yaml. Net behavior unchanged vs. pre-0l. Cross-run OCS reuse deferred until consolidation lands.

**Cumulative wall-clock impact estimate (conservative):**
- ~4–10 min off every `/ace:run` from the surviving 10 PRs (0a, 0b, 0c, 0d, 0e, 0g, 0h, 0i, 0j, 0k).
- Validation deferred to the next live run — none of the changes have been end-to-end verified.

## Skipped / declined this session

- **Separate `bin/ace-preflight` script** — would duplicate ~90% of `bin/ace-doctor`. Replaced with PR 0b (extend doctor).
- **Pre-bake pre-flight into `/ace:run` slash command body** — tempting but reduces flexibility (different opps have different preconditions). Keep the command body thin, push richness into the orchestrator doc + doctor.
- **Parallel-Agent-dispatch test** — gates the Phase 1 sub-skill parallelism (5–8 min) and Phase 2 Nova-build parallelism (2–5 min) wins. User flagged prior churn on this and deferred. Re-test against a duplicate orchestrator AFTER the state-consolidation refactor lands.
- **Trim `commcare_make_build` poll budget** — investigation showed the atom is synchronous (POST → JSON), no polling loop to trim. Non-issue.
- **Phase 1 input-hash cache gate** — user noted ace-web forking covers the iteration loop; cache deferred indefinitely.
- **`ocs_get_chatbot_embed_info` redundant call** — 1s/run, too marginal to ship as its own PR.
- **OCS dead-collection cleanup** — no `ocs_delete_collection` MCP atom exists; cosmetic-only issue per the subagent's `[INFO]` flag.

## Architectural pivot (mid-session)

PR 0l surfaced a deeper question: where does cross-run state belong? PR #219 (by a parallel session) had codified a "per-opp vs per-run" split that introduced a sibling `connect-state.yaml` file. The user clarified the target architecture is more comprehensive:

- **`opp.yaml` = thin identity only** (display_name, slug, tags, created_at) for ace-web rendering. Read-only from inside any run.
- **`run_state.yaml` = single source of truth** for every evolving piece of state (Connect IDs, solicitation, selected_llo, synthetic workflows, OCS chatbot).
- **Cross-run discovery** = walk `runs/` for the most recent prior `run_state.yaml`.
- **`connect-state.yaml` is a mistake** — its content folds back into run_state.yaml.

PR 0l was reverted as moving in the wrong direction. A multi-PR state-consolidation refactor was queued — handoff prompt drafted for a fresh session, covering: design doc first (`docs/superpowers/specs/2026-05-10-state-consolidation.md`), then 6 sequenced PRs (4 block migrations + doc refactor + fallback cleanup). That work is now in flight in a separate session.

## Meta-observations

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

6. **Verify subagent survey claims against code before designing a PR.**
   The Phase 4 subagent survey reported "5–10 min saved by RAG reuse"
   as the top opportunity. I built PR 0l around that claim. On closer
   inspection: the existing Step 2 list-based idempotency already had
   the chatbot-reuse path; the survey hadn't read the code carefully.
   The actual mechanism (content fingerprint + LLM-nondeterminism-aware
   cache invalidation) was subtler than the survey framed, and the
   "fix" I shipped didn't engage with that. Lesson: a subagent's
   perf-opportunity report is a starting point, not a spec; verify
   the proposed mechanism is sound by reading the producer skill +
   consumer skill code BEFORE drafting the PR.

7. **Ask "where does state belong?" BEFORE shipping any change that
   writes state.** PR 0l added a rich block to `opp.yaml` without
   first asking whether opp.yaml was the right home. The transcript
   showed operator-edited fields under `opp.yaml.ocs_chatbot` and I
   treated that as evidence of a canonical schema — when in fact those
   were ad-hoc personal annotations. Anti-pattern: treating
   operator-shaped state as load-bearing contract. Right move: ask the
   user (or read the canonical architecture doc) before introducing a
   new state location.

8. **Codifying an interim architecture as if it were final encourages
   drift.** PR #219 (parallel session) wrote down the partial state
   ("opp.yaml has selected_llo + solicitation + tags; connect-state.yaml
   is a sibling per-opp file") as "Fork Points — Per-Opp vs Per-Run
   State". The doc was clear and well-written, but it captured the
   accumulated-mistakes layout, not the intended endpoint. A doc that
   codifies "what is" can read as "what should be" unless it explicitly
   flags interim status. For the state-consolidation refactor: the
   design doc should say up-front "this supersedes PR #219's Fork
   Points classification" so future readers don't ricochet between two
   authoritative-looking docs.

9. **Validate behavior on a live run before claiming a perf win.** All
   11 PRs shipped this session are "the model should now do X" or "the
   skill should now batch Y" changes. Whether the model actually
   complies is unverified. Estimated wall-clock savings (4–10 min/run)
   are arithmetic from doc intent, not measured outcomes. The next
   `/ace:run` produces the evidence. Future perf-lens sessions should
   include a "validation run" as part of the loop, not as a
   nice-to-have.
