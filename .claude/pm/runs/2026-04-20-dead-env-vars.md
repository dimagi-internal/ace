## 2026-04-20 — adoption-blockers (dead env vars, second pass)

**Lens used:** adoption-blockers, explicitly re-run at user request after the 2026-04-20 morning env-drift cycle shipped well. Applied the key learning from that run: **read primary sources directly, don't trust tooling**. Step 1 was `diff <(keys from installed .env) <(keys from .env.tpl)` — confirmed the env-drift class (keys missing from env) was cleanly closed by 0.5.4–0.5.5 (16/16 match on my box).

**Background read:** `.claude/pm/context.md`, `.claude/pm/learnings.md` (31 entries now), prior runs `2026-04-19-qa-eval-iteration-loop.md` and `2026-04-20-env-drift-adoption-blockers.md`, `.env.tpl`, installed `~/.claude/plugins/data/ace-ace/.env`, `bin/ace-doctor`, `commands/{setup,doctor,ocs-login,ocs-bootstrap-template,run}.md`, `README.md`, `scripts/bootstrap-ocs-golden-template.ts`, `skills/ocs-agent-setup/SKILL.md`, `playbook/integrations/ocs-integration.md`.

**Core finding — the inverse subclass:** `env_drift` closed "keys in `.env.tpl` but missing from installed `.env`." The inverse subclass — **keys declared in `.env.tpl` with zero consumers in code** — was unaudited. `grep -rE "\b$KEY\b" mcp lib scripts skills bin hooks agents commands test` surfaced four dead vars:

- `OCS_GOLDEN_TEMPLATE_PUBLIC_ID` — printed by bootstrap, README step 6 tells user to paste into `.env`, **never read by any code.** The per-opp `ocs-agent-setup` skill retrieves its own `public_id` via `ocs_get_chatbot_embed_info` after cloning. The golden template's public_id is never referenced at runtime.
- `OCS_GOLDEN_TEMPLATE_EMBED_KEY` — same pattern, same dead code path.
- `OCS_PROD_TEAM_SLUG` — declared, injected from 1Password, zero consumers anywhere.
- `ACE_SESSION_STATE_DIR` — declared with value `~/.ace`, but every consumer hardcodes `path.join(os.homedir(), '.ace', ...)` rather than reading this var.

**Secondary finding:** `.env.example` is stale and redundant. Missing `ACE_DRIVE_ROOT_FOLDER_ID` (added 0.5.3) and `OCS_PROD_TEAM_SLUG`. Only one doc (`playbook/integrations/ocs-integration.md:19`) still pointed at it. Two-file pattern was a holdover from pre-1Password setup.

**Tertiary finding:** bootstrap output tells user to paste values into `.env`, but `.env.tpl` has `OCS_GOLDEN_TEMPLATE_ID` as an `op://` reference. Any future re-inject (triggered e.g. by `env_drift` on a new var) silently reverts the pasted value to whatever's in 1Password. The docs themselves contradicted the architecture.

### Do it

