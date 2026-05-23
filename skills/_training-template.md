# `training-*` skill template

Shared conventions for the per-artifact training skills under Phase 6.
Six skills (`training-llo-guide`, `training-flw-guide`,
`training-quick-reference`, `training-faq`, `training-deck-outline`,
`training-onboarding-email`) plus the renderer (`training-deck-build`)
all follow the same skeleton. This file documents the shared shape so
each skill body can reference it instead of duplicating boilerplate.

This is a **reference document**, not a skill. It is not invoked.
Excluded from the skill catalog because the filename starts with `_`.

## Skeleton

```markdown
# <Skill Name>

(1-3 sentence framing — what artifact this skill produces, who reads
the artifact, what Phase 6 sequence position the skill occupies.)

## When to run

(Phase 6 sequencing — which sibling skills must run before, which
skills consume this artifact.)

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| <phase> | `<path>` | <purpose> |

## Output

Single file: `ACE/<opp>/runs/<run-id>/6-qa-and-training/<artifact>.md`

## Format

(Markdown skeleton or YAML schema for the artifact. Each per-artifact
skill defines its own; do not try to share.)

## Format rules

(Per-artifact rules: word budget, voice/tone, screenshot embedding
policy, structural conventions. Each skill's audience and re-run
semantics drive different rules — do not try to share.)

## Process

1. Read inputs.
2. Compose the artifact per format rules.
3. Self-check against the four-criterion self-eval (per-skill specific).
4. Write to Drive.
5. Self-evaluate via LLM-as-Judge — write
   `<artifact>_verdict.yaml` using the verdict shape from
   `skills/_eval-template.md § Verdict YAML contract`.
6. Hand off — print Drive URL + verdict summary.

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)`.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

## Why a separate skill

(Per-skill specific — describe this skill's audience, re-run
semantics, and why it owns one artifact instead of being merged with
siblings. Reference the sibling skills explicitly.)

## Change Log

| Date | Change | Author |
|---|---|---|
```

## Per-artifact decomposition rationale

The legacy `training-materials` umbrella was removed in 0.10.89 in
favor of one skill per artifact. The decomposition gives:

- **Independent re-run.** Re-running the FAQ after a PDD edit doesn't
  re-emit the entire LLO guide.
- **Independent eval.** Each artifact has its own four-criterion
  self-eval — verdicts attribute cleanly per artifact.
- **Independent context budget.** Each LLM call sees only the inputs
  it needs (FAQ doesn't need deck-outline context).
- **Phase-8 boundary.** `training-onboarding-email` is consumed by
  Phase 9 LLO onboarding; isolating it from Phase-6-only siblings
  makes the cross-phase dependency explicit.

## Sibling map

| Skill | Artifact | Audience | Sequencing |
|---|---|---|---|
| `training-llo-guide` | `llo-manager-guide.md` | LLOs running the deployment | Step 2 (parallel) |
| `training-flw-guide` | `flw-training-guide.md` | FLWs in the field | Step 2 (parallel) |
| `training-quick-reference` | `quick-reference.md` | FLWs (printed pocket card) | Step 2 (parallel) |
| `training-faq` | `faq.md` | LLOs and FLWs | Step 2 (parallel) |
| `training-deck-outline` | `training-deck-outline.md` | Phase 6 internal (input to deck-build) | Step 2 (parallel) |
| `training-onboarding-email` | `training-onboarding-email.md` | Phase 9 (consumed at LLO onboarding) | Step 3 (sequential, after siblings) |
| `training-deck-build` | Google Slides URL | LLO (presents to FLWs / records) | Step 4 (sequential, after deck-outline) |

`agents/qa-and-training.md` enforces the sequencing.

## Common Drive paths

All per-artifact training skills write to:
`ACE/<opp-name>/runs/<run-id>/6-qa-and-training/`

All consume per-opp screenshots from:
`ACE/<opp-name>/runs/<run-id>/6-qa-and-training/screenshots/`

All consume cross-opp Connect screenshots from:
`ACE/_common/connect-screenshots/<connect-version>/`
(produced by the standalone `connect-baseline-screenshots` skill —
NOT a Phase 6 dispatch).

## Verdict shape

Same shape as eval skills — see
`skills/_eval-template.md § Verdict YAML contract`.

The artifact-specific `dimensions` differ per skill (each has its own
four-criterion self-eval) but the verdict envelope, severity rules,
and gate-brief surface follow the shared contract.

## When to update this template

Edit when:
- A new per-artifact training skill is added (update the sibling map).
- The Phase 6 dispatch order changes (update sequencing column).
- A shared contract changes (then also touch `_eval-template.md` if
  the change affects verdict shape or stock blocks).

Per-skill format rules and audience-specific concerns stay in each
skill's own file — do not pull them into this template.
