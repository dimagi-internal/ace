# ACE skills audit — findings (Stage 1)

**Date:** 2026-05-06
**Scope:** automated audit pass over all 54 ACE skills under `skills/`.
Stage 2 (per-phase deep-read) and Stage 3 (per-phase fix PRs) follow.
**Companion brief:** `/tmp/skill-budget-handoff.md` (routing-budget angle, written by another session).

## TL;DR

| Lever | Today | Goal |
|---|---:|---:|
| ACE description chars (aggregate) | **15,834** | ≤6,500 (≤120/skill) |
| Per-skill descriptions over 200 chars | **39 / 54** | 0 |
| Skills with banned-pattern flags in description | **33 / 54** | 0 |
| Skills with `## Inputs` section | 16 / 54 | 54 |
| Skills with `## Outputs` section | 8 / 54 | 54 |
| Skills with `## Procedure` or `## Steps` section | 7 / 54 | 54 |
| Stale/dead cross-references | **~10 instances** | 0 |
| Stale `## Current Workaround` blocks | **2** (`llo-uat`, `llo-feedback`) | 0 |

The audit confirms three orthogonal issues:

1. **Description bloat** — descriptions enumerate phases, paths, sibling refs,
   and trigger phrases that belong in the body.
2. **Body-structure drift** — most skills lack the `## Inputs / ## Outputs /
   ## Procedure` skeleton, leading to ad-hoc layouts that vary skill-to-skill
   and phase-to-phase.
3. **Reference staleness** — references to retired skills (`training-materials`
   umbrella, `qa-plan`) and out-of-date workarounds (manual email send when
   `email-communicator` exists) survive past their refactor.

## Per-skill description char counts and lint flags

(Source: `/tmp/skill-desc-lint.txt`. Sorted descending by chars.)

| Skill | Chars | Banned patterns |
|---|---:|---|
| app-screenshot-capture | 800 | phase-label, step-of-phase, inline-paths, internal-coupling |
| app-multimedia-coverage | 770 | sibling-of, delete-this-skill |
| commcare-form-patch | 573 | phase-label, temporary, delete-this-skill, inline-paths, internal-coupling |
| connect-baseline-screenshots | 510 | (size only) |
| connect-program-setup-eval | 445 | internal-coupling |
| ocs-chatbot-eval | 413 | phase-label, internal-coupling |
| pdd-to-learn-app-eval | 396 | mirror-of, internal-coupling |
| app-test-cases | 395 | phase-label, successor-to, inline-paths, internal-coupling |
| llo-launch-eval | 388 | phase-label, internal-coupling |
| training-deck-outline | 378 | inline-paths, ace-opp-path |
| idea-to-pdd-eval | 378 | inline-paths, internal-coupling |
| solicitation-monitor | 358 | phase-label, ace-opp-path, internal-coupling |
| app-ux-eval | 349 | inline-paths, internal-coupling |
| ocs-widget-handoff-eval | 346 | phase-label, inline-paths |
| cycle-grade-eval | 342 | internal-coupling |
| flw-data-review-eval | 335 | internal-coupling |
| pdd-to-deliver-app-eval | 334 | internal-coupling |
| opp-eval | 324 | (size only) |
| eval-calibration | 314 | (size only) |
| ocs-chatbot-qa | 311 | internal-coupling |
| training-flw-guide | 309 | inline-paths |
| upload-transcript | 299 | (size only) |
| app-release-eval | 299 | phase-label, provisional, inline-paths |
| ocs-agent-setup | 298 | (size only) |
| pdd-to-test-prompts | 297 | phase-label |
| llo-invite | 293 | phase-label |
| solicitation-review-eval | 285 | provisional, skills-path |
| app-release | 282 | phase-label |
| app-connect-coverage | 282 | (size only) |
| solicitation-create-eval | 280 | provisional, skills-path |
| solicitation-create | 275 | phase-label |
| training-deck-build | 273 | phase-label, inline-paths |
| solicitation-review | 267 | phase-label, inline-paths |
| training-onboarding-email | 255 | phase-label, inline-paths |
| pdd-to-app-journeys | 248 | phase-label, inline-paths |
| training-faq | 236 | phase-label, inline-paths |
| email-communicator | 234 | (size only) |
| llo-launch | 210 | (size only) |
| connect-opp-setup | 207 | (size only) |
| training-llo-guide | 186 | inline-paths |
| llo-onboarding | 180 | (clean) |
| idea-to-pdd | 174 | (clean) |
| app-deploy | 172 | phase-label |
| pdd-to-deliver-app | 169 | (clean) |
| pdd-to-learn-app | 167 | (clean) |
| flw-data-review | 167 | (clean) |
| training-quick-reference | 165 | inline-paths |
| llo-uat | 146 | (clean) |
| learnings-summary | 140 | (clean) |
| connect-program-setup | 138 | (clean) |
| timeline-monitor | 132 | (clean) |
| llo-feedback | 120 | (clean) |
| opp-closeout | 98 | (clean) |
| cycle-grade | 92 | (clean) |

