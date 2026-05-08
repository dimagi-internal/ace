# ACE Skills — Author Contract

This file is the contract for authoring SKILL.md files in `skills/`. Read it before adding a new skill or making non-trivial edits to an existing one. Existing skills are the source of truth — if this contract drifts from them, fix the contract or fix the skills, but they should agree.

ACE skills are prompt-based capability definitions. Each one handles one step of the CRISPR-Connect process (see `docs/superpowers/specs/2026-04-01-ace-design.md`). Skills are stateless — they read from and write to the opportunity's Google Drive folder (`ACE/<opp-name>/`) and call MCP tools for external system access. The agents in `agents/` are what dispatch to skills.

## File location and naming

Each skill lives in its own directory under `skills/`:

```
skills/
└── <skill-name>/
    └── SKILL.md
```

`<skill-name>` is kebab-case and matches the `name:` frontmatter field exactly. Multi-word names use single hyphens, not underscores. Names should be verbs or verb phrases ("idea-to-pdd", "app-deploy", "llo-onboarding"), not nouns.

If a skill needs supporting files (templates, scripts, prompt fragments), they go alongside `SKILL.md` in the same directory.

## Required frontmatter

Every SKILL.md begins with YAML frontmatter:

```markdown
---
name: <skill-name>
description: >
  <verb> <object>. Use when <distinguishing condition>.
disable-model-invocation: true
---
```

### `name` (required)

Must match the directory name exactly.

### `description` (required, ≤200 chars, target ~120)

The description appears in the harness skill catalog at session start —
ACE plus other plugins competes for an aggregate budget around 8K-16K
chars across all installed plugins, and Claude Code silently drops
overflow. Keep descriptions tight. Two clauses: `<verb> <object>. Use
when <distinguishing condition>.` Don't lead with the skill name.

**Banned patterns in `description:`**

The following information belongs in the body, not the description.
The CI lint (planned) fails if any of these match:

| Pattern | Where to put it |
|---|---|
| `Phase N` / `Step N of Phase M` | Body intro paragraph |
| File paths (`*.yaml`, `*.md`, `ACE/<opp>/...`) | `## Inputs` / `## Outputs` |
| `reads X, writes Y` | `## Inputs` / `## Outputs` |
| `Sibling of` / `Successor to` / `Mirror of` | `## Related skills` |
| `TEMPORARY`, `Provisional`, `Delete this skill when…` | `## Removal criteria` |
| 3+ trigger-phrase paraphrases (`or "X"`, `or "Y"`) | Cut entirely; the harness routes by intent, not by exact phrase match |
| `skills/<name>/SKILL.md` paths | Body cross-references |

The generated playbook (`docs/generated/playbook.md`) renders the
description verbatim, so a tight description doubles as a tight
playbook entry.

### `disable-model-invocation` (recommended)

Default for ACE skills is `disable-model-invocation: true`. ACE skills
are dispatched by the orchestrator and phase agents by exact name —
they do not need to compete for the routing-index budget. Setting this
flag removes the skill from the harness catalog entirely without
affecting `Skill(name)` invocation by name.

Carve out an exception (omit the flag, default `false`) only if a
human user is plausibly going to free-text invoke the skill rather
than going through `/ace:run` or `/ace:step`. As of 2026-05, no ACE
skill currently meets that bar.

### Other fields

No other frontmatter fields are used. Don't add `version:`, `author:`,
or similar — git is the source of truth for authorship and history.

## Required sections

Every SKILL.md must have these sections, in this order:

### 1. `# <Skill Display Name>` (h1)

The h1 is the human-readable display name (e.g., "Idea to PDD"), not the kebab-case `name`. One short paragraph after the h1 restates the skill's purpose in plain language for someone who hasn't read the frontmatter.

### 2. `## Inputs`

A bullet list (or table) of every artifact the skill reads. Each entry
gives the source phase, the path, and what the input is used for.
Inputs are the explicit contract between this skill and its upstream
producers — keeping them in one section means a phase agent can
verify the contract without reading the full procedure.

```markdown
## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | archetype, framing, FLW count |
| Phase 2 | `2-commcare/pdd-to-learn-app_summary.md` | nova_app_id, module list |
```

### 3. `## Outputs`

A bullet list of every artifact the skill writes. Same contract
discipline as `## Inputs`. Path uses the artifact-path scheme
defined under `## QA vs Eval — the two-phase pattern` below.