1. **P1 — Delete dead env vars + add class-level `unused_env_keys` doctor check** — Effort: S+ — Status: **done, pushed (PR #49)**
   - Removed `OCS_GOLDEN_TEMPLATE_PUBLIC_ID`, `OCS_GOLDEN_TEMPLATE_EMBED_KEY`, `OCS_PROD_TEAM_SLUG`, `ACE_SESSION_STATE_DIR` from `.env.tpl`
   - Updated `scripts/bootstrap-ocs-golden-template.ts` header comment (`.env.example` → `.env.tpl`), removed public_id/embed_key print lines
   - Updated `README.md` First-Run step 6 + `commands/ocs-bootstrap-template.md` expected-output block
   - Added `unused_env_keys` check to `bin/ace-doctor`: for each `KEY=` in `.env.tpl`, greps `mcp lib scripts skills bin hooks agents commands test`; WARNs on any key with zero consumers. Informational (WARN, not FAIL) per the 2026-04-15 learning.
   - Verified on-box: doctor now reports `PASS unused_env_keys: every .env.tpl key has at least one consumer`. Tests still 89/89.

2. **P2 — Delete `.env.example`** — Effort: S (trivial) — Status: **done, same PR**
   - `rm .env.example`
   - `playbook/integrations/ocs-integration.md:19` now points at `.env.tpl`
   - `.gitignore` comment updated

3. **P3 — Bootstrap output reframed: 1Password is source of truth** — Effort: S — Status: **done, same PR**
   - `scripts/bootstrap-ocs-golden-template.ts` "Add to your ACE .env:" block replaced with: (1) `op item edit "ACE - Open Chat Studio" "Config.golden_template_id[text]=<new_id>" --vault AI-Agents --account dimagi.1password.com`, (2) `op inject -i .env.tpl -o ~/.claude/plugins/data/ace-ace/.env --account dimagi.1password.com`, (3) `/reload-plugins`. The existing-template path (when bot already exists, not force) prints experiment_id + public_id with a note that no vault change is needed.
   - `commands/ocs-bootstrap-template.md` expected-output block mirrors the new script output, with a rationale paragraph explaining why local paste-to-`.env` fights `op inject`.
   - Per user direction: only fires on new/replaced template; existing-template path just echoes the id.

### Backlog

Carried forward from 2026-04-20 earlier (unchanged):

**P3** — `ocs_list_collections` MCP tool
**P4** — Archetype coverage audit (remaining silent atomic-visit defaults)
**P5** — Rubric proliferation
**P6** — Collection sync from ccc-support upstream (deferred)
**P7** — `fgd-synthesis` skill (deferred per user direction)

New from this cycle:

- **P8 — Wire up `ACE_SESSION_STATE_DIR` as a real knob, if someone ever needs it.** Removed as dead code here; re-add with a real consumer (`mcp/ocs/auth` reads it, falls back to `~/.ace`) when a concrete use case surfaces. Probably never — `~/.ace` is fine.
- **P9 — Doctor `unused_env_keys` check could also verify non-empty values** for required keys (analogous to how `drive_root` and `ocs_shared_collection` do today). Deferred — the current check catches the class we care about most (declared but unread). If a user ever injects with an empty 1Password field, the existing per-var checks catch the common cases.

### Closed

- **None new.** Same rationale as the 2026-04-20 earlier cycle: the class-level preventer (`unused_env_keys`) generalizes today's finding — any future dead-var addition gets caught automatically. Future proposals of the "remove $FOO, it's dead" shape should be redundant with doctor.

### Skipped on this run (raised but not formally proposed)

- **0.5.6 missing CHANGELOG entry.** Commit `f45549d` (llo-invite phase move) bumped VERSION to 0.5.6 but added no CHANGELOG stanza. Noticed while editing CHANGELOG.md for 0.5.7. Out of scope for this PM cycle; trivial fix if it lands in the next PR.
- **Worktree node_modules FAIL in `/ace:doctor --here`.** Dev ergonomics issue — worktrees don't inherit the parent repo's `node_modules`. Ran `npm test` successfully regardless (vitest found somehow). Not an adoption-blocker for operators; DX friction for contributors. Defer unless it blocks a contributor.
- **`scripts/bootstrap-ocs-golden-template.ts` step labels are inconsistent** (`[1/5]`, `[2/5]`, `[3/5]`, `[4/6]`, `[5/6]`, `[6/6]`) — pre-existing drift from when step 5 was added. Not adoption-blocking, trivial cosmetic fix if someone is touching the script anyway.

### Meta-observations

**What worked well:**

- **The class-level grep was the whole cycle in one command.** `grep -rE "\b$KEY\b" mcp lib scripts skills bin hooks agents commands test` against each `.env.tpl` key surfaced all four dead vars in under a minute. Made the scout feel mechanical — exactly the mode I want adoption-blockers scouts to be in.
- **Caught a bug in my own doctor check before shipping.** First draft of `unused_env_keys` used `grep -v '\.env'` to exclude env-file hits; that accidentally filtered `process.env.FOO` in JS/TS consumers. The doctor output flagged `OCS_USERNAME` and `OCS_PASSWORD` as unused — which I *knew* had a consumer at `mcp/ocs-server.ts:81-82`. Noticed the discrepancy, removed the broken filter, check now reports accurately. **Lesson: when a doctor check reports surprising results, don't ship — trace the disagreement first.**
- **Reading the script's own output block surfaced the P3 finding.** I wasn't planning to propose P3 until I re-read bootstrap's print statements while deleting the two dead lines. The "paste into .env" advice jumped out against the backdrop of the 2026-04-20 "vault values are hypotheses too" learning. Same pattern as the morning cycle: learnings.md compounds, lens-specific scouts pick up items that would otherwise drift.

**What was wasteful:**

- **I paused mid-scout to ask about OCS MCP and 22 capabilities.** User (correctly) steered me back to adoption-blockers. Lens discipline: stay in the lens until scout is complete, THEN consider related explorations as separate proposals. Adoption-blockers scout is cheap and bounded — don't fuse it with an integration-depth scout.
- **Debugging the grep in the doctor check took 3–4 tool calls** because I was running under zsh (word-splitting differs from bash). Wasted tokens tracing the wrong hypothesis. **Lesson: when a shell construct behaves unexpectedly, check `$BASH_VERSION` before assuming the script is wrong.** The doctor runs under bash (`#!/usr/bin/env bash`); my ad-hoc debug calls were under zsh (Bash tool's default). Different semantics for unquoted `$var` word-splitting.

**Prompt adjustments for next time:**

- **For adoption-blockers scouts, run both the forward and inverse diff.** Morning cycle did forward (tpl → env, keys missing from install). This cycle did inverse (tpl keys → codebase, keys without consumers). Both are one-line greps; do them together every time. Candidate for canopy update.
- **When adding a doctor check, unit-test it against a known-good case before shipping.** The `grep -v '\.env'` bug would have been caught by "verify that `OCS_USERNAME` shows up in consumers before trusting the output." Applies more broadly: any diagnostic that emits PASS/WARN/FAIL should be exercised against both states at authoring time. Related learning from 0.5.4 follow-up ("test the hint actually runs end-to-end"), extended to "test the check actually catches the thing it claims to catch."

**Confidence on validation:**

- **High on dead-var removal.** Verified by full-tree grep after removal: the four removed vars have zero remaining references in code paths (only `docs/superpowers/{specs,plans}/*` historical refs remain, explicitly frozen per CLAUDE.md).
- **High on `unused_env_keys` check.** Reports `PASS` against the cleaned `.env.tpl`; reports accurate `WARN` list if dead vars are re-added (verified by intentionally re-adding and checking output). Tests still 89/89 — the check is bash-only, no test surface change.
- **Medium on P3 reframe.** Not exercised against a live re-bootstrap. Would be strengthened by running `OCS_BOOTSTRAP_FORCE=1 npx tsx scripts/bootstrap-ocs-golden-template.ts` and visually verifying the new output block reads correctly. Left for manual post-merge smoke if anyone refreshes the template.

### Self-improvement (canopy-skills meta-PRs)

Two candidates:

1. **"For adoption-blockers scouts, run both the forward AND inverse diff."** Morning cycle's canopy candidate was "Step 1: diff installed config against template (forward)." Extend to: "Step 1a — forward diff: what keys in `.template` are missing from installed?  Step 1b — inverse sweep: what keys in `.template` have zero consumers in the code tree (grep -rE for each key against code-bearing dirs)?" Both surface adoption-blocker classes; both are cheap; together they close the dead-var subclasses at the template boundary.

2. **"Before shipping a diagnostic (doctor / health check / CI gate), exercise it against both PASS and FAIL states."** The 2026-04-20 follow-up rule ("run the `fix:` command at least once before landing") covers the remediation side. This cycle's bug — a grep filter that accidentally excluded real consumers — is the complementary failure: the check itself was wrong, reporting false positives. Rule addition: **any FAIL/WARN path should be exercised with a known-good input at authoring time** to confirm it doesn't misfire. Candidate for canopy's adoption-blockers lens AND the broader "writing checks" guidance if there is one.
