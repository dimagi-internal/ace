# ACE Iteration Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tight, mostly-autonomous loop that exercises only ACE phases 3+4+6 on `bednet-spot-check`, reusing a frozen golden upstream prefix, until 5 clean runs land in a row on one unchanged plugin version.

**Architecture:** Hard server/client split. The **server** runs ONE first-class, loop-blind operation — `/ace:run <opp> --seed-from <golden-run-id> --only 3,4,6` — which substitutes phases 1–2 from a golden run at setup, executes 3→4→6, and writes the normal `run_state.yaml`. The **client** (`/ace:iterate`, level-0) only observes `run_state.yaml` + the Claude session, interprets clean/dirty, owns the streak, and on dirty runs an autonomous fix→ship→refresh cycle. Runs are path-agnostic (local or ace-web); ace-web is the default observable runner.

**Tech Stack:** TypeScript + vitest (`lib/`), markdown procedure docs (`agents/`, `commands/`), MCP atoms (gdrive/connect/mobile), `fork-run` skill (existing fork mechanic), ace-web Django (`refresh-plugin` + `seeded-run`, separate PR).

**Spec:** `docs/superpowers/specs/2026-06-01-ace-iterate-loop-design.md`

---

## File structure

**ACE plugin (this repo):**

| File | Responsibility | Action |
|---|---|---|
| `lib/run-state-validator.ts` | Add `validateIterateState()` + `IterateState` types — the client-only loop-state schema | Modify |
| `test/lib/run-state-validator.test.ts` | Tests for `validateIterateState` | Modify |
| `commands/run.md` | Document `--seed-from` + `--only` flags | Modify |
| `agents/ace-orchestrator.md` | Run-init seed substitution + phase-allowlist execution loop | Modify |
| `agents/qa-and-training.md` | Phase-6 app-QA-only mode when Phase 5 not in allowlist | Modify |
| `commands/iterate.md` | `/ace:iterate` entrypoint (client control) | Create |
| `agents/iterate-loop.md` | Level-0 procedure doc: observe → judge → streak → autofix → refresh → resume | Create |
| `.claude-plugin/plugin.json` | (only if commands need registration — verify) | Modify |

**ace-web (sibling repo `~/emdash-projects/ace-web`, separate PR — Task 9):**

| File | Responsibility |
|---|---|
| `apps/system/api.py` | `POST /system/refresh-plugin` (re-run refresh across tasks) |
| `apps/opps/actions.py` | `seeded-run` action `_phrase` + `inject_action` |
| `apps/opps/urls.py` | route (if action needs explicit routing) |

---

## Task 1: `iterate-state.yaml` schema + validator (TDD)

The only classic unit-testable piece. `iterate-state.yaml` is a **client-only** log; the validator gives `/ace:iterate --resume` a structural check before trusting it.

**Files:**
- Modify: `lib/run-state-validator.ts`
- Test: `test/lib/run-state-validator.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/lib/run-state-validator.test.ts` (before the final closing — add as a new top-level `describe`):

```ts
import {
  validateRunState,
  classifyPhaseWriteBack,
  validateIterateState,
} from '../../lib/run-state-validator.js';

describe('validateIterateState', () => {
  const minimal = {
    opp: 'bednet-spot-check',
    target_phases: [3, 6],
    golden_run_id: '20260601-1252',
    runner: 'web',
    streak: 0,
    required_streak: 5,
    iterations: [],
  };

  it('accepts a minimal well-formed state', () => {
    const r = validateIterateState(minimal);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateIterateState('nope').valid).toBe(false);
    expect(validateIterateState(42).valid).toBe(false);
  });

  it('requires opp, golden_run_id, runner', () => {
    const r = validateIterateState({ ...minimal, opp: undefined });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === 'opp')).toBe(true);
  });

  it('rejects an unknown runner', () => {
    const r = validateIterateState({ ...minimal, runner: 'cloud' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === 'runner')).toBe(true);
  });

  it('rejects a negative or non-integer streak', () => {
    expect(validateIterateState({ ...minimal, streak: -1 }).valid).toBe(false);
    expect(validateIterateState({ ...minimal, streak: 2.5 }).valid).toBe(false);
  });

  it('requires target_phases to be a non-empty integer array', () => {
    expect(validateIterateState({ ...minimal, target_phases: [] }).valid).toBe(false);
    expect(validateIterateState({ ...minimal, target_phases: ['3'] }).valid).toBe(false);
  });

  it('validates each iteration entry shape', () => {
    const r = validateIterateState({
      ...minimal,
      iterations: [
        { run_id: '20260601-1300', verdict: 'clean', version_at_run: '0.13.502' },
        { run_id: '20260601-1330', verdict: 'bogus' },
      ],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === 'iterations[1].verdict')).toBe(true);
  });

  it('treats null as valid (fresh, not-yet-written state)', () => {
    expect(validateIterateState(null).valid).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/lib/run-state-validator.test.ts -t validateIterateState`
