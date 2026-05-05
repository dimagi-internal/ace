# Multi-run-per-opp revival + canonical input packs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the ACE Drive layout so each opp is a folder with `inputs/` (canonical input pack) and `runs/<YYYYMMDD-HHMM>/` (one folder per `/ace:run` invocation), and make `/ace:run` zero-arg pick the most-recently-touched opp's input pack and start a fresh run on it.

**Architecture:** Plugin orchestrator changes write the new shape; ace-web's structured-layout reader (still alive as legacy code from the 2026-04-20 single-run drop) is revived to read it. Plugin lands first on its own branch (`spec/multi-run-revival`); ace-web lands within ~24h on its own branch (`multi-run-revival`) and bumps `ACE_REF` to pull the new plugin into the Docker image.

**Tech Stack:** ACE plugin (markdown skills + TypeScript MCPs + bash for `bin/ace-doctor`), Python 3.12 / Django 5 + DRF (ace-web backend), React 19 + Vite + Tailwind (ace-web frontend), pytest + pytest-django for tests, vitest for plugin TS tests.

**Working dirs:**
- Plugin: `/Users/acedimagi/emdash/repositories/ace`, branch `spec/multi-run-revival` (already created with the spec commit `cab1826`).
- ace-web: `/Users/acedimagi/emdash/repositories/ace-web`, create new branch `multi-run-revival` from `main`.

**Spec:** `/Users/acedimagi/emdash/repositories/ace/docs/superpowers/specs/2026-05-02-ace-run-multi-run-revival-design.md`.

---

## File Structure

### Plugin files (Phase A)

| File | Action | Responsibility |
|---|---|---|
| `lib/run-paths.ts` | **new** | Pure helpers: `generateRunId(now)`, `parseOppRef(arg)` (parses `<opp>` vs `<opp>/<run-id>`), `runFolderPath(opp, runId)`. Unit-testable. |
| `lib/run-paths.test.ts` | **new** | Vitest for the helpers. |
| `lib/artifact-manifest.ts` | modify | Add 2 entries: `inputs/` (external) and `opp.yaml` (orchestrator). Keep existing entries unchanged (still relative to the run folder). |
| `agents/ace-orchestrator.md` | modify | Replace `## Starting a New Opportunity` (lines 587-702) with the new `inputs/`-discovery + `runs/<run-id>/` flow. Add a note in `## Touching State` that paths are now run-relative. |
| `commands/run.md` | modify | Argument grammar: `<opp>` and `<opp>/<run-id>` resume forms; zero-arg flow described. |
| `commands/status.md` | modify | Output reorganized: list opps (one line each), each opp expands to its runs sorted newest-first. |
| `bin/ace-doctor` | modify | Two new checks: (a) at least one `<opp>/inputs/pdd.md` under Drive root, (b) `ACE_E2E_AUTH_TOKEN` is set in `.env`. |
| `skills/upload-transcript/SKILL.md` | modify | Document that `opp_run_id` is now sent alongside `opp_slug` for new-layout opps. |
| `VERSION` | modify | Bump (currently 0.10.x → 0.11.0 since this is a Drive-layout breaking change). |
| `CHANGELOG.md` | modify | Add 0.11.0 entry. |

### ace-web files (Phase B)

| File | Action | Responsibility |
|---|---|---|
| `Dockerfile` | modify | Bump `ARG ACE_REF=v0.11.0` (or whatever the plugin tag becomes). |
| `apps/opps/sync.py` | modify | `load_opp` and `load_opp_card` learn the new layout: opp = folder with `inputs/`, runs = list under `runs/`. Keep flat-layout reader alive for ~1 week back-compat. |
| `apps/opps/views.py` | modify | `workbench` accepts optional `?run_id=` query param; new `runs_list` view at `/api/workspaces/<ws>/opps/<opp>/runs`. |
| `apps/opps/urls.py` | modify | Wire `runs_list` view. |
| `apps/opps/serializers.py` | modify | Serialize the `runs[]` list on the opp snapshot. |
| `apps/opps/tests/test_sync_multi_run.py` | **new** | Pytest with a fixture Drive client that returns the new layout. |
| `apps/opps/tests/test_views_runs_list.py` | **new** | Pytest for the new endpoint. |
| `frontend/src/components/opps/RunSelector.tsx` | **new** | Dropdown showing `runs[]`, defaults to latest, fires `onRunChange(runId)`. |
| `frontend/src/components/opps/WorkbenchHeader.tsx` | modify | Mount `RunSelector` next to the opp title. |
| `frontend/src/pages/OppWorkbenchPage.tsx` | modify | Track selected `runId`, refetch on change. |
| `frontend/src/pages/OppListPage.tsx` | modify | One row per opp folder (display_name + last-run timestamp + run count + scorecard chip). |

---

# Phase A — Plugin

All Phase-A tasks happen in `/Users/acedimagi/emdash/repositories/ace` on branch `spec/multi-run-revival`. Confirm with `git status` before starting.

## Task 1: Add `lib/run-paths.ts` helpers + tests

**Files:**
- Create: `/Users/acedimagi/emdash/repositories/ace/lib/run-paths.ts`
- Create: `/Users/acedimagi/emdash/repositories/ace/lib/run-paths.test.ts`

These are pure utility functions for run-id generation and `<opp>/<run-id>` parsing. TS-only, no Drive calls. Unit tests live next to them per existing plugin convention (compare `lib/artifact-manifest.ts` + any existing `*.test.ts`).

- [ ] **Step 1: Write the failing tests**

```typescript
// lib/run-paths.test.ts
import { describe, expect, it } from 'vitest';
import { generateRunId, parseOppRef, runFolderPath } from './run-paths';

describe('generateRunId', () => {
  it('formats local time as YYYYMMDD-HHMM', () => {
    const d = new Date(2026, 4, 2, 18, 30); // local; month is 0-indexed
    expect(generateRunId(d)).toBe('20260502-1830');
  });

  it('zero-pads single-digit fields', () => {
    const d = new Date(2026, 0, 5, 9, 7);
    expect(generateRunId(d)).toBe('20260105-0907');
  });
});

describe('parseOppRef', () => {
  it('parses bare opp slug', () => {
    expect(parseOppRef('turmeric')).toEqual({ opp: 'turmeric', runId: null });
  });

  it('parses <opp>/<run-id>', () => {
    expect(parseOppRef('turmeric/20260502-1830')).toEqual({
      opp: 'turmeric',
      runId: '20260502-1830',
    });
  });

  it('rejects multi-slash', () => {
    expect(() => parseOppRef('a/b/c')).toThrow(/expected/);
  });

  it('rejects empty', () => {
    expect(() => parseOppRef('')).toThrow(/empty/);
  });
});

describe('runFolderPath', () => {
  it('joins opp + run-id with runs/ separator', () => {
    expect(runFolderPath('turmeric', '20260502-1830')).toBe(
      'turmeric/runs/20260502-1830'
    );
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/acedimagi/emdash/repositories/ace
npx vitest run lib/run-paths.test.ts
```

Expected: FAIL — module `./run-paths` does not exist yet.

- [ ] **Step 3: Implement the helpers**

```typescript
// lib/run-paths.ts
/**
 * Pure helpers for the multi-run Drive layout introduced in
 * docs/superpowers/specs/2026-05-02-ace-run-multi-run-revival-design.md.
 *
 * No Drive calls; no I/O. Used by the orchestrator to compute paths and
 * by tests to verify path logic without mocking Drive.
 */

export interface OppRef {
  /** Opp slug (folder name under ACE/). Always non-empty. */
  opp: string;
  /** Run-id (folder name under ACE/<opp>/runs/). Null = "fresh run". */
  runId: string | null;
}

/**
 * Format a Date as `YYYYMMDD-HHMM` in local time.
 * Used as a run-id when starting a fresh run.
 *
 * On collision (already-existing folder with the same id), the caller
 * appends `-2`, `-3`, etc. — see ace-orchestrator.md § Starting a New
 * Opportunity step 5.
 */
export function generateRunId(now: Date): string {
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}`;
}

/**
 * Parse `/ace:run` positional argument into {opp, runId}.
 *
 * Accepts:
 *   - "turmeric"                  → { opp: "turmeric", runId: null }
 *   - "turmeric/20260502-1830"    → { opp: "turmeric", runId: "20260502-1830" }
 *
 * Rejects multi-segment paths and empty strings.
 */
export function parseOppRef(arg: string): OppRef {
  if (!arg || arg.length === 0) {
    throw new Error('parseOppRef: empty argument');
  }
  const parts = arg.split('/');
  if (parts.length === 1) {
    return { opp: parts[0], runId: null };
  }
  if (parts.length === 2) {
    return { opp: parts[0], runId: parts[1] };
  }
  throw new Error(
    `parseOppRef: expected "<opp>" or "<opp>/<run-id>", got ${JSON.stringify(arg)}`
  );
}

/**
 * Drive path of a run folder relative to the ACE root, e.g.
 *   "turmeric/runs/20260502-1830".
 */
