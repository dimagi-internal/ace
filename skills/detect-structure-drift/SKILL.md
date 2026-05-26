---
name: detect-structure-drift
description: >
  Audit the ACE plugin's internal structure for drift between the three
  sources of truth — agent frontmatter, lib/artifact-manifest.ts, and
  agents/orchestrator-reference.md § State Schema. Reports unclaimed
  manifest producers, orphan SKILL.md directories, missing skill files,
  phase-vocab mismatches, and state-schema parity gaps.
disable-model-invocation: true
---

# detect-structure-drift

The ACE plugin's lifecycle is described in three machine-or-human-readable places that should agree but can drift:

1. **Agent frontmatter** — `agents/<phase-agent>.md` YAML headers. Each phase agent declares `phase`, `phase_ordinal`, `phase_display`, and ordered `skills:` + `recurring_skills:` + `manual_skills:` arrays with nested `qa_skill:`, `eval_skill:`, `has_judge:` properties. This is the structural spine — `apps/system/reader.py` in ace-web parses this for the /system page. (`manual_skills:` is the HITL track — e.g. `solicitation-review` in `solicitation-management.md`. Treat its entries as phase-claimed for every check.)
2. **`lib/artifact-manifest.ts`** — every artifact a run writes to Drive, with `producedBy: <skill-or-agent>` + `phase: <name>`. The execution roster: the broadest enumeration of skills that actually do work in `/ace:run`.
3. **`agents/orchestrator-reference.md` § State Schema** — prose `run_state.yaml` template showing per-phase skill ordering. Human-curated documentation that the orchestrator writes against.

This skill compares them and surfaces drift. It is read-only and idempotent.

## Inputs

- `$CLAUDE_PLUGIN_ROOT` — the ACE plugin install root (Claude Code sets this when invoking plugin commands; fall back to the cwd if unset and the user invoked from a checkout).
- Optional first arg `--strict` — fail loudly (annotate `EXIT STATUS: 1` at the bottom of the report) if any check produces a FAIL. Default is report-only.

## Process

### Step 1: Resolve plugin root

Determine `$PLUGIN_ROOT`. If `$CLAUDE_PLUGIN_ROOT` is set, use it. Else walk up from `$PWD` looking for a directory containing both `agents/` and `skills/` and `lib/artifact-manifest.ts`. If neither resolves, abort with "Cannot find ACE plugin root; set CLAUDE_PLUGIN_ROOT or run from a checkout."

### Step 2: Read the three sources

Issue these reads in parallel so all the content is in context for cross-checks:

- Every file matching `$PLUGIN_ROOT/agents/*.md` — Read each. Parse the YAML frontmatter (between the first two `---` lines). Collect for every agent: `name`, `phase`, `phase_ordinal`, `phase_display`, `skills` (list of objects), `recurring_skills` (list of objects), `manual_skills` (list of objects). **Skip `agents/orchestrator-reference.md`** — it's the state-schema source for Check E, not an agent (it has an empty frontmatter block). Agents without a `phase:` field are non-phase agents — currently `ace-orchestrator`, `ocs-tester`, `sweep`. Non-phase agents that DO have a `skills:` array (e.g. `ocs-tester` re-claiming `ocs-chatbot-qa`/`ocs-chatbot-eval`) still contribute their names to the `phase_claimed` set for Check C purposes — those skills are reachable via that agent.
- `$PLUGIN_ROOT/lib/artifact-manifest.ts` — Read. Extract:
  - The `export const PHASES = [...]` array (the canonical phase vocab).
  - Every `producedBy: '<name>'` occurrence with its surrounding `phase: '<name>'` value. Build `manifest_producers: Map<producer_name, set<phase>>`.
- `$PLUGIN_ROOT/lib/artifact-manifest-roles.ts` — Read. Extract `PHASE_FOLDERS` keys.
- `$PLUGIN_ROOT/agents/orchestrator-reference.md` — Read. Find the **first** `phases:` YAML block (the State Schema section starting around line 44). For each `<phase>:` heading and its child `<skill>: <status>` lines, collect `state_schema: Map<phase_name, list[skill_name]>`. Stop at the first non-indented line after the block.
- Use Glob (or `ls` via Bash) on `$PLUGIN_ROOT/skills/*/SKILL.md` to enumerate every SKILL.md directory. Record the set `skill_dirs`.

### Step 3: Build the canonical phase spine

Sort agents that have a `phase_ordinal` by ordinal. Emit the phase spine table:

```
PHASE SPINE (agent frontmatter):
  ordinal  phase                          phase_display                        agent
  -------  -----------------------------  -----------------------------------  -----------------------------
  1        idea-to-design                 Idea to Design                       idea-to-design
  2        scenarios-and-acceptance       Scenarios & Acceptance Planning      scenarios-and-acceptance
  ...
  10       closeout                       Closeout                             closeout

NON-PHASE AGENTS:
  ace-orchestrator, orchestrator-reference, ocs-tester, sweep
```

### Step 4: Run the drift checks

