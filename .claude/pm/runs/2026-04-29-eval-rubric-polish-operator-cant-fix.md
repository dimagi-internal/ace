## 2026-04-29 — eval-rubric-polish-operator-cant-fix (custom lens)

**Lens used:** "operator-can't-fix vs operator-can-fix" — every eval rubric must distinguish defects the operator can address (skill output errors, missing required fields, hallucinations) from constraints the operator literally cannot address (platform schema limits, capture-API restrictions, upstream environmental gaps, build-not-yet-produced stubs). When a rubric fails this distinction, it produces noise — penalizing skills for things outside their control — and the noise drowns the signal. Picked because the first non-degraded `connect-program-setup-eval` run on `turmeric-market-survey-2026-04-28` and the 0.9.11 cross-opp validation against `turmeric-dogfood-20260427` independently surfaced the same pattern in three different rubrics. Three instances = a class.

**Background read:** `CLAUDE.md`, `docs/eval-calibration-learnings.md`, `skills/eval-calibration/SKILL.md`, `skills/README.md § QA vs Eval`, `lib/verdict-schema.ts`, `test/lib/verdict-schema.test.ts`, all 8 `*-eval/SKILL.md` files, the prior PM run `2026-04-28-turmeric-dogfood-ocs-contracts.md`, the verdict YAML on Drive at `ACE/turmeric-market-survey-2026-04-28/verdicts/connect-program-setup-eval-*.yaml`, CHANGELOG entries 0.9.0 → 0.10.5. Mid-cycle: `mcp/connect/backends/playwright.ts` and `mcp/connect/backends/html-scrape.ts` for the read-side bug investigation that became 0.10.6.

**Core finding:** Five releases (0.10.6 → 0.10.10) shipped, all driven by one structural pattern. The same fix shape applies whether the rubric is grading Connect program creation, Nova-built apps, or OCS chatbots: introduce a category that *describes* the constraint instead of *deducting* for it. Concretely:

- `[PLATFORM]` severity tier (0.10.7) — defects originating in the upstream service, not the skill.
- `[DRIFT]` severity tier (0.10.7) — discrepancies between artifact text and live state; diagnostic-only because the dimension consuming either source already deducts if either is wrong (counting drift again double-penalizes).
- `[INFO-SKIPPED]` severity tier (0.10.7) — sub-checks bypassed for missing input.
- `partial` verdict tier (0.10.7) — artifact correct, live verification unreachable.
- `incomplete` verdict tier (already prose, schema-formalized in 0.10.7) — structural gap prevents grading.
- HITL-stub guard (0.10.8) — early-return `incomplete` when Nova hasn't built the app yet.
- Clean-source branch (0.10.9) — switch the dimension's grading function when the input shape doesn't match the dimension's assumptions.
- Capture-method branch (0.10.10) — same pattern in `ocs-chatbot-eval` source-usage when transcripts come from the widget endpoint (which never returns inline citations) vs the OpenAI-compatible endpoint.

The 0.10.6 fix is a *consequence* of the rubric working: `connect-program-setup-eval` flagged a real bug (Program fields empty after read), which traced to a read-side hydration bug in `getProgram` (not a write-side serialization gap as the verdict described). The eval framework caught a production bug — and the rubric's own diagnostic post-hoc was wrong about the layer, which seeded the 0.10.6 "defect-vs-cause discipline" rule (state observations confidently, phrase causes tentatively).

The verdict schema bumped 1 → 2 (additive — every v1 verdict still validates as v2). Six new schema tests cover the new tiers; 218/247 tests passing every release. The prose contracts in rubric SKILL.md files had referenced `incomplete` for months before the schema accepted it — purely doc-level drift until any rubric actually emitted that value. 0.10.7 closed that gap explicitly.

### Do it

