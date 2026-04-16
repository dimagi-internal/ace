## 2026-04-16 — core-workflow-end-to-end (custom lens)

**Lens used:** "trying to make sure the core workflow works end to end" (custom — user-supplied arg, translated as a core-workflow-across-all-phases lens).

**Background read:** `.claude/pm/context.md`, `.claude/pm/learnings.md`, previous run log (2026-04-15 end-to-end-user-journey). `lib/artifact-manifest.ts`, `commands/{run,step}.md`, all 6 phase agents (`ace-orchestrator`, `design-review`, `commcare-setup`, `connect-setup`, `ocs-setup`, `llo-manager`, `closeout`), `test/fixtures/{CRISPR-Test-001,CRISPR-Test-002}/`, `test/fixtures/artifact-manifest.test.ts`, `CRISPR-Test-002/validation-2026-04-08.md`, a handful of skills (`ocs-chatbot-qa`, `idea-to-pdd`, `app-deploy`, `llo-onboarding`) for dry-run and input-contract details.

**Core finding:** 0.3.1 polished install and first-run. The remaining end-to-end risk is **across phases and across the full lifecycle**: fixture drift, silent prerequisite failures, and test coverage that stops at Phase 3.

Three distinct gaps between "install green" and "full pipeline runs":

1. **Fixtures' `state.yaml` predates the 0.2.0 phase restructure.** Listed 19 flat skills; missing `pdd-to-test-prompts` and any form of `ocs-chatbot-qa`. No phase grouping. Since the 2026-04-08 walk-through explicitly said "This is not an actual /ace:run," nobody had verified the current (post-0.2.0) pipeline against the current fixtures.
2. **`/ace:step` has no prerequisite check.** Violates the 2026-04-15 learning (`skills that read external-human inputs must fail loudly, not improvise`). `/ace:step ocs-chatbot-qa <opp> --deep` silently fails when `test-prompts.md` hasn't been produced.
3. **Manifest test only validates up to Phase 3.** `artifact-manifest.test.ts` line: `validateFixture(files, 'connect', ['README.md'])`. Phases 4–6 are uncovered — manifest drift in OCS, operate, or closeout won't trip CI.

### Do it

1. **P1 — Refresh CRISPR-Test-001 state.yaml + validation-2026-04-16.md** — Effort: M — Status: **done, shipped 0.3.2 (commit 29d7a45)**
   - Branch: `emdash/new-pm-8uq`
   - Outcome: `state.yaml` rewritten to a phases → skills nested map covering all 22 skills (including the three `ocs-chatbot-qa` modes). Gate list updated to the five actual review-mode gates. Fresh desk-trace walk-through at `test/fixtures/validation-2026-04-16.md` supersedes the 2026-04-08 doc; documents input/output flow through every phase, calls out remaining gaps for P2/P3.

2. **P2 — Prerequisite check in /ace:step via artifact manifest** — Effort: S-M — Status: **done, shipped 0.3.2**
   - Outcome: `commands/step.md` now specifies a manifest-driven check. Before dispatching, `artifactsConsumedBy(<skill>)` is enumerated; any missing `required: true` artifact (skipping `producedBy: external` and dated/recurring paths) fails loudly with an error that names each missing file and its producer skill. Closes the silent-failure bypass path.

3. **P3 (redirected) — CRISPR-Test-003-Turmeric complete E2E fixture + extended manifest test** — Effort: M+ — Status: **done, shipped 0.3.2**
   - Redirect from the user: instead of narrowing/widening the manifest test, build a **new** complete E2E fixture seeded from `docs/examples/pdd-turmeric-market-survey.md` and use it to test.
   - Outcome: new `test/fixtures/CRISPR-Test-003-Turmeric/` with every required artifact stubbed — idea/PDD/test-prompts through closeout/cycle-grade.md (27 artifact files + README + state). `artifact-manifest.test.ts` extended with two new assertions: zero unexpected files, zero missing required artifacts at `upToPhase: 'closeout'`. Both pass. 11 tests total in the manifest suite, 76 passing across the full `npm test` run.

### Backlog

(none from this run — all 3 proposals dispositioned "Do it" and shipped as 0.3.2)

### Closed

(none from this run)

### Skipped on this run (raised but not formally proposed)

