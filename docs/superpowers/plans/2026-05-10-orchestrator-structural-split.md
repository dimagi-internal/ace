# Orchestrator Structural Split (PR 0c) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Worktree required.** This is a 1700-line doc refactor — work in an isolated worktree via `superpowers:using-git-worktrees`.

**Goal:** Split `agents/ace-orchestrator.md` (currently 1728 lines) into a procedure doc (top-of-file = top-of-execution-flow) and a sibling reference doc, hoist scattered anti-patterns into one consolidated section near the top of procedure, and convert phase blocks to a uniform template — without losing or rewording any normative content.

**Architecture:** Pure content move + reorder. Two output files: `agents/ace-orchestrator.md` (procedure, ~600 lines) and a NEW `agents/orchestrator-reference.md` (catalogs, schemas, contracts, ~700 lines). All cross-references between the two use H2 anchors (markdown auto-anchors), not line numbers. The procedure doc reads top-to-bottom in execution order.

**Tech Stack:** Markdown editing only. No code changes. Verification is `git diff` review + grep checks for content preservation.

**Line-number conventions in this plan.** Line numbers cited (e.g. "currently line 988") are the start-state values from the inventory in Task 1. After ANY task that moves content, line numbers shift. **Use H2 heading text as the canonical anchor when finding sections to move** — e.g. `grep -n "^## Producer Artifact Verifier" agents/ace-orchestrator.md`. The line numbers are hints, not addresses.

---

## Why this PR exists

Three perf PRs already shipped from this lens (0a/0b/0d). They worked despite the orchestrator's size because they were additive and locally-scoped. PR 0c attacks the cross-cutting structural problems the perf-lens analysis surfaced:

1. **Reading order ≠ execution order.** Top of file is `Agent Topology → State Schema → Cruft Management`. Workflow doesn't start until line 872. Pre-flight content is at line 1416. The model reads top-to-bottom; by the time it gets to "what to do" it's been thinking about state schemas for 800 lines.
2. **Reference and procedure interleaved.** `Phase Write-Back Contract` (line 1031, 100+ lines of spec) sits between the workflow that uses it and the verifier that enforces it. Splitting reference off lets the procedure doc read like a procedure.
3. **Anti-patterns scattered.** "Don't summarize and continue" (line 749), "don't fan out env probes" (line 723), "don't fake background tasks" (line 394), "don't dispatch two Agents in one message" (line 715). Compliance with negative rules is much higher when they're in one scannable list near the top.
4. **Phase blocks aren't uniformly shaped.** Lines 876–970 — each phase has a different shape. A uniform `Inputs → Atoms → Outputs → Write-back → Gate` template makes the workflow pattern-matchable instead of re-read each time.

## Background — what the worker needs to know

**Repository conventions** (`CLAUDE.md`):
- This is the ACE plugin repo. `agents/` holds procedure docs + subagent definitions. The orchestrator is the canonical procedure doc — `/ace:run` reads it inline at level 0.
- `main` is branch-protected. Ship via PR + `clean-install` CI check. See § Git worktrees and merging to main in `CLAUDE.md`.
- Version bump via `bash scripts/version-bump.sh` (worktree-safe). Pre-commit hook syncs the four version files. After merge, `/ace:update` in the original session.