1. **`getProgram` read-path fix + defect-vs-cause discipline (0.10.6)** — Effort: S — Status: **done, shipped 0.10.6**
   - Commit: `718595b`
   - Outcome: `connect-program-setup-eval` on `turmeric-market-survey-2026-04-28` flagged "Program created with all fields filled but `connect_get_program` returns empty fields." The verdict attributed the cause to a write-side serialization gap. Wrong layer. `getProgram` (mcp/connect/backends/playwright.ts:133) wrapped `listPrograms`, and `parseProgramsList` (html-scrape.ts:54) only extracts `name` + `description` from the list page — every other field is hardcoded to `0`/`''` with the comment *"caller can hydrate via getProgram() if needed."* But getProgram never hydrated. Fix mirrors the existing `getOpportunity` pattern: read `/a/<org>/program/<uuid>/edit` and use `extractFormFieldValues`. Strengthened the integration test (was asserting only `p.name`; now asserts all 8 hydrated fields). Plus added step-8 "Defect-vs-cause discipline" to the rubric: state observations confidently, phrase causes tentatively, format as `Observed: <fact>. Likely cause (unverified): <hypothesis>.` LLM-as-Judge rubrics tend to pattern-match defects to the most familiar root-cause label rather than reasoning about layer; this rule constrains the pattern.

2. **Verdict schema v2 + `connect-program-setup-eval` 5-item polish (0.10.7)** — Effort: M — Status: **done, shipped 0.10.7**
   - Commit: `e992109`
   - Outcome: First non-degraded grading of the rubric on the turmeric run produced five distinct findings; ship as one batch since they're all in the same rubric file and internally consistent. Schema gained `partial` and `incomplete` as top-level verdict tiers (the prose has referenced `incomplete` for months — schema-only drift); `PLATFORM`, `DRIFT`, `INFO-SKIPPED` as severity tiers; optional `live_state_verified: boolean` and `overall_score_pre_cap: number`. Per-item verdict stays `pass | warn | fail` since item-level entries are by definition graded. SCHEMA_VERSION 1 → 2. The rubric polish: (1) `partial` tier definition for runtime-blocked-but-not-degraded; (2) `[PLATFORM]` use for Connect schema limits the skill can't bypass; (3) `[DRIFT]` for `connect-setup-summary` ↔ live-state discrepancies, with explicit "diagnostic only, never deductive" rule (counting drift double-penalizes); (4) payment threshold-sanity now explicitly conditional — emit `[INFO-SKIPPED]` when no PDD day-rate; (5) `live_state_verified` boolean caps verdict ≤ partial when false. Six new schema tests, prose contract in `skills/README.md` re-synced with code.