**Check A — Skill claims have backing files.** For every name referenced from agent frontmatter (the entry's `name`, plus `qa_skill`, plus `eval_skill` when present, across `skills:` + `recurring_skills:` + `manual_skills:`), assert `$PLUGIN_ROOT/skills/<name>/SKILL.md` exists. A missing file is a FAIL. Format:

```
A — Skill claims have backing files
  PASS — all <N> claimed skills have SKILL.md
  -- or --
  FAIL — idea-to-pdd-qa: claimed by idea-to-design (as qa_skill of idea-to-pdd) but skills/idea-to-pdd-qa/SKILL.md does not exist
```

**Check B — Manifest producers are claimed.** For every distinct `producedBy:` value in the manifest:

  - Skip the literal string `'external'` (human-provided inputs).
  - **INFO-mark any `producedBy:` value that equals the name of a phase agent from the spine OR the name of a non-phase agent (`ace-orchestrator`, `ocs-tester`, `sweep`).** These are bookkeeping artifacts owned by the agent itself, not by a skill — don't flag them as unclaimed.
  - For every remaining producer, assert it appears in *some* agent frontmatter — either as a top-level `skills[].name` / `recurring_skills[].name` / `manual_skills[].name`, or as a nested `qa_skill:` / `eval_skill:` value. Unclaimed = WARN. Format:

```
B — Manifest producers are claimed
  WARN — decisions-render: produces artifacts in phase 'design' but no agent frontmatter claims it
  INFO — ace-orchestrator: agent-owned bookkeeping artifact (run-readme, etc.)
```

**Check C — SKILL.md directories are reachable.** For every directory in `skill_dirs`, classify it. Order matters — apply the first rule that matches:

  - **Phase-claimed** if it appears as `name` in some agent's `skills` / `recurring_skills` / `manual_skills`.
  - **Judge-claimed** if it appears as `qa_skill` or `eval_skill` in some agent's frontmatter.
  - **Manifest-only** if it appears only as a `producedBy:` in `artifact-manifest.ts`.
  - **Command-claimed** if some `commands/*.md` body references `Skill(<name>)` or `/ace:<name>` — these are slash-command-invoked utility skills (e.g. `sweep-*`, `fork-run`, `upload-transcript`, `interview-*`, `video-from-program-page`).
  - **Sweep-claimed** if `agents/sweep.md` body names the skill as a dispatch target (the sweep umbrella dispatches its system-specific children inline).
  - **Orphan** otherwise.

Print each non-phase-claimed group explicitly. Orphans are WARN; manifest-only, command-claimed, and sweep-claimed are INFO. The point of the three INFO buckets is to distinguish *why* a skill isn't in the agent frontmatter — it tells the operator whether the gap is benign:

```
C — SKILL.md directories are reachable
  PASS — <N> total, <P> phase-claimed, <J> judge-claimed
  INFO — manifest-only (run by phase but not in agent frontmatter): decisions-render, eval-calibration, ...
  INFO — command-claimed (invoked via /ace:<X>): fork-run, upload-transcript, interview-*, ...
  INFO — sweep-claimed (dispatched by agents/sweep.md): sweep-drive, sweep-connect, ...
  WARN — orphan (no agent, no manifest, no command, no sweep ref): skills/<name>/, ...
```

**Check D — Phase vocab consistency.** Build three sets:

  - `agent_phases` = set of `phase:` values across all phase agents.
  - `manifest_phases` = `PHASES` array from `lib/artifact-manifest.ts`.
  - `folder_phases` = keys of `PHASE_FOLDERS` from `lib/artifact-manifest-roles.ts`.

They should all be equal modulo a closed set of intentional aliases. The manifest uses short folder-prefix-stem names; the agent uses full phase ids. The allowlist is:

```
ALLOWLISTED_ALIASES = {   # (manifest_phase, agent_phase) pairs — mirror lib/artifact-manifest-roles.ts § PHASE_FOLDERS
  ('design',                       'idea-to-design'),
  ('scenarios-and-acceptance',     'scenarios-and-acceptance'),
  ('commcare',                     'commcare-setup'),
  ('connect',                      'connect-setup'),
  ('ocs',                          'ocs-setup'),
  ('qa-and-training',              'qa-and-training'),
  ('synthetic-data-and-workflows', 'synthetic-data-and-workflows'),
  ('solicitation-management',      'solicitation-management'),
  ('execution-management',         'execution-management'),
  ('closeout',                     'closeout'),
}
```

Treat the manifest and agent vocabularies as equal under this mapping. Flag any phase that doesn't pair under the allowlist as FAIL. If a new phase is added in the future, extend the allowlist here with a one-line comment explaining why — don't loosen the check.

```
D — Phase vocab consistency
  PASS — all <N> phases pair under the allowlist
  -- or --
  FAIL — phase 'foo' present in artifact-manifest.ts but no agent-phase pairs with it
```

**Check E — State-schema parity.** For each `<phase>:` in `state_schema` from `orchestrator-reference.md`:

  - Assert `<phase>` appears in `agent_phases`. Missing = FAIL.
  - For each `<skill>:` child line under it, **strip any trailing `-quick`, `-monitor`, or `-deep` suffix before lookup** — these are step-disambiguation tags (Phase 5 vs Phase 9 vs `/ace:qa-deep` invocations of the same underlying skill). Then assert the stripped name appears either as a `name` or `qa_skill` or `eval_skill` somewhere in agent frontmatter, OR as a `producedBy:` in the manifest. Unclaimed step = WARN (likely the prose drifted from the structural sources).

Conversely, for each agent's `skills[].name`, assert it appears (with or without the suffix) under the matching `<phase>:` block in the state schema. Skill missing from the state schema = WARN.

**Whole-phase missing from state schema = FAIL, not WARN** — that's a missing template stanza, not prose drift. Surface it as its own bullet at the top of Check E output, separate from per-step warnings.

```
E — State-schema parity (orchestrator-reference.md § State Schema)
  PASS — all <N> documented steps map to known skills
  WARN — orchestrator-reference lists 'foo' under 'qa-and-training' but no agent or manifest claims it
  WARN — agent 'qa-and-training' claims skill 'bar' but it's missing from the state schema
```

### Step 5: Render the report

Print to stdout in this order:

1. Header line: `# detect-structure-drift @ <PLUGIN_ROOT> — VERSION <X.Y.Z>` (read `VERSION` file).
2. Phase spine table (Step 3).
3. Each check (A-E) as its own section in order. Within each section, print the result line first (PASS/WARN/FAIL summary), then any detail rows.
4. Counts footer: `Findings: <FAIL> FAIL, <WARN> WARN, <INFO> INFO across <C> checks`.
5. If `--strict` was passed AND any FAIL was reported: append `EXIT STATUS: 1`. Else `EXIT STATUS: 0`.

The report is the only side-effect. **Do not** modify any file. **Do not** propose fixes inline — the operator decides whether each drift is a bug or an intentional gap (e.g. a manifest-only utility skill might be deliberate cross-phase plumbing).

## When to use

- **Before a release** — catches the case where a SKILL.md was deleted but its `qa_skill:` reference in an agent wasn't (FAIL on Check A).
- **After adding a new skill** — verifies the skill is claimed somewhere visible (Check C makes the choice explicit: phase, judge, manifest-only, or orphan).
- **After renaming a phase** — Check D catches alias drift across the three files.
- **Investigating "why is skill X showing in Utility Skills on /system?"** — Check C's manifest-only and orphan groups answer it directly.

## Out of scope

- **Cross-repo checks.** This skill audits the ACE plugin only. Whether `ace-web`'s `apps/system/reader.py` displays the structure correctly is a separate concern (the reader currently drops nested `qa_skill:` / `eval_skill:` from the phase display, which is why some skills look "missing from phases" on `/system`). If you want to audit ace-web's rendering, write a sibling skill there.
- **Eval-grade contents of SKILL.md.** This skill doesn't grade prompt quality, only structural references.
- **Mechanical fixes.** No auto-rewrites. The output is for a human (or a follow-up skill) to act on.

## Implementation notes for agents

- The artifact manifest is ~1290 lines but uniform. A regex over the source — `/producedBy:\s*'([^']+)'/g` — is sufficient; do not try to parse it as TypeScript. Pair each match with the nearest `phase: '...'` on the same `{...}` block by scanning backwards from the match position.
- For the orchestrator-reference State Schema block, anchor on the **first** occurrence of `^phases:$` and read until the next blank line followed by a non-indented heading or fence. There are multiple `phases:` blocks in the file (currently at lines 44, 501, 801) — the first is `run_state.yaml`'s schema; the others are inline examples for `decisions.yaml` etc. Always use the first.
- When parsing agent frontmatter inline-flow objects (e.g. `- { name: foo, has_judge: true, qa_skill: foo-qa }`), find the closing `}` via brace-depth counting first, then split the inside on top-level commas. Trailing `#` line comments after the closing `}` (e.g. `} # canopy:walkthrough scores per scene`) must be discarded — they appear after several entries in `synthetic-data-and-workflows.md` and `scenarios-and-acceptance.md`. Values may have arbitrary horizontal whitespace before them (column-aligned style varies file-to-file).
- The phase-name allowlist for Check D (the manifest⇄agent alias set) is the ONLY substitution table. If a new phase is added, extend `ALLOWLISTED_ALIASES` above with a one-line comment explaining why — don't loosen the check.
- Run all Reads in parallel where possible; the audit should complete in under a few seconds even with 100+ skill dirs.

## Related

- `apps/system/reader.py` (in `ace-web`) — the parser that produces the /system page. Currently does NOT promote nested `qa_skill:` / `eval_skill:` entries into phase rows for display; they fall to "Utility Skills." This skill makes that gap visible via Check C's manifest-only and judge-claimed groupings.
- `lib/artifact-manifest.ts` § header comment — names this skill's #2 source-of-truth explicitly: "single source of truth for ... which skill produces each artifact."
- `agents/orchestrator-reference.md` § State Schema — the human-curated `run_state.yaml` template that Check E grades against.
