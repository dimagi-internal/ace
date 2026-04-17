## 2026-04-17 — internal-dimagi-admins (custom lens)

**Lens used:** "internal dimagi users who are going to be creating full opps via ace" — custom user-supplied arg, treated as an admin-group-coordination lens (how the 5-person CRISPR admin group actually uses ACE day-to-day when juggling multiple opps).

**Background read:** `.claude/pm/context.md`, `.claude/pm/learnings.md`, previous run log (2026-04-16 core-workflow-end-to-end). `commands/{run,step,status,doctor}.md`, `agents/{ace-orchestrator,design-review,connect-setup,llo-manager}.md`, `skills/{idea-to-pdd,ocs-chatbot-qa,app-deploy,llo-invite,llo-launch,timeline-monitor}/SKILL.md`, `test/fixtures/CRISPR-Test-00{1,3}-Turmeric/state.yaml`, `lib/artifact-manifest.ts`, `test/fixtures/artifact-manifest.test.ts`, `skills/README.md`, `README.md`. Mid-cycle: read the **CRISPR-Connect Vision and Plan** Google Doc (the user pointed to it after Phase 3 dispositions).

**Core finding:** 0.3.2 closed the "does the pipeline work end to end" gap. The remaining end-to-end risk is no longer mechanical — it's **legibility for the admin group**: who owns what, which opps need action, and what to actually check at each gate. Three state-schema + command spec edits addressed:

1. **`/ace:status` surfaces "which opps need me right now."** Pre-0.3.3 the list view was a flat `Phase | Step | Mode | Updated` — admins had to infer "needs action" by reading state.yaml per opp. Now each row carries a derived status tag (`ACTION NEEDED` / `RUNNING` / `IDLE` / `ERROR` / `DONE`) and a `Blocked on` column (`gate: <name>` / `error: <skill>` / `input: <file>`); rows sort `ACTION NEEDED` first.
2. **No "who's driving this" field in state.yaml.** With 5 admins and N opps, hand-offs (Neal → Matt on a Tuesday gate) had no attribution trail without Slack. Added `initiated_by` (one-time, at creation) and `last_actor` / `last_actor_at` (updated on every skill invocation, both `/ace:run` and `/ace:step`). `/ace:status` renders "last touched by X, N days ago"; `--mine` filters to the current operator's git-config email.
3. **Gate approvals were context-thin.** Pre-0.3.3 the orchestrator paused with a bare `AskUserQuestion`. The 2026-04-08 stress-test PDDs (both failed rubric) would have rubber-stamped through. Defined a uniform gate-brief contract: skill writes `gate-briefs/<gate>.md` with a fixed structure (artifact path, 3–5 imperative checklist items, auto-surfaced concerns tagged `[BLOCKER]` / `[WARN]` / `[INFO]`, recommended disposition). Orchestrator reads + displays verbatim before the `AskUserQuestion`. Missing brief = fail loudly.

### Do it

1. **P1 — Status tags + sort + `--mine` in `/ace:status`** — Effort: S-M — Status: **done, shipped 0.3.3**
   - Outcome: `commands/status.md` rewritten. Rule table (gate pending → ACTION NEEDED, step=error → ERROR, recurring-only → IDLE, cycle-grade=done → DONE) captured precisely. Default view drops `Mode` column (kept in detail view). Footer shows counts and --all hint.

2. **P2 — Add `initiated_by` / `last_actor` / `last_actor_at` to state.yaml** — Effort: S — Status: **done, shipped 0.3.3**
   - Outcome: new `## State Schema` and `## Touching State — Operator Capture` sections in `agents/ace-orchestrator.md`. `/ace:step` spec adds step 4 "Update operator identity" before dispatch. Source: `git config user.email`; fallback `unknown`. Identity is *captured, not enforced* — a git config mismatch just means `--mine` won't find the opp; no authorization check. Fixture state.yaml files updated for both CRISPR-Test-001 and CRISPR-Test-003-Turmeric. 76 existing tests still pass.