Expected: FAIL — `validateIterateState is not a function` / import error.

- [ ] **Step 3: Implement `validateIterateState`**

Append to `lib/run-state-validator.ts` (after `classifyPhaseWriteBack`, reusing the existing `isObject`, `pushError`, `ValidationIssue`, `ValidationResult`):

```ts
const ITERATE_RUNNERS = new Set(['web', 'local']);
const ITERATE_VERDICTS = new Set(['clean', 'dirty']);

export interface IterateIteration {
  run_id: string;
  verdict: 'clean' | 'dirty';
  failure_class?: string;
  fix_pr?: string;
  version_at_run?: string;
  started_at?: string;
}

export interface IterateState {
  opp: string;
  target_phases: number[];
  golden_run_id: string;
  runner: 'web' | 'local';
  plugin_version?: string;
  streak: number;
  required_streak: number;
  caps?: { per_failure_class_fix?: number; max_iterations?: number };
  kill?: boolean;
  iterations: IterateIteration[];
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * Validate `iterate-state.yaml` — the CLIENT-ONLY loop log read by
 * `/ace:iterate --resume`. Null/undefined is valid (fresh state before
 * the first write). The server-side run NEVER reads or writes this file.
 */
export function validateIterateState(parsed: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (parsed === null || parsed === undefined) {
    return { valid: true, errors, warnings };
  }
  if (!isObject(parsed)) {
    pushError(errors, '', `iterate-state.yaml must be a mapping, got ${typeof parsed}`, 'object', parsed);
    return { valid: false, errors, warnings };
  }

  if (typeof parsed.opp !== 'string' || parsed.opp.length === 0) {
    pushError(errors, 'opp', 'opp must be a non-empty string', 'string', parsed.opp);
  }
  if (typeof parsed.golden_run_id !== 'string' || parsed.golden_run_id.length === 0) {
    pushError(errors, 'golden_run_id', 'golden_run_id must be a non-empty string', 'string', parsed.golden_run_id);
  }
  if (typeof parsed.runner !== 'string' || !ITERATE_RUNNERS.has(parsed.runner)) {
    pushError(errors, 'runner', `runner must be one of ${[...ITERATE_RUNNERS].join(', ')}`, 'enum', parsed.runner);
  }
  if (!isInt(parsed.streak) || (parsed.streak as number) < 0) {
    pushError(errors, 'streak', 'streak must be a non-negative integer', 'integer', parsed.streak);
  }
  if (!isInt(parsed.required_streak) || (parsed.required_streak as number) < 1) {
    pushError(errors, 'required_streak', 'required_streak must be a positive integer', 'integer', parsed.required_streak);
  }
  if (!Array.isArray(parsed.target_phases) || parsed.target_phases.length === 0 ||
      !parsed.target_phases.every(isInt)) {
    pushError(errors, 'target_phases', 'target_phases must be a non-empty array of integers', 'array', parsed.target_phases);
  }

  if (parsed.iterations !== undefined) {
    if (!Array.isArray(parsed.iterations)) {
      pushError(errors, 'iterations', 'iterations must be an array when present', 'array', parsed.iterations);
    } else {
      parsed.iterations.forEach((it, i) => {
        const p = `iterations[${i}]`;
        if (!isObject(it)) {
          pushError(errors, p, 'iteration entry must be a mapping', 'object', it);
          return;
        }
        if (typeof it.run_id !== 'string' || it.run_id.length === 0) {
          pushError(errors, `${p}.run_id`, 'run_id must be a non-empty string', 'string', it.run_id);
        }
        if (typeof it.verdict !== 'string' || !ITERATE_VERDICTS.has(it.verdict)) {
          pushError(errors, `${p}.verdict`, `verdict must be one of ${[...ITERATE_VERDICTS].join(', ')}`, 'enum', it.verdict);
        }
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/lib/run-state-validator.test.ts`
Expected: PASS (existing + new `validateIterateState` cases).

