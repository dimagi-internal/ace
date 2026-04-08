## 2026-04-08 — focus-group-framework (custom lens)

**Lens used:** `improved skill framework so we can run focus groups, see docs folder for background ideas` (custom — not one of the standard rotation lenses).

**Background read:** `README.md`, `docs/superpowers/specs/2026-04-01-ace-design.md`, `docs/generated/playbook.md`, `docs/examples/idd-vaccine-hesitancy.md`, `docs/examples/idd-turmeric-market-survey.md`, `docs/examples/idd-stress-test-observations.md`, `templates/idd-template.md`, and the SKILL.md files for `idea-to-idd`, `idd-to-learn-app`, `idd-to-deliver-app`, `app-test`, `connect-opp-setup`, `flw-data-review`, `cycle-grade`. Also confirmed PR #3 added the example IDDs.

**Core finding:** every existing skill is hard-coded to one delivery archetype — "one FLW visit = one photo + GPS + form." Never named as an assumption; baked into the IDD template, the section list in `idea-to-idd`, the Nova briefs, the verification vocabulary in `connect-opp-setup`, the quantitative queries in `flw-data-review`, and the grading dimensions in `cycle-grade`. A focus-group IDD walks in and silently breaks. The fix is **not** "add 4 new focus-group skills" (the stress-test doc's suggestion) — that forks the framework. The fix is to give skills variation points that branch on a declared archetype, plus a shared evidence-model vocabulary.

### Do it

1. **F2 — Stress-test rubric in `idea-to-idd`** — Effort: S — Status: **done, merged into PR #4**
   - Branch: `emdash/pm-session-9n4`
   - PR: jjackson/ace#4
   - Outcome: 5-question rubric (executability, verifiability, measurability, stage-gate clarity, resource realism) replaces the weak "is it complete enough" self-eval. Includes vaccine-hesitancy and turmeric IDDs as calibrated grading anchors. Stress-test results emitted as IDD appendix.

2. **F1 — Delivery archetype as first-class concept** — Effort: M — Status: **done, in PR #4**
   - Branch: `emdash/pm-session-9n4`
   - PR: jjackson/ace#4
   - Outcome: New `Archetype:` field in `templates/idd-template.md` (atomic-visit | focus-group | multi-stage). `## Archetypes` section added to all 7 archetype-aware skills with concrete focus-group branches drawn from the stress-test doc and the vaccine-hesitancy IDD. atomic-visit is the default; new archetypes are additive PRs.

3. **F3 — Evidence Model section + downstream consumption** — Effort: M — Status: **done, in PR #4**
   - Branch: `emdash/pm-session-9n4`
   - PR: jjackson/ace#4
   - Outcome: New `## Evidence Model` section in IDD template using Layer A (delivery proof) / Layer B (content proof) / Layer C (cross-delivery quality) vocabulary. `connect-opp-setup`, `app-test`, `flw-data-review`, `cycle-grade` now read from this section instead of re-deriving verification. Skills error if Evidence Model is missing.

4. **F4 — CRISPR-Test-002 focus-group fixture** — Effort: M — Status: **done, in PR #4**
   - Branch: `emdash/pm-session-9n4`
   - PR: jjackson/ace#4
   - Outcome: Pair fixture to CRISPR-Test-001 (atomic-visit). Simplified vaccine-hesitancy IDD (Stage 1 only, 2 segments, 1 LLO), full Evidence Model, stress-test all-pass. README.md documents the regression spec for each archetype-aware skill against the fixture. Stub Learn + Deliver app summaries.

### Backlog

(none from this run — all 4 proposals were dispositioned "Do it" and shipped together)

### Closed

(none from this run — no proposals were rejected)

### Skipped on this run (raised but not formally proposed)

- **F5 — `skills/README.md` author contract**. Not yet urgent; would document required SKILL.md sections (frontmatter, Process, MCP Tools Used, Mode Behavior, Dry-Run Behavior, Change Log) plus optional Archetypes / LLM-as-Judge Rubric / Evidence Model. Natural follow-on once a third archetype or a non-Jon contributor starts touching skills. Hold for a future cycle's `tech-debt` lens.
- **Regenerate `docs/generated/playbook.md`**. `/ace:docs` is a slash command, not a script — it must be run by Claude. Noted in PR description as a post-merge step. Could become a hook (`afterMerge` for skills/ changes).
- **Add `archetype: atomic-visit` to CRISPR-Test-001's IDD**. Currently relies on the default fallback. Adding it explicitly would let the fixture demonstrate the new field. Trivial follow-up; not in this PR to keep the diff focused.

### Meta-observations

**What worked well:**
- Doing the docs read in parallel (Bash + Glob + Read in batched calls) was much faster than sequential. I read 7 files in 2 message turns.
- Bootstrapping `context.md` from the existing README + design spec + memory rather than asking 4 questions interactively saved a lot of round-trips. The skill explicitly allows skipping questions answerable from code — that flexibility was the right call here.
- The lens being a custom string (not one of the rotation 5) wasn't a problem. The skill's framing of "exploration lenses" as suggestive rather than prescriptive worked well — I just used the user's exact phrasing.
- The stress-test doc (`docs/examples/idd-stress-test-observations.md`) was load-bearing background. Without it I would have proposed a much weaker version of F2/F3, because that doc had already done the conceptual work — I was mostly formalizing what was already a one-off observation into framework-level structure.
- Using `AskUserQuestion` for per-proposal disposition kept the user in control without ambiguous bulk-chat answers. All 4 dispositions came through cleanly.

**What was wasteful:**
- I made one duplicate-numbering mistake in the ordered list in `idea-to-idd/SKILL.md` (had two "step 4"s after the initial Edit) and had to do a follow-up renumber. Checking step numbering after each big ordered-list edit would have caught it inline.
- Same again in `app-test/SKILL.md` — needed a follow-up renumber after adding step 3. Pattern: any time I insert a step in the middle of an ordered list, I should grep `^[0-9]+\.` immediately after to verify sequential numbering.
- I read the focus-group example IDD twice — once to extract focus-group structure, once when checking the stress-test doc that links to it. Would have been fine to skip the second read.
- I checked `.gitignore` and `.claude/` tracking *after* writing files to `.claude/pm/` rather than before. Result was correct (those files stayed untracked, which was the right choice), but I could have established the rule before writing.

**Prompt adjustments for next time:**
- For multi-skill framework changes like this one, the right number of proposals is 3–4, not the standard 3. The user dispositioned all 4 as "Do it" because they were tightly interdependent — splitting the 4 across two cycles would have shipped half a feature. The skill's "top 3" guidance is a soft cap, not a rule.
- When the user asks for a "framework" change, the wrong instinct is to add new skills/files. The right instinct is to add variation points to existing skills/files. I need to keep that as a working bias for any future "framework" lens.
- The `## Archetypes` section pattern (default + branches, declared once per skill) is reusable for *any* configuration that varies across IDD types. If a future cycle introduces something like `## Modalities` (online vs in-person) or `## Geographies` (regulatory branching), the same pattern should be considered before forking skills.

**Confidence on validation:**
- Medium-high. F1, F3, F4 are well-instrumented in the SKILL.md text and the fixture has explicit pass/fail expectations per skill. Real validation requires running the skills against the fixture in a Claude session, which I can't do from the implementing session without round-tripping through the user. The test plan in PR #4 makes this explicit.
- Lower on F2 specifically — LLM-as-Judge rubrics are notoriously generous. The few-shot grading anchors (vaccine-hesitancy-as-fail, turmeric-as-near-pass) help, but the proof comes from running it. If the rubric grades the vaccine-hesitancy IDD as "pass" or grades the turmeric IDD as "fail," that's a false positive that needs the rubric tightened.

### Self-improvement (canopy-skills meta-PRs)

Three universal-improvement candidates surfaced from this run's meta-observations were proposed as PRs against `jjackson/canopy-skills`:

1. **U1 — Custom lens support is first-class.** jjackson/canopy-skills#7. Adds a one-paragraph note to Phase 1 clarifying that custom lenses (not in the rotation list) are first-class. Two-line addition; no existing content removed.
2. **U2 — Top-N can exceed 3 when interdependent.** jjackson/canopy-skills#8. Softens Phase 2's "top 3" hard cap to a soft default with an explicit interdependence escape hatch. One-line edit.
3. **U3 — Lesson #9: Framework changes mean variation points, not new components.** jjackson/canopy-skills#9. Appends a 9th lesson encoding the parameterization-over-fork bias for "framework" lenses.

All three PRs are open for jjackson review. Per the Self-Improvement Protocol, the skill is intentionally gated on human review before merging — no auto-merge.