```markdown
## Outputs

- `<phase>/<skill>_summary.md` — primary artifact
- `<phase>/<skill>_verdict[-<mode>].yaml` — verdict YAML (when self-evaluating)
- `<phase>/<skill>_gate-brief[-<mode>].md` — gate brief (when this skill gates a phase)
```

### 4. `## Process`

A numbered list of steps the skill executes. Each step is a single imperative sentence in **bold**, optionally followed by a sub-bulleted breakdown of what the step entails. Steps should be sequential and the numbering must be sequential — if you insert a step in the middle of the list, renumber every step after it. Use `grep -nE '^[0-9]+\.' SKILL.md` to verify after edits.

If the skill reads from the PDD's `archetype:` and/or `## Evidence Model` section, that read should be an explicit early step. Don't bury it in prose — it's load-bearing for downstream behavior.

### 5. `## MCP Tools Used`

A bullet list of MCP tools the skill calls, grouped by server. For each tool, indicate whether it's built or "NOT YET BUILT" (with the relevant ticket number when applicable). Example:

```markdown
## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_update_file`
- Connect: `create_opportunity`, `set_verification_rules` — **NOT YET BUILT** (CCC-301)
```

**Drive parent contract.** Every `drive_create_file` and `drive_create_folder` call MUST pass an explicit `parentFolderId` rooted in the opportunity's `ACE/<opp-name>/` folder. Service Accounts have zero My-Drive quota; the MCP rejects calls whose parent isn't on a Shared Drive (typed error from `assertParentOnSharedDrive`, added 0.5.18). Never call these tools without `parentFolderId`, and never rely on a "default to root" fallback — there is no safe root for an SA.

### 6. `## Mode Behavior`

How the skill behaves in **Auto** vs **Review** mode. One bullet per mode. Both modes execute the same steps; only the gating and human-handoff differs.

```markdown
## Mode Behavior
- **Auto:** <action>, notify admin group, proceed
- **Review:** <action>, present for human approval, wait
```

### 7. `## Change Log`

A markdown table of dated changes. Append at the bottom on every non-trivial edit. Don't delete history. Format:

```markdown
## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-08 | <description of change> | <author or context> |
```

Trivial typo fixes don't need a change log entry; behavior changes do. When in doubt, append.

## Body templates (`_*.md` reference docs)

Three reference documents extract shared boilerplate so individual
skills don't duplicate it:

- **`skills/_eval-template.md`** — for `*-eval` skills. Defines the
  verdict YAML contract, auto-surfaced severity rules, inflation guard
  pattern, and stock blocks for `## MCP Tools Used / ## Mode Behavior /
  ## Dry-Run Behavior`. Every `*-eval` skill body should reference
  this file's "Verdict YAML contract" instead of inlining the YAML
  schema.
- **`skills/_training-template.md`** — for `training-*` skills. Defines
  the per-artifact decomposition rationale, sibling map, common Drive
  paths, and shared verdict shape (which itself references
  `_eval-template.md`). Per-skill format rules and audience-specific
  concerns stay in each skill's own file.
- **`skills/_solicitation-template.md`** — for the Phase 7 solicitation
  family. Defines the `opp.yaml.solicitation` and `opp.yaml.selected_llo`
  contract, the connect-labs MCP atom inventory per skill, and the
  Phase 7 → Phase 8 boundary rule.

These files start with `_` so they are excluded from the skill catalog
(they aren't skills — they're reference docs). When you add a new
skill in one of the three families, copy the skeleton from the matching
template and reference shared sections rather than duplicating them.

## Optional sections

These are added when the skill needs them. They have a fixed location and format so the structure stays predictable across skills.

### `## Archetypes` (when the skill branches on PDD delivery archetype)

Required if the skill behaves differently for `atomic-visit` vs `focus-group` vs `multi-stage` PDDs. Place this section **immediately before** `## MCP Tools Used`.

Each archetype is a `### <archetype-name>` subheading with a short description and the archetype-specific instructions. The default (`atomic-visit`) goes first. Skills that don't branch on archetype omit this section entirely.

```markdown
## Archetypes

### `atomic-visit` (default)
<what the skill does for atomic-visit PDDs>

### `focus-group`
<what the skill does differently for focus-group PDDs>

### `multi-stage`
<how the skill handles multi-stage PDDs — typically dispatches per stage>
```

The 9 archetype-aware skills today are: `idea-to-pdd`, `pdd-to-test-prompts`, `pdd-to-app-journeys`, `pdd-to-learn-app`, `pdd-to-deliver-app`, `connect-opp-setup`, `llo-invite`, `flw-data-review`, `cycle-grade`.