- [ ] **Step 5: Commit**

```bash
git add lib/run-state-validator.ts test/lib/run-state-validator.test.ts
git commit -m "feat(iterate): add iterate-state.yaml schema validator"
```

---

## Task 2: First-class seeded run — `--seed-from` + `--only` (orchestrator)

The entire server-side surface. Loop-blind: writes only normal `run_state.yaml`. Reuses the `fork-run` skill for the substitution copy.

**Files:**
- Modify: `commands/run.md` (frontmatter `argument-hint` + Arguments section)
- Modify: `agents/ace-orchestrator.md` (run-init seed step + phase-allowlist loop)

- [ ] **Step 1: Document the flags in `commands/run.md`**

In the frontmatter `argument-hint`, append: ` [--seed-from <golden-run-id>] [--only <phase-ordinals>]`.

In the `## Arguments` section, add:

```markdown
- `--seed-from <golden-run-id>` — start mid-pipeline with a golden upstream
  prefix. At run-init, before executing any phase, substitute the phases
  *below* the lowest `--only` ordinal by copying them from `<golden-run-id>`
  (via the `fork-run` mechanic: copy `<N>-<phase>/` folders + the matching
  `phases.<phase>.products.*` blocks into the new run, mark them `done`).
  The new run still mints its own fresh run-id. Requires `--only`. Use for
  "re-run from phase N with frozen upstream" — independently useful, and the
  operation the iteration loop dispatches.
- `--only <phase-ordinals>` — comma-separated phase ordinals to execute
  (e.g. `3,4,6`). Phases not listed are neither run nor required, EXCEPT the
  orchestrator fails loud if a listed phase's required input artifact was
  produced by an un-listed, un-seeded phase. When `5` is absent and `6` is
  present, Phase 6 runs in **app-QA-only mode** (see `agents/qa-and-training.md
  § Archetypes / app-QA-only`). Pauses for Phases 8–10 still never auto-fire
  unless explicitly listed.
```

- [ ] **Step 2: Add the run-init seed substitution to `agents/ace-orchestrator.md`**

After the run-folder creation step (§ Starting a New Opportunity, step 4, around line 643), add a new sub-step:

```markdown
### Step 4b — Seed substitution (`--seed-from` only)

When `--seed-from <golden-run-id>` was passed:

1. Validate `--only` is also present and non-empty; if not, halt:
   `--seed-from requires --only (which phases to actually run).`
2. Compute `seed_phases` = every phase ordinal **below** `min(--only)`.
   For `--only 3,4,6`, `seed_phases = [1, 2]`.
3. Invoke the `fork-run` skill against the golden run to copy the seed
   prefix into THIS new run folder:
   `fork-run --opp_slug <opp> --from_run_id <golden-run-id>
    --from_skill <first-skill-of min(--only)> --mode keep-all
    --feedback "seeded run for --only <ordinals>"`.
   (`min(--only)=3` → `from_skill: pdd-to-learn-app`.) fork-run copies all
   skills upstream of the fork boundary — i.e. exactly `seed_phases` — plus
   `decisions.yaml` and the upstream `phases.*.products.*` blocks.
4. In this run's `run_state.yaml`, mark every `seed_phases` block
   `status: done`, `verdict: seeded`, `summary_artifact: <copied summary>`,
   and note `seeded_from: <golden-run-id>` at the run-state root.
5. Set the start pointer to `min(--only)` instead of Phase 1.

If `--seed-from` is absent, run-init is unchanged (start at Phase 1).
```

- [ ] **Step 3: Add the phase-allowlist guard to the execution loop**

In the phase-execution section (after the phase list, around line 218), add:

```markdown
**Phase allowlist (`--only`).** When `--only <ordinals>` is set, iterate the
phase list but execute ONLY the listed ordinals. For each listed phase, before
dispatch, confirm its required input artifacts (per `lib/artifact-manifest.ts`
`artifactsConsumedBy`) are present — produced either by an earlier listed phase
or by the seeded prefix. If a required input is missing AND its producer is
neither listed nor seeded, halt loud:

> `/ace:run --only <ordinals>`: phase <N> needs `<artifact>` produced by
> phase <M>, which is neither in --only nor seeded via --seed-from. Add <M>
> to --only or pass --seed-from <golden-run-id>.

Phases not in `--only` are skipped silently (no pending, no pause). The
phase-boundary fence + Phase Write-Back Contract still apply to listed phases.
```