3. **HITL-stub branch in app-eval rubrics (0.10.8)** — Effort: S — Status: **done, shipped 0.10.8**
   - Commit: `f0476d8`
   - Outcome: 0.9.11 cross-opp validation found that `pdd-to-deliver-app-eval` and `pdd-to-learn-app-eval` both mis-graded HITL-pending app summaries on `turmeric-dogfood-20260427` (Nova hadn't finished building yet, summary was a stub). The deliver rubric got 2 of 5 dimensions ungradable; the learn rubric's most load-bearing dimension (assessment_score_wiring at 30%) graded the stub as "wiring entirely missing" → forced ≤3 → fail on a build that wasn't actually a defect. Both rubrics now have a step-2 guard that emits `verdict: incomplete` immediately when `nova_app_id` is missing/null/TBD or the summary is skeleton-only. Mirrors `connect-program-setup-eval`'s degraded-mode pattern: structural gaps in the upstream environment are environmental, not quality defects.

4. **Clean-source branch in `idea-to-pdd-eval` (0.10.9)** — Effort: S — Status: **done, shipped 0.10.9**
   - Commit: `792ba2e`
   - Outcome: The reviewer-comment-fidelity dimension (20% weight) assumed every idea.md contains formal `[a]/[b]` reviewer footnotes. Clean PM-authored sources have none; the rubric scored gracefully by treating PDD's Open Questions as analog, but the anchors at 9.5 ("all comments addressed") were measuring a vacuously-true question. Now: step 2 detects `clean_source = true` automatically (no footnotes, no Comments/Feedback section). When true, the dimension switches to grading **deferred-decision discipline** — looks for a section explicitly handling uncertainty (Open Questions / Deferred Decisions / TBD-per-LLO / Phase-1-Discovery) with concrete questions, owner phases, resolution mechanisms. Anchors 9.5 → 4.0. Surfaces `[INFO] clean-source branch active` for auditability. Dimension-semantics fix, not deduction-tuning.

5. **Capture-method branching in `ocs-chatbot-eval` source-usage (0.10.10)** — Effort: S — Status: **done, shipped 0.10.10**
   - Commit: `4403515`
   - Outcome: The original "empty `cited_files` + body names sources → ≤5 cap" rule was meant to catch a pipeline bug. But `ocs-chatbot-qa` captures exclusively via the anonymous widget endpoint, which doesn't return inline citation markup regardless of bot grounding. The cap fired on every widget transcript — same noise/signal conflation as the Connect schema limit issue. Now: `ocs-chatbot-qa` writes `Capture method: widget | openai-compat` in the transcript header. `ocs-chatbot-eval` source-usage dimension branches on it. Widget captures grade body-text grounding (does the response name source docs by title? does it paraphrase content the KB demonstrably contains?) and emit `[PLATFORM] empty cited_files expected on widget capture` instead of binding the cap. OpenAI-compat captures keep the existing two-tier cap (empty `cited_files` there IS a real grounding gap).

### Backlog

P1 and P2 unblock the next calibration cycle; P3–P5 are post-real-run.

**P1 — Cross-model variance audit on the 4 provisional rubrics:**
- `connect-program-setup-eval`, `cycle-grade-eval`, `llo-launch-eval`, `flw-data-review-eval` are all provisional pending cross-model verification (Sonnet/Opus/Haiku spread ≤ 1.0). The audit can't run usefully against synthetic data — it needs real artifacts. Defer until a non-degraded production run produces the four input artifacts. The 0.10.7 rubric polish on `connect-program-setup-eval` should reduce its variance specifically (PLATFORM/DRIFT entries no longer randomly hit the inflation guard); next audit run is the test of that hypothesis.

**P2 — Real artifacts for the 4 provisional rubrics:**
- `connect-program-setup-eval` needs a non-degraded Phase 3 with `live_state_verified: true` (i.e., `connect_get_*` MCP calls succeeded). Now that 0.10.6 fixed the read-path bug and 0.10.1 fixed the opportunity creation 500, the next opp dispatch should produce one cleanly. Other three need: first launch (`llo-launch-eval`), first weekly review (`flw-data-review-eval`), first closed cycle (`cycle-grade-eval`). All are real-run blockers. Authoring rubrics in their absence repeats the original sin (rubrics that confidently score 8.5 on nothing) — explicitly documented as anti-pattern in `eval-calibration-learnings.md § 1`.

**P3 — Three minor operate-category rubrics (`llo-invite-eval` / `llo-onboarding-eval` / `llo-uat-eval`):**
- Mentioned as backlog in 0.9.11 + 0.10.6 memory updates. None ship today. Each is straightforward (mirror `flw-data-review-eval` structure: 5 dimensions, recurring shape, dated verdicts) but each needs ≥1 real run to calibrate against. Same blocker as P2: don't author without ground truth.

**P4 — Operator-effort tracking in `state.yaml`:**
- A meta-eval signal nobody has today: how many gate-iterate cycles per phase, how many minutes operators spend reviewing each gate brief, which skills produce the most "approve with caveats" rationale text. Lets us spot rubrics where the *operator* keeps overriding even when the rubric scores high. Design is the work; small implementation. Defer until at least one real cycle has flowed through cleanly so we know what the field shape should be.

**P5 — Drift between rubric prose and schema (preventer pattern):**
- 0.10.7 explicitly resynced `lib/verdict-schema.ts` with what 8 rubric SKILL.md files were claiming. The drift was harmless because nothing called `validateVerdict` at runtime on a real verdict — only the test does. Class-level preventer worth considering: hook a CI step (or `/ace:doctor`) that loads each `*-eval/SKILL.md`, regex-extracts every `verdict:` and `severity:` literal in YAML examples, and asserts each one is in the schema enum. Small effort; would prevent the next instance of the same drift. Backlog because it's preventer not blocker.

### Closed

**P1 from 2026-04-28-turmeric-dogfood-ocs-contracts.md (`set_chatbot_system_prompt` partial-save bug):** Already shipped in 0.6.4 (commit `cf45a59`, "transactional `set_chatbot_pipeline`"). Out-of-band closure during this session's prep read.

### Skipped on this run (raised but not formally proposed)

- **`/ace:doctor` post-update sweep** — offered to run it at session-end but user closed before invocation. Pre-existing CHANGELOG suggests doctor checks are mature (0.5.4 / 0.5.9 / 0.5.18 / 0.7.1 all added preventer probes); the load-error noted on `/reload-plugins` may or may not be ours. First action for the next session.
- **Re-grade `turmeric-market-survey-2026-04-28` against the new schema/rubric** — every release this session would change the verdict YAML for that opp. Skipped because re-grading without rerunning the underlying skill would just be testing the rubric against a frozen capture; the more useful test is to wait for the next opp run and let the new branches activate live. The 0.10.6 fix in particular needs a real `connect_get_program` read against a live program to confirm hydration works end-to-end.
- **Bumping `eval-calibration` skill itself with the new patterns** — `skills/eval-calibration/SKILL.md` is the methodology spec. The "operator-can't-fix" pattern is now durable enough to bake in (criteria for adding new severity tiers, how to detect when a dimension's input shape doesn't match its assumptions). Two paragraphs of work; deferred because it's better to wait for one or two more uses of the pattern before claiming it generalizes.

### Meta-observations

**What worked well:**

- **Five releases of size-S each beat one release of size-M.** Resisted the temptation to bundle 0.10.7 + 0.10.8 + 0.10.9 + 0.10.10 into a single "rubric polish pass." Per-release CHANGELOG entries plus per-rubric Change Log table rows preserve the audit trail at the granularity calibration actually needs (per `eval-calibration-learnings.md § Score trajectory across iterations is the audit trail`). Each release answers exactly one question; future cross-model audits can attribute variance to specific rubric edits without bisection.

- **Schema bump was load-bearing despite zero runtime impact.** `validateVerdict` only runs from tests today. But making the schema match the prose means the *next* time someone hooks runtime validation (CI, `/ace:doctor`, or a future `opp-eval` aggregator), every existing rubric still validates. Also gave the v2 changes a clean sentinel — `SCHEMA_VERSION === 2` is the marker for "PLATFORM/DRIFT/INFO-SKIPPED severities and partial/incomplete verdicts are formal, not aspirational."

- **The "operator-can't-fix" lens generalized fast.** Started as one polish item in `connect-program-setup-eval` (`[PLATFORM]` for Connect schema limits). Within the same session it absorbed three other findings (HITL-stub, clean-source, capture-method) that on inspection were all the same fix shape. Worth promoting to first-class rubric design rule, not just a fix recipe — added to `project_eval_framework_state.md` memory entry as the durable framing.

- **Verifying that the bug-the-rubric-caught was real.** Bug #2 from the prompt (Opportunity 500) was already fixed in 0.10.1 — confirmed before touching anything (commit `48e2380` was driven by the same turmeric run that the eval flagged). Bug #1 (Program "serialization") was unfixed and traced to a read-side hydration bug in 30 minutes once I read `getProgram` and `parseProgramsList`. The eval-framework-as-bug-finder claim in the docs is now grounded in two production bugs caught and fixed, not just one.

**What to do differently next time:**

- **Run `/reload-plugins` mid-session, not at end.** The 1-error-on-reload at session close means the new code path may already have a regression; we shipped 5 releases without exercising the loaded plugin once. A mid-session reload after 0.10.7 (when the schema bump landed) would have surfaced any plugin-load issue immediately. This generalizes: **after any schema or skill-prose change that the harness re-parses, reload before continuing.** Same class as "real run > spec review."

- **Don't guess root cause from a verdict YAML alone.** I came close to reproducing the rubric's own bias on bug #1 — almost wrote the fix as a write-side change before grepping for `getProgram`. The defect-vs-cause discipline rule (0.10.6) is the durable countermeasure for the rubric, but the same rule applies to **operators reading verdicts**: read the code, not the verdict's diagnosis.

- **Watch for stale prompt anchoring.** The session prompt was written at 0.9.11 and still framed everything as "0.9.12 backlog." Real version was 0.10.5. Caught the drift after one round of confused output but should be a default check at session start: "what version is `main` actually at, vs what the prompt claims?"

**Pattern emerging across sessions:**

- This session's "operator-can't-fix" lens, the 2026-04-28 session's "class-level preventers > instance-level fixes," and the 2026-04-19 session's "real run > spec review" are all variations of the same root principle: **rubric/contract design must distinguish noise from signal at the boundary, not at the consumer.** The `[PLATFORM]` severity tier IS a class-level preventer for false deductions; the schema enum extension IS a contract-level distinction; the HITL-stub guard IS a real-run-detected gap. Three sessions in, this looks like the dominant ACE design rule. Worth surfacing more prominently in `CLAUDE.md § Conventions` once one or two more uses confirm it generalizes.