### `## LLM-as-Judge Rubric` (when the skill self-evaluates or is an eval skill)

Some skills self-evaluate their output before passing it downstream; dedicated `-eval` skills (see `## QA vs Eval — the two-phase pattern` below) exist entirely to apply a rubric. In both cases, when the rubric is non-trivial, factor it out into its own section instead of burying it inside a process step. Place this section **immediately before** `## Gate Brief` (if present), `## Archetypes` (if present), or `## MCP Tools Used` (if neither).

The rubric should be concrete enough to grade on — bullet points with grading anchors, or a numbered checklist with pass/fail conditions. See `skills/idea-to-pdd/SKILL.md` for the canonical example (the 5-question stress-test rubric with worked anchors from the example PDDs). See `skills/ocs-chatbot-eval/SKILL.md` for the 4-dimension weighted-score pattern that dedicated `-eval` skills follow.

### `## Gate Brief` (when the skill ends a phase with a `<skill>_gate-brief[-<mode>].md` artifact)

Required for any skill that writes a gate brief at
`runs/<run-id>/<phase>/<skill>_gate-brief[-<mode>].md` — the canonical
artifact the orchestrator reads at a `--mode review` pause. Place this
section **immediately after** `## LLM-as-Judge Rubric` (if present)
and **immediately before** `## Archetypes` (if present) or `## MCP
Tools Used` (if neither). Document the four fields the gate brief
populates (Artifact Under Review, What to Check, Auto-Surfaced
Concerns, Recommended Disposition) using the canonical shape from
`agents/ace-orchestrator.md § Gate Brief Contract`.

The 5 gate-owning skills today are: `idea-to-pdd` (Phase 1→2), `app-deploy` (Phase 2→3), `ocs-chatbot-eval` (Phase 4→5), `llo-invite` (Phase 7 invite-list), `llo-launch` (Phase 8 launch). `opp-eval` also writes a Gate Brief section but its brief is advisory (does not gate any phase).

### `## Current Workaround` (when the skill is blocked on un-built APIs)

For skills whose ideal flow depends on APIs that don't exist yet, document the manual fallback. Place this **after** `## MCP Tools Used` and **before** `## Mode Behavior`. The workaround should be a numbered list of human-in-the-loop steps that produce the same external effect.

Many existing skills have these blocks (everything blocked on CCC-301, Nova bot API, OCS MCP, etc.) — they're expected and not tech debt. They get removed once the underlying API ships.

### `## Dry-Run Behavior` (when the skill has external side effects)

Required for any skill that sends emails, publishes apps, creates Jira tickets, or otherwise produces external effects. Document what the skill does instead under `--dry-run`. Place this **after** `## Mode Behavior` and **before** `## Failure Modes` (if present) or `## Change Log` (if not).

```markdown
## Dry-Run Behavior

When `--dry-run` is active:
- <full-action> is generated normally
- <effectful-action> is written to `comms-log/dry-run-<step>.md` instead of executing
- State tracks as `dry-run-success`
```

See `docs/superpowers/specs/2026-04-01-ace-design.md` § "Testing and Dry-Run Strategy" for the full dry-run model.

### `## Failure Modes` (when the skill has typed errors worth enumerating)

Optional. Use it to enumerate named errors and recovery hints — the kind of thing an operator wants to grep when a skill stops cold. Bullet list of `<ErrorName>` → recovery hint. Place this section **after** `## Dry-Run Behavior` (if present) or `## Mode Behavior` (if not), and **before** `## Change Log`. Canonical examples: `skills/ocs-agent-setup/SKILL.md`, `skills/pdd-to-test-prompts/SKILL.md`.

## QA vs Eval — the two-axis pattern

Every producer artifact is checked along two **orthogonal** axes. Both run on every artifact (separately or inline); QA gates eval.

- **QA = structural correctness.** Binary pass/fail. Hard do-not-pass-go failures. Mostly static checks; LLM use is allowed but discouraged unless static can't capture the rule. Reference: `skills/_qa-template.md`.
- **Eval = quality judgment.** Soft 0-10 scores via LLM-as-Judge. Always uses LLM. Surfaces gate-brief BLOCKERs that halt phases, plus WARN/INFO advisory signals. Reference: `skills/_eval-template.md`.

### The line between them