- [ ] **Step 4: Verify the contract is internally consistent**

Run: `bash -c 'grep -n "seed-from\|--only\|seed_phases\|app-QA-only" commands/run.md agents/ace-orchestrator.md'`
Expected: matches in both files; `--only`/`--seed-from` defined in run.md and consumed in the orchestrator.

Run: `npm run -s detect-structure-drift 2>/dev/null || npx tsx scripts/*detect*drift* 2>/dev/null; echo "drift check done"`
(If `/ace:detect-structure-drift` is a command not a script, skip — Task 6 runs it.)

- [ ] **Step 5: Commit**

```bash
git add commands/run.md agents/ace-orchestrator.md
git commit -m "feat(run): first-class seeded run via --seed-from + --only phase allowlist"
```

---

## Task 3: Phase-6 app-QA-only mode

When Phase 5 (OCS) isn't in the allowlist, Phase 6 must run the mobile app-QA path and skip the OCS-dependent training-doc skills (which need a chatbot URL).

**Files:**
- Modify: `agents/qa-and-training.md`

- [ ] **Step 1: Add the app-QA-only mode section**

Add a section to `agents/qa-and-training.md` (near its archetypes/branching area):

```markdown
## Mode: app-QA-only

Active when the orchestrator runs this phase under `--only` WITHOUT Phase 5
(OCS) in the allowlist (e.g. `--only 3,4,6`). In this mode:

- **Run** the mobile app-QA path: `app-test-cases`, `app-screenshot-capture`,
  the shallow app-QA judge.
- **Skip** the OCS-dependent training-doc skills (`training-llo-guide`,
  `training-flw-guide`, `training-quick-reference`, `training-faq`,
  `training-onboarding-email`) and the deck render — they reference the OCS
  chatbot URL, which is absent. Mark each skipped skill
  `steps.<skill>.status: skipped`, `note: app-QA-only mode (no Phase 5)`.
- The phase verdict is computed from the app-QA judge alone. Write-back
  contract is satisfied with the skipped skills explicitly marked (not
  `deferred`, which would block `verdict: pass`).

This mode is the iteration-loop fast path; it is NOT used in a normal full
`/ace:run` (where Phase 5 always precedes Phase 6).
```

- [ ] **Step 2: Verify**

Run: `grep -n "app-QA-only\|skipped" agents/qa-and-training.md`
Expected: the new mode section present; `skipped` status used (not `deferred`).

- [ ] **Step 3: Commit**

```bash
git add agents/qa-and-training.md
git commit -m "feat(phase6): app-QA-only mode when Phase 5 absent from --only"
```

---

## Task 4: `/ace:iterate` client control + `agents/iterate-loop.md`

The only loop-aware code. Level-0 (dispatches `Agent` for fix+ship). Observes; never embeds loop logic server-side.

**Files:**
- Create: `commands/iterate.md`
- Create: `agents/iterate-loop.md`

- [ ] **Step 1: Create `commands/iterate.md`**

```markdown
---
description: Drive an autonomous iteration loop on phases 3+4+6 until N clean runs in a row
argument-hint: <opp> [--target 3,6] [--golden <run-id>] [--runner web|local] [--until-clean N] [--resume]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:iterate

Client-side control loop. Launches first-class seeded runs
(`/ace:run <opp> --seed-from <golden> --only 3,4,6`) on a runner, OBSERVES
each run's `run_state.yaml` + Claude session, judges clean/dirty, owns the
streak, and on dirty runs an autonomous fix→ship→refresh cycle. Stops at N
clean runs in a row on one unchanged plugin version.

The loop logic lives entirely here — the server-side run is loop-blind.

## Arguments
- `<opp>` — opportunity slug (e.g. `bednet-spot-check`).
- `--target <ordinals>` — phases to iterate on (default `3,6`; `4` always
  rides along as a dependency, so the executed allowlist is `3,4,6`).
- `--golden <run-id>` — golden upstream prefix run. If omitted, see
  `agents/iterate-loop.md § Golden prefix resolution`.
- `--runner web|local` — where runs execute (default `web`; observable).
- `--until-clean N` — required consecutive clean streak (default `5`).
- `--resume` — continue from `ACE/<opp>/iterate-state.yaml`.

## Process

Execute `agents/iterate-loop.md` inline at top level (this invocation IS
level-0, so `Agent` is available for the fix+ship dispatch).
```