3. **P3 — Gate-brief contract + 5 skill emits + manifest entries** — Effort: M — Status: **done, shipped 0.3.3**
   - Outcome: `§ Gate Brief Contract` in `agents/ace-orchestrator.md` defines the required markdown shape (4 sections: Artifact Under Review, What to Check, Auto-Surfaced Concerns, Recommended Disposition). Each of the 5 gate-owning skills (`idea-to-pdd`, `app-deploy`, `ocs-chatbot-qa` `--deep` only, `llo-invite`, `llo-launch`) gained a `## Gate Brief` section naming the specific checklist items and concern signals for that gate. `lib/artifact-manifest.ts` gained 5 `gate-briefs/<gate>.md` entries (required, consumed by `ace-orchestrator`), one per phase where the producing skill lives. `CRISPR-Test-003-Turmeric` ships 5 stub gate briefs; `CRISPR-Test-001`'s `expectedMissing` list updated for 3 new design/commcare/connect gate briefs. Auto-mode contract: skills still write briefs, orchestrator doesn't pause, but a `[BLOCKER]` in an auto brief escalates to the admin group — admins opted into speed, not known-broken sends.

### Backlog

(none from this run — all 3 proposals dispositioned "Do it" and shipped as 0.3.3)

### Closed

(none from this run)

### Skipped on this run (raised but not formally proposed)

- **`/ace:abort <opp-name>`** — clean cancellation for experimental opps. Real need (admins will experiment with junk names, Drive folders will accumulate), but narrow — can `rm` the Drive folder manually today. Hold for a tech-debt lens.
- **Admin "Day 2" runbook** — a doc section explaining what admins approve at each gate, how hand-offs work, how to interpret `/ace:status`. Valuable but one-shot; the gate-brief checklists (P3) cover most of the per-gate question, and `/ace:status` UX (P1) covers most of the daily-triage question. Revisit if multiple admins hit the same onboarding question.
- **MSA / Work Order contracting flow** — the vision doc describes an MSA + WO model (LLOs know it's AI, MSA caps budget, each WO has accept + do-by deadlines, ace-mailing-list cc'd on every conversation). `llo-invite` today just produces a prepared list; there's no WO issuance, no deadline-tracker, no "LLOs know they're talking to AI" framing in the onboarding email. Substantial Phase 3/5 scope. A cycle of its own.
- **`/ace:status` recurring-skill signals** — surfacing "timeline-monitor hasn't run in 2 weeks" or "ocs-chatbot-qa --monitor score dropped 2 points" would be a richer IDLE row. Needs a trigger mechanism for recurring skills first (no scheduler today). Larger cycle.
- **Ownership enforcement** — an explicit "this opp is assigned to X" field with read/write boundaries. Deliberately *not* done. Identity-is-captured-not-enforced keeps the admin group frictionless.

### Meta-observations

**What worked well:**
- **Vision-doc read in Phase 3, not Phase 1.** The user dropped the CRISPR-Connect Vision and Plan doc *after* dispositions. Reading it after proposals were locked but before implementation was the right order: it reinforced P3 ("micromanage ACE" framing, "ACE going wrong" budget hedge, "easy for Dimagi humans to follow along") without derailing scope. If I'd read it in Phase 1, I would have been tempted to propose MSA/WO work that isn't ready for a cycle.
- **Identity-captured-not-enforced was the right call.** Temptation was to add "assigned_to" with per-opp ownership gates. Held the line — capture `last_actor`, let `--mine` be a filter, don't build a permission system for a 5-person team.
- **Gate brief as a separate file, not inline in the artifact.** Briefly considered inlining a "## Gate Brief" section inside `pdd.md` / `deployment-summary.md`. Separate files win: keeps artifacts clean for downstream skills that consume them, and each skill doesn't need to coordinate section-anchor conventions with its peers. Also makes the manifest-driven check trivial.
- **Reading all 5 gate-owning skills before writing any `## Gate Brief` section.** Each skill produces different-shaped output (PDD stress test vs. deployment summary vs. QA scorecard vs. invite list vs. launch record). Unifying the brief *shape* while letting each skill's *checklist* be domain-specific means admins get a consistent UX with context-specific content. Would have been worse to try to templatize the checklist itself.

