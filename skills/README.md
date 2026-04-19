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

`<skill-name>` is kebab-case and matches the `name:` frontmatter field exactly. Multi-word names use single hyphens, not underscores. Names should be verbs or verb phrases ("idea-to-pdd", "app-test", "llo-onboarding"), not nouns.

If a skill needs supporting files (templates, scripts, prompt fragments), they go alongside `SKILL.md` in the same directory.

## Required frontmatter

Every SKILL.md begins with YAML frontmatter:

```markdown
---
name: <skill-name>
description: >
  One-to-three-sentence description of what the skill does. This is what
  /ace:docs renders into the generated playbook, so it must be readable
  in isolation. Lead with the verb. Mention key inputs and outputs.
---
```

- **`name`** (required) — must match the directory name
- **`description`** (required) — readable standalone, 1–3 sentences, leads with the verb. The generated playbook (`docs/generated/playbook.md`) renders this verbatim, so it should be self-contained.

No other frontmatter fields are required. Don't add `version:`, `author:`, or similar — git is the source of truth for authorship and history.

## Required sections

Every SKILL.md must have these sections, in this order:

### 1. `# <Skill Display Name>` (h1)

The h1 is the human-readable display name (e.g., "Idea to PDD"), not the kebab-case `name`. One short paragraph after the h1 restates the skill's purpose in plain language for someone who hasn't read the frontmatter.

### 2. `## Process`

A numbered list of steps the skill executes. Each step is a single imperative sentence in **bold**, optionally followed by a sub-bulleted breakdown of what the step entails. Steps should be sequential and the numbering must be sequential — if you insert a step in the middle of the list, renumber every step after it. Use `grep -nE '^[0-9]+\.' SKILL.md` to verify after edits.

If the skill reads from the PDD's `archetype:` and/or `## Evidence Model` section, that read should be an explicit early step. Don't bury it in prose — it's load-bearing for downstream behavior.

### 3. `## MCP Tools Used`

A bullet list of MCP tools the skill calls, grouped by server. For each tool, indicate whether it's built or "NOT YET BUILT" (with the relevant ticket number when applicable). Example:

```markdown
## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_update_file`
- Connect: `create_opportunity`, `set_verification_rules` — **NOT YET BUILT** (CCC-301)
```

### 4. `## Mode Behavior`

How the skill behaves in **Auto** vs **Review** mode. One bullet per mode. Both modes execute the same steps; only the gating and human-handoff differs.

```markdown
## Mode Behavior
- **Auto:** <action>, notify admin group, proceed
- **Review:** <action>, present for human approval, wait
```

### 5. `## Change Log`

A markdown table of dated changes. Append at the bottom on every non-trivial edit. Don't delete history. Format:

```markdown
## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-08 | <description of change> | <author or context> |
```

Trivial typo fixes don't need a change log entry; behavior changes do. When in doubt, append.

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

The 7 archetype-aware skills today are: `idea-to-pdd`, `pdd-to-learn-app`, `pdd-to-deliver-app`, `app-test`, `connect-opp-setup`, `flw-data-review`, `cycle-grade`.

### `## LLM-as-Judge Rubric` (when the skill self-evaluates or is an eval skill)

Some skills self-evaluate their output before passing it downstream; dedicated `-eval` skills (see `## QA vs Eval — the two-phase pattern` below) exist entirely to apply a rubric. In both cases, when the rubric is non-trivial, factor it out into its own section instead of burying it inside a process step. Place this section **immediately before** `## Archetypes` (if present) or **immediately before** `## MCP Tools Used` (if not).

The rubric should be concrete enough to grade on — bullet points with grading anchors, or a numbered checklist with pass/fail conditions. See `skills/idea-to-pdd/SKILL.md` for the canonical example (the 5-question stress-test rubric with worked anchors from the example PDDs). See `skills/ocs-chatbot-eval/SKILL.md` for the 4-dimension weighted-score pattern that dedicated `-eval` skills follow.

### `## Current Workaround` (when the skill is blocked on un-built APIs)

For skills whose ideal flow depends on APIs that don't exist yet, document the manual fallback. Place this **after** `## MCP Tools Used` and **before** `## Mode Behavior`. The workaround should be a numbered list of human-in-the-loop steps that produce the same external effect.

Many existing skills have these blocks (everything blocked on CCC-301, Nova bot API, OCS MCP, etc.) — they're expected and not tech debt. They get removed once the underlying API ships.

### `## Dry-Run Behavior` (when the skill has external side effects)

Required for any skill that sends emails, publishes apps, creates Jira tickets, or otherwise produces external effects. Document what the skill does instead under `--dry-run`. Place this **after** `## Mode Behavior` and **before** `## Change Log`.