- [ ] **Step 2: Create `agents/iterate-loop.md`**

```markdown
---
name: iterate-loop
description: >
  Client-side ACE iteration control. Observes first-class seeded runs,
  judges clean/dirty, maintains a 5-in-a-row streak, and autonomously
  fixes+ships+refreshes on dirty. Runs at level 0 (dispatches Agent).
---

# iterate-loop

Level-0 procedure doc executed inline by `/ace:iterate`. NEVER dispatched as
a subagent (it dispatches `Agent` for fix+ship — see CLAUDE.md § Agent topology).

## Invariant: server runs first-class, client observes

The runner executes `/ace:run <opp> --seed-from <golden> --only 3,4,6` — an
ordinary run that writes a normal `run_state.yaml`. This procedure reads that
run_state + the Claude session transcript and does ALL loop interpretation.
Never put streak/judge/autofix logic into the run itself.

## State: `ACE/<opp>/iterate-state.yaml` (client-only)

Validated by `validateIterateState` (`lib/run-state-validator.ts`). Schema:

` ``yaml
opp: bednet-spot-check
target_phases: [3, 6]
golden_run_id: 20260601-1252
runner: web
plugin_version: 0.13.502
streak: 0
required_streak: 5
caps: { per_failure_class_fix: 2, max_iterations: 25 }
kill: false
iterations:
  - run_id: 20260601-1300
    started_at: <ISO>
    verdict: clean
    version_at_run: 0.13.502
` ``

## Golden prefix resolution

If `--golden` is omitted: read `iterate-state.yaml.golden_run_id` (resume) or,
on first run, halt and ask the operator to confirm a golden run-id (see Task 5;
do NOT silently pick a stale run).

## Loop

0. **Init / resume.** Read or create `iterate-state.yaml`; validate it.
   Read the live plugin version (web: poll the ace-web system version
   endpoint; local: `cat VERSION`). Stamp `plugin_version`.
1. **Kill check.** If `kill: true`, stop and report.
2. **Cap check.** If `streak >= required_streak` → success, stop. If
   `len(iterations) >= caps.max_iterations` → halt-and-surface.
3. **Launch a seeded run** on the runner:
   - **web**: POST the `seeded-run` action (or working-session message-inject)
     with `/ace:run <opp> --seed-from <golden_run_id> --only 3,4,6`. Capture
     the new working-session slug.
   - **local**: spawn `/ace:run <opp> --seed-from <golden_run_id> --only 3,4,6`.
4. **Observe** until phases 3+6 reach terminal:
   - Poll `runs/<new-run-id>/run_state.yaml` on Drive.
   - Read the session transcript (web: `GET /sessions/<slug>/messages`;
     local: the `.jsonl`) for progress + failure detail.
5. **Judge** (client-side interpretation):
   - **clean** iff `classifyPhaseWriteBack(run_state, 'commcare-setup') == 'ok'`
     AND `classifyPhaseWriteBack(run_state, 'qa-and-training') == 'ok'` AND the
     Phase 3 producer/eval verdicts (`app-release-qa`, `app-connect-coverage`,
     `pdd-to-*-app` evals) and the Phase 6 shallow app-QA verdict are `pass`.
   - **dirty** otherwise. Derive `failure_class` = `<failing-skill>: <first
     failing check + first 200 chars of the verdict/transcript>`.
6. **Record** the iteration in `iterate-state.yaml`.
7. **Branch:**
   - **clean** → `streak += 1`; go to 1.
   - **dirty** → `streak = 0`; run **Autofix** (below); go to 1.

## Autofix (on dirty — always local, against the ACE checkout)

Per-failure-class cap: if this `failure_class` has already been fixed
`caps.per_failure_class_fix` times, halt-and-surface (don't churn versions).

Dispatch ONE `Agent` (level-1 fix+ship subagent) with the failing verdict
fileId + transcript excerpt inline (do NOT paraphrase — see orchestrator-
reference § On phase retry, pass the verdict fileId inline). The subagent:

1. Root-causes via the `investigate` skill (Iron Law: no fix without root cause).
2. Makes the minimal fix in the failing skill / recipe / atom.
3. Ships per the canonical poll-loop (orchestrator-reference § Fix-and-ship
   subagent template): `scripts/version-bump.sh` → commit → PR →
   `gh pr merge --auto --merge` → **poll until MERGED**.
4. `gh issue create` against `jjackson/ace` (one per distinct finding).
5. Returns: PR URL, final state (MERGED/DIRTY/CHECK-FAILED), merged VERSION,
   issue URL.

After the subagent returns MERGED:
- **Refresh the runner to the new plugin version.**
  - **web**: `POST <ACE_WEB_BASE_URL>/system/refresh-plugin`; poll the system
    version endpoint until it reports the merged VERSION across runner tasks.
  - **local**: `/ace:update` (or rely on the next fresh process).
- Stamp `plugin_version` = merged VERSION (streak already reset to 0).

If the subagent returns DIRTY-after-rebase-exhausted or CHECK-FAILED, halt-and-
surface with the PR URL + failing check — operator decides.

## Exit

- **Success**: `streak == required_streak`. Report the 5 clean run-ids + the
  stable VERSION. Point the operator at `/ace:sweep drive,connect,ocs,hq,opp-runs`
  to reclaim the per-iteration opps/apps/chatbots.
- **Halt**: cap hit, kill flag, or unfixable failure class — report state +
  the last `failure_class` + open issues/PRs.
```