**What was wasteful:**
- **`npm install` forgot to run before `npm test`, again.** Same friction as the 2026-04-16 cycle (vitest missing). The 2026-04-16 run noted this as a soft observation ("prime the env before scouting depths"); today I still hit it. Promoting to a concrete rule for my next run: **if the task is an implementation task on a Node project, run `npm install` as part of Phase 1 (scout) preflight, not when tests fail**. Planning to propose a universal-improvement PR at the bottom.
- **Initial draft of the gate-brief shape had 6 sections; trimmed to 4.** First pass had separate "Severity summary" and "Auto-Surfaced Concerns" sections and a "Related artifacts" bullet list. Collapsed all into the Concerns block (which already carries severity via tags) and removed the related-artifacts section (Artifact Under Review already has the primary path; admins who want more can open the Drive folder). Rule of thumb: if the brief is ~15 lines or fewer per gate, admins read it; 30 lines becomes another artifact to skim.

**Prompt adjustments for next time:**
- When adding required artifacts to `lib/artifact-manifest.ts`, **immediately** check the test file's `expectedMissing` hardcoded list for partial fixtures — new `required: true` entries must be added there too, or CRISPR-Test-001 goes red. Today I caught this by running the test; next time I should edit the test in the same commit as the manifest edit rather than discovering the gap.
- The vision-doc mid-cycle read showed that sometimes the user has more context to offer than what's in `context.md` — and that context is in a Google Doc, not the repo. Worth proactively checking (or asking) whether there's a strategy doc in Drive I should read at the start of a lens that touches roadmap, not just code shape.

**Confidence on validation:**
- **High on P1 (status rendering).** Purely a command-spec rewrite; rule table is deterministic and maps cleanly onto state.yaml fields that already exist plus the 3 new ones. A manual /ace:status trial against CRISPR-Test-001 / CRISPR-Test-003-Turmeric will confirm — left for a dry-run cycle.
- **High on P2 (ownership fields).** State schema extension is additive; existing fixtures updated; 76/76 tests pass. The only runtime risk is "skill / orchestrator forgets to update `last_actor`" — but that's a lint-level concern mitigated by the explicit contract in `§ Touching State`.
- **High on P3 (gate-brief contract).** Spec-level; each skill's `## Gate Brief` section names exact signal sources the skill already produces (stress-test grades for idea-to-pdd, pass/warn/fail counts for ocs-chatbot-qa, etc.). The 5 synthetic gate-brief stubs in CRISPR-Test-003-Turmeric show the shape concretely. Manifest test passes with zero missing / zero unexpected.

### Self-improvement (canopy-skills meta-PRs)

One observation worth consolidating:

**"Run `npm install` (or the language equivalent) as preflight in Phase 1 for Node / JS projects, not on first test failure."** This is the second cycle in a row where I hit `vitest: command not found` mid-implementation. The current PM skill's Phase 1 guidance says "Run the test suite — what passes, fails, is missing?" — it should add "and if the project has a lockfile, ensure deps are installed before scouting so the same `npm test` invocation works in Phase 4 (Implement) and Phase 5 (Validate)." Not a cycle-blocker but a consistent 1-2 minute tax. **Candidate for a future consolidation PR** (didn't merit a fresh PR today, but if it happens a third time, it promotes to a universal-PR candidate).

Beyond that: no fresh universal candidates. The "custom lenses from user args" pattern (three cycles in a row now) and the "build-a-fixture-before-writing-assertions" pattern (2026-04-16) are still standing observations; both still apply.
