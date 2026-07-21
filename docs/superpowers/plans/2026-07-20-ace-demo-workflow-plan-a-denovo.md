# ACE Demo Workflow — Plan A (standalone de-novo demo pipeline)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standalone `/ace:demo --source denovo` that stands up a live labs dashboard from a short brief and hands it to the canopy DDD loop — proving the DDD-native, provider-parameterized architecture end-to-end with no Connect Labs code changes.

**Architecture:** A thin ACE front-end over existing dynamic primitives. `demo-data-setup` generates synthetic data + authors a dashboard dynamically via the labs atoms (the same atoms Phase 7's `synthetic-data-generate` + `synthetic-workflow-seed` already use) and returns the realized `${var}` map (`par_url`). `demo-narrative` authors a canopy DDD `WhyBrief` + `UnifiedSpec` whose scenes render `${par_url}` and whose `setup` block re-runs the generation. A level-0 `demo` procedure orchestrates setup → narrate → hand to `/canopy:ddd-run`. State is a minimal structural `run_state.yaml` with one live phase.

**Tech Stack:** TypeScript MCP atoms (`ace-connect`, `connect-labs` remote); ACE Markdown skills + procedure docs + slash commands; canopy DDD python (`scripts/ddd/validate`, `canopy:ddd` / `/canopy:ddd-run`); vitest; run-state validator (`lib/run-state-validator.ts`).

## Global Constraints

- **VERSION is the single source of truth.** Bump via `bash scripts/version-bump.sh` (worktree-safe); pre-commit hook syncs the other 3 files. Never hand-edit `package.json` / `plugin.json` / `marketplace.json`.
- **Ship via PR to branch-protected `main`.** `git push -u origin <branch>` → `gh pr create` → `gh pr merge <pr> --auto --merge`. Then `/ace:update` in-session after merge.
- **Run `npx tsc --noEmit` before every push** — CI `clean-install` type-checks; vitest does not.
- **Skills are stateless.** Per-demo state lives in Drive `ACE/<demo-name>/`. No local state in `SKILL.md`.
- **SKILL.md dir name = frontmatter `name:` exactly** (kebab-case verb phrase).
- **Level-0 topology rule:** anything that calls `Agent` must run at level 0 (procedure doc executed inline), never as a subagent. `/ace:demo` dispatches the DDD agent → it is a procedure doc, not a subagent.
- **Structural state, not flags** (`docs/learnings/2026-06-01-seeded-run-structural-not-flags.md`): demo run shape lives in `run_state.yaml.phases.*.status`, never in a `/ace:demo` flag the model may drop.
- **Grep `docs/atom-schemas.md` for atom signatures** — never paraphrase. This plan adds NO new atoms, so that file does not change.
- **Reference skills (mirror, don't reinvent):** `skills/synthetic-data-generate/SKILL.md`, `skills/synthetic-workflow-seed/SKILL.md`, `skills/synthetic-workflow-polish/SKILL.md`, and the recipe in `hal:synthetic-walkthrough` (`~/emdash/repositories/hal/skills/synthetic-walkthrough/SKILL.md`).
- **Labs realized-map contract:** the generation step must return a flat JSON `${var}` map containing at least `par_url` (a `/labs/workflow/<def>/run/?run_id=<rid>&opportunity_id=<opp>` deep-link) plus any drill URLs. This is the ONLY handoff downstream consumes.
- **Labs gotchas to encode** (spec §6): opp ids ≥ 10,000 are labs-only (no HQ app); pin the timeline to a fixed Monday; do NOT pre-seed the flagged current-week worker's audit/task (created on-camera); first persona = network manager (flag-rate 0); a "resolved" cluster needs all audits completed + all tasks closed; anomaly weeks 0-based (audits) vs coaching-arc weeks 1-based (tasks).

---

## File Structure

- `docs/superpowers/plans/2026-07-20-ace-demo-workflow-plan-a-denovo.md` — this plan.
- `docs/superpowers/plans/2026-07-20-plan-a-task1-findings.md` — Task 1 discovery output (created in Task 1).
- `lib/demo-run-state.ts` — pure builder for the minimal structural demo `run_state.yaml`. One responsibility: emit a contract-valid single-live-phase run-state object.
- `test/lib/demo-run-state.test.ts` — vitest for the builder, asserting `classifyPhaseWriteBack` / `validate_run_state` acceptance.
- `skills/demo-data-setup/SKILL.md` — denovo data + dynamic dashboard authoring → realized map.
- `skills/demo-data-setup-qa/SKILL.md` — structural QA gate for the realized map.
- `skills/demo-narrative/SKILL.md` — author + validate the DDD `WhyBrief` + `UnifiedSpec`.
- `agents/demo.md` — level-0 procedure doc: orchestrate setup → narrate → DDD handoff.
- `commands/demo.md` — `/ace:demo` slash command that reads and executes `agents/demo.md`.
- `CLAUDE.md`, `playbook/integrations/connect-labs.md` — doc updates.
- `docs/learnings/2026-07-20-demo-workflow-ddd-native.md` — durable learning.

---

## Task 1: Discovery & preflight (live audit + canopy invocation mechanics)

Discovery task. No code ships; it locks the exact atom sequence and canopy handoff so later tasks are not speculative. Deliverable: a committed findings note.

**Files:**
- Create: `docs/superpowers/plans/2026-07-20-plan-a-task1-findings.md`

- [ ] **Step 1: Confirm the denovo atom set exists live.** Verify each atom is in the live `connect-labs` MCP `tools/list` (they should be — Phase 7 uses them): `synthetic_generate_from_manifest`, `synthetic_create_labs_only`, `workflow_create`, `workflow_update_definition`, `workflow_update_render_code`, `workflow_patch_render_code`, `pipeline_update_schema`, `workflow_create_run`, `workflow_save_snapshot`, `workflow_get`, `synthetic_env_ensure`, `synthetic_env_list`. Use `ToolSearch("select:mcp__connect_labs__workflow_create,...")` or curl the live `tools/list`. Record which are present.

- [ ] **Step 2: Capture a real realized-map shape.** Run `mcp__connect_labs__synthetic_env_ensure` with `env=program-admin-report` once (idempotent, self-cleaning) and record the returned realized `${var}` map verbatim into the findings note — specifically the `par_url` and any drill URLs. This is the concrete contract Task 3 must reproduce and Task 4 consumes.

- [ ] **Step 3: Lock the canopy handoff mechanics.** Locate the canopy checkout (`find ~/emdash* -maxdepth 4 -type d -name canopy`; expect `~/emdash-projects/canopy/`). Record: (a) the exact shell command to validate a spec — `cd <canopy> && uv run python -m scripts.ddd.validate unified_spec <path>` and `... why_brief <path>` (confirm module path from `scripts/ddd/validate.py`); (b) how to run one render+judge — the `/canopy:ddd-run` command args (`run_id`, `unified_spec`, `why_brief`); (c) that `base_url` for scenes is `https://labs.connect.dimagi.com`. Mirror `hal:synthetic-walkthrough` for the `uv`-from-canopy pattern.

- [ ] **Step 4: Record the narrative JSON Schema location.** From `scripts/ddd/validate.py` (`dump_json_schemas`, ~line 239) note where the published JSON Schemas land (`scripts/narrative/schema/json/`), and the required `Scene` fields Task 4 must emit: `persona, title, show, concept_claim, provenance (→ spine id), role, features[] (≥1 with description+verify for demo scenes), url, actions[]`, plus the top-level `setup` block (`command`, `outputs`, `rerun`).

- [ ] **Step 5: Write and commit the findings note.**

Contents: the confirmed atom list, the captured realized-map (with `par_url`), the exact canopy validate + `/canopy:ddd-run` commands, and the `Scene`/`setup` required fields. End with an explicit line: **"Denovo path needs zero labs changes: confirmed / NOT confirmed (reason)."**

```bash
git add docs/superpowers/plans/2026-07-20-plan-a-task1-findings.md
git commit -m "docs(plan-a): Task 1 discovery — denovo atoms + canopy handoff locked"
```

**Acceptance:** findings note committed; the "zero labs changes" line is `confirmed`. If NOT confirmed, STOP and escalate — a labs gap moves work into Plan B before Plan A can proceed.

---

## Task 2: Minimal demo run-state scaffold (`lib/demo-run-state.ts`)

The one clean code+test task. A pure builder that emits a structural `run_state.yaml` object with exactly one live phase (`synthetic-data-and-workflows`) and all others `not-applicable`, valid under the Phase Write-Back Contract.

**Files:**
- Create: `lib/demo-run-state.ts`
- Test: `test/lib/demo-run-state.test.ts`

**Interfaces:**
- Consumes: `classifyPhaseWriteBack`, `validateRunState` from `lib/run-state-validator.ts` (confirm exact export names in Step 1).
- Produces: `buildDemoRunState(opts: { demoName: string; runId: string; source: 'denovo' | 'clone' | 'ace-run'; createdAt: string }): DemoRunState` — a plain object serializable to `run_state.yaml`, with `run_type: 'demo'`, `phases['synthetic-data-and-workflows'].status: 'in-progress'`, and every other pipeline phase `status: 'not-applicable'`.

- [ ] **Step 1: Read the validator contract.** Open `lib/run-state-validator.ts`; note the exact exported function names + the required per-phase keys (`status`, `verdict`, `completed_at`, `summary_artifact`, `steps`) and the allowed `status` enum (confirm `not-applicable` is accepted; if not, use the accepted "skipped"-class value the validator permits and record which).

- [ ] **Step 2: Write the failing test.**

```typescript
// test/lib/demo-run-state.test.ts
import { describe, it, expect } from 'vitest'
import { buildDemoRunState } from '../../lib/demo-run-state'
import { classifyPhaseWriteBack } from '../../lib/run-state-validator'

describe('buildDemoRunState', () => {
  const rs = buildDemoRunState({
    demoName: 'op-ensorvation-nutrition',
    runId: 'demo-20260720-1200',
    source: 'denovo',
    createdAt: '2026-07-20T12:00:00Z',
  })

  it('marks only the synthetic phase live', () => {
    expect(rs.phases['synthetic-data-and-workflows'].status).toBe('in-progress')
    expect(rs.phases['connect-setup'].status).toBe('not-applicable')
    expect(rs.phases['idea-to-design'].status).toBe('not-applicable')
  })

  it('records demo run_type and source', () => {
    expect(rs.run_type).toBe('demo')
    expect(rs.phases['synthetic-data-and-workflows'].products?.synthetic?.source?.provider).toBe('denovo')
  })

  it('passes the phase write-back classifier for the live phase', () => {
    const verdict = classifyPhaseWriteBack(rs, 'synthetic-data-and-workflows')
    expect(verdict).not.toBe('malformed')
  })
})
```

- [ ] **Step 3: Run test to verify it fails.** `npx vitest run test/lib/demo-run-state.test.ts` — expect FAIL ("Cannot find module '../../lib/demo-run-state'").

- [ ] **Step 4: Implement `buildDemoRunState`.** Emit a full run-state object: top-level `run_type`, `run_id`, `demo_name`, `created_at`; a `phases` map containing every pipeline phase (`idea-to-design`, `scenarios-and-acceptance`, `commcare-setup`, `connect-setup`, `ocs-setup`, `qa-and-training`, `synthetic-data-and-workflows`, `solicitation-management`, `execution-management`, `closeout`), all `not-applicable` except the synthetic phase which is `in-progress` with an initialized `products.synthetic.source = { provider }` and the required contract keys present (`verdict: null`, `completed_at: null`, `summary_artifact: null`, `steps: []`). Match the exact key names the validator requires (from Step 1).

- [ ] **Step 5: Run test to verify it passes.** `npx vitest run test/lib/demo-run-state.test.ts` — expect PASS. Then `npx tsc --noEmit` — expect clean.

- [ ] **Step 6: Commit.**

```bash
git add lib/demo-run-state.ts test/lib/demo-run-state.test.ts
git commit -m "feat(demo): minimal structural demo run-state builder"
```

---

## Task 3: `demo-data-setup` skill (denovo provider)

Authoring task. Deliverable is a `SKILL.md` that produces a live-rendering `par_url`. Verified by a live smoke + the skill-atom drift test. Mirror `synthetic-data-generate` + `synthetic-workflow-seed` — this skill is their denovo-parameterized composition, not new generation logic.

**Files:**
- Create: `skills/demo-data-setup/SKILL.md`
- Create: `skills/demo-data-setup-qa/SKILL.md`
- Reference: `skills/synthetic-data-generate/SKILL.md`, `skills/synthetic-workflow-seed/SKILL.md`, `skills/synthetic-workflow-polish/SKILL.md`

**Interfaces:**
- Consumes: a demo brief (inline text or Drive path) + `demoName` + the demo `runId`; `buildDemoRunState` output (Task 2) as the state it writes into.
- Produces: writes `phases.synthetic-data-and-workflows.products.synthetic.source` = the realized-map contract: `{ provider: 'denovo', labs_synthetic_opp_id, deliver_units[], narrative_context_ref, realized_vars: { par_url, ...drills } }`, and a `realized.json` artifact in the demo run folder. `par_url` MUST render a live dashboard.

- [ ] **Step 1: Author `skills/demo-data-setup/SKILL.md`.** Required sections/contract (concrete, not placeholder):
  - **Frontmatter:** `name: demo-data-setup`, description naming the three providers but this skill implements `denovo` only in Plan A (`clone`/`ace-run` documented as "see Plan B / Phase 7").
  - **Inputs:** brief, demoName, runId, optional `--pin-monday <YYYY-MM-DD>` (default: compute a fixed recent Monday and record it — never a sliding window).
  - **Step: author the per-opp generator manifest** from the brief — `flw_personas` (first = network manager, `flag_rate: 0`), `anomalies` (0-based weeks), `coaching_arcs` (1-based `week_triggered`, verbatim transcripts), pinned `timeline.start_date`, opp ids ≥ 10,000. Cross-reference the manifest-schema gotchas section of `synthetic-data-generate`.
  - **Step: generate data** via `synthetic_generate_from_manifest` (+ `synthetic_create_labs_only` for the labs-only opp), exactly as `synthetic-data-generate` does.
  - **Step: author the dashboard dynamically** via `workflow_create` → `pipeline_update_schema` → `workflow_update_render_code`/`workflow_patch_render_code` → `workflow_create_run` → `workflow_save_snapshot`, exactly as `synthetic-workflow-seed` does (ADAPT-or-SCRATCH). Reuse its alias-consistency + period-scoping + snapshot-hook guidance by reference.
  - **Step: build `par_url`** from the saved `run_id` + `def_id` + `opp_id` (the `/labs/workflow/<def>/run/?run_id=<rid>&opportunity_id=<opp>` shape — the bare workflow URL renders the picker, per `docs/learnings/2026-06-13-labs-workflow-run-deeplink.md`).
  - **Step: write-back** the realized-map contract into `run_state` + emit `realized.json`.
  - **Encode every §6 gotcha inline** as a checklist.

- [ ] **Step 2: Author `skills/demo-data-setup-qa/SKILL.md`.** Binary structural gate (no LLM): asserts `realized.json` exists, `par_url` matches the deep-link regex `^https://labs\.connect\.dimagi\.com/labs/workflow/\d+/run/\?run_id=[^&]+&opportunity_id=\d+$`, `labs_synthetic_opp_id` ≥ 10000, timeline is pinned (not sliding), and the flagged current-week worker has NO pre-seeded audit/task. Verdict shape per `lib/verdict-schema.ts`.

- [ ] **Step 3: Verify no atom-reference drift.** `npx vitest run test/skill-atom-references.test.ts` — expect PASS (every atom-shaped token in the new skill resolves to a registered atom). Fix any typo'd atom name until green.

- [ ] **Step 4: Live smoke.** In-session, invoke the skill against a tiny throwaway nutrition brief with `demoName: plan-a-smoke`. Confirm it returns a `par_url` and that opening it (authed browse, per `hal:synthetic-walkthrough` §1/§3) renders a populated dashboard — not the run picker, not an empty grid. Record the `par_url` in the commit message.

- [ ] **Step 5: Commit.**

```bash
git add skills/demo-data-setup/SKILL.md skills/demo-data-setup-qa/SKILL.md
git commit -m "feat(demo): demo-data-setup (denovo) — dynamic data+dashboard → live par_url"
```

**Acceptance:** `skill-atom-references` green; the live smoke's `par_url` renders a populated dashboard.

---

## Task 4: `demo-narrative` skill

Author a canopy DDD `WhyBrief` + `UnifiedSpec` from the brief + realized map. Verified by canopy's own validator — the authoritative gate.

**Files:**
- Create: `skills/demo-narrative/SKILL.md`
- Reference: canopy `scripts/narrative/models.py`, `scripts/ddd/validate.py`; the PAR reference spec `~/emdash/repositories/connect-labs/docs/walkthroughs/program-admin-report.yaml`.

**Interfaces:**
- Consumes: the demo brief + the realized map from Task 3 (`par_url` + drills + `narrative_context_ref`).
- Produces: two files in the demo run folder — `why_brief.yaml` (`WhyBrief`) and `docs/walkthroughs/<demo-slug>.yaml` (`UnifiedSpec`) — both passing canopy `scripts/ddd/validate`. The `UnifiedSpec.setup.command` re-invokes the Task-3 generation and `outputs` points at `realized.json`; scenes use `url: ${par_url}` (+ drill vars).

- [ ] **Step 1: Author `skills/demo-narrative/SKILL.md`.** Required contract:
  - **Frontmatter:** `name: demo-narrative`.
  - **Output 1 — `why_brief.yaml`:** `narrative_slug`, `problem` (the funder's nutrition-program pain), `spine[]` (each `id, claim, rationale, evidence[]` — for a demo, evidence is `kind: assumed` where the claim is aspirational, with honest `Gap`s of type `DECISION`/`CAPABILITY`), `gaps[]`. Every grounded spine item needs ≥1 non-assumed evidence; every `Gap.claim_ref` resolves to a spine id.
  - **Output 2 — `UnifiedSpec`:** `name`, `narrative`, `base_url: https://labs.connect.dimagi.com`, `personas[]` (first = network manager), `why_brief` (embedded ref), `setup: { command: "<Task-3 generation command>", outputs: "realized.json", rerun: per_render }`, and `scenes[]` where each scene carries `persona` (must exist in personas), `title`, `show`, `concept_claim` (≥5 words, falsifiable, no banned marketing phrases), `provenance` (= a spine id), `role: demo`, ≥1 `feature` with non-empty `description` + `verify`, `url: ${par_url}` (first scene on a surface only — consecutive same-`url` scenes reload; omit `url` on follow-on scenes per `hal:synthetic-walkthrough` anti-pattern), and `actions[]` from the 17-verb vocabulary.
  - **Step: validate** by shelling to canopy (command locked in Task 1): `cd <canopy> && uv run python -m scripts.ddd.validate why_brief <path>` and `... unified_spec <path>`. Loop until both pass.

- [ ] **Step 2: Live authoring + validation run.** Using the Task-3 smoke's realized map, author a 3–4 scene nutrition narrative and run the two validate commands. Expected: both exit 0.

- [ ] **Step 3: Verify atom drift + commit.** `npx vitest run test/skill-atom-references.test.ts` (green — this skill references few/no atoms), then:

```bash
git add skills/demo-narrative/SKILL.md
git commit -m "feat(demo): demo-narrative — authors DDD WhyBrief+UnifiedSpec on the realized map"
```

**Acceptance:** the live authoring run's `why_brief.yaml` + `<slug>.yaml` both pass canopy `scripts/ddd/validate`.

---

## Task 5: `/ace:demo` command + `demo` procedure doc (end-to-end)

Wire the pieces into a level-0 procedure and slash command, and prove the full denovo flow.

**Files:**
- Create: `agents/demo.md` (procedure doc, executed inline at level 0)
- Create: `commands/demo.md` (`/ace:demo`)
- Reference: `agents/ace-orchestrator.md` (procedure-doc pattern), `commands/run.md`, `commands/step.md`.

**Interfaces:**
- Consumes: Tasks 2–4 (`buildDemoRunState`, `demo-data-setup`, `demo-narrative`) + `/canopy:ddd-run`.
- Produces: a completed demo run under `ACE/<demo-name>/runs/<demo-run-id>/` with a live dashboard `par_url` + a rendered DDD walkthrough, and `phases.synthetic-data-and-workflows` written back per contract.

- [ ] **Step 1: Author `agents/demo.md`.** Frontmatter retained (so `/ace:status`/`/ace:eval` keep working). Body = ordered procedure: (1) scaffold demo state via `buildDemoRunState` and write `run_state.yaml` to the demo run folder; (2) invoke `demo-data-setup` (provider from `--source`; Plan A: `denovo`); (3) gate on `demo-data-setup-qa`; (4) invoke `demo-narrative`; (5) hand to `/canopy:ddd-run` with the authored `unified_spec` + `why_brief` (or the full `canopy:ddd` agent if `--render` requests the converge+video loop); (6) write-back the phase block + emit a short summary with the live `par_url` + the canopy-web `/ddd/<slug>/<run_id>` package URL. State the level-0 requirement explicitly (dispatches the DDD agent).

- [ ] **Step 2: Author `commands/demo.md`.** `/ace:demo` reads `agents/demo.md` and executes it inline. Args: `--source {denovo|clone}` (Plan A: denovo; clone → "see Plan B"), `--brief <text|path>`, `--name <demo-name>`, optional `--pin-monday <date>`, optional `--render` (run the full DDD converge+video loop vs. single render+judge). Document defaults.

- [ ] **Step 3: End-to-end live smoke.** Run `/ace:demo --source denovo --brief "<nutrition program brief>" --name plan-a-e2e`. Expected: a live `par_url` dashboard, a DDD render/judge pass, `run_state.yaml` present with the synthetic phase written back, and `/ace:status plan-a-e2e` shows the demo with one live phase. Record the two URLs.

- [ ] **Step 4: Commit.**

```bash
git add agents/demo.md commands/demo.md
git commit -m "feat(demo): /ace:demo level-0 procedure — denovo end-to-end to DDD"
```

**Acceptance:** the e2e smoke produces a live dashboard + a rendered walkthrough; `/ace:status` shows the demo run.

---

## Task 6: Docs, learning, and ship

**Files:**
- Modify: `CLAUDE.md` (commands list + a one-line demo-workflow note under `commands/`)
- Modify: `playbook/integrations/connect-labs.md` (partial refresh: add the `synthetic_env_*`, dynamic `workflow_*` authoring, and clone/profile/fidelity families to the atom map; mark the doc's stale non-existent skill names removed)
- Create: `docs/learnings/2026-07-20-demo-workflow-ddd-native.md`

- [ ] **Step 1: Update `CLAUDE.md`.** Add `demo` to the commands list with a one-liner; note the demo pipeline = `demo-data-setup` → `demo-narrative` → DDD, three providers (denovo shipped; clone = Plan B; ace-run = Phase 7 convergence = Plan C).

- [ ] **Step 2: Partial-refresh `connect-labs.md`.** Add the atom families the exploration found missing (env, dynamic workflow authoring, clone/profile/fidelity, pages), and delete the references to non-existent legacy skill names. Do NOT attempt a full rewrite — scope to what Plan A touched + the audit findings.

- [ ] **Step 3: Write the learning.** `docs/learnings/2026-07-20-demo-workflow-ddd-native.md`: the corrected dynamic-first model (labs synthetic system + workflows are dynamic; `envs/*.yaml` is the durable-capture layer; committing durable demos to labs is correct), why ACE delegates render/judge/video to DDD, and the realized-`par_url` map as the single provider→narrative handoff.

- [ ] **Step 4: Type-check, bump, PR.**

```bash
npx tsc --noEmit                      # expect clean
npm test                              # expect green (incl. demo-run-state + skill-atom-references)
bash scripts/version-bump.sh
git add -A && git commit -m "docs(demo): CLAUDE.md + connect-labs refresh + demo-workflow learning; vN.N.N"
git push -u origin <branch>
gh pr create --title "feat: /ace:demo — standalone DDD-native denovo demo pipeline (Plan A)" --body "<summary + spec/plan links>"
gh pr merge <pr> --auto --merge
```

- [ ] **Step 5: After merge, sync.** Watch the merge (`gh pr view <pr> --json state,mergedAt`), then run `/ace:update` + `/reload-plugins` in-session. (No MCP code changed, so no full restart needed.)

**Acceptance:** PR merged; `/ace:update` applied; `/ace:demo --source denovo` works from the updated plugin.

---

## Self-Review (completed)

**Spec coverage:** §3.1 seam → Tasks 2–3 (realized-map contract). §3.2 pipeline → Tasks 3–5. §3.3 ACE-builds table → Tasks 2–5. §3.5 minimal state → Task 2. §5 live audit + `connect-labs.md` refresh → Tasks 1, 6. §6 gotchas → Task 3 Step 1 + Task 3-QA. §7 canopy invocation → Task 1 Step 3 + Task 4. §10 open questions: clone→dashboard (§10.1) is out of Plan A scope by design (Plan B); canopy mechanics (§10.2) → Task 1; durable-vs-ephemeral (§10.3) noted in Task 6 learning; eval reuse (§10.4) → uses DDD validate/judges (Tasks 4–5) + one ACE QA gate (Task 3-QA). §4 Phase 7 convergence + §clone provider are explicitly Plans B/C, not A.

**Placeholder scan:** no "TBD/handle edge cases/similar to Task N". Skill-authoring tasks specify the exact contract (sections, atoms, output fields, gotchas, acceptance gate) rather than fabricating full 400-line SKILL.md bodies — the honest form for ACE Markdown skills, with a live gate as the real test.

**Type consistency:** `buildDemoRunState` / `classifyPhaseWriteBack` used identically in Task 2 test + Task 5 procedure. `par_url` deep-link shape identical across Tasks 1, 3, 4. Realized-map contract identical in Tasks 3 (produces) and 4/5 (consume).

## Follow-on plans (not this plan)

- **Plan B — clone provider:** deep clone-atom audit; confirm/build the clone→dashboard orchestration (or minimal labs bridge if a real gap); fidelity gate; `--source clone --opp <id>`.
- **Plan C — Phase 7 convergence:** rewire `agents/synthetic-data-and-workflows.md` onto `demo-data-setup(ace-run)` + `demo-narrative`; retire `synthetic-walkthrough-spec`/`-run`/`-summary`; keep the old path until the new one is green.