Rule of thumb: **if the AI can typically fix the issue by re-reading inputs and trying again, it's QA. If fixing requires substantive design decisions or value judgments, it's eval.**

| Issue | Why | Lives in |
|---|---|---|
| Required section missing | AI re-reads upstream, writes the section | QA |
| Section is empty / placeholder | Same | QA |
| Reviewer-comment table missing rows for [a]–[d] | Same | QA |
| Verdict YAML weights don't sum to 1.0 | Arithmetic; AI normalizes | QA |
| Number consistency (regex same value formatted same way) | Mechanical | QA |
| Archetype declared and matches the enum | Static schema check | QA |
| **Reviewer dispositions are concrete vs hand-waved** | Substantive judgment | Eval |
| **Archetype matches the *spirit*, not just the declaration** | Semantic | Eval |
| **Named downstream consumer is committed vs vague** | Judgment | Eval |
| **Budget covers labor at recruitment-realistic rates** | Domain judgment | Eval |
| **Primary metrics measure goal vs upstream proxy** | Semantic | Eval |

### QA: hard fails, AI-fixable, mostly static

A QA check is a **do-not-pass-go check**. There is no "this is bad but okay to continue" tier in QA — that pattern belongs in eval. When QA fails:

1. Orchestrator attempts automated remediation (regenerate the artifact with explicit instructions to address each failed check, using the `auto_fix_hint` per failure).
2. Re-run QA. If now passing, proceed to eval.
3. If after a bounded number of auto-fix attempts QA still fails, **halt** with `verdict: incomplete` and surface the failed checks + auto-fix hints to the operator. Never silently proceed.

**Tooling.** Static checks (regex, parsing, schema validation, file existence, count thresholds, arithmetic) are preferred. LLM use IS allowed when the check requires semantic interpretation that's still hard-fail-shaped — e.g. "is this section actually about X or just labeled X?" But static is cheaper and more reliable; reach for LLM only when static can't capture the rule.

**QA is necessary but not sufficient.** Orchestrator-level meta-judgment still applies. QA can't be comprehensive; it catches what we know how to check, but the producer (or a human reviewer) may still flag things QA missed. QA passing ≠ artifact is good — it just means the artifact is gradable.

### Eval: soft scores, LLM, quality-only

Eval applies LLM-as-Judge rubrics to grade *quality* dimensions, given QA has confirmed the artifact is structurally correct. Eval:

- **Always** runs LLM-as-judge.
- **Never** re-checks structural concerns QA already covered.
- Produces 0-10 dimension scores + weighted overall.
- Surfaces gate-brief BLOCKERs that halt phases (different from QA hard fails — these are quality concerns severe enough to stop, not structural failures).
- Soft signals (WARN/INFO) inform reviewers but don't auto-halt.
- Can read upstream evals' verdicts as **context** when forming judgments, but should NOT have hardcoded cross-eval cap rules. Each eval stands on its own.

### Coverage rule: every producer has both