- **Actually run `/ace:run CRISPR-Test-003-Turmeric --dry-run` in a separate session.** The fixture + refreshed state.yaml + validation doc make this much easier to do, but an actual live run against the MCPs is a separate qualification effort. Noted as follow-up — worth its own cycle if the fixture shape surfaces unexpected friction when dispatched through a real orchestrator.
- **Orchestrator reading artifact-manifest for its own prereq checks.** P2 wires this into `/ace:step`, but the orchestrator itself could benefit from the same manifest lookup on each phase transition (defense in depth). Out of scope for "one cohesive cycle" and the orchestrator already runs skills in dependency order. Revisit if manifest drift shows up in the live path despite P3's CI coverage.
- **Documenting the 3-fixture contract.** `CRISPR-Test-001` = partial input fixture for `ocs-agent-setup`; `CRISPR-Test-002` = focus-group/archetype-stress fixture (Phase 1–3); `CRISPR-Test-003-Turmeric` = complete E2E. A README in `test/fixtures/` would disambiguate. Hold for a tech-debt lens.

### Meta-observations

**What worked well:**
- Following the 2026-04-15 U1 pattern — treating the user's custom string ("trying to make sure the core workflow works end to end") directly as a lens — worked cleanly again. The three proposals all fell out of the lens naturally without my having to snap it onto the canonical rotation list.
- Reading the artifact manifest (`lib/artifact-manifest.ts`) before proposing was load-bearing. The list of required artifacts per phase told me exactly what needed to exist in the E2E fixture; `artifactsConsumedBy()` was the missing piece that /ace:step wanted.
- The redirect on P3 produced a strictly better outcome. My original proposal was "extend the test." The user's redirect was "build a new fixture seeded from turmeric PDD and use that to test." The new fixture is also a tech-debt and onboarding asset, not just a CI check — so the same work buys more value. Worth remembering: when the user redirects, the reshaped version often covers both the original scope AND an orthogonal benefit.
- Validating fixture coverage by running the test (`npm test -- test/fixtures/artifact-manifest.test.ts`) as I went, not at the end, caught one iteration of "did I actually hit every required artifact?" without a silent gap slipping through.

**What was wasteful:**
- The first `npm test` invocation hit `vitest: command not found` because node_modules was stale in the worktree. Running `npm install` upfront during Phase 1 would have avoided the mid-P3 friction. Next cycle: when I know I'm going to be running tests, prime the env before scouting depths.
- I created the fixture directory tree with one `mkdir -p` and wrote files in two batches of 5–6 at a time. The batching was fine for prompt-output length but required more sequential rounds than necessary. A single parallel-write-all batch would have been faster.
- The proposal table in the scouting output was reasonably dense but included the full "What / Why / Validate" text inside each `AskUserQuestion` — which worked, but the questions were long. Could have been tighter with links to a per-proposal section in the run log.

**Prompt adjustments for next time:**
- When a fixture is load-bearing for a test, check the test assertions BEFORE writing the fixture, not after. I did this in the right order (read `expectedMissing` list first), but it's worth making a reflex rule.
- When the lens is "does X work end to end," the move is *always* to write/refresh a dry-run trace document. That's the only artifact that lets a human see the full flow without running the plugin. Make that the default first deliverable for this class of lens.

**Confidence on validation:**
- **High on P2 (command-level prereq check).** Purely specification-level; the contract is testable once an implementation exists. The learnings.md preference already exists to guide anyone reading it.
- **High on P3 (fixture + test extension).** Tests pass with zero missing / zero unexpected. Any manifest drift now fails loudly.
- **Medium on P1 (state.yaml schema refresh).** The schema is structurally consistent with orchestrator/agent specs, but the orchestrator doesn't have code that *enforces* the nested shape — a human reads state.yaml in review mode. If the live orchestrator flattens or re-interprets the schema silently, the refresh may need another pass.

### Self-improvement (canopy-skills meta-PRs)

No universal-improvement candidates that warrant a fresh PR this cycle. The two standing observations from 2026-04-08 and 2026-04-15 still apply:
- **Custom lenses from user args work well** (U1 — already a pending PR from last cycle). Re-validated again today.
- **Phase 4-ish "smoke-test your work before committing"** is the closest thing to a new universal observation from this cycle — I hit a fresh instance of it with the stale `vitest` binary. Not strong enough to justify its own PR; the existing Phase 4 "Fix the issues and re-run validation" already covers this implicitly.

One soft observation specific to this class of "across-all-phases" lens: the PM skill's scout-phase guidance says "Run the test suite — what passes, fails, is missing?" but doesn't call out that **fixture drift against a specification/manifest is a distinct failure mode from tests failing**. Today's scout found three gaps that all showed up as "tests pass" — a working test suite with stale assumptions is a harder failure to see than a red test. Not worth a meta-PR on its own, but noting it for a future consolidation pass.
