# CRISPR-Test-002 — Walk-Through Validation (2026-04-08)

This is a manual walk-through validation of the focus-group framework changes (jjackson/ace#4) against the CRISPR-Test-002 fixture. I read each archetype-aware SKILL.md and simulated executing it against the fixture's files, then compared the simulated output to the regression spec in the fixture's `README.md`.

**This is not an actual `/ace:run`** — that requires invoking the plugin from a separate Claude session with the GDrive MCP active. This walk-through is the next-best validation: it confirms the SKILL.md instructions are internally consistent, that the fixture has the inputs each skill needs, and that the regression spec matches what each skill is actually instructed to produce.

## Result summary

| Skill | Inputs available? | Process consistent? | Output matches spec? | Notes |
|---|---|---|---|---|
| `idea-to-pdd` | Yes (after fix below) | Yes | Yes | Required adding `idea.md` to the fixture |
| `pdd-to-learn-app` | Yes | Yes | Yes | — |
| `pdd-to-deliver-app` | Yes | Yes | Yes | — |
| `app-test` | Yes (after fix below) | Yes | Yes | Required adding `deployment-summary.md` |
| `connect-opp-setup` | Yes (after fix below) | Yes | Yes | Required adding `connect-setup/program.md` and `deployment-summary.md` |
| `flw-data-review` | Partial | Yes | N/A — needs runtime data | Fixture has no synthetic submission data |
| `cycle-grade` | Partial | Yes | N/A — needs runtime data | Fixture is in pending state, not completed state |

**Bottom line:** 5 of 7 archetype-aware skills can be validated against the fixture in its current form. The remaining 2 (`flw-data-review`, `cycle-grade`) need runtime data — either fake completed sessions and a closed-out opportunity state, or a separate "completed" companion fixture. These gaps existed in CRISPR-Test-001 too and predate this PR; they're noted at the bottom of this report under **Known fixture limitations**.

## Fixture additions made during validation

These were missing inputs that prevented end-to-end runnability. Added to **both** CRISPR-Test-001 and CRISPR-Test-002 since the gaps were pre-existing and symmetric:

1. **`idea.md`** — synthetic initial idea, used as input to `idea-to-pdd`. Without this, `idea-to-pdd` step 1 has nothing to read.
2. **`deployment-summary.md`** — synthetic deployment record (fake CommCare app IDs and URLs), used as input by `app-test` and `connect-opp-setup`. Without this, those skills error at the input-reading step.
3. **`connect-setup/program.md`** — synthetic Connect program record (fake program ID and URL), used as input by `connect-opp-setup`. Same reason.

These are stubs only; real values would be populated by running the upstream skills. The stubs make the fixtures self-contained for downstream-skill testing.

## Per-skill walk-through

### 1. `idea-to-pdd`

**Inputs read:** `idea.md` (added during validation).

**Process trace:**
- Step 1 reads the idea ✓
- Step 2 determines archetype from the idea text — vaccine-hesitancy focus groups → `focus-group`
- Step 3 expands the idea, working through the focus-group additional questions in `## Archetypes`: recruitment, language, facilitation skill, consent, venue, duration/compensation, question guide, output spec
- Step 4 drafts the PDD with base sections + focus-group additional sections (Recruitment Plan, Facilitation Protocol, Question Guide, Output Specification)
- Step 5 runs the 5-question stress-test rubric
- Step 6 writes the PDD with `## Stress Test Results` appendix

**Expected output:** an PDD structurally equivalent to `test/fixtures/CRISPR-Test-002/pdd.md`, with all 5 stress-test checks passing (the fixture was constructed to pass).

**Comparison with fixture spec:** ✓ The fixture's `pdd.md` is an instance of what `idea-to-pdd` should produce for a focus-group archetype with all gaps resolved. The README spec ("reads `archetype: focus-group`, drafts focus-group additional sections, runs the rubric, all-pass") matches the SKILL.md process exactly.

**Caveat:** This skill is non-deterministic (LLM output varies). The validation here is structural ("the output should have these sections, the rubric should grade these results"), not literal ("the output should equal pdd.md byte-for-byte"). The fixture's pdd.md is a *target shape*, not a golden output.

### 2. `pdd-to-learn-app`

**Inputs read:** `pdd.md`.

**Process trace:**
- Step 1 reads the PDD ✓
- Step 2 extracts Learn app requirements; `## Archetypes` → `focus-group` → "facilitation training app, not form walkthrough"
- Step 3 generates a Nova brief that explicitly references the PDD's Facilitation Protocol section and lists the 8 modules from the PDD's Learn App Specification
- Step 4 (workaround active — Nova bot API not built) writes the brief to `ACE/CRISPR-Test-002/app-briefs/learn-app-brief.md`
- Step 5 self-evaluates whether the brief is a facilitation-training brief (not a form walkthrough)
- Step 6 writes the app summary

**Expected output:** A Nova brief describing the 8-module facilitation training app with the modules from the PDD's Learn App Specification:
1. Facilitation basics
2. Probing techniques
3. Neutral framing
4. Group dynamics
5. Question guide walkthrough
6. Session form walkthrough
7. Consent and ethics
8. Logistics

**Comparison with fixture spec:** ✓ The fixture's `app-summaries/learn-app-summary.md` already documents the expected 8-module structure. The README spec ("brief explicitly references the Facilitation Protocol section, includes the 8 modules, does not generate a generic data-collection-form-walkthrough brief") matches.

### 3. `pdd-to-deliver-app`

**Inputs read:** `pdd.md`.

**Process trace:**
- Step 1 reads the PDD ✓
- Step 2 extracts Deliver app requirements; `## Archetypes` → `focus-group` → "session documentation, segment-level case"
- Step 3 generates a Nova brief that explicitly references the PDD's Output Specification section and describes the form structure: pre-session, per-question-domain (×6), post-session, with case at segment level
- Step 4 (workaround) writes the brief
- Step 5 self-evaluates
- Step 6 writes the app summary

**Expected output:** A Nova brief describing a session-documentation form mirroring the structure in `app-summaries/deliver-app-summary.md` — three forms (Session start, Per-domain summary ×6, Session end), case management at segment level.

**Comparison with fixture spec:** ✓ Aligned. The fixture's `deliver-app-summary.md` was hand-written to be the spec. The SKILL.md instructs the brief to call out "session documentation, not atomic data collection."

### 4. `app-test`

**Inputs read:** `app-summaries/learn-app-summary.md`, `app-summaries/deliver-app-summary.md`, `deployment-summary.md` (added during validation), `pdd.md`.

**Process trace:**
- Step 1 reads app summaries ✓
- Step 2 reads deployment details ✓
- Step 3 reads `archetype: focus-group` and the PDD's Evidence Model section. Errors out if Evidence Model is missing — fixture has it ✓
- Step 4 generates the test plan; `## Archetypes` → `focus-group` → covers per-domain section coverage, file-upload paths, consent gating, segment-level case lifecycle. Layer A entries from the Evidence Model become capture tests.
- Step 5 executes tests (in dry-run, generates the plan only)
- Step 6 self-evaluates with the new check "does every Layer A artifact have a passing capture test?"
- Step 7 writes test results, with each test case linked back to its Evidence Model layer

**Expected output:** A test plan with explicit Layer A capture tests covering:
- GPS-within-target-area capture
- Audio file present and ≥ 45 min duration
- Attendance form complete
- All 6 per-domain summary forms submitted
- Consent confirmation present
- Facilitator reflection present

Plus content validation tests on free-text fields (themes, quotes, facilitator reflection — paragraph-length acceptance), file-upload end-to-end tests, consent gating tests, segment-level case lifecycle tests.

**Comparison with fixture spec:** ✓ The README spec lists exactly these test categories. The SKILL.md → fixture mapping is clean.

### 5. `connect-opp-setup`

**Inputs read:** `pdd.md`, `connect-setup/program.md` (added during validation), `deployment-summary.md` (added during validation).

**Process trace:**
- Step 1 reads inputs ✓
- Step 2 reads `archetype: focus-group` and the PDD's Evidence Model. Errors if Evidence Model is missing — fixture has it ✓
- Step 3 creates the opportunity (workaround active — `create_opportunity` API not built); `## Archetypes` → `focus-group` → uses delivery type "Experiment"
- Step 4 configures verification rules from Layer A. Each Layer A row in the fixture's Evidence Model maps to one rule.
- Step 5 configures delivery units; `## Archetypes` → `focus-group` → delivery unit = one completed session (not one participant); total count = 6 sessions from the PDD
- Step 6 configures payment units (per-session, $500/session)
- Step 7 writes the opportunity config summary

**Expected output:** An opportunity config spec with:
- Delivery type: "Experiment"
- Delivery unit: one completed focus-group session
- Payment unit count: 6 (= PDD's planned session count)
- Verification rules quoting Evidence Model Layer A:
  - GPS within target community area
  - Audio file present, duration ≥ 45 minutes
  - Attendance form complete
  - All 6 per-domain summary forms submitted
  - Consent confirmation present
  - Facilitator reflection present
- Soft flags from Layer B/C: AI quality check on per-domain summaries, segment differentiation

**Comparison with fixture spec:** ✓ The README spec is a 1:1 match with the SKILL.md instructions. The fixture's PDD has all 6 Layer A rows that should become rules.

### 6. `flw-data-review` *(partial — needs runtime data)*

**Inputs read:** app summaries ✓, pdd.md (with archetype + Evidence Model) ✓, **fake submission data** *(NOT in fixture)*.

**Process trace:**
- Step 1 reads context including archetype and Evidence Model. Branches to `focus-group` qualitative review.
- Step 2 queries FLW data via scout-data MCP. **This is where the walk-through stops** — the fixture has no synthetic completed-session data to query against.
- (Steps 3–6 would self-evaluate, generate recommendations, write the review)

**Why this is a partial:** Validating `flw-data-review` requires synthetic completed sessions in the fixture — at minimum, 3–6 fake "session output" records with realistic per-domain summaries, quotes, attendance, and audio metadata. These would mirror what the Deliver app would actually capture in production. They don't exist yet.

**What the skill *would* do** if the data existed (verified by reading the SKILL.md):
- Per-session quality review: are summaries specific or generic? Are quote counts ≥ 2 per domain? Is the facilitator reflection substantive?
- Cross-session synthesis: themes by segment, convergence/divergence between the two segments, saturation indicator, top barriers with quote attribution, implications for a Stage 2 PDD
- Quote bank extraction
- Facilitator coaching signals
- **Does NOT** run quantitative checks (submission rates, outlier detection, daily caps)

**Comparison with fixture spec:** ✓ The README spec describes exactly this qualitative review. The SKILL.md → spec mapping is correct on paper; the missing piece is runtime data.

**Recommendation:** Create a `test/fixtures/CRISPR-Test-002-completed/` companion fixture with 6 fake session-output records. Out of scope for this PR; logged as a follow-up.

### 7. `cycle-grade` *(partial — needs runtime data)*

**Inputs read:** all opportunity artifacts including learnings-summary, pdd.md (with archetype + Evidence Model). **Fixture has none of the completed-cycle artifacts** (test results, monitoring reports, FLW data reviews, OCS transcripts, LLO feedback, learnings summary).

**Process trace:**
- Step 1 reads all artifacts. **This is where the walk-through stops** — the fixture has only the inputs to the *first* skill in the cycle, not the outputs of all 19.
- (Steps 2–6 would grade across dimensions, self-evaluate, generate recommendations, write the report, email)

**Why this is a partial:** Validating `cycle-grade` requires the fixture to be in a "completed" state with all the artifacts the grader reads. The fixture is in a "pending" state (per state.yaml). This is the same gap CRISPR-Test-001 has — neither fixture is currently set up for end-of-cycle skill testing.

**What the skill *would* do** if all artifacts existed (verified by reading the SKILL.md):
- Read the PDD's Evidence Model; Layer A → FLW Performance evidence; Layer B/C → Intervention Effectiveness / Research Quality evidence
- For `focus-group`, grade 7 dimensions (the standard 6 + Research Quality). Use facilitation-quality rubric for FLW Performance, research-yield rubric for Intervention Effectiveness.
- Self-evaluate fairness
- Write the cycle grade report and email the admin group

**Comparison with fixture spec:** ✓ The README spec aligns with the SKILL.md. Missing piece is the completed-state artifacts.

**Recommendation:** Same as flw-data-review — a "completed" companion fixture or runtime artifact synthesis. Out of scope for this PR; logged as a follow-up.

## Issues found during validation

### None affecting the merged framework changes

The walk-through did not surface any inconsistencies between the SKILL.md instructions and the fixture spec. The 5 fully-validatable skills (idea-to-pdd, pdd-to-learn-app, pdd-to-deliver-app, app-test, connect-opp-setup) all have clean process traces against the fixture inputs, and each skill's output (per its SKILL.md) matches what the fixture README claims it should produce.

The 2 partially-validatable skills (flw-data-review, cycle-grade) are blocked on missing runtime data, not on framework or skill bugs. Their SKILL.md → spec mapping is internally consistent.

### Pre-existing fixture gaps (not regressions)

These gaps existed in CRISPR-Test-001 before this PR and were inherited symmetrically by CRISPR-Test-002:

1. ~~No `idea.md` in either fixture~~ → **fixed in this PR** (added stubs to both)
2. ~~No `deployment-summary.md` in either fixture~~ → **fixed in this PR** (added stubs to both)
3. ~~No `connect-setup/program.md` in either fixture~~ → **fixed in this PR** (added stubs to both)
4. **No fake submission data in either fixture** → not fixed; would block `flw-data-review` testing on either fixture. Logged as follow-up.
5. **Neither fixture is in a "completed" state** → not fixed; would block `cycle-grade`, `learnings-summary`, `opp-closeout`, `llo-feedback` testing. Logged as follow-up.

## Known fixture limitations

These are out of scope for the focus-group framework PR but should be tracked as follow-up work to make the fixtures fully end-to-end testable:

| Limitation | Affects | Effort | Notes |
|---|---|---|---|
| No synthetic submission data | `flw-data-review` (both fixtures) | M | For atomic-visit: fake CommCare submissions. For focus-group: fake session output records with realistic per-domain summaries. |
| No "completed-state" companion fixture | `cycle-grade`, `learnings-summary`, `opp-closeout`, `llo-feedback` | L | Would need a `CRISPR-Test-001-completed` and `CRISPR-Test-002-completed` with all the post-execution artifacts. Or add a "post-run" mode to the existing fixtures. |
| No automated regression script | All skills | L | Currently each fixture run is manual. ACE's existing eval framework (`test/eval/`) is for Nova blueprints, not SKILL.md prompt outputs. A regression script would diff dry-run outputs against expected behaviors documented in the fixture READMEs. |

## Conclusion

**The focus-group framework changes are validated** for the 5 skills that can be walked through against the fixture (idea-to-pdd, pdd-to-learn-app, pdd-to-deliver-app, app-test, connect-opp-setup). The SKILL.md instructions, the fixture inputs, and the fixture README's regression spec are all internally consistent and produce the same expected outputs.

The 2 remaining skills (flw-data-review, cycle-grade) are validated *on paper* (the SKILL.md → spec mapping is correct) but cannot be runtime-validated without additional fixture content. This is a pre-existing limitation that affects atomic-visit testing equally — fixing it is a separate, larger effort than this PR.

Three small fixture gaps (`idea.md`, `deployment-summary.md`, `program.md`) were found during validation and are fixed in this PR for both fixtures.