**Three perf PRs already merged ahead of this one** (don't repeat their content):
- **0a (#202)** — Pre-flight Checklist subsection inside `## Performance Conventions` (lines 548–648). Don't move it; it stays in procedure.
- **0b (#203)** — `bin/ace-doctor --preflight` mode. Touches `bin/ace-doctor`. Orchestrator references it from Pre-flight Checklist Step 1.
- **0d (#204)** — `### Phase Boundary Fence — when, in one message` subsection inside `## Phase Write-Back Verifier` (lines 1143–1193). The fence is procedure (must STAY in procedure doc); the procedure body of the verifier (lines 1194–1245) is reference (moves to reference doc).

**Run log for context:** `.claude/pm/runs/2026-05-10-orchestrator-perf-lens.md` — captures the lens that produced these PRs.

---

## File structure

**Modify:** `agents/ace-orchestrator.md` — current 1728 lines → ~600 lines after extraction. New top-down execution order.

**Create:** `agents/orchestrator-reference.md` — ~700 lines. Pure reference content. Linked from procedure doc.

**Modify:** `CLAUDE.md` — section "Layout" mentions `ace-orchestrator.md`. Likely needs a sibling mention of the new reference doc; check for any line-number references that broke.

**Modify:** `VERSION`, `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — via `scripts/version-bump.sh` at end.

---

## Section classification (the contract for the move)

Anchors are H2 headings as they exist today. **Worker: don't fight this classification — if you disagree on a borderline section, ask before moving.**

### Stays in procedure doc (`agents/ace-orchestrator.md`)

| Today's heading | Today's line | New position in procedure (target order) |
|---|---|---|
| `## You are ACE` | 32 | 1 (intro) |
| **NEW** `## Anti-patterns and discipline` | (hoist) | 2 (right after intro) |
| `## Performance Conventions` (with `### Pre-flight Checklist` and `### Per-phase conventions`) | 543 | 3 (rename to `## Pre-flight & per-phase conventions`) |
| `## Populated opps are the norm` (incl. `### Why default mode looks like this`) | 266 | 4 (rename to `## Modes — default, review, auto`) |
| `## Resuming after a halt` | 748 | 5 |
| `## Starting a New Opportunity` (incl. `### Resolution`, `### Fallback`) | 1416 | 6 |
| `## Workflow` (Phases 1–9) | 872 | 7 (Task 10 will reshape phase blocks) |
| `## Between Phases` | 971 | 8 |
| `### Phase Boundary Fence — when, in one message` (extract from current Phase Write-Back Verifier section) | 1143 | 9 (promote to its own H2: `## Phase boundary fence`) |
| `## Per-Step Eval Hook` | 1301 | 10 |
| `## Umbrella Eval` | 1363 | 11 |
| `## Error Handling` | 1391 | 12 |
| `## Dry-Run Mode` | 1399 | 13 |
| `## Sandbox Mode` | 1409 | 14 |
| `## Post-Run: ace-web Transcript Upload` | 1246 | 15 |
| At end: forward-link to `agents/orchestrator-reference.md` | (new) | 16 |

### Moves to reference doc (`agents/orchestrator-reference.md`)

| Today's heading | Today's line | New position in reference |
|---|---|---|
| `## Agent Topology` | 24 | 1 |
| `## Your State` | 39 | 2 |
| `## State Schema` | 53 | 3 |
| `## Scope boundaries — what goes in run_state.yaml` | 155 | 4 |
| `## Cruft management — archive: block convention` | 197 | 5 |
| `## Per-Phase Folder Lifecycle` (incl. `### Current/ shortcut refresh`) | 793 | 6 |
| `## Producer Artifact Verifier` | 988 | 7 |
| `## Phase Write-Back Contract` | 1031 | 8 |
| `## Phase Write-Back Verifier` body (the procedure starting at `### Procedure` line 1194) | 1194 | 9 (under heading `## Phase Write-Back Verifier — procedure`) |
| `## Pause Points` | 1264 | 10 |
| `## Touching State — Operator Capture` (incl. `### State-as-canary contract`) | 1665 | 11 |

### Folds into the new `## Anti-patterns and discipline` (procedure doc, position 2)

These sections each contribute a tight rule block; the worker consolidates and removes the original sections from procedure. Worker may also push the *full content* into reference (e.g. as `## Discipline rules — full text`) if any nuance is too rich for the consolidated block — judgment call, but err on the side of fully consolidating.

| Source section | Today's line | What to extract |
|---|---|---|
| `## Long-Running Skills — No Fake Background Tasks` (incl. `### When background IS appropriate`, `### When polling IS appropriate`) | 394 | The rules ("no fake background tasks", "background IS appropriate when X", "polling IS appropriate when Y"). Keep the rationale concise — this is anti-pattern territory. |
| `## Skill Invocation Discipline` | 457 | The discipline rules. |
| `## External Mutations — Verify After Create` | 489 | The 4-step write→read→compare→halt-loud rule. The canonical-example reference (`skills/connect-opp-setup/SKILL.md`) stays. |
| **From `## Resuming after a halt`** | 748 | The `**Anti-pattern — do NOT "summarize and continue."**` paragraph specifically. |
| **From `## Performance Conventions` per-phase block** | 648 | The `**Resolve .env in one shot, not by probing.**`, `**Batch independent operations.**`, `**Agent(...) dispatches DO NOT parallelize.**` rules. |

The consolidated `## Anti-patterns and discipline` should read as a *scannable list*, not a wall of prose. Aim for ~80–120 lines. Cite full content in reference doc if too dense.

---

## Tasks

### Task 1: Set up the worktree and read the current state

**Files:**
- Read: `agents/ace-orchestrator.md` (1728 lines)
- Read: `CLAUDE.md` (for cross-references)
- Read: `.claude/pm/runs/2026-05-10-orchestrator-perf-lens.md` (lens context)

- [ ] **Step 1: Confirm worktree is set up**

Run: `git rev-parse --git-dir`
Expected output: contains `/worktrees/`. If not, create one via `superpowers:using-git-worktrees`.

- [ ] **Step 2: Confirm working tree is clean**

Run: `git status --short`
Expected output: empty (no modified or staged files).

- [ ] **Step 3: Read the orchestrator end-to-end**

Use `Read` on `agents/ace-orchestrator.md` (full file). Do not skim. As you read, mentally tag each H2 section as PROCEDURE or REFERENCE per the classification table above. If you disagree with the classification on any section, STOP and ask the user before continuing.

- [ ] **Step 4: Take the content checksum baseline**

Run:
```bash
awk '!/^[[:space:]]*$/ && !/^#/ {print}' agents/ace-orchestrator.md | sort -u > /tmp/orch-content-before.txt
wc -l /tmp/orch-content-before.txt
```
Save this number — you'll re-run the same command at the end and verify the union of `agents/ace-orchestrator.md` + `agents/orchestrator-reference.md` reproduces the same set of unique non-blank, non-heading lines.

- [ ] **Step 5: Commit no changes; tag the start point**

Run:
```bash
git log -1 --oneline
```
Note the SHA. You'll diff against this at the end.

---

### Task 2: Create the empty reference doc skeleton

**Files:**
- Create: `agents/orchestrator-reference.md`

- [ ] **Step 1: Write the reference doc with H2 headings only (empty bodies)**

Write `agents/orchestrator-reference.md` with this exact content:

```markdown
# ACE Orchestrator — Reference

This doc is the *reference* counterpart to `agents/ace-orchestrator.md`. It catalogs schemas, contracts, lifecycle invariants, and architectural diagrams that the orchestrator's procedure references. The procedure doc tells you WHAT to do; this doc tells you the SHAPE of what you're doing.

If you're executing `/ace:run`, read `agents/ace-orchestrator.md` first. Come here only when the procedure points you at a specific section.

---

## Agent Topology

(populated in Task 3)

## Your State

(populated in Task 3)

## State Schema

(populated in Task 3)

## Scope boundaries — what goes in `run_state.yaml`

(populated in Task 4)

## Cruft management — `archive:` block convention

(populated in Task 4)

## Per-Phase Folder Lifecycle

(populated in Task 4)

## Producer Artifact Verifier

(populated in Task 5)

## Phase Write-Back Contract

(populated in Task 5)

## Phase Write-Back Verifier — procedure

(populated in Task 5)

## Pause Points

(populated in Task 6)

## Touching State — Operator Capture

(populated in Task 7)
```

- [ ] **Step 2: Verify file landed**

Run:
```bash
ls -la agents/orchestrator-reference.md
grep -c "^## " agents/orchestrator-reference.md
```
Expected: file exists; 11 H2 headings.

- [ ] **Step 3: Commit**

```bash
git add agents/orchestrator-reference.md
git commit -m "orchestrator-reference: skeleton (PR 0c step 1/12)"
```

---

### Task 3: Move architectural sections to reference (Agent Topology, Your State, State Schema)

**Files:**
- Modify: `agents/ace-orchestrator.md` (cut)
- Modify: `agents/orchestrator-reference.md` (paste)

- [ ] **Step 1: Cut `## Agent Topology` from orchestrator, paste into reference**

In `agents/ace-orchestrator.md`, locate the section starting with `## Agent Topology` (currently line 24). It runs until the next H2. Cut the entire block including the `## Agent Topology` heading line.

In `agents/orchestrator-reference.md`, replace the line `## Agent Topology\n\n(populated in Task 3)\n` with the cut content.

- [ ] **Step 2: Repeat for `## Your State`**

Cut from orchestrator (currently ~line 39), paste into reference replacing the placeholder under `## Your State`.

- [ ] **Step 3: Repeat for `## State Schema`**

Cut from orchestrator (currently ~line 53). This is the largest of the three (~100 lines of YAML schema). Paste into reference replacing the placeholder under `## State Schema`.

- [ ] **Step 4: Verify the moves**

Run:
```bash
git diff agents/ace-orchestrator.md | grep -c '^-'
git diff agents/orchestrator-reference.md | grep -c '^+'
```
The difference between adds and removes should be the placeholder lines deleted (`(populated in Task 3)` x3) — i.e. about 3 fewer adds than removes (plus minor whitespace adjustments). If the gap is wider than ~5, something was lost. Investigate before continuing.

Run:
```bash
grep -n "^## Agent Topology\|^## Your State\|^## State Schema" agents/ace-orchestrator.md
```
Expected: empty output (all three moved out).

```bash
grep -n "^## Agent Topology\|^## Your State\|^## State Schema" agents/orchestrator-reference.md
```
Expected: three matches, in that order.

- [ ] **Step 5: Commit**

```bash
git add agents/ace-orchestrator.md agents/orchestrator-reference.md
git commit -m "orchestrator: move topology + state inventory + state schema → reference (PR 0c step 2/12)"
```

---

### Task 4: Move scope/cruft/lifecycle to reference

**Files:**
- Modify: `agents/ace-orchestrator.md` (cut)
- Modify: `agents/orchestrator-reference.md` (paste)

- [ ] **Step 1: Cut `## Scope boundaries — what goes in run_state.yaml`**

Cut the section (heading + body until next H2). Paste under the corresponding placeholder in reference.

- [ ] **Step 2: Cut `## Cruft management — archive: block convention`**

Same pattern. Move to reference.

- [ ] **Step 3: Cut `## Per-Phase Folder Lifecycle` (including the `### Current/ shortcut refresh` subsection)**

This section runs from current line 793 to the next H2. Move the entire block including any H3 subsections.

- [ ] **Step 4: Verify**

Run:
```bash
grep -n "^## Scope boundaries\|^## Cruft management\|^## Per-Phase Folder Lifecycle" agents/ace-orchestrator.md
```
Expected: empty.

```bash
grep -n "^## Scope boundaries\|^## Cruft management\|^## Per-Phase Folder Lifecycle\|^### Current/ shortcut refresh" agents/orchestrator-reference.md
```
Expected: 4 matches.

- [ ] **Step 5: Commit**

```bash
git add agents/ace-orchestrator.md agents/orchestrator-reference.md
git commit -m "orchestrator: move scope + cruft + folder lifecycle → reference (PR 0c step 3/12)"
```

---

### Task 5: Move write-back contract + verifier procedure to reference (KEEP fence in procedure)

**This is the most delicate task in the plan.** PR 0d added `### Phase Boundary Fence` *inside* `## Phase Write-Back Verifier` (currently lines 1143–1193). The fence is procedure (timing rule + worked examples) and MUST stay in the procedure doc. The verifier's actual procedure (currently lines 1194–1245, starting with `### Procedure`) moves to reference.

**Files:**
- Modify: `agents/ace-orchestrator.md` (cut Producer Artifact Verifier; cut Phase Write-Back Contract; KEEP Phase Boundary Fence; cut verifier procedure body)
- Modify: `agents/orchestrator-reference.md` (paste)

- [ ] **Step 1: Cut `## Producer Artifact Verifier`**

Move the full section (currently ~line 988) to reference under the placeholder.

- [ ] **Step 2: Cut `## Phase Write-Back Contract`**

Move the full section (currently ~line 1031, ~100 lines) to reference under the placeholder.

- [ ] **Step 3: Carefully split `## Phase Write-Back Verifier`**

The current section is structured:
```
## Phase Write-Back Verifier
<intro paragraph>

### Phase Boundary Fence — when, in one message
<PR 0d content — STAYS in procedure>

### Procedure
<the verifier's actual checklist procedure — MOVES to reference>
```

Action: in `agents/ace-orchestrator.md`, replace the H2 `## Phase Write-Back Verifier` line with `## Phase boundary fence` (promoting the H3 fence to its own H2). Delete the original intro paragraph and the `### Phase Boundary Fence — when, in one message` H3 line (the fence content stays under the new H2). Delete the `### Procedure` H3 and its body (move to reference).

In `agents/orchestrator-reference.md`, replace the placeholder under `## Phase Write-Back Verifier — procedure` with: the original intro paragraph + the `### Procedure` body. (Drop the `### Procedure` H3 since the H2 already names it.)

- [ ] **Step 4: Verify**

Run:
```bash
grep -n "^## Producer Artifact Verifier\|^## Phase Write-Back Contract\|^## Phase Write-Back Verifier" agents/ace-orchestrator.md
```
Expected: empty.

```bash
grep -n "^## Phase boundary fence" agents/ace-orchestrator.md
```
Expected: one match.

```bash
grep -n "^## Producer Artifact Verifier\|^## Phase Write-Back Contract\|^## Phase Write-Back Verifier — procedure" agents/orchestrator-reference.md
```
Expected: 3 matches.

```bash
grep -n "Anti-pattern.*Boundary observed in real transcripts" agents/ace-orchestrator.md
```
Expected: one match (the worked-example anti-pattern from PR 0d, must still be in procedure).

- [ ] **Step 5: Commit**

```bash
git add agents/ace-orchestrator.md agents/orchestrator-reference.md
git commit -m "orchestrator: move verifiers + write-back contract → reference; keep boundary fence in procedure (PR 0c step 4/12)"
```

---

### Task 6: Move Pause Points to reference

**Files:**
- Modify: `agents/ace-orchestrator.md` (cut)
- Modify: `agents/orchestrator-reference.md` (paste)

- [ ] **Step 1: Cut `## Pause Points`**

The section is a catalog (table of pause points + per-mode behavior). Move to reference under placeholder.

- [ ] **Step 2: Verify**

```bash
grep -n "^## Pause Points" agents/ace-orchestrator.md   # expected: empty
grep -n "^## Pause Points" agents/orchestrator-reference.md   # expected: 1 match
```

- [ ] **Step 3: Commit**

```bash
git add agents/ace-orchestrator.md agents/orchestrator-reference.md
git commit -m "orchestrator: move pause-points catalog → reference (PR 0c step 5/12)"
```

---

### Task 7: Move Touching State — Operator Capture to reference

**Files:**
- Modify: `agents/ace-orchestrator.md` (cut)
- Modify: `agents/orchestrator-reference.md` (paste)

- [ ] **Step 1: Cut `## Touching State — Operator Capture` (including `### State-as-canary contract`)**

Move the full section to reference.

- [ ] **Step 2: Verify**

```bash
grep -n "^## Touching State\|^### State-as-canary contract" agents/ace-orchestrator.md   # expected: empty
grep -n "^## Touching State\|^### State-as-canary contract" agents/orchestrator-reference.md   # expected: 2 matches
```

- [ ] **Step 3: Commit**

```bash
git add agents/ace-orchestrator.md agents/orchestrator-reference.md
git commit -m "orchestrator: move operator-capture state contract → reference (PR 0c step 6/12)"
```

---

### Task 8: Hoist anti-patterns into one consolidated `## Anti-patterns and discipline` section

**Files:**
- Modify: `agents/ace-orchestrator.md` (consolidate, then delete sources)
- Modify: `agents/orchestrator-reference.md` (optional — paste full text if too dense for procedure)

This is the most judgment-heavy task. Read the source sections in full first, then decide structure.

- [ ] **Step 1: Read all the anti-pattern source sections**

Use `Read` on `agents/ace-orchestrator.md` and locate:
- `## Long-Running Skills — No Fake Background Tasks` (incl. `### When background IS appropriate`, `### When polling IS appropriate`) — currently around line 394.
- `## Skill Invocation Discipline` — currently around line 457.
- `## External Mutations — Verify After Create` — currently around line 489.
- The `**Resolve .env in one shot**`, `**Batch independent operations**`, `**Agent(...) dispatches DO NOT parallelize**` rule blocks inside `### Per-phase conventions` (currently around line 663).
- The `**Anti-pattern — do NOT "summarize and continue."**` paragraph inside `## Resuming after a halt` (currently around line 749).

- [ ] **Step 2: Draft the consolidated section**

Write a new `## Anti-patterns and discipline` section right after `## You are ACE` in `agents/ace-orchestrator.md`. Structure it as a scannable rules list:

```markdown
## Anti-patterns and discipline

These are the rules the orchestrator MUST follow during `/ace:run`. Each rule is a one-line directive. Where the rule has a worked failure mode (an incident or a transcript pattern), follow with a short **Why** paragraph. Detailed rationale and historical context lives in `agents/orchestrator-reference.md` § Discipline — full text.

### Tool dispatch
- **Don't fake background tasks.** No prose like "I'll check on this in 5 minutes." If a skill is long-running, run it in the foreground and let it complete. (Background dispatch IS appropriate for: <bullet>; polling IS appropriate when: <bullet>.)
- **Don't dispatch two `Agent` calls in one message.** Claude Code does not reliably parallelize `Agent` dispatches. Treat all `Agent` and `/nova:autobuild`-style dispatches as serial.
- **Do batch independent tool calls.** N independent `drive_read_file`, `connect_create_payment_unit`, etc. in a single assistant message. Sequential single-tool messages waste harness parallelism.
- **Don't fan out env probes.** One Bash to resolve `.env` (use `bin/ace-doctor --preflight`). Not 3–4 separate `ls`/`test -f` probes.

### State writes
- **Verify after every external create.** Write → read → compare → halt loud on mismatch. (Canonical example: `skills/connect-opp-setup/SKILL.md` Steps 4 + 6.) Mismatch on a load-bearing field is a `[BLOCKER]`.
- **Don't read-modify-write `run_state.yaml` by hand.** Use `update_yaml_file` with `merge: 'two-level'`. The CAS retry inside `update_yaml_file` is the race-correctness mechanism.

### Procedure discipline
- **Don't "summarize and continue" to dodge context exhaustion.** Trust the 1M-context window. If the harness genuinely signals exhaustion, write back and resume via `/ace:run <opp>/<run-id>` in a fresh session.
- **Don't skip producer skills to shortcut to consumers.** § Producer Artifact Verifier (in reference) catches this at the next phase boundary, but the discipline lives here.
- **Don't add operator-confirmation prompts on populated opps.** The "do you want to overwrite live state?" gate is off-spec — push reuse-vs-rebuild decisions down into phase agent skill logic instead.
```

(Worker: rephrase as needed for readability; the goal is "scannable rule list," not exhaustive rationale.)

- [ ] **Step 3: Delete the now-consolidated source sections from procedure**

Cut from `agents/ace-orchestrator.md`:
- `## Long-Running Skills — No Fake Background Tasks` and its H3 subsections.
- `## Skill Invocation Discipline`.
- `## External Mutations — Verify After Create`.
- The three rule blocks inside `### Per-phase conventions` (Resolve .env, Batch independent, Agent... DO NOT parallelize).
- The `**Anti-pattern — do NOT "summarize and continue."**` paragraph from `## Resuming after a halt`.

- [ ] **Step 4: Optionally paste full source text into reference**

If the consolidated section had to drop important rationale (e.g. specific failure-mode incidents), append a `## Discipline — full text` H2 at the end of `agents/orchestrator-reference.md` containing the original prose.

- [ ] **Step 5: Verify**

```bash
grep -n "^## Long-Running Skills\|^## Skill Invocation Discipline\|^## External Mutations" agents/ace-orchestrator.md
```
Expected: empty.

```bash
grep -n "^## Anti-patterns and discipline" agents/ace-orchestrator.md
```
Expected: one match.

```bash
grep -c "summarize and continue" agents/ace-orchestrator.md
```
Expected: at most one match (in the consolidated section, not in `## Resuming after a halt`).

- [ ] **Step 6: Commit**

```bash
git add agents/ace-orchestrator.md agents/orchestrator-reference.md
git commit -m "orchestrator: hoist scattered anti-patterns into one section near top (PR 0c step 7/12)"
```

---

### Task 9: Reorder remaining procedure sections into execution order

After Tasks 3–8, `agents/ace-orchestrator.md` should contain (in some order) only the sections from the procedure column of the classification table, plus the new `## Anti-patterns and discipline`. This task reorders them.

**Files:**
- Modify: `agents/ace-orchestrator.md`

Target order (top to bottom):

1. `## You are ACE`
2. `## Anti-patterns and discipline` (NEW — Task 8)
3. `## Pre-flight & per-phase conventions` (renamed from `## Performance Conventions`)
4. `## Modes — default, review, auto` (renamed from `## Populated opps are the norm — do NOT pause to ask "are you sure?"`; absorbs `### Why default mode looks like this`)
5. `## Resuming after a halt`
6. `## Starting a New Opportunity`
7. `## Workflow`
8. `## Between Phases`
9. `## Phase boundary fence` (renamed from PR 0d's H3, promoted to H2 in Task 5)
10. `## Per-Step Eval Hook`
11. `## Umbrella Eval`
12. `## Error Handling`
13. `## Dry-Run Mode`
14. `## Sandbox Mode`
15. `## Post-Run: ace-web Transcript Upload (optional)`
16. `## See also: orchestrator-reference.md` (NEW — added in Task 11)

- [ ] **Step 1: Move sections one at a time into the target order**

Use Edit's "cut from here, paste there" pattern. After each move, run:
```bash
grep -n "^## " agents/ace-orchestrator.md
```
And verify the section list is heading toward the target order.

- [ ] **Step 2: Rename `## Performance Conventions` → `## Pre-flight & per-phase conventions`**

```bash
sed -i.bak 's/^## Performance Conventions$/## Pre-flight \& per-phase conventions/' agents/ace-orchestrator.md
rm agents/ace-orchestrator.md.bak
```

- [ ] **Step 3: Rename `## Populated opps are the norm — do NOT pause to ask "are you sure?"` → `## Modes — default, review, auto`**

The full original heading line is verbose; replace with a concise heading. Use Edit (sed will struggle with the special characters in the heading).

- [ ] **Step 4: Verify final section order**

Run:
```bash
grep -n "^## " agents/ace-orchestrator.md
```
Expected output (in this order): the 16-item list above.

- [ ] **Step 5: Commit**

```bash
git add agents/ace-orchestrator.md
git commit -m "orchestrator: reorder procedure sections into execution order (PR 0c step 8/12)"
```

---

### Task 10: Convert phase blocks to a uniform template

**Files:**
- Modify: `agents/ace-orchestrator.md` (rewrite each phase block under `## Workflow`)

The current `## Workflow` has 9 phase blocks (currently lines 876–970), each shaped differently. Convert to a uniform template.

**Template (apply to each `### Phase N: <name>`):**

```markdown
### Phase N: <Name>

**Dispatch:** `Agent(<phase-agent-name>)` (or `inline procedure-doc agents/<name>.md` for Phase 2).

**Inputs (inline at handoff):** PDD, prior-phase verdicts (`<prior-phase>/<producer>-{qa_result,eval_verdict}.yaml`), `run_state.yaml`. See § Pre-flight & per-phase conventions → "Pass artifacts inline at phase handoff" for the template.

**Atoms / skills used (orchestrator-visible only):** <list, e.g. `Agent(design-review)` or `Agent(connect-setup)` — the orchestrator only sees the top-level Agent dispatch except for Phase 2 which dispatches Nova at L0>.

**Outputs:** <list of artifacts the phase produces in `runs/<run-id>/<N>-<phase>/`>.

**Write-back:** `phases.<phase>.{status, started_at, completed_at, verdict, summary_artifact, steps}` per § Phase Write-Back Contract (in reference). The boundary fence (§ Phase boundary fence) governs WHEN.

**Gate:** <`[BLOCKER]` halts; pause behavior per § Pause Points (in reference)>.

**Notes:** <any phase-specific prose worth preserving — e.g. Phase 2's level-0 constraint, Phase 7's HITL boundary, Phase 9's trigger condition>.
```

- [ ] **Step 1: Read the current `## Workflow` section in full**

You need every phase's existing prose in front of you before rewriting.

- [ ] **Step 2: Rewrite each phase block one at a time, committing per-phase**

For each phase 1–9:

1. Replace the phase block with the uniform template, filling in fields from the existing prose. Preserve all phase-specific facts (Phase 2 level-0 constraint, Phase 5 internal-only contract, Phase 6 reversibility note, Phase 7 HITL boundary, Phase 8 entry gate, Phase 9 trigger).
2. Run `grep -A 20 "^### Phase N:" agents/ace-orchestrator.md` to spot-check the rewritten block.
3. Commit with message `orchestrator: phase N uniform template (PR 0c step 9.<N>/12)`.

If a fact in the original prose doesn't fit any of the template's fields, add a "Notes" bullet — don't drop it.

- [ ] **Step 3: After all 9 phases rewritten, verify nothing was lost**

Run:
```bash
grep -c "^### Phase " agents/ace-orchestrator.md
```
Expected: 9.

```bash
git diff <start-SHA-from-Task-1>..HEAD -- agents/ace-orchestrator.md | grep -c '^-### Phase '
```
Expected: 9 (each old block deleted).

```bash
git diff <start-SHA-from-Task-1>..HEAD -- agents/ace-orchestrator.md | grep -c '^+### Phase '
```
Expected: 9 (each new block added).

---

### Task 11: Add forward-link from procedure to reference + update CLAUDE.md

**Files:**
- Modify: `agents/ace-orchestrator.md` (add link section at end)
- Modify: `CLAUDE.md` (mention the new reference doc in § Layout)

- [ ] **Step 1: Add forward-link section to end of procedure doc**

Append to `agents/ace-orchestrator.md`:

```markdown
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

The procedure doc above is the canonical execution flow; the reference doc is normative for the shapes and rules cited above.
```

- [ ] **Step 2: Update `CLAUDE.md` § Layout**

In `CLAUDE.md`, locate the line in the `## Layout` section that today reads:

```
- `agents/` — 11 agents. Two procedure docs (`ace-orchestrator`, `commcare-setup`); nine subagents.
```

Update to:

```
- `agents/` — 11 agents + 1 reference doc. Two procedure docs (`ace-orchestrator`, `commcare-setup`); nine subagents; `orchestrator-reference.md` is the reference companion to `ace-orchestrator.md` (state schemas, write-back contract, pause-points catalog).
```

- [ ] **Step 3: Update the `Phase Write-Back Contract` reference in CLAUDE.md**

`CLAUDE.md` line ~109 today reads:
```
See `agents/ace-orchestrator.md § Phase Write-Back Contract`
```

The Phase Write-Back Contract moved to reference in Task 5. Update to:
```
See `agents/orchestrator-reference.md § Phase Write-Back Contract`
```

- [ ] **Step 4: Search for other line-number or section references to ace-orchestrator.md in any doc**

Run:
```bash
grep -rn "ace-orchestrator.md" --include='*.md' . | grep -v "docs/superpowers/plans/"
```

For each hit, evaluate whether the referenced section moved to the reference doc (per the classification table). If so, update to point at `agents/orchestrator-reference.md` instead. Use H2 anchor (`§ <heading>`), never line numbers.

- [ ] **Step 5: Commit**

```bash
git add agents/ace-orchestrator.md CLAUDE.md
git commit -m "orchestrator: forward-link to reference + CLAUDE.md cross-ref updates (PR 0c step 10/12)"
```

---

### Task 12: Verify content preservation + skim-read

**Files:**
- Read: `agents/ace-orchestrator.md`
- Read: `agents/orchestrator-reference.md`

- [ ] **Step 1: Content checksum**

```bash
awk '!/^[[:space:]]*$/ && !/^#/ {print}' agents/ace-orchestrator.md agents/orchestrator-reference.md | sort -u > /tmp/orch-content-after.txt
wc -l /tmp/orch-content-after.txt
diff /tmp/orch-content-before.txt /tmp/orch-content-after.txt | head -50
```

The diff should show:
- A handful of *added* lines for the new `## Anti-patterns and discipline` consolidated section (since you rewrote rules into a tighter form).
- A handful of *added* lines for the `## See also` section.
- A handful of *added* lines for the new orchestrator-reference.md frontmatter.
- A handful of *removed* lines for any prose that was *consolidated away* during the anti-patterns hoist.
- Phase block deltas from Task 10's uniform-template rewrite.

If the diff shows entire paragraphs of the original prose missing (not just rewording), STOP and investigate. Recover lost content from `git log -p` against the start SHA.

- [ ] **Step 2: Skim-read both files top-to-bottom**

Specifically check:
- Procedure doc reads as a procedure top-to-bottom — pre-flight → run-start → workflow → boundary fence → per-step → post-run.
- Reference doc reads as reference — schemas, contracts, catalogs, no execution-order prose.
- No section appears in both files (except the rare case where the original was BOTH procedure and reference — Anti-patterns / Discipline being one of those).

- [ ] **Step 3: Run all PR 0a/0b/0d-specific spot checks**

```bash
# PR 0a — pre-flight checklist still in procedure doc
grep -c "^### Pre-flight Checklist" agents/ace-orchestrator.md   # expected: 1

# PR 0b — bin/ace-doctor --preflight reference present
grep -c "bin/ace-doctor --preflight" agents/ace-orchestrator.md  # expected: at least 1

# PR 0d — phase boundary fence in procedure doc as H2
grep -c "^## Phase boundary fence" agents/ace-orchestrator.md    # expected: 1
grep -c "Boundary observed in real transcripts" agents/ace-orchestrator.md  # expected: 1
```

- [ ] **Step 4: Run a sanity check that orchestrator's H2 list matches the target order**

```bash
grep -n "^## " agents/ace-orchestrator.md
```
Expected (16 H2s, in execution order): see Task 9 list.

```bash
grep -n "^## " agents/orchestrator-reference.md
```
Expected (11 H2s).

- [ ] **Step 5: Bump version + final commit + PR**

```bash
bash scripts/version-bump.sh
git add VERSION package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "VERSION bump for PR 0c"
git push -u origin <branch-name>
gh pr create --title "orchestrator: structural split — procedure vs reference, anti-patterns hoisted, uniform phase template (PR 0c)" --body "<see Self-Review checklist below for body>"
```

PR body should include:
- Goal statement.
- The classification table from the top of this plan.
- A note that PR 0a/0b/0d shipped ahead and their content is preserved (pre-flight checklist, --preflight reference, phase boundary fence — all still in procedure doc).
- Test plan: doc-only change, CI's `clean-install` is the gate; manual skim-read done.

- [ ] **Step 6: Wait for CI, merge, run `/ace:update`, notify the original session.**

Per `CLAUDE.md` § Plugin updates — NEVER locally patch.

---

## Self-review checklist (run before opening the PR)

- [ ] **No section appears in both files** unless intentionally duplicated (Anti-patterns + Discipline full text being the only allowed duplication).
- [ ] **All H2 anchors used in cross-references resolve** — for every `§ <heading>` mention, grep both files for the heading.
- [ ] **PR 0a/0b/0d content preserved**:
  - Pre-flight Checklist (6 numbered steps + Stop Signs subsection) — in procedure.
  - `bin/ace-doctor --preflight` referenced in Step 1 of Pre-flight Checklist.
  - Phase Boundary Fence (with anti-pattern → right-pattern transcript example) — in procedure as own H2.
- [ ] **No line-number references** in either doc to the OTHER doc. All cross-references use H2 anchors.
- [ ] **VERSION bumped exactly once** at the end (not per-task).
- [ ] **Each task's commit is atomic** — `git log --oneline` shows 12 PR-0c-step-N/12 commits + the version bump commit.

## Backout

If review surfaces problems and we need to back out:
- Revert the merge commit on `main` (creates a revert PR).
- The original `agents/ace-orchestrator.md` content is intact in git history at the start SHA from Task 1.
- PR 0a/0b/0d are not affected — they were earlier merges.

## Estimated time

10–14 hours of focused work for an engineer with this plan in hand. Most of the time is in Task 8 (anti-pattern hoist — needs careful reading of source sections to consolidate without information loss) and Task 10 (phase template rewrites — 9 blocks × ~10 min each + verification).