- Every producer skill has either a `-qa` companion skill OR an inline QA step.
- Every producer skill has either an `-eval` companion skill OR an inline self-eval.
- QA always runs. Eval gates on QA — if QA fails irrecoverably, eval is skipped (`verdict: incomplete`).
- Producer skills CAN inline both for simple artifacts; the contract is that QA checks are still binary hard fails (vs eval's soft scores) even when inline.

### When the QA work requires runtime

Some artifacts can only be checked by running something — a deployed chatbot must be exercised before structural checks (response received, citation field populated, latency under threshold) can run. In that case, the QA skill exercises the artifact and writes a capture/transcript alongside its QA result. The eval skill reads the capture as input. This is the original "QA captures evidence" pattern; it remains valid for runtime-exercise artifacts. Reference example: `ocs-chatbot-qa` + `ocs-chatbot-eval`.

### Migration

Many existing rubrics mix structural dimensions (e.g. `structural_completeness`, `numbers_present`) with quality dimensions (e.g. `demand_reality`, `mission_alignment`). They're being restructured one at a time. Pattern:

1. Extract structural dimensions to a `-qa` skill (or inline QA step). Convert tier deductions to binary pass/fail with `auto_fix_hint`.
2. Leave quality dimensions in `-eval`. Tighten anchors to span the full 0-10 range now that the rubric isn't anchored by easy-to-pass structural checks.
3. Update artifact paths: `<phase>/<producer>-qa_result.yaml` (new) alongside `<phase>/<producer>-eval_verdict.yaml` (existing).

The `idea-to-pdd-eval` rubric (post-0.13.84) is the next migration target; `ocs-chatbot-qa` + `ocs-chatbot-eval` is the runtime-exercise reference pattern.

### Artifact-path contract

**The rule (one path scheme for all per-run artifacts):**

> Every per-run artifact lives at
> `ACE/<opp-name>/runs/<run-id>/<phase>/<skill>_<artifact>[-<mode>].<ext>`.

Phase folders are `1-design/`, `2-commcare/`, `3-connect/`, `4-ocs/`,
`5-qa-and-training/`, `6-solicitation-management/`,
`7-execution-manager/`, `8-closeout/`. Skills choose the phase that
matches **when the work runs** (so `--monitor` mode for OCS lands
under `7-execution-manager/`, not `4-ocs/`, because monitoring is
Phase 8 work). The canonical inventory is in `lib/artifact-manifest.ts`
— that file is the source of truth when prose and code drift.

**No opp-level `qa-captures/`, `verdicts/`, `eval-reports/`,
`gate-briefs/`, `scorecards/` directories.** No `YYYY-MM-DD-` filename
prefixes (the run-id encodes time). The single durable exception is
golden-template no-opp runs, which keep
`ACE/golden-template/qa-captures/<dated>.md` because there is no
run-id to slot into — used only by `ocs-chatbot-qa` /
`ocs-chatbot-eval` when invoked without an `opp_name`.

| Purpose | Path | Writer |
|---|---|---|
| Capture / transcript / evidence | `<phase>/<producer>_transcript[-<mode>].md` | `-qa` skill |
| Structured machine-readable verdict | `<phase>/<producer>[-eval]_verdict[-<mode>].yaml` | `-eval` skill (or producer with inline self-eval) |
| Human-readable eval report | `<phase>/<eval-skill>_report[-<mode>].md` | `-eval` skill |
| Rolling monitor trend | `<phase>/<eval-skill>_trend.md` | `-eval` skill (`--monitor` mode only) |
| Gate brief (if this eval gates a phase) | `<phase>/<skill>_gate-brief[-<mode>].md` | `-eval` skill |

Paths are uniform across skills so the umbrella `opp-eval` aggregator
can discover verdicts by walking phase folders without per-skill
knowledge.

**Verdict filename rule.** The segment immediately before `_verdict`
identifies the eval that wrote it. The Workbench / ace-web reader
maps eval names back to producer rows via the eval→producer pairing
declared in each phase agent's frontmatter, not by parsing the
filename. Concrete consequences:

- `-eval` skills include `-eval` in their filename (e.g.
  `1-design/idea-to-pdd-eval_verdict.yaml`).
- Recurring per-step evals append a mode suffix:
  `7-execution-manager/flw-data-review-eval_verdict-monitor.yaml`.
- Skills that self-evaluate inline (no separate `-eval` skill — e.g.
  `app-screenshot-capture`, every per-artifact training skill) write
  `<phase>/<self>_verdict[-<mode>].yaml`.
- Skills that ARE their own registry row (no producer/eval split,
  e.g. `ocs-chatbot-eval`) keep their own name and a mode suffix:
  `4-ocs/ocs-chatbot-eval_verdict-{quick,deep}.yaml`,
  `7-execution-manager/ocs-chatbot-eval_verdict-monitor.yaml`.
- The umbrella `opp-eval` writes into its own subfolder under
  `8-closeout/`:
  `8-closeout/opp-eval/opp-eval_verdict-deep.yaml` (and matching
  scorecard / gate-brief / trend siblings) so re-runs and the
  per-skill verdicts don't collide.

**Wiring.** Per-step `-eval` skills run automatically in `/ace:run` —
each phase agent dispatches the matching eval after each producer skill
completes. See `agents/ace-orchestrator.md § Per-Step Eval Hook`. Use
`/ace:eval --all <opp>` to retroactively run evals over an existing opp.

### Verdict YAML shape

Every `-eval` skill writes the same top-level shape so `opp-eval` can
aggregate verdicts uniformly across skills:

```yaml
skill: <eval-skill-name>       # e.g., ocs-chatbot-eval
target: <what-was-judged>      # e.g., experiment_id, pdd-path
mode: quick | deep | monitor   # or omit if the eval has one mode
ran_at: <ISO timestamp>
capture_path: <phase>/<producer>_transcript[-<mode>].md  # relative to runs/<run-id>/, or "inline-self-eval" if the skill is its own producer

overall_score: 0.0-10.0           # weighted, post-cap
overall_score_pre_cap: 0.0-10.0   # optional; raw weighted mean before any cap binds
verdict: pass | warn | fail | incomplete | partial

# Optional. true if the rubric ran live MCP probes against upstream state
# and confirmed agreement; false if probes were skipped, failed, or N/A.
# When false on a non-degraded artifact, verdict is capped at `partial`.
live_state_verified: true | false

dimensions:
  <dim-name>: { score: 0-10, weight: 0.0-1.0 }
  # weights sum to 1.0

per_item:                      # optional — one entry per judged thing
  - ref: <prompt / row / field>  # canonical item identifier
    score: 0-10
    verdict: pass | warn | fail   # per-item is always graded; no incomplete/partial
    note: <one-line rationale>
  # Each entry MAY include domain-specific fields (e.g., `prompt:` for
  # chatbot evals, `session_id:` for FGD evals). The canonical key is
  # `ref`; aggregators read by `ref` and ignore extras.

auto_surfaced:                 # optional — inputs to the gate brief
  - severity: BLOCKER | WARN | INFO | PLATFORM | DRIFT | INFO-SKIPPED
    message: <one-line>
  # BLOCKER, WARN, INFO are the rubric-deducting tiers (WARN counts toward
  # inflation guards). PLATFORM (defect upstream of the skill), DRIFT
  # (artifact-vs-live-state disagreement), and INFO-SKIPPED (sub-check
  # bypassed for missing input) are diagnostic-only — they document gaps
  # without penalizing skill quality. The producing skill drafts one entry
  # per surfaced concern during judgment. `opp-eval` concatenates these
  # when aggregating verdicts into the run-level brief. If the producing
  # skill has nothing to surface, omit this field (don't write an empty
  # list).

gate:                          # optional — only if this eval gates a phase
  threshold: 0.0-10.0
  disposition: approve | reject | iterate
```

**Verdict tier semantics:**
- `pass` / `warn` / `fail` — graded artifact, defects (or absence) sized by
  the rubric's deductions.
- `incomplete` — structural gap in the artifact prevents grading
  (degraded-mode TBD-MANUAL ids, missing PDD, etc.). Counts as "not gradable"
  in `opp-eval`'s coverage cap, not as a defect.
- `partial` — artifact looks correct on paper but live verification probes
  failed at grading time. Records the text-only score; downstream consumers
  should re-grade when MCP is reachable. Caps overall at 8.5.

Skills may add their own fields below this minimum, but should not rename
or reshape the core keys — the aggregator reads them positionally.
Historical skills used `per_prompt:` for the per-item list; `per_item:`
is canonical as of 0.4.3, with domain-specific subkeys inside each entry
(so a chatbot eval entry can include a `prompt:` field alongside `ref`).

The shape is mirrored in code at `lib/verdict-schema.ts` (Zod schema +
`validateVerdict()` helper). Tests live at `test/lib/verdict-schema.test.ts`.
Skill prompts cannot import the schema at runtime, but `opp-eval` and
external tooling can validate verdicts before aggregation; the schema is
the source of truth if this prose drifts.

### Canonical examples

- `skills/ocs-chatbot-qa/SKILL.md` + `skills/ocs-chatbot-eval/SKILL.md` —
  the reference qa/eval pair. The qa skill captures a chat transcript
  with structural checks; the eval skill grades across 4 weighted
  dimensions and writes the Phase 4 gate brief.
- `skills/idea-to-pdd/SKILL.md` — a skill with inline self-eval (no
  separate `-eval` skill). The 5-question stress-test rubric runs inside
  the skill as a self-check before writing the PDD.
- `skills/opp-eval/SKILL.md` — the canonical **umbrella eval**. Distinct
  from a per-skill `-eval`: it does not grade any individual artifact
  itself, it walks every phase folder under `runs/<run-id>/` collecting
  `*_verdict*.yaml` files for an opportunity and rolls them into a
  run-level scorecard across 7 skill-category dimensions plus
  improvement recommendations. Ad-hoc, not gate-bound. As more
  per-skill `-eval` skills gain rubrics and start writing verdicts,
  opp-eval automatically picks them up.

## Long-running skills — no fake background tasks

If a skill's work loop runs for more than ~30 seconds (chat suites,
multi-form mobile recipes, multi-build releases, multi-page screenshot
captures), it must follow the long-running-skill contract from
`agents/ace-orchestrator.md § Long-Running Skills — No Fake Background
Tasks`. Concretely:

