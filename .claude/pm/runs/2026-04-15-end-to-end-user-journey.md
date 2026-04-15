## 2026-04-15 — end-to-end-user-journey (custom lens)

**Lens used:** "someone just tryin to use ace end to end to build out a program and deploy it" (custom — user-supplied phrasing, essentially an adoption-blocker / first-run-journey hybrid).

**Background read:** `README.md`, `CLAUDE.md`, `agents/ace-orchestrator.md`, `agents/design-review.md`, `skills/idea-to-pdd/SKILL.md`, `commands/run.md`, `commands/step.md`, `commands/status.md`, `commands/setup.md`, `commands/doctor.md`, `commands/ocs-login.md`, `commands/ocs-bootstrap-template.md`, `bin/ace-doctor`, `.env.tpl`, top of `lib/artifact-manifest.ts`. Also confirmed recent restructure via `git log` (6-phase pipeline since 0.2.0, PDD rename in 0.3.0).

**Core finding:** the install story is polished (`/ace:setup`, `/ace:doctor`, `/ace:update` all ship green checks), but the **first-run story is a silent cliff**. Three distinct gaps a new end-to-end user hits between "doctor green" and "first opp deployed":

1. **`idea.md` has no bootstrap path.** `idea-to-pdd` reads from `ACE/<opp>/idea.md`; the artifact manifest marks it `producedBy: 'external'`; the orchestrator's "Starting a New Opportunity" section (lines 119–124 pre-fix) just said "create folder, init state.yaml, begin Phase 1". A fresh `/ace:run my-new-opp` either fails deep in Phase 1 or has the LLM improvise an idea — neither is acceptable.
2. **README Quick Start doesn't match the real first-run.** Only listed `setup` / `doctor` / `run`. Missing the `.env` injection (required for OCS MCP + Gmail), `/ace:ocs-login`, and `/ace:ocs-bootstrap-template` — users succeed through Phase 3 then hit a wall at Phase 4. Architecture counts also stale (6 agents / 21 skills vs. real 8 / 22).
3. **`/ace:doctor` only checked install-time state.** No `.env` check, no OCS env var check, no OCS Playwright session check, no Gmail config check. A green doctor could still hand a user a broken runtime.

### Do it

1. **P1 — Orchestrator idea capture** — Effort: M — Status: **done, PR #30**
   - Branch: `emdash/all-areas-argue-9lk`
   - PR: jjackson/ace#30
   - Outcome: `ace-orchestrator.md` "Starting a New Opportunity" now checks for `ACE/<opp>/idea.md` and prompts via `AskUserQuestion` for inline paste / Drive URL / abort if missing. `idea-to-pdd/SKILL.md` also fails fast with an actionable error when invoked via `/ace:step` without the file, instead of improvising an idea. Two layers of defense against the silent-failure mode.

2. **P2 — README first-run walkthrough + stale counts** — Effort: S — Status: **done, PR #30**
   - Branch: `emdash/all-areas-argue-9lk`
   - PR: jjackson/ace#30
   - Outcome: New "First-Run Walkthrough" section with the ordered 8-step checklist (install → setup → GWS key → op inject .env → /ace:ocs-login → /ace:ocs-bootstrap-template → /ace:doctor → /ace:run --dry-run). Architecture section updated to 8 agents (with correct phase agent names) / 22 skills / 6 phases.

3. **P3 — /ace:doctor runtime readiness** — Effort: S — Status: **done, PR #30**
   - Branch: `emdash/all-areas-argue-9lk`
   - PR: jjackson/ace#30
   - Outcome: `bin/ace-doctor` gains WARN-level checks for `env_file`, `ocs_env` (all three of OCS_BASE_URL / OCS_TEAM_SLUG / OCS_GOLDEN_TEMPLATE_ID), `gmail_config` (ACE_GMAIL_ACCOUNT), and `ocs_session` (~/.ace/ocs-session-<team>.json with > 30 day freshness warning). Unresolved `op://…` references treated as missing. Each WARN has a concrete `fix:` hint pointing at the right command (`op inject`, `/ace:ocs-login`, `/ace:ocs-bootstrap-template`). Verified live: on my configured machine it reports 1 genuine WARN (gmail_config) where I hadn't populated 1Password.

### Backlog

