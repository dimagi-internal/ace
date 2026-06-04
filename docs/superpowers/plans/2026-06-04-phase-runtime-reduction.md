# Phase 3/6 Runtime Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut ACE Phase-3/6 wall-clock time by attacking the thing that actually dominates it — **model turns (85%)**, not external systems (15%).

**Architecture:** Two levers, both targeting the 85%: (1) **fewer turns** (each round-trip is a model turn), and (2) **smaller context per turn** (generation latency scales with context; ACE's own procedure/skill docs are ~350KB of it). Every change is shipped to one repo (`ace` plugin or `ace-web`), then **validated with one seeded `--only 3,4,6` run** before the next — no blind batch edits to load-bearing procedure docs.

**Tech Stack:** ACE plugin (markdown SKILL.md/agent docs, TS MCP servers), ace-web (Django seeded-run harness), the session analyzer (`/cost`, `/structure`) for before/after measurement.

---

## Baseline (measured, run `20260604-1340`, 55m54s)

| Bucket | Time | Share |
|---|---|---|
| **Model turns** (think + generate between tool calls) | **47m41s** | **85%** |
| External/tool execution (Nova, Connect, HQ, Drive, mobile) | 8m13s | 15% |

**Turn-count drivers (266 tool calls / 534 msgs):** `ToolSearch` ×32 · Drive/artifact writes ×52 (`drive_create_file` 25, `upload_binary` 16, `update_file` 6, `update_yaml` 5) · `TaskCreate`/`TaskUpdate` ×25 · read/list/glob ×67.
**Context drivers (~350KB docs read in):** `ace-orchestrator.md` 89KB · `pdd-to-deliver-app/SKILL.md` 52KB (6,696 words) · `commcare-setup.md` 24KB · `pdd-to-learn-app` 31KB · `app-release-qa` 24KB · `app-release` 21KB · `_app-component-library.md` 17KB.

**Measurement protocol (run after EACH item):** trigger a seeded run, then compare `/cost` total + the timeline split (`tool/external` vs `model turns`) + tool-call count against this baseline. A change "passes" only if (a) total wall drops or holds, and (b) the phase still completes (no new halts, device walk still runs).

---

## Ranked items (highest confidence first)

| # | Item | Lever | Est. impact | Confidence | Risk |
|---|---|---|---|---|---|
| 0 | skip-evals in seeded runs | turns | ~7 min | **shipped (#595)** | none |
| 1 | Strip non-executable bulk from skill/agent docs → reference files | context | high (the 85%) | **HIGH** | low (behavior-preserving) |
| 2 | Cut `ToolSearch` churn (×32) | turns | ~20–30 turns | **MED-HIGH** | low–med |
| 3 | Reduce Drive-write ceremony (×52) | turns | ~15–30 turns | MED | med (some artifacts load-bearing) |
| 4 | Coarsen self-task-tracking (×25 Task*) | turns | ~15–20 turns | MED | low |
| 5 | Tighten executable Process sections | context | high | LOW-MED | **high (load-bearing)** |
| 6 | Model tiering / parallelism | both | unknown | LOW | high |

Implement **top-down, one at a time, validating each**. Stop wherever ROI flattens.

---

## Task 1: Strip non-executable bulk from the fattest docs (HIGH confidence)

**Rationale:** Skill best practice (`superpowers:writing-skills`): "Skills are NOT narratives about how you solved a problem once"; token efficiency is first-class. The ACE skills violate this heavily (change-logs, "caught in vivo on run X", debug-arc prose). Moving that content out is **behavior-preserving by construction** — the agent executes the Process/decision-rules/gotchas, never the war-stories. Targets the 85% (smaller context → faster generation) + token cost.

**Files (per skill, repeat the pattern):**
- Modify: `skills/pdd-to-deliver-app/SKILL.md` (6,696 words → target ≤ ~3,500)
- Create: `skills/pdd-to-deliver-app/reference.md` (relocated narrative/examples)
- Then: `skills/pdd-to-learn-app/`, `skills/app-release-qa/`, `skills/app-release/`, `agents/commcare-setup.md`, `agents/qa-and-training.md`, `agents/ace-orchestrator.md`

**What is SAFE to move/remove (keep nothing executable out of SKILL.md):**
- `## Change Log` sections → delete (git is the changelog).
- Incident war-stories / "caught in vivo on run …", "the debug arc was…", dated learnings prose → delete the anecdote, **keep the resulting rule** (e.g. "Enforce 50-char slug limit *(caught on bednet 20260512 when…)*" → "Enforce 50-char slug limit").
- Extended worked examples / sample outputs → `reference.md`, with an inline pointer: "For a worked example, see `reference.md`."
- "Why / rationale" prose that doesn't change the steps → `reference.md`.

**What MUST stay inline (executable — do NOT move):** the `## Process` steps, decision rules, `## Archetypes` branches, atom signatures/params, gotchas/constraints, halt conditions, the inputs/products contract.

- [ ] **Step 1: Inventory the doc.** For `skills/pdd-to-deliver-app/SKILL.md`, list each `##`/`###` section with line range + classify each as `executable` | `reference` | `delete` (changelog/war-story). Paste the classification into the PR description.

- [ ] **Step 2: Move `reference`-classed prose to `reference.md`** and replace with a one-line pointer. Delete `delete`-classed prose. Leave all `executable` content byte-identical.

- [ ] **Step 3: Verify nothing executable was lost** (mechanical diff check):

```bash
cd skills/pdd-to-deliver-app
# Every imperative step / atom name / "MUST"/"HALT"/"Step N" line that was in
# the old Process must still be present in the new SKILL.md (not just reference.md):
git show HEAD:SKILL.md | grep -oE '`[a-z_]+`|HALT|MUST|Step [0-9]+' | sort -u > /tmp/old_exec.txt
grep -oE '`[a-z_]+`|HALT|MUST|Step [0-9]+' SKILL.md | sort -u > /tmp/new_exec.txt
comm -23 /tmp/old_exec.txt /tmp/new_exec.txt   # lines here = executable tokens that DISAPPEARED — must be empty or justified
```
Expected: empty output (or every line accounted for by a deliberate merge).

- [ ] **Step 4: Confirm the size win.**

```bash
echo "before:"; git show HEAD:SKILL.md | wc -w
echo "after:";  wc -w < SKILL.md
```
Expected: meaningful reduction (target ≥ 30%), with `reference.md` holding the moved prose.

- [ ] **Step 5: Ship + version-bump + PR** (`bash scripts/version-bump.sh`, commit, PR, auto-merge), then `/ace:update`.

- [ ] **Step 6: VALIDATE with a run.** Deploy ace-web (re-vendors plugin at main HEAD), trigger a seeded `--only 3,4,6` run, and confirm via `/cost` + timeline: total wall ≤ baseline, Phase 3 completes, no new halts. Record the new `Read`-bytes-in-context (re-run the per-tool result-size probe) to quantify the context drop.

- [ ] **Step 7: Repeat Steps 1–6 for the next doc**, fattest-first (`ace-orchestrator.md` 89KB has the most absolute KB but is read once; `pdd-to-learn-app` next). One doc per PR + run so a behavior regression is bisectable.

---

## Task 2: Cut `ToolSearch` churn (×32) (MED-HIGH confidence)

**Rationale:** 32 `ToolSearch` calls = 32+ model turns spent loading deferred MCP atom schemas on demand. ACE registers many atoms across 5 MCPs; Claude Code defers them, and the agent re-searches as each need arises.

**This task starts with an INVESTIGATION step — the fix is only ACE-controllable if the churn is procedure-driven, not pure harness behavior.**

- [ ] **Step 1: Characterize the 32 searches.** From a run transcript, extract every `ToolSearch` query + the atom(s) it loaded + which phase/skill issued it. Bucket: (a) distinct atoms genuinely first-used, vs (b) re-searches for atoms already loaded earlier, vs (c) searches the procedure could have batched.

- [ ] **Step 2: Decide the lever based on Step 1:**
  - If re-searches dominate (b): the agent isn't remembering loaded tools — add a "tools you'll use this phase" preamble to the phase agent docs so it loads them once up front (one batched `ToolSearch select:a,b,c`).
  - If genuine breadth (a): assess whether the most-used ACE atoms should be **eagerly registered** (not deferred) so they're always present — check how `mcp/*/capability-map.ts` + plugin.json control deferral, and whether ACE can mark hot atoms non-deferred.
  - If neither is ACE-controllable: document as a harness limitation and stop (don't fake a fix).

- [ ] **Step 3: Implement the chosen lever, ship, VALIDATE with a run** — confirm `ToolSearch` count drops materially and total wall holds/drops.

---

## Task 3: Reduce Drive-write ceremony (×52) (MED confidence)

**Rationale:** 52 artifact-write turns/run. Some are load-bearing (run_state.yaml, the per-phase verdicts the analyzer/canopy read); some may be redundant or batchable.

- [ ] **Step 1: Classify all 52 writes** (from a transcript) as `required` (read by analyzer/canopy/resume — e.g. run_state.yaml, verdict files, decisions log) vs `incidental` (intermediate summaries, re-writes, per-step screenshots).
- [ ] **Step 2: For `incidental` writes** — batch siblings into one write where possible, or defer to a single end-of-phase flush. For `decisions-render` (runs per-phase): confirm whether one end-of-run render suffices (check `skills/decisions-render` "invoked at end of every phase" contract).
- [ ] **Step 3: Implement, ship, VALIDATE** — confirm write count drops and no analyzer/canopy/resume consumer breaks (run `/ace:status` + check the run's Drive folder is intact).

---

## Task 4: Coarsen self-task-tracking (×25 `TaskCreate`/`TaskUpdate`) (MED confidence)

**Rationale:** 25 turns/run spent on the agent's own todo list. Granular per-sub-step task tracking is overhead in a long deterministic procedure.

- [ ] **Step 1:** In the phase agent docs, add explicit guidance to track tasks at **phase/step granularity, not per-tool-call** (e.g., "one task per Process step, not per atom call").
- [ ] **Step 2: Ship + VALIDATE** — confirm `Task*` count drops and the agent still completes all steps (no dropped steps from coarser tracking).

---

## Task 5: Tighten executable Process sections (LOW-MED confidence — DEFER until 1–4 measured)

**Rationale:** The 553-line `## Process` is the biggest single context chunk, but it's the executable procedure — trimming it risks silently breaking a phase, and there's no cheap test (validation = a full run). Only attempt after 1–4 quantify how much headroom remains, and do it **one section at a time, each behind its own validation run**, with the Step-3 mechanical executable-token diff from Task 1 as a guard.

---

## Self-Review

- **Coverage:** every measured driver (context docs, ToolSearch, Drive writes, Task*, Process size) maps to a task (1, 2, 3, 4, 5 respectively); skip-evals (item 0) already shipped.
- **No placeholders:** each implementable task has concrete files, classification gates, and a mechanical verification + validation-run step. Task 2/3/5 deliberately lead with an investigation step because the *fix* is not yet known — that is stated, not hidden.
- **Consistency:** every task ends in the same validation protocol (seeded `--only 3,4,6` run + `/cost`/timeline compare), matching the baseline measurement method.