- [ ] **Step 3: Verify the docs parse + level-0 invariant is stated**

Run: `grep -n "level 0\|NEVER dispatched\|first-class\|seeded-run\|refresh-plugin" agents/iterate-loop.md commands/iterate.md`
Expected: level-0 invariant + server/client split present in both.

- [ ] **Step 4: Register the command if needed**

Run: `grep -n "commands/iterate\|\"iterate\"" .claude-plugin/plugin.json`
If commands are auto-discovered (no explicit registry), no change. If a registry exists, add `iterate`. (ACE auto-discovers commands from `commands/` — verify and only edit if necessary.)

- [ ] **Step 5: Commit**

```bash
git add commands/iterate.md agents/iterate-loop.md
git commit -m "feat(iterate): /ace:iterate client control + iterate-loop procedure doc"
```

---

## Task 5: Establish + lock the golden `bednet-spot-check` prefix

Operational (live Drive). Produces a known-good, current-schema Phase 1–2 prefix to fork from.

**Files:** none (writes `ACE/bednet-spot-check/iterate-state.yaml` on Drive).

- [ ] **Step 1: Inspect existing bednet runs for a clean current-schema Phase 1–2**

Use `resolve_opp_path bednet-spot-check` → list `runs/`. For each recent run,
read `runs/<id>/run_state.yaml` and check `phases.idea-to-design.status == done`
+ `phases.scenarios-and-acceptance.status == done` with `verdict: pass`, and the
PDD is current-schema (`Archetype:` declared; passes `idea-to-pdd-qa`).

- [ ] **Step 2: Pick or produce the golden**

If a clean current-schema run exists, record its run-id as `golden_run_id`.
If none qualifies, run `/ace:run bednet-spot-check --only 1,2` once to produce a
fresh Phase 1–2, then use that run-id. (Confirm the chosen run-id with the
operator — never silently pick a stale run.)

- [ ] **Step 3: Seed `iterate-state.yaml`**

Write `ACE/bednet-spot-check/iterate-state.yaml` with the locked
`golden_run_id`, `target_phases: [3,6]`, `runner: web`, `streak: 0`,
`required_streak: 5`, `caps`, `kill: false`, `iterations: []`. Validate it
loads clean via `validateIterateState`.

- [ ] **Step 4: Commit (none — Drive-only).** Note the golden run-id in the run log.

---

## Task 6: Wire-up + plugin health

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS (including the new `validateIterateState` cases).

- [ ] **Step 2: Structure-drift + docs**

Run: `/ace:detect-structure-drift` (resolve any frontmatter/manifest drift from the new agent doc).
Run: `/ace:docs` (regenerate the derived playbook so `/ace:iterate` appears).

- [ ] **Step 3: Commit any generated/doc updates**

```bash
git add -A
git commit -m "chore(iterate): regen docs + resolve structure drift"
```

---

## Task 7: Ship the ACE-side change

Follow CLAUDE.md § Plugin updates (the ONLY way).

- [ ] **Step 1: Version bump (worktree-safe)**