**Pattern frequencies in descriptions (across 54 skills):**

| Pattern | Count | Example fix |
|---|---:|---|
| `phase-label` ("Phase 5", "Step 1 of Phase X") | 19 | move to body intro |
| `inline-paths` (.yaml/.md/.json files in description) | 16 | move to `## Inputs` / `## Outputs` |
| `internal-coupling` ("reads X, writes Y") | 14 | move to `## Inputs` / `## Outputs` |
| `ace-opp-path` (`ACE/<opp>/...`) | 4 | move to body |
| `provisional` ("Provisional rubric") | 4 | move to body, "## Calibration status" |
| `successor-to` / `mirror-of` / `sibling-of` | 4 | move to body, "## Related skills" |
| `temporary` / `delete-this-skill` | 2 | move to body, "## Removal criteria" |
| `step-of-phase` ("Step N of Phase M") | 1 | move to body |
| `skills-path` (`skills/<name>/SKILL.md`) | 2 | move to body |

## Stale references (catalog)

### Stale skill references (high priority)

1. **`training-materials` umbrella (removed 0.10.89)** referenced as a current
   skill in:
   - `training-deck-build/SKILL.md:7,13,19` — "Phase 5 follow-up to
     `training-materials`", "After `training-materials` has written..."
   - `training-deck-outline/SKILL.md:20,33,188` — "after `training-materials`
     has produced..."
   - `training-onboarding-email/SKILL.md:34,170` — phase-table claims it's a
     sibling of `training-materials`
   - `training-flw-guide/SKILL.md:199` — historical context; OK to keep as
     such if framed as past tense

   **Fix:** rephrase as "the per-artifact training skills" or list the actual
   sibling skill names. The path `ACE/<opp-name>/training-materials/` (the
   directory) is still correct and should NOT be touched — the bug is only
   when the term refers to the now-removed umbrella *skill*.

2. **`qa-plan` (retired by `app-test-cases`)** referenced in:
   - `app-test-cases/SKILL.md` — frontmatter description: "Successor to qa-plan
     (which is retired in this same release)." Per pattern lint, this is a
     `successor-to` flag — move to body's `## Related skills` section.
   - `app-screenshot-capture/SKILL.md:317-318` — changelog history; valid as
     past tense.

3. **`pdd-to-deliver-app-eval/SKILL.md:21-22`** lists "future cross-artifact
   rubrics: `pdd-to-learn-app-eval`, `learn-vs-deliver-eval`,
   `connect-opp-vs-pdd-eval`" — `pdd-to-learn-app-eval` has shipped; the
   "future" framing is dated. Update to "siblings: `pdd-to-learn-app-eval`;
   planned: ..."

### Stale workflow (high priority)