```markdown
## Dry-Run Behavior

When `--dry-run` is active:
- <full-action> is generated normally
- <effectful-action> is written to `comms-log/dry-run-<step>.md` instead of executing
- State tracks as `dry-run-success`
```

See `docs/superpowers/specs/2026-04-01-ace-design.md` § "Testing and Dry-Run Strategy" for the full dry-run model.

## QA vs Eval — the two-phase pattern

Evaluation in ACE splits into two orthogonal phases so evidence can be
captured once and graded many times (including by different rubrics, or
re-graded after a rubric improves without re-exercising the artifact).

**`-qa` skills (capture).** Exercise the artifact and produce structured
evidence. Sometimes the work is mechanical — send a prompt suite and
collect responses (`ocs-chatbot-qa`), read FLW submissions and verify
delivery proof (`flw-data-review`). Sometimes the evidence comes from the
field — FGD audio captured by a facilitator, a sample photo sent by an
FLW. Either way, a `-qa` skill writes a transcript/capture artifact to a
known path and runs cheap structural checks (response received, audio
length ≥ threshold, all required fields present). **`-qa` never runs
LLM-as-Judge.**

**`-eval` skills (judge).** Read a capture artifact, apply an LLM-as-Judge
rubric, and write a machine-readable verdict plus a human-readable report.
Because the evidence is already captured, `-eval` can be re-run anytime
— against the same transcript with an improved rubric, or across many
captures to compute a trend. **`-eval` never exercises the artifact.**

### When to use which

- **Most skills produce their own evidence inline.** The skill writes its
  primary artifact (`pdd.md`, `learn-app.json`, `connect-setup/opportunity.md`)
  and optionally includes a self-eval step (e.g., `idea-to-pdd`'s 5-question
  stress-test rubric). No separate `-qa` or `-eval` skills needed.
- **A standalone `-qa` skill exists when exercising the artifact requires
  runtime work the producing skill didn't do** — chatting with a deployed
  bot, running an app through its UI, facilitating a group session,
  reviewing submitted deliveries. The `-qa` skill writes a capture; the
  `-eval` skill grades it.
- **Avoid `-qa` skills that are just `-eval` under a different name.** If
  nothing runtime is happening between "produce the artifact" and "judge
  it," the producing skill's inline self-eval is the right place.

### Artifact-path contract

Every `-qa` / `-eval` pair writes to these canonical paths under
`ACE/<opp-name>/`. Paths are uniform across skills so the umbrella
`opp-eval` aggregator (future) can discover verdicts without per-skill
knowledge.

| Purpose | Path | Writer |
|---|---|---|
| Capture / transcript / evidence | `qa-captures/YYYY-MM-DD-<slug>.md` | `-qa` skill |
| Structured machine-readable verdict | `verdicts/<skill>-<mode>.yaml` | `-eval` skill |
| Human-readable eval report | `eval-reports/YYYY-MM-DD-<slug>.md` | `-eval` skill |
| Rolling monitor trend | `eval-reports/trend.md` | `-eval` skill (`--monitor` mode only) |
| Gate brief (if this eval gates a phase) | `gate-briefs/<skill>-<mode>.md` | `-eval` skill |

### Verdict YAML shape

Every `-eval` skill writes the same top-level shape so `opp-eval` can
aggregate verdicts uniformly across skills:

```yaml
skill: <eval-skill-name>       # e.g., ocs-chatbot-eval
target: <what-was-judged>      # e.g., experiment_id, pdd-path
mode: quick | deep | monitor   # or omit if the eval has one mode
ran_at: <ISO timestamp>
capture_path: qa-captures/<path>  # or inline-self-eval if the skill is its own producer

overall_score: 0.0-10.0        # weighted
verdict: pass | warn | fail

dimensions:
  <dim-name>: { score: 0-10, weight: 0.0-1.0 }
  # weights sum to 1.0

per_item:                      # optional — one entry per judged thing
  - ref: <prompt / row / field>
    score: 0-10
    verdict: pass | warn | fail
    note: <one-line rationale>

gate:                          # optional — only if this eval gates a phase
  threshold: 0.0-10.0
  disposition: approve | reject | iterate
```

Skills may add their own fields below this minimum, but should not rename
or reshape the core keys — the aggregator reads them positionally.

### Canonical examples

- `skills/ocs-chatbot-qa/SKILL.md` + `skills/ocs-chatbot-eval/SKILL.md` —
  the reference qa/eval pair. The qa skill captures a chat transcript
  with structural checks; the eval skill grades across 4 weighted
  dimensions and writes the Phase 4 gate brief.
- `skills/idea-to-pdd/SKILL.md` — a skill with inline self-eval (no
  separate `-eval` skill). The 5-question stress-test rubric runs inside
  the skill as a self-check before writing the PDD.