1. **Add a `## Wall-Clock Budget` section** declaring per-unit and
   suite-level caps. Track elapsed with `date +%s` checkpoints.
2. **Add a liveness probe** as the first step inside `## Process`
   (after credential resolution). One cheap (<5s) call against the
   upstream service. Fail loud if it doesn't respond — don't burn
   budget on a dead session.
3. **Write artifacts incrementally.** Every captured unit (prompt,
   form, screenshot) lands in the artifact file as it completes,
   typically via `drive_update_file` with `ifMatchRevisionId`
   (revision-CAS, available since 0.11.3). "Build everything in
   memory and flush at the end" is banned — a mid-loop kill loses
   the work.
4. **Resume from partial.** First step inside `## Process` (after
   liveness) reads any existing artifact and skips already-completed
   units. Re-running the skill is idempotent.
5. **Three-strike circuit breaker.** Three consecutive unit failures
   (timeout, error response) abort the suite. Burning the rest of
   the budget produces noise.
6. **Heartbeat `run_state.yaml`.** Write `<step>: in_progress` with a
   fresh `last_actor_at` BEFORE work, `done` AFTER. Resume agents
   treat `in_progress` + `last_actor_at` > 15 min as dead (see
   `agents/ace-orchestrator.md § State-as-canary contract`).
