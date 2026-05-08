# ACE Decisions Log — Design

**Status:** Draft
**Date:** 2026-05-08
**Author:** ACE
**Related:** [`agents/ace-orchestrator.md`](../../../agents/ace-orchestrator.md) (Phase Write-Back Contract, `archive:` block convention), [`skills/idea-to-pdd/SKILL.md`](../../../skills/idea-to-pdd/SKILL.md) (current `open-questions.md` convention), [`skills/idea-to-pdd-eval/SKILL.md`](../../../skills/idea-to-pdd-eval/SKILL.md) (`deferred-decision-discipline` rubric branch, viability axis from PR #144 / #145), [`docs/superpowers/specs/2026-05-08-qa-eval-migration.md`](2026-05-08-qa-eval-migration.md) (concurrent QA/Eval split — sequencing note in § Coordination below), [`skills/_qa-template.md`](../../../skills/_qa-template.md), [`lib/qa-types.ts`](../../../lib/qa-types.ts)

## Problem

ACE phase agents make many load-bearing decisions silently. Phase 1's `idea-to-pdd` self-evaluates against a 5-question stress-test rubric and only emits an `open-questions.md` doc when a dimension grades partial or fail. Clean-source idea inputs (the canonical case for production opps) score 5/5 and emit nothing — even though the same run silently picks an FLW count, a budget plausibility verdict, an AI confidence threshold, a sample size, a payment rate, a verification mechanism, an archetype, a primary metric framing, and so on.

This has three concrete costs:

1. **Reviewers can't audit decisions before approving Phase 8.** The gate brief surfaces stress-test concerns, but not the raft of defaults applied silently. The eval rubric expansion in PR #144 / #145 (`demand_reality`, `resource_realism`, `mission_alignment`, `fallback_validates_primary`) grades on dimensions that are exactly these silent defaults.
2. **Humans can't iterate on Phase 1 design choices without re-authoring `idea.md` from scratch.** The natural loop ("I want 12 FLWs not 8, regenerate the PDD") requires rewriting source material instead of overriding a single choice.
3. **The autopilot path has no record of what it picked.** A successful `/ace:run` produces a PDD and downstream artifacts but no enumerated list of "here's what I decided when no human was around."

The closest existing artifact is the optional `open-questions.md` Google Doc emitted by `idea-to-pdd`. Its 4-column table (`# | Question | Default | Source`) is the right shape but: (a) only fires on rubric failures; (b) only covers Phase 1; (c) renders as plain text in Google Docs (Drive's text/plain import does not parse markdown). The `run_state.yaml.open_questions:` block is a different concept — phase-level skill backlog / unresolved tickets, not human-facing decisions.

## Goal

Introduce **`decisions.yaml`** as the per-run, structured record of every load-bearing default an ACE phase applies. Every phase appends rows when it picks a default. The doc is the surface for Phase 1 iteration ("edit a default, re-run, get a different PDD") and the audit trail for Phase 8 review ("what did the AI decide silently?").

The data model is the source of truth. Renderings (Google Doc, Sheet, ace-web view) are derived artifacts that can be iterated independently. v1 ships a single prose Google Doc renderer — the user-preferred surface for in-Drive review.

**Non-goals:**

- A new mid-run pause mode. Default `/ace:run` behaviour stays autopilot: AI picks defaults, ships PDD + downstream phases, never blocks on missing human input. Review mode (existing) is the place for explicit pauses.
- Auto-syncing edits to the rendering on `/ace:run` start. v1 round-trip is an explicit `/ace:step decisions-sync` call between runs. v2 can fold the sync into `/ace:run` after the v1 contract proves stable.
- Re-anchoring the `idea-to-pdd-eval` rubric's `deferred-decision-discipline` branch onto `decisions.yaml`. Tracked as a follow-up; out of scope for v1.
- ace-web rendering. The schema is shaped for it (per-row stable IDs, status enum, source citation) but the rendering itself is later.

## Architecture

### Source of truth: `decisions.yaml`

Sits next to `run_state.yaml` in `ACE/<opp>/runs/<run-id>/`. Same write pattern, same Phase Write-Back Contract enforcement:

```
ACE/<opp>/runs/<run-id>/
  run_state.yaml              ← phase status, gates, backlog (existing)
  decisions.yaml              ← NEW: structured decisions log
  inputs-manifest.yaml
  1-design/
  2-commcare/
  ...
```

Sibling file rather than a `decisions:` block inside `run_state.yaml`: `run_state.yaml` is already busy with `phases.<phase>.{status, verdict, completed_at, summary_artifact, steps}`, `gates.<gate>`, `open_questions:`, `archive:`, `phase_X_backlog:`. Decisions are a *log*, not state — different lifecycle, different consumers (human-facing renderings vs. orchestrator state machine), different eval-rubric attachment points. Mixing them complicates the schema and forces every consumer to filter.

### Schema

```yaml
schema_version: 1
opportunity: turmeric
run_id: 20260507-1733
generated_at: 2026-05-07T17:33:00Z

decisions:
  - id: flw-count                          # stable across re-runs; kebab-case
    phase: 1-design                        # which phase wrote this row
    skill: idea-to-pdd                     # which skill, for audit
    question: How many FLWs should the program target?
    default: "5–8"                         # currently elected value
    options_considered:                    # the menu the human picks from
      - "3–5"
      - "10–15"
      - "20+"
    source: idea.md §2; atomic-visit archetype norm
    status: applied                        # applied | overridden | open
    notes: |                               # free-form rationale, optional
      Atomic-visit norm at this geographic scope.

  - id: ai-photo-threshold
    phase: 1-design
    skill: idea-to-pdd
    question: AI auto-accept confidence threshold?
    default: "≥90%"
    options_considered: ["≥85%", "≥95%"]
    source: stress-test verifiability dimension
    status: applied

  - id: named-downstream-consumer
    phase: 1-design
    skill: idea-to-pdd
    question: Is there a named downstream consumer with pre-committed action?
    default: "none-named-proceed-with-caveat"
    options_considered:
      - "named-consumer-with-MOU"
      - "named-consumer-no-MOU"
      - "none-named-proceed-with-caveat"
      - "none-named-halt"
    source: idea-to-pdd-eval `demand_reality` dimension (PR #144)
    status: open                           # load-bearing; flag in gate brief
    notes: |
      No consumer named in idea.md. Proceeding with default;
      flag in gate brief. Human edit recommended.
```

Field semantics:

- **`id`** — stable across re-runs of the same opp, used for sync-back. Kebab-case, namespaced by phase prefix only when ambiguous (e.g. `phase-3-payment-unit-shape`). Skills MUST NOT regenerate IDs on re-runs — the round-trip mechanic depends on stable IDs.
- **`phase`** — `<N>-<name>`, matches the run-folder convention (`1-design`, `2-commcare`, etc.).
- **`skill`** — name of the writing skill. For audit; not used for routing.
- **`question`** — one specific question per row, no compounds.
- **`default`** — the AI's currently-elected value. The human edits this in the rendering when overriding.
- **`options_considered`** — the menu. The human can pick from this list or write a value not in the list (renderer parses both). Including the default in `options_considered` is allowed but not required.
- **`source`** — specific citation. `idea.md §X`, `<eval-skill> <dimension> dimension`, `archetype default`, `<MCP atom> default`. No vague "research" or "common practice."
- **`status`** — enum: `applied` (default in use, not overridden), `overridden` (human edited), `open` (load-bearing decision the AI flagged for human attention; processed forward with the listed default but surfaced in gate brief). v1 does not include `resolved` or `superseded` — premature.
- **`notes`** — optional free-form rationale. Renderer formats as italicized paragraph.

### Scope — what counts as a row

Two filters, both must be true:

1. **Load-bearing.** A reasonable person could pick differently AND it materially shapes downstream phases or eval scores.
2. **Maps to a known surface.** The default ties to one of: an `*-eval` rubric dimension, an `*-qa` structural check (post-PR #146 split), a Phase Write-Back field that downstream phases read, or a numeric/named-entity surfaced in the PDD.

Rough row-count budget per phase (final calibration is the first sub-project of implementation — read turmeric run `20260507-1733` artifacts to ground each row in evidence):

| Phase | Rows | Examples |
|---|---|---|
| 1 design | 10–15 | FLW count, archetype confirmation, budget plausibility, named downstream consumer, AI threshold, sample size, payment rate, verification mechanism, language, primary metric vs goal, fallback design, solicitation defaults |
| 2 commcare | 3–5 | one-form-per-module workaround, deliver unit count, multimedia coverage strategy |
| 3 connect | 3–5 | verification flags, payment unit shape, opportunity name pattern, end date |
| 4 ocs | 2–3 | system prompt baseline, RAG collection contents, test-prompt count |
| 5 qa | 3–5 | walkthrough scenarios, training-deck sections, training audience |
| 6 synthetic | 2–3 | persona count, scenario count, narrative arc |
| 7 solicitation | 3–4 | solicitation type (EOI/RFP), deadline, candidate LLO list |
| 8 execution | 2–3 | UAT depth, go-live cutoff, monitoring cadence |
| **Total** | **~30–50** | mostly Phase 1 |

Form-field-level choices, Connect program slugs, email copy, font sizes — below the bar. They live in code or skill defaults, not the decisions log.

### Rendering — v1: prose Google Doc

The user-preferred surface is a prose Google Doc, not a table or sheet. Tables in Google Docs are unpleasant to interact with; prose with structural headings reads naturally and edits cleanly.

Renderer skill (`decisions-render`) emits `ACE/<opp>/runs/<run-id>/decisions.gdoc` with this shape:

```
Decisions Log — turmeric / run 20260507-1733

Generated 2026-05-07T17:33:00Z. To override a default, edit the
"Default:" line of the relevant decision below. To propose a new
option, add a bullet to "Considered:". Then run
/ace:step decisions-sync turmeric/20260507-1733 to push your edits
back into the run.

────────────────────────────────────────────────

Phase 1 — Design

flw-count
How many FLWs should the program target?

  Default: 5–8
  Considered:
    • 3–5
    • 10–15
    • 20+
  Source: idea.md §2; atomic-visit archetype norm
  Status: applied

  Atomic-visit norm at this geographic scope.

ai-photo-threshold
AI auto-accept confidence threshold?

  Default: ≥90%
  Considered:
    • ≥85%
    • ≥95%
  Source: stress-test verifiability dimension
  Status: applied

named-downstream-consumer
Is there a named downstream consumer with pre-committed action?

  Default: none-named-proceed-with-caveat
  Considered:
    • named-consumer-with-MOU
    • named-consumer-no-MOU
    • none-named-proceed-with-caveat
    • none-named-halt
  Source: idea-to-pdd-eval demand_reality dimension (PR #144)
  Status: OPEN — load-bearing; human edit recommended

  No consumer named in idea.md. Proceeding with default; flag
  in gate brief.

────────────────────────────────────────────────

Phase 2 — CommCare Setup

…
```

**Native Google Docs formatting, not markdown-as-text.** Drive's `text/plain` import path does not parse markdown — `# Heading` renders as literal `# Heading`. The renderer uses the `docs_batch_update` MCP atom (already available in `ace-gdrive`) to apply real Google Docs structural elements:

- "Decisions Log — …" as `HEADING_1`
- "Phase N — …" as `HEADING_2`
- Each decision's `id` as `HEADING_3` (so the doc's outline view in Google Docs surfaces every decision as a navigable anchor)
- The question as bold body text under the heading
- Field labels (`Default:`, `Considered:`, `Source:`, `Status:`) as bold inline runs
- `Considered:` items as native bullet list
- `Status: OPEN` rows highlighted (background color or bold-red text)
- `notes` as italic paragraph at the end of each section

Doc body is built in-memory as a list of `docs_batch_update` requests, then submitted in one batch.

### Rendering — when the renderer runs

- **End of Phase 1** (`idea-to-pdd`): the doc is rendered for the first time. Phase 1 owns the bulk of rows; humans are most likely to want to iterate at this point.
- **End of every subsequent phase**: the renderer re-runs and overwrites the doc, picking up the new rows. Find-or-create semantics on `decisions.gdoc` (existing `drive_create_file` behaviour) means human edits persist in the YAML across re-renders, and the doc stays at one stable URL across the whole run.
- **End of run** (closeout phase): the renderer runs one last time and the doc is the primary artifact a reviewer reads alongside the closeout summary.

### Gate brief integration

Each phase's gate brief gains a `Decisions Log: <url>` line (mirroring the existing `Open Questions: <url>` convention). Below it, the gate brief includes a compact markdown summary filtered to that phase's rows — three columns (Question, Default, Status) so a reviewer doesn't have to leave the brief to scan the phase's decisions.

Rows with `status: open` in the current phase produce `[WARN]` entries in the gate brief's `Auto-Surfaced Concerns` section.

### Round-trip — v1: explicit sync skill

Workflow:

1. Run completes. `decisions.yaml` is the source of truth; `decisions.gdoc` is the rendering.
2. Human opens the gdoc, edits any `Default: <value>` line, optionally adds bullets to `Considered:`.
3. Human runs `/ace:step decisions-sync <opp>/<run-id>`.
4. `decisions-sync` skill reads the gdoc, walks each `HEADING_3` (decision ID), parses the `Default:` and `Considered:` lines, diffs against `decisions.yaml`. For every row where the rendered `Default:` differs from the YAML's `default`:
   - Update YAML's `default` field to the human's value.
   - Append the original AI default to `options_considered` if not already there (so the AI's pick is preserved as a recorded option).
   - Set `status: overridden`.
   - Append a `notes` line: `Overridden 2026-05-08 by human via decisions.gdoc.`
5. New `Considered:` bullets get added to `options_considered`.
6. YAML is rewritten; gdoc is *not* re-rendered (the human's prose edits stay).
7. Next `/ace:run` (or `/ace:step idea-to-pdd`) reads the updated YAML; overridden defaults flow as authoritative inputs into the PDD draft.

The parser is convention-based: it walks structural elements via `docs_get`, finds `HEADING_3` runs (the IDs), reads the paragraphs that follow up to the next `HEADING_3` or `HEADING_2`. Within that block, it greps for `Default:` and `Considered:` line patterns. New bullets without a matching `options_considered` entry are appended.

If the human deletes a row, the parser leaves the YAML row intact and surfaces a warning ("decision X exists in YAML but not in gdoc — keeping YAML row, run not blocked"). Deletes are rare; we don't auto-delete YAML rows from a missing prose section.

If the parser cannot locate a decision's `HEADING_3` ID, the run halts with an actionable error pointing the user at the missing section.

### Phase 1 (`idea-to-pdd`) interaction

The interaction the user said doesn't currently exist becomes:

**Default mode (autopilot):**
1. Read inputs as today.
2. Determine archetype, draft PDD outline mentally.
3. Populate `decisions.yaml` with Phase 1 rows + AI-elected defaults.
4. Draft PDD using the selected defaults.
5. Run `decisions-render` → `decisions.gdoc`.
6. Write PDD + gate brief; gate brief links the gdoc prominently.

The PDD ships in one shot with AI defaults. Reviewer reads the gdoc post-hoc and re-runs `/ace:step idea-to-pdd <opp>/<run-id>` after editing if they want a different PDD. (`/ace:step` re-runs the skill in the same run-id, regenerating the PDD from the updated YAML.)

**Review mode:**
1. Read inputs.
2. Populate `decisions.yaml` with Phase 1 rows + defaults.
3. Run `decisions-render`.
4. Write a Phase 1 *interim* gate brief that says: "Decisions log written. Edit any defaults you want changed, then resume the run."
5. **Pause.**
6. On resume: read the (possibly edited) `decisions.yaml`, draft PDD using those values.
7. Continue to PDD-final gate brief as today.

The pause is opt-in via `--mode review`, consistent with how review mode works elsewhere. Default mode stays full autopilot.

### Phase Write-Back Contract update

Add a clause to `agents/ace-orchestrator.md § Phase Write-Back Contract`:

> Every phase MUST append rows to `decisions.yaml` for any default it applies that meets the load-bearing + maps-to-known-surface bar. Each phase's writing skill is responsible for the rows scoped to that phase. Phase agent verifies post-run that at least one row exists for the phase (warning, not error — some phases legitimately apply no defaults if all inputs are explicit).

Same enforcement style as the existing `phases.<phase>.{status, verdict, …}` contract: stub-fill + warn at the orchestrator level if a phase forgot.

### Eval rubric impact (out of scope, follow-up)

`idea-to-pdd-eval`'s clean-source branch grades `deferred-decision discipline` on the PDD's Open Questions section. Once `decisions.yaml` is the canonical surface, the rubric should re-anchor on the YAML directly: count rows with `status: open`, grade on whether each open row has a load-bearing default vs. silently-deferred to the LLO. Tracked as a follow-up PR after v1 ships and the calibration set is stable.

## Coordination with the QA/Eval migration (PRs #146 / #147 / #148)

PR #146 codified the QA/Eval split principle: structural correctness lives in `*-qa` skills (binary pass/fail, auto-fix), quality judgment stays in `*-eval` (0–10 LLM-as-Judge). PR #147 lays out the migration plan — `idea-to-pdd` is **Phase 1 PR #1** of that migration. PR #148 ships the test scaffolding (`lib/qa-types.ts`, `test/skills/`, `test/calibration/`).

Three coordination points:

1. **Sequencing.** Land our PR #1 (Phase 1 write-side) **after** the QA/Eval migration of `idea-to-pdd` lands. That migration extracts `idea-to-pdd-qa` from `idea-to-pdd-eval` and slims the eval rubric. Landing into the post-split shape is cleaner than retrofitting. If the migration stalls, our PR can land first and the `decisions.yaml` structural checks join the QA skill when it's extracted.
2. **Decisions.yaml is a QA-checkable artifact.** Once `idea-to-pdd-qa` exists, it gains static checks for the decisions log: file present, schema valid (Zod against `lib/decisions-schema.ts`), at least one row per phase category in the bar criterion (warning, not fail, since the bar is heuristic), every `id` unique, every row references a real `phase` value. These are mechanical structural checks — perfect QA fits.
3. **Convention reuse.** Our schema lib follows the `lib/qa-types.ts` Zod-schema pattern (`lib/decisions-schema.ts` exports `DecisionRow`, `DecisionsLog`, plus YAML read/write helpers). Our tests live under `test/skills/<producer>/decisions/` per the new test-harness convention shipped in PR #148.

Net effect on our spec: bar criterion phrasing widened to include `*-qa` checks (already done above); `lib/decisions-schema.ts` follows `lib/qa-types.ts` conventions; sub-project ordering deferred until after `idea-to-pdd` migrates. No structural changes to the architecture or schema.

## Sub-project decomposition

Implementation is split into four PRs, landed in order. Each is independently reviewable and shippable.

1. **Schema + Phase 1 write-side.** Define `lib/decisions-schema.ts` (Zod schemas + types + YAML read/write helpers, mirroring `lib/qa-types.ts` conventions), update `skills/idea-to-pdd/SKILL.md` to write the Phase 1 row set. Calibration set: read turmeric run `20260507-1733` artifacts and identify the Phase 1 rows that should be written. Goal: PDD on a re-run of turmeric produces a `decisions.yaml` with the calibrated row set. **Order: lands after `idea-to-pdd` QA/Eval migration (PR #147 Phase 1 PR #1).** When that lands, `idea-to-pdd-qa` gains a `decisions-yaml-structural` check group covering presence + schema validity + per-phase row coverage.
2. **Phase 2–9 write-side.** Per-skill PRs: each phase's primary writing skill appends its rows. Bundled as one tracking PR or shipped one-by-one as appetite allows. As each phase's producer migrates to QA/Eval split, its companion `*-qa` skill picks up the same `decisions-yaml-structural` check group (shared helper in `lib/decisions-schema.ts`).
3. **Renderer.** `decisions-render` skill (new): YAML → Google Doc via `docs_batch_update`. Find-or-update semantics; runs at end of every phase. Gate brief integration: `Decisions Log: <url>` line + per-phase summary.
4. **Round-trip.** `decisions-sync` skill (new): read gdoc → parse → diff → update YAML. Document the workflow in `agents/ace-orchestrator.md` and surface as `/ace:step decisions-sync <opp>/<run-id>`.

## Migration

No migration needed. `decisions.yaml` is purely additive — existing runs without one continue to work; gate briefs without a `Decisions Log:` line continue to render. The first `/ace:run` after the schema PR ships emits one for new runs.

The existing `open-questions.md` convention in `idea-to-pdd` is retired in PR #1. The `## Open Questions Convention` section of `skills/idea-to-pdd/SKILL.md` is replaced with a `## Decisions Log Convention` section that points at the new contract. The `Open Questions: <url>` line in the gate brief is replaced with `Decisions Log: <url>`. `run_state.yaml.open_questions:` is unaffected — different concept, stays as-is.

## Open questions for the spec itself

- **Calibration set sourcing.** PR #1 needs the concrete Phase 1 row list. The spec proposes 10–15 rows; the implementation step reads turmeric's PDD + gate brief + eval verdicts to ground each row in evidence. If the count drops to 5 or balloons to 25, that's a signal the bar criterion needs a re-look — flag in PR #1's commit message.
- **Sync conflict policy.** If a human edits the gdoc *while* a run is in progress (reading the YAML), the gdoc edits will be silently overwritten on the next render. v1 accepts this; v2 may want optimistic-concurrency via `revisionVersion` (the Drive MCP already exposes it). Documented as a known limitation.

## Change log

| Date | Change | Author |
|---|---|---|
| 2026-05-08 | Initial design | ACE |