## How the PDD `## Evidence Model` flows through skills

The PDD template (`templates/pdd-template.md`) declares an `## Evidence Model` section with three layers:

- **Layer A — Delivery proof** (the thing happened): drives **verification rules** in `connect-opp-setup` and **capture-path tests** in `app-test`. Hard gates.
- **Layer B — Content proof** (it was done properly): drives **content-quality tests** in `app-test` and **per-delivery review** in `flw-data-review`. Soft flags.
- **Layer C — Cross-delivery quality** (the data is useful): drives **cross-delivery synthesis** in `flw-data-review` and **Intervention Effectiveness / Research Quality grading** in `cycle-grade`. Soft flags.

If you're writing a skill that sets up verification, runs tests, reviews data, or grades quality, you almost certainly want to read the Evidence Model in your skill's first or second process step and use it as the spec rather than re-deriving from the PDD body. **If the PDD has no Evidence Model section, fail loudly** — that's a sign `idea-to-pdd` skipped or short-circuited the stress-test rubric and the PDD shouldn't be propagating.

## How to register a new archetype

The 3 current archetypes are `atomic-visit`, `focus-group`, and `multi-stage`. Adding a new archetype is a framework-level change that touches ~3 places:

1. **`templates/pdd-template.md`** — add the new archetype to the `Archetype:` enum description and to the archetype-guidance block at the top of the template.
2. **`skills/idea-to-pdd/SKILL.md`** — add a `### <new-archetype>` subheading inside `## Archetypes` describing the additional questions to ask in step 3 and the archetype-specific sections to draft in step 4.
3. **The 6 other archetype-aware skills** (`pdd-to-learn-app`, `pdd-to-deliver-app`, `app-test`, `connect-opp-setup`, `flw-data-review`, `cycle-grade`) — add a `### <new-archetype>` subheading inside `## Archetypes` describing how the skill behaves for the new archetype.

Do **not** create a new skill per archetype. The whole point of the archetype mechanism is to avoid forking the framework — a new archetype is an additive change inside the existing 7 skills, not a fan-out of new skill files. (See Lesson 9 of the canopy `product-management` skill: *"Framework changes mean variation points, not new components."*)

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
- **`skills/app-test/SKILL.md`** — canonical example of an Evidence-Model-consuming skill with archetype branching but no Current Workaround.
- **`skills/cycle-grade/SKILL.md`** — canonical example of archetype branching that adds a 7th grading dimension (`Research Quality`) for one specific archetype.
- **`skills/llo-onboarding/SKILL.md`** — canonical example of a simple skill with no archetype branching and no Evidence Model consumption.

## Generated documentation

`docs/generated/playbook.md` is generated from agent + skill definitions by the `/ace:docs` slash command. It pulls the `description:` frontmatter field of each SKILL.md verbatim, so the description is what the team and downstream consumers actually read. After non-trivial skill edits — especially edits to the description, the process, or the addition of `## Archetypes` / `## Evidence Model` consumption — re-run `/ace:docs` to refresh the playbook.

## Checklist for a new skill

Before committing a new SKILL.md, verify:

- [ ] Directory name matches frontmatter `name`
- [ ] Frontmatter has `name:` and `description:`; description leads with a verb and is readable in isolation
- [ ] All five required sections present in order: `# <Display Name>` → `## Process` → `## MCP Tools Used` → `## Mode Behavior` → `## Change Log`
- [ ] Process steps are numbered sequentially (`grep -nE '^[0-9]+\.' SKILL.md`)
- [ ] If the skill branches on PDD archetype, `## Archetypes` is present with all 3 archetypes covered
- [ ] If the skill consumes the PDD's Evidence Model, an explicit early process step reads it and errors if missing
- [ ] If the skill has external side effects, `## Dry-Run Behavior` is present
- [ ] If the skill is blocked on un-built APIs, `## Current Workaround` is present
- [ ] Initial change log entry exists with the date and author
- [ ] If the skill is archetype-aware and a focus-group fixture exists, the `test/fixtures/CRISPR-Test-002/README.md` regression spec covers it

## Checklist for editing an existing skill

- [ ] Step numbering verified after any insertion (`grep -nE '^[0-9]+\.' SKILL.md`)
- [ ] Change log appended with date, change description, author/context
- [ ] If you changed the `description:` frontmatter or the Process, plan to re-run `/ace:docs`
- [ ] If you changed archetype branching, dry-run the affected fixtures (`CRISPR-Test-001` for atomic-visit, `CRISPR-Test-002` for focus-group) and update fixture READMEs if behavior expectations changed
- [ ] If you added a new MCP tool dependency, mark it as built or "NOT YET BUILT" with the ticket number