7. **No `ScheduleWakeup` from inside a phase-internal skill.** That
   primitive defers the agent without backgrounding the work. It's
   reserved for cron-recurring skills (`timeline-monitor`,
   `flw-data-review`, `ocs-chatbot-qa --monitor`) — never for
   foreground sequential work.

**Canonical example:** `skills/ocs-chatbot-qa/SKILL.md`. See its
`## Wall-Clock Budget` section and the Process steps for liveness
probe (Step 2), resume-from-partial (Step 3), incremental writes
(Step 5), and metadata-only flush (Step 7).

This convention landed in 0.11.6 after the `turmeric-20260503-0835`
deep capture stalled for 3+ hours on a fictional background task and
produced no recoverable transcript.

## How the PDD `## Evidence Model` flows through skills

The PDD template (`templates/pdd-template.md`) declares an `## Evidence Model` section with three layers:

- **Layer A — Delivery proof** (the thing happened): drives **verification rules** in `connect-opp-setup` and **structural pass criteria** in `app-test-cases`. Hard gates.
- **Layer B — Content proof** (it was done properly): drives **per-journey UX pass criteria** in `pdd-to-app-journeys` / `app-ux-eval` and **per-delivery review** in `flw-data-review`. Soft flags.
- **Layer C — Cross-delivery quality** (the data is useful): drives **cross-delivery synthesis** in `flw-data-review` and **Intervention Effectiveness / Research Quality grading** in `cycle-grade`. Soft flags.

If you're writing a skill that sets up verification, runs tests, reviews data, or grades quality, you almost certainly want to read the Evidence Model in your skill's first or second process step and use it as the spec rather than re-deriving from the PDD body. **If the PDD has no Evidence Model section, fail loudly** — that's a sign `idea-to-pdd` skipped or short-circuited the stress-test rubric and the PDD shouldn't be propagating.

## How to register a new archetype

The 3 current archetypes are `atomic-visit`, `focus-group`, and `multi-stage`. Adding a new archetype is a framework-level change that touches ~3 places:

1. **`templates/pdd-template.md`** — add the new archetype to the `Archetype:` enum description and to the archetype-guidance block at the top of the template.
2. **`skills/idea-to-pdd/SKILL.md`** — add a `### <new-archetype>` subheading inside `## Archetypes` describing the additional questions to ask in step 3 and the archetype-specific sections to draft in step 4.
3. **The 8 other archetype-aware skills** (`pdd-to-test-prompts`, `pdd-to-app-journeys`, `pdd-to-learn-app`, `pdd-to-deliver-app`, `connect-opp-setup`, `llo-invite`, `flw-data-review`, `cycle-grade`) — add a `### <new-archetype>` subheading inside `## Archetypes` describing how the skill behaves for the new archetype.

Do **not** create a new skill per archetype. The whole point of the archetype mechanism is to avoid forking the framework — a new archetype is an additive change inside the existing 9 skills, not a fan-out of new skill files. (See Lesson 9 of the canopy `product-management` skill: *"Framework changes mean variation points, not new components."*)

After adding a new archetype, add a regression fixture under `test/fixtures/` (mirror the structure of `CRISPR-Test-001` for `atomic-visit` and `CRISPR-Test-002` for `focus-group`).