(none from this run — all 3 proposals were dispositioned "Do it" and shipped together in PR #30)

### Closed

(none from this run)

### Skipped on this run (raised but not formally proposed)

- **Orchestrator pre-flight doctor call.** Considered proposing a 4th item: before dispatching Phase 1, have the orchestrator invoke `/ace:doctor` internally and bail if any WARN / FAIL is relevant to the phases about to run. With P1 (idea capture) and P3 (runtime WARNs) shipped, this becomes lower-value glue work — the user already gets actionable feedback if they run `/ace:doctor` first, and the P2 walkthrough puts that in their face. Revisit if users still report "I didn't know I needed X" after these changes land.
- **Make `/ace:docs` regenerate the README architecture counts.** Today's stale counts (fixed in P2) will rot again on the next restructure unless the numbers come from `/ace:docs` output rather than hand-edited prose. Potentially a one-line section in the generated playbook that README includes or links to. Hold for a future `tech-debt` lens.
- **Warning-to-step traceability in doctor.** `env_file` WARN has a `fix:` command, but that command assumes the user has 1Password CLI set up. A deeper version would probe for `op` availability and chain fixes. Out of scope for today's tight "fix the cliff" cycle.

### Meta-observations

**What worked well:**
- The lens was another custom string ("someone just tryin to use ACE end to end…"), and per the U1 improvement proposed last cycle, I used it directly without translating to the rotation list. Worked cleanly — the finding structure fell out of the lens itself.
- Running `bin/ace-doctor --here` on my own machine mid-implementation caught a real bug in my first pass (I'd forgotten to strip single quotes from env values, so `OCS_TEAM_SLUG='connect-ace'` was treated as `'connect-ace'` with quotes). Smoke-testing the script against a live environment before committing saved a round-trip.
- The 3-proposal cap worked here (unlike last cycle where 4 interdependent items wanted to ship together). These three are loosely coupled: P1 and P3 are both about "catch the failure before the user falls off the cliff," P2 is about narrative. They would have been fine to ship separately, but bundling was fine too.
- Pre-commit hook auto-synced `VERSION` to `package.json` / `plugin.json` / `marketplace.json` — the "edit VERSION only" rule from memory held up.
- Reading the artifact manifest (`lib/artifact-manifest.ts`) was load-bearing for P1. The line `producedBy: 'external'` was the smoking gun that confirmed idea.md had no programmatic source. Without that I might have wasted time hunting for an existing bootstrap skill.

**What was wasteful:**
- I initially tried to `Write` VERSION without reading it first — hit the "must read first" guard. Small friction, but avoidable; the Read→Write rule should be reflex by now.
- Two `Read` calls on the same CHANGELOG (the Write guard again). Edit would have worked without either read since I was only appending at the top.
- Ran `npm install` silently then had to `ls node_modules/.bin/tsx` to confirm. `npm install` was ~30s of silent wait where I could have also been verifying the doctor script in parallel.

**Prompt adjustments for next time:**
- The "fresh-user journey" lens is generative — it produced three proposals that together cover a cohesive user story (the first-run). Worth adding to the standard rotation or mental toolkit alongside `adoption-blockers`. It's more specific / actionable than `user-value`.
- When reviewing "runtime" (vs. "install") health, distinguish clearly between FAIL (tool won't run at all) and WARN (tool runs but a specific feature will fail). P3 was right to use WARN, not FAIL — the doctor would otherwise scream at a user who only wanted to do a design-review run.

**Confidence on validation:**
- High on P3 — I ran `bin/ace-doctor --here` on my configured machine, saw the expected PASS / WARN / PASS / WARN / PASS output, and one WARN turned out to match reality (`ACE_GMAIL_ACCOUNT` really isn't set in my `.env`).
- Medium on P1 — the orchestrator + skill edits are prompt-level, so real validation requires running `/ace:run test-opp` in a fresh session with an empty Drive folder. The PR test plan flags this explicitly.
- High on P2 — purely documentation; I verified the walkthrough covers every prerequisite mentioned in `.env.tpl` comments and in `ocs-bootstrap-template.md`'s prereq list.

### Self-improvement (canopy-skills meta-PRs)

No universal-improvement candidates surfaced this cycle that weren't already proposed last time. The U1 / U2 / U3 PRs from 2026-04-08 (custom-lens support, soft top-N cap, framework-changes-mean-variation-points) are still the relevant unmerged learnings; this run re-validated U1 and U2 in practice without needing a new PR.

One soft observation: the `product-management` skill's Phase 1 guidance doesn't emphasize **smoke-testing your implementation on your own machine before committing**, which caught a real bug for me on P3. The existing "If validation fails: Fix the issues and re-run validation" language in Phase 4 covers this implicitly but doesn't promote it to a core practice. Noting here for a future consolidation pass rather than a one-off PR.
