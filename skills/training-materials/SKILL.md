---
name: training-materials
description: >
  Thin umbrella that dispatches the six per-artifact training skills in
  the right order. As of 0.10.84, this skill no longer produces any
  artifact directly — every output is owned by a dedicated
  `training-<artifact>` skill. Kept as an entry point so existing
  Phase 5 orchestration and `/ace:step training-materials` invocations
  keep working; will be removed once those callers migrate.
---

# Training Materials (umbrella)

Dispatches the six per-artifact training skills. This skill no longer
produces any output of its own — call the per-artifact skills directly
or invoke this umbrella to run the full sequence.

## Per-artifact skills (the real work)

| Artifact | Owner skill |
|---|---|
| `flw-training-guide.md` | `training-flw-guide` |
| `llo-manager-guide.md` | `training-llo-guide` |
| `quick-reference.md` | `training-quick-reference` |
| `faq.md` | `training-faq` |
| `onboarding-email-body.md` | `training-onboarding-email` |
| `training-deck-outline.md` | `training-deck-outline` |
| The Slides deck itself | `training-deck-build` |

The 5 per-artifact text skills are independent — order doesn't matter
between them. `training-onboarding-email` MUST come last because it
links to the others. `training-deck-outline` and `training-deck-build`
form an outline-then-render pair (outline first, build second).

## Process

1. Dispatch all 5 text-artifact skills in parallel (they're
   independent):
   - `training-flw-guide`
   - `training-llo-guide`
   - `training-quick-reference`
   - `training-faq`
   - `training-onboarding-email` *(actually dispatch LAST — see
     dependency note below)*

2. Once `training-flw-guide` and the screenshot manifest are both
   ready, dispatch:
   - `training-deck-outline`

3. Once `training-deck-outline` is done, dispatch:
   - `training-deck-build` (only if `ACE_TRAINING_DECK_TEMPLATE_ID`
     is set; otherwise skip with an INFO note)

4. Dispatch `training-onboarding-email` LAST — it links to the other
   docs by Drive URL and they have to exist.

5. Aggregate the verdicts. The umbrella's own verdict at
   `verdicts/training-materials.yaml` is the union of the 6 child
   verdicts; `passed: true` iff every child passed (or skipped
   cleanly, in the case of training-deck-build without a template).

## Dependency rules

- `training-onboarding-email` reads the Drive URLs of
  `flw-training-guide.md`, `llo-manager-guide.md`,
  `quick-reference.md` — those must exist before it runs
- `training-deck-outline` reads the screenshot manifest from
  `app-screenshot-capture` (Phase 5 Step 2) — that must run earlier
  in the phase
- `training-deck-build` reads `training-deck-outline.md` — outline
  must run first
- The 5 text-artifact skills are otherwise independent

Phase 5 sequencing in `agents/qa-and-training.md` enforces these
rules. Direct `/ace:step training-materials` invocations honor them
too via this dispatch order.

## Why an umbrella exists at all

Three reasons we kept this skill instead of removing it outright:

1. **`/ace:step training-materials`** — operator muscle memory and
   existing scripts call this command. Removing the skill name
   would break those.
2. **`opp-eval` aggregation** — the per-skill verdicts roll up into
   a `training-materials` summary in the standard verdict-aggregation
   shape. The umbrella's verdict gives `opp-eval` a single
   per-phase-step reading.
3. **One-call dispatch** — if you want all training docs regenerated
   in one go (e.g., after a PDD edit), this is the entry point.

The umbrella will be removed once these constraints relax (most
likely once `opp-eval` aggregates per-skill verdicts directly without
a parent grouping).

## MCP Tools Used

None directly. Each child skill manages its own MCP usage.

## Outputs

None directly. Children produce:
- `ACE/<opp>/training-materials/{llo-manager-guide,flw-training-guide,quick-reference,faq,onboarding-email-body,training-deck-outline}.md`
- A Google Slides deck under the same folder (if template configured)
- `ACE/<opp>/verdicts/training-{flw-guide,llo-guide,quick-reference,faq,onboarding-email,deck-outline}.yaml`
- `ACE/<opp>/verdicts/training-materials.yaml` — the umbrella verdict

## Mode Behavior

- **Auto:** Dispatch all 6 children in dependency order, aggregate,
  proceed.
- **Review:** Run children in `auto` mode but pause after each child's
  verdict for human inspection before continuing. Useful when an LLO
  wants to review materials before invites go out.
- **Dry-run:** Run each child in `dry-run` mode. Aggregate verdict
  with `dry_run: true`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial monolith. Produced 7 docs in one LLM call. | ACE team |
| 2026-04-28 | Move from Phase 2 to Phase 5. | ACE team |
| 2026-04-30 | Add common-vs-opp screenshot layering + 2 new outputs. | ACE team |
| 2026-05-02 | Per-artifact split begins (0.10.79): `training-deck-outline.md` extracted to `training-deck-outline` skill. | ACE team |
| 2026-05-02 | Continue split (0.10.83): `flw-training-guide.md` extracted to `training-flw-guide` skill. | ACE team |
| 2026-05-02 | Complete split (0.10.84): remaining 4 artifacts extracted to `training-llo-guide`, `training-quick-reference`, `training-faq`, `training-onboarding-email`. This skill becomes a thin umbrella. | ACE team |