Run: `bash scripts/version-bump.sh`

- [ ] **Step 2: Commit, push, PR, arm auto-merge**

```bash
git add -A && git commit -m "feat(iterate): autonomous phase-3+6 iteration loop"
git push -u origin "$(git branch --show-current)"
gh pr create --fill
gh pr merge "$(gh pr view --json number -q .number)" --auto --merge
```

- [ ] **Step 3: Poll until merged, then update this session**

Poll per the fix-and-ship template until `state == MERGED`, then run `/ace:update` + `/reload-plugins`. (MCP code unchanged in the ACE-side tasks, so no full restart needed; if a later task touches `mcp/`, restart.)

---

## Task 8: Live validation — one seeded run, then a short loop

- [ ] **Step 1: Validate the first-class seeded run alone**

Run (local runner, the simplest path): `/ace:run bednet-spot-check --seed-from <golden-run-id> --only 3,4,6`
Expected: a new run-id; phases 1–2 marked `done`/`seeded`; phases 3→4→6 execute; Phase 6 in app-QA-only mode; normal `run_state.yaml` verdicts written. No streak/iterate-state touched by the run.

- [ ] **Step 2: Run the loop for 2 iterations (cap-limited smoke)**

Run: `/ace:iterate bednet-spot-check --golden <golden-run-id> --runner local --until-clean 2`
Expected: launches seeded runs, observes run_state, judges, increments streak; on a dirty run, the autofix dispatch fires and ships a PR. Confirm `iterate-state.yaml` records each iteration.

- [ ] **Step 3: Switch to web runner + full target**

Run: `/ace:iterate bednet-spot-check --runner web --until-clean 5`
(Requires Task 9's `refresh-plugin` + `seeded-run` action live on ace-web. If not yet shipped, stay on `--runner local` and message-inject for web.)

---

## Task 9: ace-web — `refresh-plugin` + `seeded-run` action (separate repo/PR)

**Files (in `~/emdash-projects/ace-web`):**
- Modify: `apps/system/api.py` — `POST /system/refresh-plugin`
- Modify: `apps/opps/actions.py` — `seeded-run` `_phrase` + `inject_action`

- [ ] **Step 1: `refresh-plugin` endpoint**

Add a Ninja route `POST /system/refresh-plugin` that runs
`scripts/refresh-ace-plugin.sh` on the receiving task (idempotent; reuses the
entrypoint script). Fan-out across >1 ECS task: simplest first cut is per-task
(the loop polls the version endpoint until the value flips), with a documented
follow-up for service-wide signalling. Return `{started: true, version_before}`.
The control then polls the existing system version endpoint until it reports the
merged VERSION.

- [ ] **Step 2: `seeded-run` action**

In `apps/opps/actions.py`, add to `_phrase`:

```python
    if action == "seeded-run":
        only = payload.only or "3,4,6"
        return f"/ace:run {slug} --seed-from {payload.golden_run_id} --only {only}"
```

Extend `ActionPayload` with `golden_run_id` + `only`; the `<run_id>` path
segment carries the golden run-id. `inject_action` creates the message as today.

- [ ] **Step 3: Tests + ship**

Run ace-web's test suite (`uv run pytest apps/system apps/opps`), then ship per ace-web's PR workflow. Rebuild not required for the action; `refresh-plugin` ships in the next ace-web image but the entrypoint script it calls already exists (#582).

- [ ] **Step 4: Confirm end-to-end**

Re-run Task 8 Step 3 against the web runner; confirm a merged ACE fix is picked up by the next iteration after `refresh-plugin` (no image rebuild).

---

## Self-review notes

- **Spec coverage:** server-first-class (T2), Phase-6 app-QA-only (T3), client observer+judge+streak+autofix (T4), iterate-state schema (T1), golden prefix (T5), refresh-plugin + seeded-run (T9), guardrails/caps/kill (T4), cleanup pointer (T4 exit) — all mapped.
- **Type consistency:** `validateIterateState` / `IterateState` / `IterateIteration` used consistently T1↔T4; `--seed-from`/`--only` consistent T2↔T4↔T9; `seeded-run` action name consistent T4↔T9.
- **Live-validation honesty:** T2/T3/T4 are markdown-contract tasks verified by grep + structure-drift + a real seeded run (T8), not unit tests — that's the right gate for procedure-doc behavior. The one unit-testable unit (T1) is full TDD.
```