export function runFolderPath(opp: string, runId: string): string {
  return `${opp}/runs/${runId}`;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run lib/run-paths.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/acedimagi/emdash/repositories/ace
git add lib/run-paths.ts lib/run-paths.test.ts
git commit -m "feat(lib): run-paths helpers for multi-run layout

generateRunId, parseOppRef, runFolderPath — pure helpers used by the
orchestrator to compute the new <opp>/runs/<run-id>/ paths."
```

---

## Task 2: Update `lib/artifact-manifest.ts` for the new layout

**Files:**
- Modify: `/Users/acedimagi/emdash/repositories/ace/lib/artifact-manifest.ts`

The manifest entries already use paths *relative to the opp folder* (e.g., `idea.md`, `verdicts/<skill>-eval-deep.yaml`). The semantics shift: those paths are now relative to the **run folder** (`<opp>/runs/<run-id>/`). No path string changes; just two new entries.

- [ ] **Step 1: Read existing manifest header to confirm pattern**

```bash
sed -n '40,90p' /Users/acedimagi/emdash/repositories/ace/lib/artifact-manifest.ts
```

Confirm `ARTIFACT_MANIFEST` is a `readonly ArtifactEntry[]` with `idea.md` and `pdd.md` as the first two entries.

- [ ] **Step 2: Update the file-header comment**

In `lib/artifact-manifest.ts`, replace lines 1–19 (the JSDoc block) with:

```typescript
/**
 * Canonical artifact manifest for ACE opportunities.
 *
 * Every file that an ACE skill reads from or writes to Google Drive under
 * `ACE/<opp>/runs/<run-id>/` is listed here. Two opp-level files
 * (`opp.yaml` and the `inputs/` folder) sit at `ACE/<opp>/` itself,
 * one level above the run folder; they are flagged with `phase: 'design'`
 * and `producedBy: 'orchestrator'` (or 'external' for inputs).
 *
 * This module is the single source of truth for:
 *   - What artifacts exist at each lifecycle phase
 *   - Which skill produces each artifact
 *   - Which skills consume each artifact
 *   - Whether an artifact is required or optional at phase completion
 *
 * Skills are SKILL.md prompt files and cannot import this module at runtime.
 * The manifest is used by:
 *   - Test fixture validation (does the fixture have the right files?)
 *   - ace:doctor checks on live opportunity Drive folders
 *   - Documentation generation
 *   - ace-web's structured-layout reader (apps/opps/sync.py)
 *
 * To audit: grep -r 'ACE/<opp>/runs/' skills/ agents/
 */
```

- [ ] **Step 3: Add the two new entries at the top of `ARTIFACT_MANIFEST`**

Insert immediately after line 46 (`export const ARTIFACT_MANIFEST: readonly ArtifactEntry[] = [`):

```typescript
  // ── Opp-level artifacts (NOT under runs/<run-id>/) ─────────────

  {
    path: 'inputs/',
    producedBy: 'external',
    consumedBy: ['ace-orchestrator', 'idea-to-pdd'],
    phase: 'design',
    required: true,
    description: 'Canonical input pack for the opp. Contains pdd.md (required) and any supporting docs (sample paper forms, interview guides, notes). Read at run start; the PDD body is copied into runs/<run-id>/idea.md.',
  },
  {
    path: 'opp.yaml',
    producedBy: 'ace-orchestrator',
    consumedBy: ['ace-orchestrator'],
    phase: 'design',
    required: false,
    description: 'Opp-level metadata: display_name, slug, last_run_id, tags, created_at, created_by. Created lazily on the first run; updated on every run to bump last_run_id.',
  },

```

- [ ] **Step 4: Run TypeScript compile + existing manifest tests**

```bash
cd /Users/acedimagi/emdash/repositories/ace
npx tsc --noEmit lib/artifact-manifest.ts
# If a manifest test exists, run it:
[ -f lib/artifact-manifest.test.ts ] && npx vitest run lib/artifact-manifest.test.ts
```

Expected: tsc clean, vitest pass (or skipped if no test).

- [ ] **Step 5: Commit**

```bash
git add lib/artifact-manifest.ts
git commit -m "feat(manifest): add inputs/ and opp.yaml as opp-level artifacts

Other entries are now interpreted as run-relative
(ACE/<opp>/runs/<run-id>/<path>) — no path string changes; the path
strings keep their existing values."
```

---

## Task 3: Rewrite `agents/ace-orchestrator.md § Starting a New Opportunity`

**Files:**
- Modify: `/Users/acedimagi/emdash/repositories/ace/agents/ace-orchestrator.md`

This is the load-bearing change. The "Starting a New Opportunity" section currently spans lines 587–702. Replace it.

- [ ] **Step 1: Read the current section to confirm boundaries**

```bash
sed -n '585,705p' /Users/acedimagi/emdash/repositories/ace/agents/ace-orchestrator.md
```

Confirm it begins with `## Starting a New Opportunity` and ends with `4. **Begin Phase 1.**` followed by the next H2 (`## Touching State — Operator Capture`).

- [ ] **Step 2: Replace lines 587–702 with the new section**

Use `Edit` tool. Old string starts with `## Starting a New Opportunity` line 587 and ends with `4. **Begin Phase 1.**` line 702. Replace with:

```markdown
## Starting a New Opportunity

`/ace:run` resolves an opp + run-id from its arguments before any skill
fires. The shape of the Drive folder hierarchy:

```
ACE/                              (= ACE_DRIVE_ROOT_FOLDER_ID)
├── <opp>/                        (folder name = opp slug)
│   ├── inputs/                   (canonical input pack — read-only here)
│   │   ├── pdd.md                (the PDD — required)
│   │   └── *.{pdf,md,...}        (optional supporting docs)
│   ├── runs/
│   │   └── <run-id>/             (e.g. "20260502-1830")
│   │       ├── idea.md           (copy of inputs/pdd.md, written at run start)
│   │       ├── state.yaml
│   │       ├── pdd.md            (output of idea-to-pdd; distinct from inputs/pdd.md)
│   │       └── ... (all skill-output subfolders)
│   └── opp.yaml                  (display_name, last_run_id, tags, ...)
```

### Resolution

1. **Read the positional argument** (if any). Use `parseOppRef(arg)` from
   `lib/run-paths.ts` to split `<opp>` vs `<opp>/<run-id>`.

2. **Resolve the opp.**

   **(a) `<opp>` was passed explicitly** (positional or via `parseOppRef`):
   skip discovery, use that opp. If the folder doesn't exist under
   `ACE_DRIVE_ROOT_FOLDER_ID`, create it (`drive_create_folder`); the
   operator is creating a new opp in this case. Do not auto-create
   `inputs/` — the operator must do that step manually so they actively
   choose what goes in. If after this step the opp folder lacks an
   `inputs/` subfolder, stop with the new-layout error message (see § Fallback below).

   **(b) `--idea FILE|-` was passed**: scripted-seed flow. If `<opp>`
   was also provided, use it; otherwise auto-generate a fresh slug
   `smoke-<YYYYMMDD-HHMM>` (today's behavior). Write the idea body
   directly into `runs/<run-id>/idea.md` after step 5 — this path
   bypasses `inputs/` entirely (scripted runs are non-interactive by
   design). No `inputs/pdd.md` write.

   **(c) Zero-arg discovery** (default when neither (a) nor (b)):

   1. Read `ACE_DRIVE_ROOT_FOLDER_ID`. If unset/empty, error:
      `ACE_DRIVE_ROOT_FOLDER_ID is not set in your .env (expected at
      $CLAUDE_PLUGIN_DATA/.env); re-inject from .env.tpl via "op inject
      -i .env.tpl -o $CLAUDE_PLUGIN_DATA/.env --account
      dimagi.1password.com" and retry.`

   2. **Shared-Drive precondition** (unchanged from prior version) — if
      the root is on My Drive instead of a Shared Drive, every artifact
      write fails. `drive_create_file` and `drive_create_folder`
      pre-flight this; `/ace:doctor` reports `drive_shared` PASS/FAIL.

   3. `drive_list_folder` on the ACE root. Filter to subfolders that
      contain an `inputs/` subfolder (one extra `drive_list_folder`
      call per candidate to confirm). The `PDD/` folder, any other
      flat docs, and legacy flat opps without an `inputs/` subfolder
      are ignored.

   4. For each candidate opp, compute `mtime` = newest of:
      - the `inputs/` folder's `modifiedTime`
      - every direct child of `inputs/`'s `modifiedTime`

      Pick the candidate with the latest `mtime`. Tiebreak alphabetical
      on opp name.

   5. If no candidate exists (no folder under `ACE/` has an `inputs/`
      subfolder), stop with the new-layout fallback message — see
      § Fallback below. Do NOT silently fall through to the legacy
      `PDD/` picker.

3. **Resolve the run-id.**

   - **Resume mode** — `<opp>/<run-id>` was passed: load existing
     `state.yaml` from `<opp>/runs/<run-id>/state.yaml` and continue
     from its `step:` field. No new folder is created. Skip steps 4–6.

   - **Fresh mode** — `runId` is null: generate
     `runId = generateRunId(new Date())` (= `YYYYMMDD-HHMM` local time).
     If `<opp>/runs/<runId>/` already exists, append `-2`, `-3`, … until
     unused.

4. **Create the run folder.**
   `drive_create_folder` `<opp>/runs/<runId>/`. Capture the resulting
   folder ID; this is the **run folder ID** that gets passed to every
   downstream skill in place of the previous "opp folder ID".

5. **Seed `idea.md` inside the run folder.**

   - If `--idea FILE|-` was passed, the command has loaded the body.
     Write it verbatim to `<opp>/runs/<runId>/idea.md` via
     `drive_create_file`.

   - Otherwise (zero-arg or `<opp>`-only), find the PDD inside
     `<opp>/inputs/`:
     - prefer file named `pdd.md` or `pdd.gdoc` (case-sensitive),
     - else first file matching `*pdd*` (case-insensitive),
     - else if exactly one document file is present, use it,
     - else stop with `multiple files in inputs/, none named pdd.md —
       rename the canonical PDD to pdd.md and retry`.

     `drive_read_file` on the chosen file, then `drive_create_file`
     the body to `<opp>/runs/<runId>/idea.md`.

6. **Initialize `state.yaml`** at `<opp>/runs/<runId>/state.yaml` with:
   - `mode`, `created` (ISO timestamp), all steps as `pending`
   - `initiated_by: <email>` from `git config user.email` (fallback: `unknown`)
   - `last_actor: <email>` and `last_actor_at: <ISO timestamp>` — same email,
     same timestamp at creation
   - `opp: <opp>`, `run_id: <runId>` — recorded so a transcript reader
     can identify the run from state.yaml alone.

7. **Update `<opp>/opp.yaml`.** Read it (`drive_read_file`); if missing,
   create with:

   ```yaml
   display_name: <opp>          # default to slug; operator can edit later
   slug: <opp>
   last_run_id: <runId>
   tags: []
   created_at: <ISO timestamp>
   created_by: <email>
   ```

   If present, update only `last_run_id` and append `<runId>` to a
   running list under `runs:` (optional — primarily for ace-web's
   ergonomics; ace-web can also derive it from `runs/`).

8. **Log the run setup explicitly.** Emit a log line in this exact form
   so transcript readers and ace-web's ingest can pick it up:

   ```
   [orchestrator] starting opp=<opp> run_id=<runId> mode=<mode>
     inputs_folder=<opp>/inputs (read-only)
     run_folder=<opp>/runs/<runId>
     idea.md ← inputs/pdd.md (or --idea FILE)
   ```

9. **Begin Phase 1.**

### Fallback — no opp has an `inputs/` folder

Stop with this message (do NOT silently fall back to the legacy `PDD/`
picker):

> No opps with an `inputs/` subfolder found under your ACE Drive root.
>
> Create one: in Drive, make `ACE/<your-opp-slug>/inputs/`, drop your
> PDD as `pdd.md` (and any supporting docs), then re-run `/ace:run`.
> See docs/superpowers/specs/2026-05-02-ace-run-multi-run-revival-design.md
> for the full layout.
>
> If you want to keep using the legacy flat layout for one more run,
> pass `--idea FILE|-` to bypass discovery.

The legacy `PDD/` flat folder is kept readable by ace-web for back-compat
viewing of legacy opps, but is no longer consulted for new runs.
```

- [ ] **Step 3: Verify the new section parses as Markdown and lines align**

```bash
cd /Users/acedimagi/emdash/repositories/ace
grep -n "^## " agents/ace-orchestrator.md | head -20
# Confirm "## Starting a New Opportunity" is followed by "## Touching State — Operator Capture"
```

- [ ] **Step 4: Smoke read the orchestrator end-to-end**

```bash
wc -l agents/ace-orchestrator.md
# Expected: file grew by ~50 lines net (new section is longer than old).
```

- [ ] **Step 5: Commit**

```bash
git add agents/ace-orchestrator.md
git commit -m "feat(orchestrator): rewrite Starting a New Opportunity for multi-run layout

Discovery now: list ACE/, filter to folders with inputs/, pick newest
by inputs/ mtime, generate run-id, create runs/<run-id>/. No PDD
picker fallback for fresh runs — operators set up inputs/ once
manually, then zero-arg /ace:run picks the most-recently-touched."
```

---

## Task 4: Update `commands/run.md` argument grammar

**Files:**
- Modify: `/Users/acedimagi/emdash/repositories/ace/commands/run.md`

- [ ] **Step 1: Update the front-matter `argument-hint`**

In `commands/run.md` line 3, change:

```yaml
argument-hint: [<opp-name>] [--mode default|review|auto] [--idea FILE|-] [--ace-web-url URL] [--dry-run] [--sandbox] [--no-evals]
```

to:

```yaml
argument-hint: [<opp>[/<run-id>]] [--mode default|review|auto] [--idea FILE|-] [--ace-web-url URL] [--dry-run] [--sandbox] [--no-evals]
```

- [ ] **Step 2: Replace the Arguments section (currently around lines 11–55)**

Replace the `## Arguments` section's `<opp-name>` bullet with:

```markdown
## Arguments
- `<opp>` or `<opp>/<run-id>` — **optional positional**.
  - Bare `<opp>` (e.g., `turmeric`): use that opp; create a fresh
    `runs/<run-id>/` folder.
  - `<opp>/<run-id>` (e.g., `turmeric/20260502-1830`): resume that
    specific run by reading its existing `state.yaml`.
  - **Omitted (zero-arg)**: discover the opp whose `inputs/` folder
    has the newest mtime, fresh run there. See
    `agents/ace-orchestrator.md § Starting a New Opportunity` for the
    full discovery flow.
```

The rest of the Arguments section (`--mode`, `--idea`, `--ace-web-url`,
`--dry-run`, `--sandbox`, `--no-evals`) is unchanged.

- [ ] **Step 3: Update the Smart-default UX section (currently lines 57–80)**

Replace the `## Smart-default UX (zero-arg happy path)` section with:

```markdown
## Smart-default UX (zero-arg happy path)

The intended minimum invocation is literally `/ace:run`. With no args,
the orchestrator picks the most-recently-touched opp (by `inputs/`
mtime under the ACE Drive root) and starts a fresh run on it. No PDD
picker prompt fires — the operator chose what goes in `inputs/`
once, and zero-arg trusts that choice.

Resolution:

1. If `--idea FILE|-` was passed, scripted-seed flow: write the idea
   body to `runs/<run-id>/idea.md` directly. Skip discovery.
2. Else read `ACE_DRIVE_ROOT_FOLDER_ID`. Stop with an actionable error
   if unset.
3. List `ACE/`. Find subfolders containing an `inputs/` subfolder.
4. Pick the candidate with the newest `inputs/` mtime; folder name = `<opp>`.
5. If no candidate exists, stop with the new-layout setup message.
6. Generate `runId` = `YYYYMMDD-HHMM` (collision-suffixed).
7. `mkdir <opp>/runs/<runId>/`; copy `inputs/pdd.md` body → `runs/<runId>/idea.md`.
8. Init `state.yaml`; update `opp.yaml.last_run_id`.
9. Begin Phase 1.

See `agents/ace-orchestrator.md` for full detail.
```

- [ ] **Step 4: Update the Process section step 1 (around line 88)**

Find:

```markdown
1. Parse arguments. Default mode is `default`. If `<opp-name>` is missing,
   generate `smoke-<YYYYMMDD-HHMM>` using `date +%Y%m%d-%H%M`.
```

Replace with:

```markdown
1. Parse arguments. Default mode is `default`. The positional argument
   may be `<opp>`, `<opp>/<run-id>`, or omitted; pass it through to the
   orchestrator's discovery step (see `agents/ace-orchestrator.md
   § Starting a New Opportunity`). The orchestrator handles slug
   generation and resume-detection — `commands/run.md` does NOT
   pre-generate a slug here.
```

- [ ] **Step 5: Lint / format check**

```bash
cd /Users/acedimagi/emdash/repositories/ace
# No formal linter for markdown; verify there are no broken references.
grep -n "smoke-<YYYYMMDD-HHMM>" commands/run.md
# Expected: zero matches (the old fallback shouldn't be referenced anymore).
```

- [ ] **Step 6: Commit**

```bash
git add commands/run.md
git commit -m "feat(commands/run): <opp>/<run-id> grammar + zero-arg picks newest inputs/

Drops the old smoke-<timestamp> auto-slug. Zero-arg now goes through
the orchestrator's inputs/-discovery flow; a fresh run-id is generated
inside the chosen opp folder. /ace:run <opp>/<run-id> resumes."
```

---

## Task 5: Update `commands/status.md` for opps→runs hierarchy

**Files:**
- Modify: `/Users/acedimagi/emdash/repositories/ace/commands/status.md`

- [ ] **Step 1: Read the current command**

```bash
cat /Users/acedimagi/emdash/repositories/ace/commands/status.md
```

Today's status command lists opportunities flat. The new shape: list opps (one line per `<opp>/`), and under each opp list its runs sorted newest-first (one line per `runs/<run-id>/`).

- [ ] **Step 2: Replace the command body**

Replace the entire body with the following (keep the front-matter intact, but update `description` to mention multi-run):

```markdown
---
description: Show the current status of an opportunity or list all active opportunities (opps + runs hierarchy)
allowed-tools: [Read, Bash, mcp__plugin_ace_ace-gdrive__drive_list_folder, mcp__plugin_ace_ace-gdrive__drive_read_file]
---

# /ace:status

Show the current state of opps and their runs.

## Arguments
- `<opp>` (optional) — show only this opp and its runs.
- `<opp>/<run-id>` (optional) — show only this specific run's detailed state.

## Process

### List mode (no args)

1. `drive_list_folder` on `ACE_DRIVE_ROOT_FOLDER_ID`. For each subfolder,
   confirm it has an `inputs/` subfolder (skip ones that don't — those
   are legacy flat opps, surface them under a separate "Legacy" section).
2. For each opp, `drive_list_folder` on `<opp>/runs/`. Sort runs newest
   first by folder name (run-id is sortable as a string).
3. For each run, `drive_read_file` `<opp>/runs/<run-id>/state.yaml` and
   pull `phase`, `step`, `mode`, `last_actor`, `last_actor_at`.
4. Print:

   ```
   <opp>  (display_name from opp.yaml)
     20260502-1830  Phase 4/ocs-agent-setup  default  ace@dimagi-ai.com  2026-05-02T18:42Z
     20260502-1430  done                     default  ace@dimagi-ai.com  2026-05-02T16:01Z
     20260501-2200  Phase 2/pdd-to-deliver-app  review  jjackson@dimagi.com  2026-05-01T22:30Z

   <other-opp>  (...)
     ...
   ```

5. After the new-layout opps, if any legacy flat opps exist (folder
   under `ACE/` with `state.yaml` at root, no `runs/` subfolder), print
   a section header `## Legacy (delete when ready)` and list them with
   the same per-run line format.

### Detail mode (`<opp>` or `<opp>/<run-id>`)

1. If `<opp>` only: print the per-run summary from list mode for that
   opp's runs, then dump `<opp>/opp.yaml` body.
2. If `<opp>/<run-id>`: print that run's `state.yaml` body verbatim, plus
   any `gates:` / verdicts referenced.
```

- [ ] **Step 3: Commit**

```bash
git add commands/status.md
git commit -m "feat(commands/status): show opps→runs hierarchy

Default list mode groups runs under their opp; legacy flat opps appear
in a separate trailing section to keep the new-layout opps clean."
```

---

## Task 6: Update `bin/ace-doctor` — inputs/pdd.md check + ACE_E2E_AUTH_TOKEN check

**Files:**
- Modify: `/Users/acedimagi/emdash/repositories/ace/bin/ace-doctor`

- [ ] **Step 1: Locate the env-check block**

```bash
grep -n "ACE_DRIVE_ROOT_FOLDER_ID\|env_drift\|ACE_E2E_AUTH_TOKEN" /Users/acedimagi/emdash/repositories/ace/bin/ace-doctor | head -20
```

The env-block starts at line 382. The `DRIVE_ROOT` check is at line 407–411.

- [ ] **Step 2: Add the `ACE_E2E_AUTH_TOKEN` env check after the `DRIVE_ROOT` check**

Find the line `warn "drive_root: ACE_DRIVE_ROOT_FOLDER_ID not set (PDD auto-discovery disabled)"` (around line 410). Insert after the closing `fi` of that block (around line 411):

```bash
  # ACE_E2E_AUTH_TOKEN gates the /auth/e2e-login/ shared-secret automation
  # path on labs. Without it, scripted tools like
  # tools/walkthrough/run_chat_e2e.py and the upload-transcript skill
  # cannot drive the deployed ace-web. Token rotates via AWS Secrets
  # Manager; mirrored into deploy/aws/task-definition.json AND should be
  # in .env so local tools and the doctor agree on the value.
  E2E_TOKEN="$(get_env ACE_E2E_AUTH_TOKEN)"
  if [ -n "$E2E_TOKEN" ]; then
    pass "e2e_auth_token: ACE_E2E_AUTH_TOKEN is set (${#E2E_TOKEN} chars)"
  else
    warn "e2e_auth_token: ACE_E2E_AUTH_TOKEN not set" "add to .env (mirror from deploy/aws/task-definition.json or AWS Secrets Manager); needed by tools/walkthrough/run_chat_e2e.py and skills/upload-transcript"
  fi
```

- [ ] **Step 3: Add the `inputs/pdd.md` discovery check**

In the same env-block, after the shared-Drive canary (around line 460), add:

```bash
  # Multi-run layout sanity: at least one <opp>/inputs/pdd.md should
  # exist under the Drive root. Without one, /ace:run zero-arg fires
  # the new-layout setup error. INFO (not WARN) — first-time installs
  # legitimately have nothing yet.
  if [ -n "$DRIVE_ROOT" ] && [ -n "$KEY" ] && [ -d "$ROOT/node_modules/googleapis" ]; then
    INPUTS_PROBE="$(GOOGLE_APPLICATION_CREDENTIALS="$KEY" node --input-type=module -e "
      import { google } from 'googleapis';
      const auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, scopes: ['https://www.googleapis.com/auth/drive'] });
      const drive = google.drive({ version: 'v3', auth });
      try {
        const root = '$DRIVE_ROOT';
        const opps = await drive.files.list({
          q: \`'\${root}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false\`,
          fields: 'files(id,name)', supportsAllDrives: true, includeItemsFromAllDrives: true, pageSize: 100,
        });
        let count = 0;
        for (const opp of opps.data.files || []) {
          const inputs = await drive.files.list({
            q: \`'\${opp.id}' in parents and name='inputs' and mimeType='application/vnd.google-apps.folder' and trashed=false\`,
            fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true,
          });
          if ((inputs.data.files || []).length > 0) count += 1;
        }
        console.log(JSON.stringify({ ok: true, count }));
      } catch (e) { console.log(JSON.stringify({ ok: false, message: String(e.message || e) })); }
    " 2>/dev/null)"
    INPUTS_OK="$(printf '%s' "$INPUTS_PROBE" | node -e "try { const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.ok?'1':'0'); } catch { console.log('?'); }" 2>/dev/null)"
    INPUTS_COUNT="$(printf '%s' "$INPUTS_PROBE" | node -e "try { const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.count||0); } catch { console.log('0'); }" 2>/dev/null)"
    if [ "$INPUTS_OK" = "1" ]; then
      if [ "$INPUTS_COUNT" -gt 0 ] 2>/dev/null; then
        pass "input_packs: $INPUTS_COUNT opp(s) under \$ACE_DRIVE_ROOT_FOLDER_ID have an inputs/ subfolder"
      else
        info "input_packs: no opps with inputs/ found yet — first-time setup, see /ace:run for the new-layout howto"
      fi
    fi
  fi
```

If `info` is not already a defined function in the doctor script, add it next to the existing `pass`/`warn`/`fail` definitions (search `_log()` and add):

```bash
info() { _log "INFO" "$1"; }
```

- [ ] **Step 4: Run the doctor to confirm both checks fire**

```bash
cd /Users/acedimagi/emdash/repositories/ace
./bin/ace-doctor
# Look for:
#   PASS e2e_auth_token: ... (or WARN if not in .env yet)
#   INFO input_packs: ... (or PASS if user has already created an input pack)
```

- [ ] **Step 5: Commit**

```bash
git add bin/ace-doctor
git commit -m "feat(doctor): check ACE_E2E_AUTH_TOKEN and <opp>/inputs/pdd.md presence

Two new checks. ACE_E2E_AUTH_TOKEN closes the gap surfaced while
designing the multi-run revival — the token was checked into
deploy/aws/task-definition.json but doctor never validated the local
.env. input_packs INFO surfaces whether the new layout is set up."
```

---

## Task 7: Update `skills/upload-transcript/SKILL.md` to send `opp_run_id`

**Files:**
- Modify: `/Users/acedimagi/emdash/repositories/ace/skills/upload-transcript/SKILL.md`

- [ ] **Step 1: Read the skill**

```bash
cat /Users/acedimagi/emdash/repositories/ace/skills/upload-transcript/SKILL.md
```

Find the section that describes the multipart payload to `/api/ingest/upload`. Confirm it currently sends `opp_slug` but is silent on `opp_run_id` for new-layout opps.

- [ ] **Step 2: Add an explicit "opp_slug + opp_run_id" payload section**

In the SKILL.md, find the multipart-fields block and add (or update) the documentation so the skill instructs Claude to send both fields:

```markdown
## Payload fields

When invoked from the orchestrator with both `<opp>` and `<run-id>` in
context (the multi-run layout introduced 2026-05-02), send BOTH:

- `opp_slug`: the opp folder name (e.g. `turmeric`).
- `opp_run_id`: the run-id (e.g. `20260502-1830`).
- `opp_step_skill` (optional): the skill that triggered the upload.

For legacy flat opps (no `runs/` subfolder), send `opp_slug` only and
omit `opp_run_id`. The ace-web ingest endpoint accepts either shape.
```

- [ ] **Step 3: Commit**

```bash
git add skills/upload-transcript/SKILL.md
git commit -m "docs(upload-transcript): document opp_run_id payload field for multi-run"
```

---

## Task 8: Bump VERSION + CHANGELOG; tag for ace-web pickup

**Files:**
- Modify: `/Users/acedimagi/emdash/repositories/ace/VERSION`
- Modify: `/Users/acedimagi/emdash/repositories/ace/CHANGELOG.md`

- [ ] **Step 1: Read current version**

```bash
cat /Users/acedimagi/emdash/repositories/ace/VERSION
```

Today's value (per recent commits): `0.10.49` or thereabouts. Bump minor (Drive layout change is breaking-ish for ace-web's reader): pick the next minor (e.g., `0.11.0`).

- [ ] **Step 2: Update VERSION**

```bash
echo "0.11.0" > /Users/acedimagi/emdash/repositories/ace/VERSION
```

- [ ] **Step 3: Update CHANGELOG.md**

Add a new top-of-file entry:

```markdown
## 0.11.0 — 2026-05-02

**Multi-run-per-opp revival + canonical input packs.**

The Drive layout changes from one folder per `/ace:run` to one folder
per opp containing `inputs/` (canonical input pack — PDD plus
supporting docs) and `runs/<YYYYMMDD-HHMM>/` (one folder per fresh
run). `/ace:run` zero-arg now picks the most-recently-touched opp by
`inputs/` mtime and starts a fresh run on it; no PDD-picker prompt
fires for fresh runs. `/ace:run <opp>/<run-id>` resumes a specific run.

- Added: `lib/run-paths.ts` helpers, `inputs/` and `opp.yaml` artifact
  manifest entries, `ACE_E2E_AUTH_TOKEN` and `input_packs` checks in
  `bin/ace-doctor`.
- Changed: `agents/ace-orchestrator.md § Starting a New Opportunity`
  rewritten for the new layout; `commands/run.md` argument grammar
  grew `<opp>/<run-id>` resume; `commands/status.md` now groups runs
  under their opp; `skills/upload-transcript` documents the
  `opp_run_id` payload field.
- Removed (in `agents/`): the `smoke-<timestamp>` auto-slug fallback;
  the legacy `PDD/` picker is no longer consulted for new runs (it
  remains readable for back-compat viewing of legacy opps in ace-web).

Spec: `docs/superpowers/specs/2026-05-02-ace-run-multi-run-revival-design.md`.
Plan: `docs/superpowers/plans/2026-05-02-ace-run-multi-run-revival.md`.

ace-web companion change required to read the new layout — see ace-web
branch `multi-run-revival`.
```

- [ ] **Step 4: Commit + tag**

```bash
cd /Users/acedimagi/emdash/repositories/ace
git add VERSION CHANGELOG.md
git commit -m "chore: bump 0.11.0 — multi-run-per-opp revival"
git tag -a v0.11.0 -m "v0.11.0 — multi-run-per-opp revival + canonical input packs"
```

- [ ] **Step 5: Push branch + tag (only after the user has reviewed the branch)**

DO NOT auto-push. The user's CLAUDE.md says only push when explicitly asked. Surface to the user:

> Plugin Phase A complete on branch `spec/multi-run-revival`. Ready to push?
>
> ```bash
> git push -u origin spec/multi-run-revival
> git push origin v0.11.0
> ```

---

# Phase B — ace-web

All Phase-B tasks happen in `/Users/acedimagi/emdash/repositories/ace-web` on a new branch `multi-run-revival` cut from `main`.

## Task 9: Bump `ACE_REF` in Dockerfile

**Files:**
- Modify: `/Users/acedimagi/emdash/repositories/ace-web/Dockerfile`

- [ ] **Step 1: Cut the branch**

```bash
cd /Users/acedimagi/emdash/repositories/ace-web
git fetch origin
git checkout -b multi-run-revival origin/main
```

- [ ] **Step 2: Locate ACE_REF**

```bash
grep -n "ACE_REF" /Users/acedimagi/emdash/repositories/ace-web/Dockerfile
```

- [ ] **Step 3: Bump to v0.11.0**

Edit `Dockerfile` to set `ARG ACE_REF=v0.11.0`. Do NOT commit yet — this is the first change of a multi-task branch and the build will fail until the rest of Phase B's reader is in place. Stash:

```bash
cd /Users/acedimagi/emdash/repositories/ace-web
git diff Dockerfile      # confirm only ACE_REF changed
```

The commit happens at the end of Phase B (Task 15) so the bump and the reader-side changes ship in one push.

---

## Task 10: Multi-run loader in `apps/opps/sync.py`

**Files:**
- Modify: `/Users/acedimagi/emdash/repositories/ace-web/apps/opps/sync.py`
- Create: `/Users/acedimagi/emdash/repositories/ace-web/apps/opps/tests/test_sync_multi_run.py`

`apps/opps/sync.py` already has the right dataclass shapes (`OppSnapshot`, `RunDetail`, `StepSnapshot`) — they were carried through from the pre-2026-04-20 multi-run era and just have `run_id="r1"` baked in. The work here is wiring the new layout's reader paths.

- [ ] **Step 1: Write failing tests for the new multi-run reader**

Create `apps/opps/tests/test_sync_multi_run.py`:

```python
"""Tests for the multi-run-aware structured-layout reader.

Layout being tested:

    ACE/
    ├── turmeric/
    │   ├── inputs/
    │   │   └── pdd.md
    │   ├── runs/
    │   │   ├── 20260502-1830/{state.yaml, idea.md, ...}
    │   │   └── 20260502-1430/{state.yaml, ...}
    │   └── opp.yaml
    └── ...
"""
from __future__ import annotations
from dataclasses import dataclass

import pytest

from apps.opps.drive_client import DriveFile, FileContent
from apps.opps.sync import (
    OppSnapshot,
    list_opp_runs,
    load_opp,
    load_opp_card,
)


@dataclass
class _Folder:
    id: str
    name: str
    parent: str
    children: list  # list[_File | _Folder]


@dataclass
class _File:
    id: str
    name: str
    parent: str
    body: str = ""
    mime_type: str = "text/plain"


class FakeDrive:
    """Minimal in-memory DriveClient. Just what sync.py uses."""

    def __init__(self, root: _Folder) -> None:
        self._index_by_id = {}
        self._build_index(root)

    def _build_index(self, node) -> None:
        self._index_by_id[node.id] = node
        if isinstance(node, _Folder):
            for c in node.children:
                self._build_index(c)

    def list_folder(self, folder_id: str) -> list[DriveFile]:
        node = self._index_by_id.get(folder_id)
        if not isinstance(node, _Folder):
            return []
        out = []
        for c in node.children:
            mime = (
                "application/vnd.google-apps.folder"
                if isinstance(c, _Folder)
                else c.mime_type
            )
            out.append(
                DriveFile(
                    id=c.id, name=c.name, mime_type=mime,
                    parent_id=folder_id, web_view_link=f"https://drive/{c.id}",
                    size_bytes=len(getattr(c, "body", "")) or None,
                    modified_time="2026-05-02T18:30:00Z",
                    path=c.name,
                )
            )
        return out

    def get_content(self, file_id: str, mime_type: str) -> FileContent:
        node = self._index_by_id.get(file_id)
        body = getattr(node, "body", "") if node else ""
        return FileContent(content=body)


def _build_turmeric_layout() -> _Folder:
    """Two runs under turmeric — newest is 20260502-1830."""
    return _Folder(
        id="ACE", name="ACE", parent="",
        children=[
            _Folder(
                id="turmeric", name="turmeric", parent="ACE",
                children=[
                    _Folder(
                        id="turmeric-inputs", name="inputs", parent="turmeric",
                        children=[
                            _File(
                                id="pdd-input", name="pdd.md", parent="turmeric-inputs",
                                body="# Turmeric PDD\n\n...",
                                mime_type="text/markdown",
                            ),
                        ],
                    ),
                    _Folder(
                        id="turmeric-runs", name="runs", parent="turmeric",
                        children=[
                            _Folder(
                                id="run-1830", name="20260502-1830", parent="turmeric-runs",
                                children=[
                                    _File(
                                        id="state-1830", name="state.yaml",
                                        parent="run-1830",
                                        body=(
                                            "mode: default\n"
                                            "phase: ocs\n"
                                            "step: ocs-agent-setup\n"
                                            "opp: turmeric\n"
                                            "run_id: 20260502-1830\n"
                                            "gates: {}\n"
                                            "initiated_by: ace@dimagi-ai.com\n"
                                            "last_actor: ace@dimagi-ai.com\n"
                                            "last_actor_at: 2026-05-02T18:42:00Z\n"
                                        ),
                                        mime_type="text/yaml",
                                    ),
                                    _File(
                                        id="idea-1830", name="idea.md",
                                        parent="run-1830",
                                        body="# Turmeric PDD",
                                        mime_type="text/markdown",
                                    ),
                                ],
                            ),
                            _Folder(
                                id="run-1430", name="20260502-1430", parent="turmeric-runs",
                                children=[
                                    _File(
                                        id="state-1430", name="state.yaml",
                                        parent="run-1430",
                                        body=(
                                            "mode: default\n"
                                            "phase: closeout\n"
                                            "step: cycle-grade\n"
                                            "opp: turmeric\n"
                                            "run_id: 20260502-1430\n"
                                            "gates: {}\n"
                                            "initiated_by: ace@dimagi-ai.com\n"
                                            "last_actor: ace@dimagi-ai.com\n"
                                            "last_actor_at: 2026-05-02T16:01:00Z\n"
                                        ),
                                        mime_type="text/yaml",
                                    ),
                                ],
                            ),
                        ],
                    ),
                    _File(
                        id="opp-yaml", name="opp.yaml", parent="turmeric",
                        body=(
                            "display_name: Turmeric Market Survey\n"
                            "slug: turmeric\n"
                            "last_run_id: 20260502-1830\n"
                            "tags: []\n"
                            "created_at: 2026-05-02T14:30:00Z\n"
                            "created_by: ace@dimagi-ai.com\n"
                        ),
                        mime_type="text/yaml",
                    ),
                ],
            ),
        ],
    )


def test_list_opp_runs_returns_runs_newest_first():
    fake = FakeDrive(_build_turmeric_layout())
    runs = list_opp_runs(fake, ace_root_folder_id="ACE", opp_slug="turmeric")
    assert [r.run_id for r in runs] == ["20260502-1830", "20260502-1430"]


def test_load_opp_card_uses_opp_yaml_display_name():
    fake = FakeDrive(_build_turmeric_layout())
    card = load_opp_card(fake, ace_root_folder_id="ACE", opp_slug="turmeric")
    assert card["slug"] == "turmeric"
    assert card["display_name"] == "Turmeric Market Survey"
    assert card["current_run_id"] == "20260502-1830"
    assert card["current_phase"] == "ocs"


def test_load_opp_returns_default_run_when_no_id_specified():
    fake = FakeDrive(_build_turmeric_layout())
    snap: OppSnapshot = load_opp(fake, ace_root_folder_id="ACE", opp_slug="turmeric")
    assert snap.current_run.run_id == "20260502-1830"
    assert snap.current_run.current_phase == "ocs"


def test_load_opp_loads_specific_run_when_run_id_given():
    fake = FakeDrive(_build_turmeric_layout())
    snap = load_opp(
        fake, ace_root_folder_id="ACE",
        opp_slug="turmeric", run_id="20260502-1430",
    )
    assert snap.current_run.run_id == "20260502-1430"
    assert snap.current_run.current_phase == "closeout"
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/acedimagi/emdash/repositories/ace-web
pytest apps/opps/tests/test_sync_multi_run.py -v
```

Expected: ImportError or AttributeError on `list_opp_runs` (not defined yet) and `load_opp` not accepting a `run_id` keyword.

- [ ] **Step 3: Add `list_opp_runs` to `apps/opps/sync.py`**

After the existing `_find_child_folder` helper (around line 99), add:

```python
@dataclass
class RunSummary:
    """One row in the runs[] list — lightweight summary, no step iteration.

    Used by:
    - The opp page's run-selector (does not need full step detail).
    - The opp card on the list page (latest run only).
    """
    run_id: str
    folder_id: str
    current_phase: str | None
    current_step: str | None
    mode: str | None
    last_actor: str | None
    last_actor_at: str | None


def list_opp_runs(
    client: DriveClient,
    *,
    ace_root_folder_id: str,
    opp_slug: str,
) -> list[RunSummary]:
    """List runs under <opp>/runs/, newest-first by run-id (sorts as string).

    Returns empty list if the opp folder doesn't exist or has no runs/
    subfolder. Each RunSummary is loaded by reading state.yaml from the
    run folder.
    """
    opp_folder = _find_child_folder(client.list_folder(ace_root_folder_id), opp_slug)
    if opp_folder is None:
        return []
    runs_folder = _find_child_folder(client.list_folder(opp_folder.id), "runs")
    if runs_folder is None:
        return []

    out: list[RunSummary] = []
    for child in client.list_folder(runs_folder.id):
        if not _is_folder(child):
            continue
        state_file = _find_child(client.list_folder(child.id), "state.yaml")
        if state_file is None:
            continue
        try:
            body = _read_text(client, state_file)
            state = yaml.safe_load(body) or {}
        except (yaml.YAMLError, OSError) as exc:
            log.warning("list_opp_runs: failed to read %s: %s", state_file.id, exc)
            continue
        out.append(
            RunSummary(
                run_id=child.name,
                folder_id=child.id,
                current_phase=state.get("phase"),
                current_step=state.get("step"),
                mode=state.get("mode"),
                last_actor=state.get("last_actor"),
                last_actor_at=state.get("last_actor_at"),
            )
        )

    out.sort(key=lambda r: r.run_id, reverse=True)
    return out
```

- [ ] **Step 4: Update `load_opp` to accept an optional `run_id`**

Find the existing `def load_opp(...)` signature (search `def load_opp(`) and:

1. Add `run_id: str | None = None` keyword arg.
2. Inside the function, change the path that today reads `<opp>/state.yaml` to:
   - If `run_id` is given: read `<opp>/runs/<run_id>/state.yaml`.
   - Else: list `<opp>/runs/` newest-first; pick the first run; read its state.yaml.
   - Fallback: if no `runs/` subfolder exists (legacy flat opp), keep today's flat reader behavior (read `<opp>/state.yaml` directly). Set `current_run.run_id = "r1"` for the legacy path so the existing frontend keeps working until the legacy reader is dropped.

Concrete patch (the exact line numbers will shift; use the surrounding code as the anchor):

```python
def load_opp(
    client: DriveClient,
    *,
    ace_root_folder_id: str,
    opp_slug: str,
    run_id: str | None = None,
) -> OppSnapshot:
    opp_folder = _find_child_folder(
        client.list_folder(ace_root_folder_id), opp_slug
    )
    if opp_folder is None:
        raise FileNotFoundError(f"opp {opp_slug!r} not found")

    opp_files = client.list_folder(opp_folder.id)
    runs_folder = _find_child_folder(opp_files, "runs")

    if runs_folder is None:
        # Legacy flat layout — keep existing reader path. Set run_id="r1".
        return _load_opp_flat(client, opp_folder, opp_files, opp_slug)

    # Multi-run layout.
    run_summaries = list_opp_runs(
        client, ace_root_folder_id=ace_root_folder_id, opp_slug=opp_slug,
    )
    if not run_summaries:
        raise FileNotFoundError(
            f"opp {opp_slug!r} has runs/ subfolder but no runs inside"
        )
    target = run_summaries[0] if run_id is None else next(
        (r for r in run_summaries if r.run_id == run_id), None
    )
    if target is None:
        raise FileNotFoundError(
            f"run {run_id!r} not found under opp {opp_slug!r}"
        )

    return _load_opp_run(
        client, opp_folder=opp_folder,
        run_summary=target, run_summaries=run_summaries,
    )
```

Then extract today's `load_opp` body into `_load_opp_flat(client, opp_folder, opp_files, opp_slug)` (legacy path) and write a new `_load_opp_run(client, opp_folder, run_summary, run_summaries)` that reads files from the run folder. Both return an `OppSnapshot` whose `current_run` is populated from the chosen run.

- [ ] **Step 5: Update `load_opp_card` (the lightweight list-card variant)**

Find `def load_opp_card(...)` and apply the same multi-run aware logic:
- list `<opp>/runs/` for the latest-run summary
- read `<opp>/opp.yaml` for `display_name` (fall back to slug)
- attach `current_run_id`, `current_phase`, `current_step` from the latest run
- For legacy flat opps (no `runs/`), keep existing logic.

- [ ] **Step 6: Run the tests**

```bash
pytest apps/opps/tests/test_sync_multi_run.py -v
```

Expected: all 4 tests PASS.

- [ ] **Step 7: Run the existing flat-layout tests to make sure they still pass**

```bash
pytest apps/opps/tests/ -v
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add apps/opps/sync.py apps/opps/tests/test_sync_multi_run.py
git commit -m "feat(opps): multi-run-aware reader in apps/opps/sync.py

list_opp_runs() lists <opp>/runs/<run-id>/ newest-first; load_opp()
takes an optional run_id and falls back to the latest run when omitted.
Legacy flat-layout reader path preserved for back-compat (opp folders
without a runs/ subfolder)."
```

---

## Task 11: New `runs_list` view + `?run_id=` on workbench

**Files:**
- Modify: `/Users/acedimagi/emdash/repositories/ace-web/apps/opps/views.py`
- Modify: `/Users/acedimagi/emdash/repositories/ace-web/apps/opps/urls.py`
- Create: `/Users/acedimagi/emdash/repositories/ace-web/apps/opps/tests/test_views_runs_list.py`

- [ ] **Step 1: Write the failing view test**

Create `apps/opps/tests/test_views_runs_list.py`:

```python
"""Tests for /api/workspaces/<ws>/opps/<slug>/runs and ?run_id= on workbench."""
import pytest
from django.urls import reverse
from rest_framework.test import APIClient

from apps.workspaces.tests.factories import workspace_with_user


@pytest.mark.django_db
def test_runs_list_returns_runs_newest_first(monkeypatch):
    ws, user = workspace_with_user("dimagi-team", "u@example.com")
    client = APIClient(); client.force_authenticate(user=user)

    # Stub list_opp_runs to return a known shape.
    from apps.opps import views, sync
    monkeypatch.setattr(views, "list_opp_runs", lambda *a, **kw: [
        sync.RunSummary(
            run_id="20260502-1830", folder_id="r1830",
            current_phase="ocs", current_step="ocs-agent-setup",
            mode="default", last_actor="u@example.com",
            last_actor_at="2026-05-02T18:42:00Z",
        ),
        sync.RunSummary(
            run_id="20260502-1430", folder_id="r1430",
            current_phase="closeout", current_step="cycle-grade",
            mode="default", last_actor="u@example.com",
            last_actor_at="2026-05-02T16:01:00Z",
        ),
    ])
    monkeypatch.setattr(views, "_resolve_ace_root_folder_id", lambda ws: "ACE")
    monkeypatch.setattr(views, "get_drive_client", lambda *a, **kw: object())

    resp = client.get("/api/workspaces/dimagi-team/opps/turmeric/runs")
    assert resp.status_code == 200
    body = resp.json()
    assert body["error"] is None
    assert [r["run_id"] for r in body["data"]] == ["20260502-1830", "20260502-1430"]


@pytest.mark.django_db
def test_workbench_with_run_id_loads_specific_run(monkeypatch):
    """?run_id=20260502-1430 forwards to load_opp(run_id=...)."""
    ws, user = workspace_with_user("dimagi-team", "u@example.com")
    client = APIClient(); client.force_authenticate(user=user)

    captured = {}

    def fake_load_opp(drive, *, ace_root_folder_id, opp_slug, run_id=None):
        captured["run_id"] = run_id
        # Return a minimal snapshot — serializer just needs a valid object.
        from apps.opps.sync import OppSnapshot
        return OppSnapshot(  # type: ignore[call-arg]
            opp=None, pdd_body="", opp_folder_id="folder-id", current_run=None,
        )

    monkeypatch.setattr("apps.opps.views.load_opp", fake_load_opp)
    monkeypatch.setattr("apps.opps.views._resolve_ace_root_folder_id", lambda ws: "ACE")
    monkeypatch.setattr("apps.opps.views.get_drive_client", lambda *a, **kw: object())

    client.get(
        "/api/workspaces/dimagi-team/opps/turmeric?run_id=20260502-1430",
    )
    assert captured["run_id"] == "20260502-1430"
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
pytest apps/opps/tests/test_views_runs_list.py -v
```

Expected: 404 (endpoint doesn't exist) + AssertionError (run_id not forwarded).

- [ ] **Step 3: Add the `runs_list` view in `apps/opps/views.py`**

After the `workbench` view (search `def workbench(`), add:

```python
@api_view(["GET"])
@permission_classes([AllowAny])
def runs_list(request, slug: str, **kwargs):
    """GET /api/workspaces/<ws>/opps/<slug>/runs — list runs newest-first."""
    ws, client, err = _require_drive(request)
    if err is not None:
        return err
    ace_folder_id = _resolve_ace_root_folder_id(ws)
    if ace_folder_id is None:
        return Response(
            error_response("ACE root folder not found", code="ace-root-not-found"),
            status=404,
        )
    from apps.opps.sync import list_opp_runs  # avoid module-cycle on import
    runs = list_opp_runs(client, ace_root_folder_id=ace_folder_id, opp_slug=slug)
    return Response(success_response([
        {
            "run_id": r.run_id,
            "folder_id": r.folder_id,
            "current_phase": r.current_phase,
            "current_step": r.current_step,
            "mode": r.mode,
            "last_actor": r.last_actor,
            "last_actor_at": r.last_actor_at,
        } for r in runs
    ]))
```

- [ ] **Step 4: Update `workbench` view to forward `?run_id=`**

Find the `workbench` view body. Where it calls `load_opp(client, ace_root_folder_id=..., opp_slug=slug)`, change to:

```python
run_id_param = request.GET.get("run_id") or None
snap = load_opp(
    client,
    ace_root_folder_id=ace_folder_id,
    opp_slug=slug,
    run_id=run_id_param,
)
```

- [ ] **Step 5: Wire `runs_list` in `apps/opps/urls.py`**

Insert into `urlpatterns` (in `apps/opps/urls.py`) before the existing `path("<slug:slug>", ...)` line:

```python
    path("<slug:slug>/runs", views.runs_list, name="opps-runs-list"),
```

- [ ] **Step 6: Run tests**

```bash
pytest apps/opps/tests/test_views_runs_list.py -v
pytest apps/opps/tests/ -v
```

Both: green.

- [ ] **Step 7: Commit**

```bash
git add apps/opps/views.py apps/opps/urls.py apps/opps/tests/test_views_runs_list.py
git commit -m "feat(opps): runs-list endpoint + ?run_id= on workbench

GET /api/workspaces/<ws>/opps/<slug>/runs returns the run list
newest-first; the workbench detail endpoint now forwards an optional
?run_id= query param to the multi-run-aware loader."
```

---

## Task 12: Serializer — include `runs[]` summary on opp snapshot

**Files:**
- Modify: `/Users/acedimagi/emdash/repositories/ace-web/apps/opps/serializers.py`

- [ ] **Step 1: Add a `runs[]` summary array + `selected_run_id` to `serialize_opp_snapshot`**

Open `apps/opps/serializers.py` and find `def serialize_opp_snapshot(...)`. Modify the signature to accept a new keyword-only `runs` argument (defaulting to `None`), and append two keys to the returned dict before `return`:

```python
def serialize_opp_snapshot(snap, *, runs=None):  # add `*, runs=None`
    # ... existing body that builds `out = {...}` is unchanged ...

    # NEW — append the multi-run summary fields:
    out["runs"] = [
        {
            "run_id": r.run_id,
            "current_phase": r.current_phase,
            "current_step": r.current_step,
            "mode": r.mode,
            "last_actor": r.last_actor,
            "last_actor_at": r.last_actor_at,
        }
        for r in (runs or [])
    ]
    out["selected_run_id"] = (
        snap.current_run.run_id if snap.current_run is not None else None
    )
    return out
```

Do NOT touch the existing key construction logic — only add the two new lines after the existing `out = {...}` block and before `return out`.

- [ ] **Step 2: Update `views.workbench` to pass `runs=...`**

In the `workbench` view, after `load_opp(...)`, also call `list_opp_runs(...)` and pass it to the serializer. (One extra Drive list_folder per page load — acceptable.)

- [ ] **Step 3: Confirm existing tests still pass + serializer test (if one exists) passes**

```bash
pytest apps/opps/tests/ -v
```

- [ ] **Step 4: Commit**

```bash
git add apps/opps/serializers.py apps/opps/views.py
git commit -m "feat(opps): include runs[] summary in opp snapshot for run-selector UI"
```

---

## Task 13: Frontend — `RunSelector` component + Workbench wiring

**Files:**
- Create: `/Users/acedimagi/emdash/repositories/ace-web/frontend/src/components/opps/RunSelector.tsx`
- Modify: `/Users/acedimagi/emdash/repositories/ace-web/frontend/src/components/opps/WorkbenchHeader.tsx`
- Modify: `/Users/acedimagi/emdash/repositories/ace-web/frontend/src/pages/OppWorkbenchPage.tsx`

- [ ] **Step 1: Create `RunSelector.tsx`**

```tsx
// frontend/src/components/opps/RunSelector.tsx
import { useState } from 'react';

export interface RunSummary {
  run_id: string;
  current_phase: string | null;
  current_step: string | null;
  mode: string | null;
  last_actor: string | null;
  last_actor_at: string | null;
}

interface RunSelectorProps {
  runs: RunSummary[];
  selectedRunId: string | null;
  onChange: (runId: string) => void;
}

export function RunSelector({ runs, selectedRunId, onChange }: RunSelectorProps) {
  const [open, setOpen] = useState(false);
  if (runs.length === 0) {
    return <span className="text-xs text-muted-foreground">no runs</span>;
  }
  const selected = runs.find((r) => r.run_id === selectedRunId) ?? runs[0];

  return (
    <div className="relative inline-block">
      <button
        type="button"
        className="px-2 py-1 text-xs border rounded hover:bg-accent"
        onClick={() => setOpen((v) => !v)}
      >
        run {selected.run_id}
        {runs.length > 1 ? <span className="ml-1 text-muted-foreground">▾</span> : null}
      </button>
      {open && (
        <ul className="absolute z-10 mt-1 right-0 w-72 max-h-96 overflow-y-auto border bg-background rounded shadow-md">
          {runs.map((r) => (
            <li key={r.run_id}>
              <button
                type="button"
                className={`block w-full text-left px-2 py-1 text-xs hover:bg-accent ${
                  r.run_id === selected.run_id ? 'bg-accent/50' : ''
                }`}
                onClick={() => { onChange(r.run_id); setOpen(false); }}
              >
                <div className="font-mono">{r.run_id}</div>
                <div className="text-muted-foreground">
                  {r.current_phase ?? '?'} / {r.current_step ?? '?'} · {r.mode ?? '?'}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount `RunSelector` in `WorkbenchHeader.tsx`**

In `WorkbenchHeader.tsx`, add a `RunSelector` next to the opp title:

```tsx
import { RunSelector, type RunSummary } from './RunSelector';

// ... in the component, accept new props:
interface Props {
  // ...existing props...
  runs: RunSummary[];
  selectedRunId: string | null;
  onRunChange: (runId: string) => void;
}

// In the rendered JSX, next to the title:
<RunSelector
  runs={props.runs}
  selectedRunId={props.selectedRunId}
  onChange={props.onRunChange}
/>
```

- [ ] **Step 3: Update `OppWorkbenchPage.tsx` to manage the selected run id**

In `OppWorkbenchPage.tsx`:

1. Add `useSearchParams` from `react-router-dom`.
2. Read `runId = searchParams.get('run_id')` and pass it to the workbench fetch (`fetch(\`/api/workspaces/${ws}/opps/${slug}?run_id=${runId}\`)`).
3. On `RunSelector` change, call `setSearchParams({ run_id: newRunId })` — the URL becomes the source of truth.
4. Pass `runs={data.runs}` and `selectedRunId={data.selected_run_id}` from the snapshot into `WorkbenchHeader`.

Pseudo-code:

```tsx
const [searchParams, setSearchParams] = useSearchParams();
const runId = searchParams.get('run_id');

const { data } = useQuery(['opp', slug, runId], () =>
  fetchOppSnapshot({ slug, runId })
);

return (
  <WorkbenchHeader
    runs={data?.runs ?? []}
    selectedRunId={data?.selected_run_id ?? null}
    onRunChange={(id) => setSearchParams({ run_id: id })}
    {/* ...existing props... */}
  />
);
```

- [ ] **Step 4: Build the frontend**

```bash
cd /Users/acedimagi/emdash/repositories/ace-web/frontend
bun run build
```

Expected: clean build, no TS errors.

- [ ] **Step 5: Manual smoke**

```bash
cd /Users/acedimagi/emdash/repositories/ace-web
docker compose up -d
# Open http://localhost:8000/w/dimagi-team/opps/<some-multi-run-opp>
# Confirm:
#   - RunSelector appears in header showing all runs
#   - Picking a non-default run updates the URL to ?run_id=<id> and refetches
```

(If no multi-run opp exists yet on local Drive, this manual smoke is deferred to the post-deploy turmeric e2e — which is the test that drives this whole change.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/opps/RunSelector.tsx \
        frontend/src/components/opps/WorkbenchHeader.tsx \
        frontend/src/pages/OppWorkbenchPage.tsx
git commit -m "feat(opps-ui): RunSelector dropdown + ?run_id= URL param"
```

---

## Task 14: Frontend — `OppListPage` shows one row per opp folder

**Files:**
- Modify: `/Users/acedimagi/emdash/repositories/ace-web/frontend/src/pages/OppListPage.tsx`

- [ ] **Step 1: Read the existing list page**

```bash
sed -n '1,80p' /Users/acedimagi/emdash/repositories/ace-web/frontend/src/pages/OppListPage.tsx
```

- [ ] **Step 2: Update the row shape**

The list endpoint already returns one card per opp folder. Verify each card includes `display_name`, `current_run_id`, `current_phase`, `last_activity_at`, `eval_score`. If a `run_count` field is missing, add it on the backend:

In `apps/opps/sync.py` `load_opp_card`:

```python
runs = list_opp_runs(client, ace_root_folder_id=..., opp_slug=opp_slug)
card["run_count"] = len(runs)
```

- [ ] **Step 3: Update the row rendering in `OppListPage.tsx`**

Each row should now read like:

```
turmeric            Turmeric Market Survey       3 runs · last 18:42 (2 min ago) · phase: ocs / ocs-agent-setup   [score 82]
cosmetics-fgd-pilot Cosmetics FGD Pilot          1 run · last 2 hours ago · phase: design / idea-to-pdd
```

Use `display_name` if present, fall back to slug. Show run count + relative time of last activity. Keep the existing scorecard chip.

- [ ] **Step 4: Build + manual smoke**

```bash
cd /Users/acedimagi/emdash/repositories/ace-web/frontend
bun run build
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/OppListPage.tsx apps/opps/sync.py
git commit -m "feat(opps-ui): one row per opp folder with run count + display_name"
```

---

## Task 15: Final test pass + Dockerfile bump commit + push

**Files:**
- Modify: `/Users/acedimagi/emdash/repositories/ace-web/Dockerfile` (the bump from Task 9, finally committed)

- [ ] **Step 1: Run the full test suite**

```bash
cd /Users/acedimagi/emdash/repositories/ace-web
pytest -v
cd frontend && bun run build && cd ..
```

Both green; no skipped or warnings on the new tests.

- [ ] **Step 2: Commit the Dockerfile bump**

```bash
git add Dockerfile
git commit -m "chore(docker): bump ACE_REF to v0.11.0 (multi-run revival)

Plugin v0.11.0 ships the new <opp>/inputs/ + <opp>/runs/<run-id>/
Drive layout. ace-web's apps/opps/sync.py reader (this branch) reads
that layout. Together they restore multi-run-per-opp."
```

- [ ] **Step 3: Push branch (after user review)**

DO NOT auto-push. Surface to the user:

> ace-web Phase B complete on branch `multi-run-revival`. Ready to push?
>
> ```bash
> git push -u origin multi-run-revival
> ```
>
> Then open a PR. After merge, trigger `Deploy to Labs` workflow with
> `run_migrations: false` (no schema changes).

- [ ] **Step 4: Post-deploy smoke — turmeric e2e**

After ace-web is deployed to labs:

1. Manually create `ACE/turmeric/inputs/pdd.md` in Drive (copy body from one of the existing turmeric PDDs in the legacy `PDD/` folder).
2. Run:
   ```bash
   ACE_E2E_AUTH_TOKEN=$(grep ACE_E2E_AUTH_TOKEN /Users/acedimagi/emdash/repositories/ace-web/deploy/aws/task-definition.json | cut -d'"' -f4)
   python /Users/acedimagi/emdash/repositories/ace-web/tools/walkthrough/run_chat_e2e.py \
     "/ace:run --mode auto --no-evals" \
     --timeout-seconds 5400 \
     --session-title "turmeric e2e — multi-run revival smoke"
   ```
3. Confirm:
   - Drive: `ACE/turmeric/runs/<YYYYMMDD-HHMM>/state.yaml` exists.
   - ace-web: `/w/dimagi-team/opps/turmeric` shows the new run, with the RunSelector dropdown listing only this run.

If the e2e completes with `chat.stream_complete` and the Drive layout matches expectations: the change is live.

---

## Self-review checklist (run after writing every task)

After all 15 tasks are written:

- [ ] **Spec coverage** — every numbered item under § "ACE plugin changes" and § "ace-web changes" in the spec has a matching task.
  - Plugin 1 (orchestrator) → Task 3
  - Plugin 2 (commands/run) → Task 4
  - Plugin 3 (per-skill paths) → covered indirectly by Task 3 (orchestrator passes the new folder ID)
  - Plugin 4 (artifact-manifest) → Task 2
  - Plugin 5 (doctor) → Task 6
  - Plugin 6 (commands/status) → Task 5
  - ace-web 1 (sync.py) → Task 10
  - ace-web 2 (views/URLs) → Task 11
  - ace-web 3 (Workbench UI) → Task 13
  - ace-web 4 (Opp list) → Task 14
  - ace-web 5 (transcript-ingest) → Task 7 (plugin side; backend already accepts `opp_run_id`)

- [ ] **Placeholder scan** — no "TBD", "TODO", "fill in later", "similar to Task N" without code repeated.

- [ ] **Type consistency** — `RunSummary` fields are the same in `apps/opps/sync.py`, the test fixture, the view, the serializer, and the frontend prop type.

- [ ] **Method/function names** — `list_opp_runs`, `load_opp` (with `run_id=None` arg), `parseOppRef`, `generateRunId`, `runFolderPath`, `RunSelector` — all consistent across tasks.

If any check fails, fix inline.