4. **`llo-uat/SKILL.md`** has a `## Current Workaround` block (Steps 1-5) that
   instructs the operator to manually send emails. The `email-communicator`
   skill exists (PR #20) and can do this autonomously. Update procedure to
   call `email-communicator` directly; remove or shrink the workaround block.

5. **`llo-feedback/SKILL.md`** — same pattern. Same fix.

### Aspirational forward-looking refs (low priority — leave with note)

6. **`app-connect-coverage/SKILL.md:252-254`** lists potential future siblings
   `app-localization-coverage`, `app-summary-coverage`. These are
   intentionally aspirational; OK to keep but clarify framing as "Potential
   future siblings (not yet shipped)".

### Verified-clean (NOT stale despite grep hits)

- `register_hq_api_key` / `finalize_opportunity` in `connect-opp-setup` —
  appears only in the changelog row that documents their removal. Valid history.
- `state.yaml` hits in `llo-launch` and `connect-opp-setup` — these are
  references to `connect-state.yaml`, NOT the renamed `state.yaml` →
  `run_state.yaml`. False positive.
- `chatbots.dimagi.com` — zero hits.
- `llo-management` (renamed to `execution-management`) — zero hits.
- `fetch_otp` (removed atom) — zero hits.

## Body-structure inconsistency

Of 54 skills:

- 38 lack `## Inputs` (and ad-hoc replacements vary: `## Reads`, `## Source
  artifacts`, `## Pre-conditions`, plain prose).
- 46 lack `## Outputs` (replacements: `## Writes`, `## Produces`, `## Output
  files`, prose).
- 47 lack `## Procedure` or `## Steps` (replacements: `## Steps to follow`,
  numbered prose, `## Algorithm`, `### Step N` headers without parent).
- 35 lack `## Archetypes` despite many being archetype-aware.

This is the single largest body-quality issue. Skills are individually
readable but a phase agent reading multiple in one session has to re-orient
to the structure each time.

## Cross-skill redundancy

Found via grep on common phrases:

1. **9 skills** include the boilerplate "Writes a verdict YAML in the shared
   QA/eval shape so opp-eval can aggregate it." This phrase belongs once in
   `skills/README.md § QA vs Eval` and should be linked to, not repeated.
2. **All 12 `*-eval` skills** follow a near-identical 5-section body (rubric
   intro / dimensions / hard-deduction rules / output verdict shape /
   calibration). The boilerplate setup duplicates ~30-50 lines per skill.
   Candidate for shared-template extraction (a `skills/_eval-template.md`
   that each eval skill includes via "See [this template]" reference).
3. **All 6 `training-*` artifact skills** follow a near-identical structure
   (audience / inputs / artifact-shape / self-eval / output path). Same
   pattern — extract to `skills/_training-template.md`.
4. **All 4 `solicitation-*` skills** share boilerplate around labs MCP usage
   and PDD reading. Same pattern.

Saving estimate from extraction: ~1,500-2,000 lines of duplicated body
content collapsed to single-line includes.

## File-length distribution

```
Smallest:   65 lines (templates / very-tight skills)
Avg:       203 lines
Median:    180 lines
Largest:   491 lines (ocs-chatbot-eval — has full rubric inline)
Total:   10,970 lines across 54 skills
```

The two longest skills (`ocs-chatbot-eval`, `opp-eval`) inline rubrics that
could move to `skills/<name>/rubric.yaml` as data files.

## Recommendations / prioritization

### P0 — Functional regressions (fix in PR 1, with budget cleanup)

- Stale `## Current Workaround` blocks in `llo-uat`, `llo-feedback`
  (manual-send instructions when email-communicator now exists).
- Stale `training-materials` skill references in `training-deck-build`,
  `training-deck-outline`, `training-onboarding-email`.
- Banned `successor-to` pattern in `app-test-cases` description.

### P1 — Cosmetic/budget (fix in per-phase PRs)

- All 39 over-200-char descriptions: rewrite to verb + use-when format ≤120
  chars. Move phase/path/coupling info to body.
- All 33 banned-pattern instances cleaned up.

### P2 — Body-structure standardization (fix in per-phase PRs)

- Add `## Inputs / ## Outputs / ## Procedure` skeleton to skills missing them.
- Standardize archetype handling header where applicable.
- Move inline rubrics out to `rubric.yaml` data files for the two largest skills.

### P3 — Redundancy extraction (separate PR after P2)

- `skills/_eval-template.md` — extract eval-skill boilerplate.
- `skills/_training-template.md` — extract training-skill boilerplate.
- `skills/_solicitation-template.md` — extract solicitation boilerplate.
- Update each affected skill to reference the template instead of inlining.

### P4 — Guardrails (separate PR after all fixes ship)

- CI lint that fails on banned-pattern matches and >200-char descriptions.
- Stale-ref allowlist test (fails on known-removed atoms / skills / domains).
- Conventions section in `skills/README.md`.

## Stage-2 deep-read targets (per-phase batches)

The automated pass found everything pattern-detectable. Stage 2 needs a
careful read of each skill's body for issues automation can't catch:
- Logical drift (procedure no longer matches its inputs/outputs)
- Dead code paths in procedures
- Missing edge cases vs. archetype contract
- Internal contradictions
- Adherence to the verdict-shape and artifact-manifest contracts

Suggested batching (one parallel agent per batch, ~5-10 skills each):

| Batch | Skills | Phase |
|---|---|---|
| B1 | idea-to-pdd, idea-to-pdd-eval, pdd-to-test-prompts, pdd-to-app-journeys | 1 |
| B2 | pdd-to-learn-app, pdd-to-deliver-app, pdd-to-learn-app-eval, pdd-to-deliver-app-eval, app-deploy, app-release, app-release-eval, app-connect-coverage, app-multimedia-coverage, commcare-form-patch | 2 |
| B3 | connect-program-setup, connect-program-setup-eval, connect-opp-setup | 3 |
| B4 | ocs-agent-setup, ocs-chatbot-qa, ocs-chatbot-eval, ocs-widget-handoff-eval | 4 |
| B5 | app-screenshot-capture, app-test-cases, app-ux-eval, training-llo-guide, training-flw-guide, training-quick-reference, training-faq, training-deck-outline, training-deck-build, training-onboarding-email, connect-baseline-screenshots | 5 |
| B6 | solicitation-create, solicitation-create-eval, solicitation-monitor, solicitation-review, solicitation-review-eval | 6 |
| B7 | llo-invite, llo-onboarding, llo-uat, llo-launch, llo-launch-eval, llo-feedback, flw-data-review, flw-data-review-eval, timeline-monitor, email-communicator, upload-transcript | 7 |
| B8 | opp-closeout, learnings-summary, cycle-grade, cycle-grade-eval, opp-eval, eval-calibration | 8 + cross-cutting |

Each agent gets the full per-batch list, this findings doc, and the brief to
verify against. Output: appended findings + suggested-rewrite blocks per
skill.

## Open questions

1. **Body-template extraction**: should the eval/training/solicitation
   templates live as actual `_*.md` files included via skill body link, or
   should they live in `skills/README.md` and be referenced inline? The
   former is more reusable; the latter is one less artifact.
2. **`disable-model-invocation` policy**: blanket-apply to all 54 ACE skills
   (the most aggressive route), or carve out exceptions for skills the user
   *might* free-text-invoke? User has stated they only use `/ace:run`, which
   argues for blanket.
3. **Rubric extraction**: move large inline rubrics (`ocs-chatbot-eval`,
   `opp-eval`) to `rubric.yaml` data files, or leave inline? Argument for
   move: easier to test/version. Argument against: skill becomes harder to
   read in isolation.

## Methodology / reproducibility

All findings can be regenerated:

```bash
# 1. Per-skill desc/frontmatter inventory
for d in $(ls skills/ | grep -v README.md); do
  # ... see /tmp/skill-inventory.txt for the full pipeline
done

# 2. Staleness greps
grep -rln "training-materials\|qa-plan\|register_hq_api_key\|chatbots.dimagi.com" skills/

# 3. Description-pattern lint
# See /tmp/skill-desc-lint.txt for output

# 4. Body-structure check
for d in skills/*/; do
  grep -c "^## Inputs\|^## Outputs\|^## Procedure" "$d/SKILL.md"
done
```

These will become `test/lib/skill-audit.test.ts` in P4.