## Where shared templates and prompts live

- `templates/` — PDD templates, email templates, training collateral templates. Read by skills that need a starting structure to populate.
- `playbook/integrations/` — integration specs (Connect, CommCare, OCS, Nova) that document what's available, what's needed, and what manual workaround applies. Skills read these to know what APIs they can call.
- `test/fixtures/` — synthetic opportunity fixtures for regression-testing skills. Each fixture has a README documenting expected per-skill behavior.

Don't put shared prompt fragments in `skills/<skill-name>/`. If a fragment is shared, it belongs at the project root level (e.g., a `templates/` or `prompts/` directory at the repo root). Inline what's specific to one skill.

## Worked examples

When in doubt, copy from the closest existing skill:

- **`skills/idea-to-pdd/SKILL.md`** — canonical example of `## LLM-as-Judge Rubric` (the 5-question stress-test rubric with calibrated grading anchors) and `## Archetypes` (3 archetypes with required-section additions).
- **`skills/connect-opp-setup/SKILL.md`** — canonical example of an Evidence-Model-consuming skill (reads Layer A in step 2, errors if missing) with archetype branching and a Current Workaround block.
- **`skills/cycle-grade/SKILL.md`** — canonical example of archetype branching that adds a 7th grading dimension (`Research Quality`) for one specific archetype.
- **`skills/llo-onboarding/SKILL.md`** — canonical example of a simple skill with no archetype branching and no Evidence Model consumption.

## Generated documentation

`docs/generated/playbook.md` is generated from agent + skill definitions by the `/ace:docs` slash command. It pulls the `description:` frontmatter field of each SKILL.md verbatim, so the description is what the team and downstream consumers actually read. After non-trivial skill edits — especially edits to the description, the process, or the addition of `## Archetypes` / `## Evidence Model` consumption — re-run `/ace:docs` to refresh the playbook.

## Checklist for a new skill

Before committing a new SKILL.md, verify:

- [ ] Directory name matches frontmatter `name`
- [ ] Frontmatter has `name:`, `description:`, `disable-model-invocation: true` (omit only with explicit justification)
- [ ] Description ≤200 chars (target ~120), follows `<verb> <object>. Use when <condition>.` format
- [ ] Description does NOT contain banned patterns (phase labels, file paths, sibling/successor refs, `TEMPORARY`/`Provisional`, trigger-phrase enumeration)
- [ ] All seven required sections present in order: `# <Display Name>` → `## Inputs` → `## Outputs` → `## Process` → `## MCP Tools Used` → `## Mode Behavior` → `## Change Log`
- [ ] Process steps are numbered sequentially (`grep -nE '^[0-9]+\.' SKILL.md`)
- [ ] If the skill is in the `*-eval` / `training-*` / `solicitation-*` family, the body references `skills/_eval-template.md` / `_training-template.md` / `_solicitation-template.md` for shared contracts instead of inlining them
- [ ] If the skill branches on PDD archetype, `## Archetypes` is present with all 3 archetypes covered
- [ ] If the skill writes a `<skill>_gate-brief[-<mode>].md` artifact (one of the 5 phase gates), `## Gate Brief` is present, placed after `## LLM-as-Judge Rubric` (if any) and before `## Archetypes`/`## MCP Tools Used`
- [ ] If the skill consumes the PDD's Evidence Model, an explicit early process step reads it and errors if missing
- [ ] If the skill has external side effects, `## Dry-Run Behavior` is present
- [ ] If the skill is blocked on un-built APIs, `## Current Workaround` is present (and gets removed when the API ships)
- [ ] Initial change log entry exists with the date and author
- [ ] If the skill is archetype-aware and a focus-group fixture exists, the `test/fixtures/CRISPR-Test-002/README.md` regression spec covers it

## Checklist for editing an existing skill

- [ ] Step numbering verified after any insertion (`grep -nE '^[0-9]+\.' SKILL.md`)
- [ ] Change log appended with date, change description, author/context
- [ ] If you changed the `description:` frontmatter or the Process, plan to re-run `/ace:docs`
- [ ] If you changed archetype branching, dry-run the affected fixtures (`CRISPR-Test-001` for atomic-visit, `CRISPR-Test-002` for focus-group) and update fixture READMEs if behavior expectations changed
- [ ] If you added a new MCP tool dependency, mark it as built or "NOT YET BUILT" with the ticket number
