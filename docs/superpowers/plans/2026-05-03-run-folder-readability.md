# Run-folder readability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `ACE/<opp>/runs/<run-id>/` so every artifact is `<phase-folder>/<producing-skill>[_<role>].<ext>`, fix three layout bugs (duplicate `verdicts/`, stray opp-root files, dead `eval-reports/`), and migrate live Drive opps + fixtures to the new shape.

**Architecture:** `lib/artifact-manifest.ts` is the single source of truth for paths; lint tests enforce that every path string in skills/agents/commands resolves to a manifest entry. A one-shot `scripts/migrate-drive-layout.ts` (dry-run by default) restructures live Drive opps. Bug fixes (find-or-create folders, doctor checks for duplicate folders + stray opp-root files) ship first as standalone improvements, then the manifest rewrite, then per-phase skill prose updates, then the orchestrator changes that produce the new layout, then live-Drive migration.

**Tech Stack:** ACE plugin (markdown skills + TypeScript MCPs + bash for `bin/ace-doctor`), vitest for plugin TS tests, no build step (ESM + `tsx`).

**Working dir:** `/Users/acedimagi/emdash/worktrees/ace/emdash/improve-drive-sowa0` (current branch `emdash/improve-drive-sowa0`). Confirm with `git status` before starting.

**Spec:** `docs/superpowers/specs/2026-05-03-run-folder-readability-design.md`.

**Out of scope for this plan (per spec § ace-web changes):** ace-web's `apps/opps/sync.py` reader updates land in a separate ace-web PR keyed off the version this plan ships (likely 0.12.0). The plugin lands first; the workbench will show empty/incomplete data for new-layout runs until the ace-web PR follows within ~24h, same model as the 2026-05-02 multi-run revival.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `mcp/google-drive-server.ts` | modify | Add `findOrCreate` mode (default true) to `drive_create_folder`; add `drive_create_shortcut` atom for `current/` layer. |
| `test/mcp/gdrive/find-or-create.test.ts` | **new** | Vitest for find-or-create folder behavior (mocks Drive client). |
| `test/mcp/gdrive/create-shortcut.test.ts` | **new** | Vitest for the new `drive_create_shortcut` atom. |
| `bin/ace-doctor` | modify | Two new checks: `dup_folders` (duplicate folder names under any opp's `runs/`); `stray_opp_root` (opp-root files outside `{opp.yaml, current/, inputs/, runs/}`). |
| `lib/artifact-manifest.ts` | modify | `Phase` enum → 7-phase form; `role` field added to `ArtifactEntry`; every `path` rewritten to `<N>-<phase>/<skill>[_<role>].<ext>`; re-tag mis-phased entries (training-materials, mobile-recipes/screenshots, llo-* artifacts). |
| `lib/artifact-manifest-roles.ts` | **new** | Closed `ROLE_VOCAB` (e.g. `summary | gate-brief | verdict | report | transcript | ...`) and `PHASE_FOLDERS` map (`design → '1-design'`, etc). |
| `test/lib/artifact-manifest-lint.test.ts` | **new** | Lints: every path matches `<phase-folder>/<skill>[_<role>].<ext>` (or is one of two exceptions); every `<skill>` exists under `skills/`; every `<role>` is in `ROLE_VOCAB`; no duplicate paths; phase tag matches phase folder. |
| `test/lib/skill-path-references.test.ts` | **new** | Greps every file under `skills/`, `agents/`, `commands/` for `ACE/<opp...>` path references and asserts each one resolves to a manifest entry. Catches drift when manifest changes faster than skill prose. |
| `scripts/migrate-drive-layout.ts` | **new** | One-shot tool. `--check` (default, dry-run) walks Drive root and prints planned moves. `--apply` performs them. Coalesces duplicate `verdicts/` folders, relocates stray opp-root files, creates `current/` shortcuts, deletes dead folders. |
| `test/scripts/migrate-drive-layout.test.ts` | **new** | Vitest with mock Drive client returning the leep-paint-collection shape; asserts the planner produces the right move list. |
| `agents/ace-orchestrator.md` | modify | Phase loop creates `<N>-<phase>/` subfolder via `drive_create_folder` (find-or-create); threads `phaseFolderId` to phase agents. Run-start writes `README.md`. Phase-completion updates `current/` shortcuts. |
| `agents/{design-review,commcare-setup,connect-setup,ocs-setup,qa-and-training,llo-manager,closeout,ocs-tester}.md` | modify | Update path references to phase-prefixed paths. Receive `phaseFolderId` from orchestrator instead of computing it. |
| `commands/{run,step,eval,status}.md` | modify | Document new layout in user-facing examples. `/ace:status` output reorganized to show phase folders. |
| `skills/*/SKILL.md` (45 files with `ACE/<opp...>` refs) | modify | Update every path string to the new manifest path. Per-phase batches (one task per phase). |
| `test/fixtures/CRISPR-Test-{001,002,003-Turmeric}/` | restructure | Move every file under `runs/<run-id>/` to its new phase-prefixed manifest path. |
| `VERSION` | modify | Bump to `0.12.0` (Drive-layout breaking change). |
| `CHANGELOG.md` | modify | Add 0.12.0 entry. |

---

# Phase A — Atomic bug fixes (good even if rest is rejected)

These three tasks land independently. Each closes a class of silent-failure bug; none depend on the rename landing.

## Task 1: `drive_create_folder` gains `findOrCreate` mode

**Files:**
- Modify: `mcp/google-drive-server.ts` (the `drive_create_folder` handler)
- Create: `test/mcp/gdrive/find-or-create.test.ts`

The duplicate-`verdicts/` bug exists because skills calling `drive_create_folder` in parallel (or across runs) each create a fresh folder rather than reusing an existing same-named one. Drive permits this; we'll prevent it at the MCP boundary.

- [ ] **Step 1: Read the current `drive_create_folder` handler to see its signature**

Run: `grep -nA 30 'drive_create_folder' mcp/google-drive-server.ts | head -60`

- [ ] **Step 2: Write the failing test**

```typescript
// test/mcp/gdrive/find-or-create.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCreateFolder } from '../../../mcp/google-drive-server.js';

const fakeDrive = {
  files: {
    list: vi.fn(),
    create: vi.fn(),
  },
};

describe('drive_create_folder findOrCreate mode', () => {
  beforeEach(() => {
    fakeDrive.files.list.mockReset();
    fakeDrive.files.create.mockReset();
  });

  it('reuses existing folder when one with the same name exists under the parent', async () => {
    fakeDrive.files.list.mockResolvedValue({
      data: { files: [{ id: 'existing-folder-id', name: 'verdicts' }] },
    });
    const result = await handleCreateFolder(
      { name: 'verdicts', parentFolderId: 'parent-1', findOrCreate: true },
      fakeDrive as any,
    );
    expect(result.id).toBe('existing-folder-id');
    expect(fakeDrive.files.create).not.toHaveBeenCalled();
  });

  it('creates a new folder when none exists with that name', async () => {
    fakeDrive.files.list.mockResolvedValue({ data: { files: [] } });
    fakeDrive.files.create.mockResolvedValue({
      data: { id: 'new-folder-id', name: 'verdicts' },
    });
    const result = await handleCreateFolder(
      { name: 'verdicts', parentFolderId: 'parent-1', findOrCreate: true },
      fakeDrive as any,
    );
    expect(result.id).toBe('new-folder-id');
    expect(fakeDrive.files.create).toHaveBeenCalledOnce();
  });

  it('always creates a new folder when findOrCreate=false', async () => {
    fakeDrive.files.list.mockResolvedValue({
      data: { files: [{ id: 'existing-folder-id', name: 'verdicts' }] },
    });
    fakeDrive.files.create.mockResolvedValue({
      data: { id: 'second-folder-id', name: 'verdicts' },
    });
    const result = await handleCreateFolder(
      { name: 'verdicts', parentFolderId: 'parent-1', findOrCreate: false },
      fakeDrive as any,
    );
    expect(result.id).toBe('second-folder-id');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- test/mcp/gdrive/find-or-create.test.ts`
Expected: FAIL with "handleCreateFolder is not exported" or similar.

- [ ] **Step 4: Refactor `drive_create_folder` handler to expose `handleCreateFolder` and accept `findOrCreate`**

In `mcp/google-drive-server.ts`, extract the body of the existing `drive_create_folder` switch case into an exported `handleCreateFolder(args, driveClient)` function. Add an optional `findOrCreate` parameter to the schema (default `true`). When set, list files under `parentFolderId` with `q: "mimeType='application/vnd.google-apps.folder' and name='<name>' and '<parent>' in parents and trashed=false"`; if any match, return the first. Otherwise create.

```typescript
export async function handleCreateFolder(
  args: { name: string; parentFolderId: string; findOrCreate?: boolean },
  drive: drive_v3.Drive,
): Promise<{ id: string; name: string }> {
  const { name, parentFolderId, findOrCreate = true } = args;
  await assertParentOnSharedDrive(parentFolderId, drive);
  if (findOrCreate) {
    const escaped = name.replace(/'/g, "\\'");
    const list = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${escaped}' and '${parentFolderId}' in parents and trashed=false`,
      fields: 'files(id,name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const existing = list.data.files?.[0];
    if (existing?.id) return { id: existing.id, name: existing.name! };
  }
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentFolderId] },
    fields: 'id,name',
    supportsAllDrives: true,
  });
  return { id: created.data.id!, name: created.data.name! };
}
```

Update the MCP tool schema to advertise `findOrCreate` (boolean, default `true`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- test/mcp/gdrive/find-or-create.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 6: Run full unit suite to confirm no regression**

Run: `npm test`
Expected: PASS, no new failures (existing fixture tests still pass — no manifest change yet).

- [ ] **Step 7: Commit**

```bash
git add mcp/google-drive-server.ts test/mcp/gdrive/find-or-create.test.ts
git commit -m "fix(gdrive): drive_create_folder gains findOrCreate to prevent dup folders"
```

## Task 2: Doctor check — duplicate folder names under a run

**Files:**
- Modify: `bin/ace-doctor`
- Create: `test/scripts/doctor-dup-folders.test.ts`

Catch the existing duplicate-`verdicts/` instances and any future class. The check walks every `<opp>/runs/<run-id>/` folder, lists immediate children, and flags any name that appears 2+ times.

- [ ] **Step 1: Read the existing doctor script structure to find where to add the check**

Run: `grep -n 'check_' bin/ace-doctor | head -20`

- [ ] **Step 2: Write the failing test**

```typescript
// test/scripts/doctor-dup-folders.test.ts
import { describe, it, expect, vi } from 'vitest';
import { detectDuplicateFolders } from '../../bin/lib/doctor-checks.js';

describe('doctor: duplicate folder detection', () => {
  it('flags two folders with the same name under one parent', () => {
    const drive = {
      list: vi.fn().mockResolvedValue([
        { id: 'a', name: 'verdicts', mimeType: 'application/vnd.google-apps.folder' },
        { id: 'b', name: 'verdicts', mimeType: 'application/vnd.google-apps.folder' },
        { id: 'c', name: 'gate-briefs', mimeType: 'application/vnd.google-apps.folder' },
      ]),
    };
    return expect(detectDuplicateFolders('run-folder-id', drive as any)).resolves.toEqual([
      { name: 'verdicts', ids: ['a', 'b'] },
    ]);
  });

  it('returns empty when all folder names are unique', () => {
    const drive = {
      list: vi.fn().mockResolvedValue([
        { id: 'a', name: 'verdicts', mimeType: 'application/vnd.google-apps.folder' },
        { id: 'b', name: 'gate-briefs', mimeType: 'application/vnd.google-apps.folder' },
      ]),
    };
    return expect(detectDuplicateFolders('run-folder-id', drive as any)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- test/scripts/doctor-dup-folders.test.ts`
Expected: FAIL ("Cannot find module '../../bin/lib/doctor-checks.js'").

- [ ] **Step 4: Create `bin/lib/doctor-checks.ts` with `detectDuplicateFolders`**

```typescript
// bin/lib/doctor-checks.ts
interface DriveLike {
  list: (folderId: string) => Promise<Array<{ id: string; name: string; mimeType: string }>>;
}

export async function detectDuplicateFolders(
  parentFolderId: string,
  drive: DriveLike,
): Promise<Array<{ name: string; ids: string[] }>> {
  const children = await drive.list(parentFolderId);
  const folders = children.filter(c => c.mimeType === 'application/vnd.google-apps.folder');
  const byName = new Map<string, string[]>();
  for (const f of folders) {
    if (!byName.has(f.name)) byName.set(f.name, []);
    byName.get(f.name)!.push(f.id);
  }
  return [...byName.entries()]
    .filter(([_, ids]) => ids.length > 1)
    .map(([name, ids]) => ({ name, ids }));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- test/scripts/doctor-dup-folders.test.ts`
Expected: PASS, both tests green.

- [ ] **Step 6: Wire the check into `bin/ace-doctor`**

In `bin/ace-doctor`, find the section that lists doctor checks and add a new entry. The bash doctor delegates Drive walks to `npx tsx scripts/doctor-walk.ts`-style helpers — follow the same pattern. For the section header:

```bash
echo
echo "[Drive layout]"
npx tsx -e "
import { detectDuplicateFolders } from './bin/lib/doctor-checks.js';
import { walkRunFolders } from './bin/lib/drive-walk.js';
const dups = await walkRunFolders().then(rs => Promise.all(rs.map(r => detectDuplicateFolders(r.id, ...))));
// emit FAIL/PASS lines
"
```

(Implementation detail: the tsx-eval pattern matches the existing OCS shared-collection probe in `bin/ace-doctor`.)

- [ ] **Step 7: Run doctor on the local Drive root to see the check report on real data**

Run: `bin/ace-doctor 2>&1 | grep -A 2 'Drive layout'`
Expected: Lists the duplicate `verdicts/` under `leep-paint-collection/runs/20260503-2128/` as a FAIL entry.

- [ ] **Step 8: Commit**

```bash
git add bin/ace-doctor bin/lib/doctor-checks.ts test/scripts/doctor-dup-folders.test.ts
git commit -m "feat(doctor): detect duplicate folder names under run folders"
```

## Task 3: Doctor check — stray opp-root files outside whitelist

**Files:**
- Modify: `bin/lib/doctor-checks.ts`
- Modify: `bin/ace-doctor`
- Create: `test/scripts/doctor-stray-files.test.ts`

The whitelist for opp-root files is exactly: `opp.yaml`, plus the folders `current/`, `inputs/`, `runs/`. Anything else is a stray write (like the `2026-05-03-connect-opp-setup-attempt-3.md` we found).

- [ ] **Step 1: Write the failing test**

```typescript
// test/scripts/doctor-stray-files.test.ts
import { describe, it, expect, vi } from 'vitest';
import { detectStrayOppRootFiles } from '../../bin/lib/doctor-checks.js';

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';

describe('doctor: stray opp-root file detection', () => {
  it('flags markdown files at opp root that are not in the whitelist', async () => {
    const drive = {
      list: vi.fn().mockResolvedValue([
        { id: 'a', name: 'opp.yaml', mimeType: DOC },
        { id: 'b', name: 'inputs', mimeType: FOLDER },
        { id: 'c', name: 'runs', mimeType: FOLDER },
        { id: 'd', name: '2026-05-03-connect-opp-setup-attempt-3.md', mimeType: DOC },
      ]),
    };
    const result = await detectStrayOppRootFiles('opp-folder-id', drive as any);
    expect(result).toEqual([{ id: 'd', name: '2026-05-03-connect-opp-setup-attempt-3.md' }]);
  });

  it('passes when only whitelisted entries exist', async () => {
    const drive = {
      list: vi.fn().mockResolvedValue([
        { id: 'a', name: 'opp.yaml', mimeType: DOC },
        { id: 'b', name: 'inputs', mimeType: FOLDER },
        { id: 'c', name: 'runs', mimeType: FOLDER },
        { id: 'd', name: 'current', mimeType: FOLDER },
      ]),
    };
    expect(await detectStrayOppRootFiles('opp-folder-id', drive as any)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/scripts/doctor-stray-files.test.ts`
Expected: FAIL ("detectStrayOppRootFiles not exported").

- [ ] **Step 3: Add `detectStrayOppRootFiles` to `bin/lib/doctor-checks.ts`**

```typescript
const OPP_ROOT_WHITELIST = new Set(['opp.yaml', 'inputs', 'runs', 'current']);

export async function detectStrayOppRootFiles(
  oppFolderId: string,
  drive: DriveLike,
): Promise<Array<{ id: string; name: string }>> {
  const children = await drive.list(oppFolderId);
  return children
    .filter(c => !OPP_ROOT_WHITELIST.has(c.name))
    .map(c => ({ id: c.id, name: c.name }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/scripts/doctor-stray-files.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the check into `bin/ace-doctor`** (under the same `[Drive layout]` section as Task 2's check)

- [ ] **Step 6: Run doctor on local Drive to confirm the leep-paint-collection stray retry file is flagged**

Run: `bin/ace-doctor 2>&1 | grep -A 5 'stray'`
Expected: Lists `2026-05-03-connect-opp-setup-attempt-3.md` under `leep-paint-collection`.

- [ ] **Step 7: Commit**

```bash
git add bin/lib/doctor-checks.ts bin/ace-doctor test/scripts/doctor-stray-files.test.ts
git commit -m "feat(doctor): detect stray opp-root files outside whitelist"
```

---

# Phase B — Manifest restructure (the spine)

Everything else hangs off the manifest. Get the data model right first.

## Task 4: Update `Phase` enum to 7 phases + add `role` field

**Files:**
- Modify: `lib/artifact-manifest.ts`
- Create: `lib/artifact-manifest-roles.ts`

The current enum is 6-phase (`design | commcare | connect | ocs | operate | closeout`). The new enum is 7-phase: `design | commcare | connect | ocs | qa-and-training | llo-manager | closeout`. The `role` field is a new optional field on `ArtifactEntry` constrained to a closed vocabulary.

- [ ] **Step 1: Create `lib/artifact-manifest-roles.ts` with the closed vocabularies**

```typescript
// lib/artifact-manifest-roles.ts

/** Phase folder name lookup: phase enum → folder slug used in Drive paths */
export const PHASE_FOLDERS = {
  'design': '1-design',
  'commcare': '2-commcare',
  'connect': '3-connect',
  'ocs': '4-ocs',
  'qa-and-training': '5-qa-and-training',
  'llo-manager': '6-llo-manager',
  'closeout': '7-closeout',
} as const;

export type PhaseFolder = typeof PHASE_FOLDERS[keyof typeof PHASE_FOLDERS];

/** Closed vocabulary for the optional `_<role>` slot in artifact filenames.
 *  Variants append a hyphenated qualifier (e.g. `verdict-deep`, `verdict-quick`).
 *  Only the BASE role needs to be in this set; qualifiers are free-form.
 */
export const ROLE_VOCAB = new Set([
  'summary',
  'gate-brief',
  'verdict',
  'report',
  'transcript',
  'scorecard',
  'manifest',
  'list',
  'record',
  'comms-log',
  'results',
  'new-pdd',
  'invoices',
  'widget-handoff',
  'learn',     // for app-connect-coverage_learn.md
  'deliver',   // for app-connect-coverage_deliver.md
]);

/** Extract the base role from `<role>[-<qualifier>]`.
 *  Examples: `summary` → `summary`, `verdict-deep` → `verdict`, `transcript-quick` → `transcript`.
 */
export function baseRole(role: string): string {
  return role.split('-')[0] === 'gate' ? 'gate-brief' :
         role.split('-')[0] === 'comms' ? 'comms-log' :
         role.split('-')[0] === 'new' ? 'new-pdd' :
         role.split('-')[0] === 'widget' ? 'widget-handoff' :
         role.split('-')[0];
}
```

- [ ] **Step 2: Update `Phase` enum in `lib/artifact-manifest.ts`**

Find `lib/artifact-manifest.ts:28`:
```typescript
export type Phase = 'design' | 'commcare' | 'connect' | 'ocs' | 'operate' | 'closeout';
```
Change to:
```typescript
export type Phase = 'design' | 'commcare' | 'connect' | 'ocs' | 'qa-and-training' | 'llo-manager' | 'closeout';
```

And `lib/artifact-manifest.ts:47`:
```typescript
export const PHASES = ['design', 'commcare', 'connect', 'ocs', 'operate', 'closeout'] as const;
```
Change to:
```typescript
export const PHASES = ['design', 'commcare', 'connect', 'ocs', 'qa-and-training', 'llo-manager', 'closeout'] as const;
```

- [ ] **Step 3: Add `role` field to `ArtifactEntry`**

In `lib/artifact-manifest.ts`, modify the `ArtifactEntry` interface (lines 30-43):

```typescript
export interface ArtifactEntry {
  /** Relative path under ACE/<opp>/runs/<run-id>/ (or 'opp.yaml' / 'inputs/' for opp-level) */
  path: string;
  /** Skill that creates this artifact (or "external" for human-provided inputs) */
  producedBy: string;
  /** Optional role suffix when one skill emits multiple artifacts.
   *  Vocabulary in lib/artifact-manifest-roles.ts.
   */
  role?: string;
  /** Skills that read this artifact as input */
  consumedBy: string[];
  /** Lifecycle phase when this artifact is produced */
  phase: Phase;
  /** Must exist when this phase completes (false = conditional/optional) */
  required: boolean;
  /** Human-readable purpose */
  description: string;
}
```

- [ ] **Step 4: Run existing tests to see expected failures (the manifest still has old paths but new enum)**

Run: `npm test -- test/fixtures/artifact-manifest.test.ts`
Expected: FAIL — the existing 6-phase test (`'has all six phases represented'`) breaks because `'operate'` is gone.

This failure is intentional — Task 5 will rewrite the manifest entries; Task 6 will rewrite this assertion.

- [ ] **Step 5: Commit (intermediate state — manifest enum updated, paths still old)**

```bash
git add lib/artifact-manifest.ts lib/artifact-manifest-roles.ts
git commit -m "refactor(manifest): expand Phase enum to 7 phases; add role field

Existing fixture test fails on the 'operate' assertion — that gets fixed in
the follow-up commit that rewrites paths and the manifest lint test."
```

## Task 4b: Inventory manifest-orphan paths referenced in skill prose

**Files:**
- Create: `docs/superpowers/notes/manifest-orphans-2026-05-03.md` (working notes — delete after triage)

A grep across `skills/`, `agents/`, `commands/` surfaces paths that skills WRITE TO or READ FROM but that `lib/artifact-manifest.ts` does not declare. These have to be triaged before Task 5's rewrite — for each, decide:
- (A) Add to manifest with a new path under the new layout.
- (B) Mark out-of-scope (e.g. `commcare-patches/` is opp-level user-curated input, not a skill output — leave as-is alongside `inputs/`).
- (C) Delete from skill prose (stale reference to a removed feature).

Known orphans from the pre-rewrite grep:

| Path in skill prose | Recommended disposition | Notes |
|---|---|---|
| `connect-state.yaml` (opp root) | (B) opp-level — add manifest entry alongside `opp.yaml` | written by `connect-program-setup` for cross-skill state |
| `eval-calibration/known-issues.md` | (A) add `eval-calibration/` opp-level entry | not run-scoped; documented in CLAUDE.md |
| `eval-calibration/<rubric>-runs.md` | (A) add as opp-level audit-trail | per-rubric, append-only |
| `open-questions.md` (opp root) | (A) add as opp-level entry | from `feedback_phase_open_questions` memory |
| `commcare-patches/commcare-patches.yaml` | (B) opp-level user input | per CLAUDE.md, lives alongside `inputs/` |
| `connect-setup-summary.md` (opp root) | (C) delete from prose | superseded by `current/connect-opp-summary.md` |
| `design-review-summary.md` (opp root) | (C) delete from prose | redundant with `1-design/idea-to-pdd.md` |
| `ocs-setup-summary.md` (opp root) | (C) delete from prose | superseded by `current/ocs-agent-config.md` |
| `gate-briefs/ocs-chatbot-qa-deep.md` | (C) probably stale — eval owns the gate brief | confirm with `grep -r ocs-chatbot-qa-deep skills/` |
| `comms-log/dry-run-ocs-agent-setup.md` | (A) add as Phase 4 transcript variant | one-off dry-run capture |

- [ ] **Step 1: Run the orphan-detection grep**

Run: `grep -rEho 'ACE/<opp[^/]*>/[a-z][a-z0-9_/.-]+\.(md|yaml|json)' skills/ agents/ commands/ | sort -u > /tmp/skill-paths.txt && grep -E "path: '" lib/artifact-manifest.ts | sed -E "s/.*path: '([^']+)'.*/ACE\\/<opp-name>\\/\\1/" | sort -u > /tmp/manifest-paths.txt && diff /tmp/skill-paths.txt /tmp/manifest-paths.txt | head -30`
Expected: A list of `<` paths (in skill prose, not manifest). Cross-reference against the table above and update `OLD_TO_NEW` / `lib/artifact-manifest.ts` accordingly in Task 5.

- [ ] **Step 2: Note resolutions in `docs/superpowers/notes/manifest-orphans-2026-05-03.md`**

Write a one-line disposition per orphan. This file is throwaway working notes; delete after Task 5 lands.

- [ ] **Step 3: Commit notes file (separate commit so the audit is traceable)**

```bash
git add docs/superpowers/notes/manifest-orphans-2026-05-03.md
git commit -m "docs: triage manifest-orphan paths before phase-prefix rewrite"
```

## Task 5: Rewrite all manifest `path` strings to phase-prefixed form

**Files:**
- Modify: `lib/artifact-manifest.ts` (every entry's `path`, plus `phase`-tag corrections, plus new `role` fields)

This is the main payload. Every manifest entry gets a new path. Re-tag mis-phased entries: training-materials → `qa-and-training`, mobile-recipes/screenshots → `qa-and-training`, llo-* artifacts → `llo-manager`.

- [ ] **Step 1: Map every existing entry to its new path**

Reference table (full table — every entry in the current manifest):

| Old path | New path | Old phase | New phase | role |
|---|---|---|---|---|
| `inputs/` | `inputs/` (unchanged; opp-level) | design | design | — |
| `opp.yaml` | `opp.yaml` (unchanged; opp-level) | design | design | — |
| `idea.md` | `1-design/idea.md` | design | design | — |
| `pdd.md` | `1-design/idea-to-pdd.md` | design | design | — |
| `test-prompts.md` | `1-design/pdd-to-test-prompts.md` | design | design | — |
| `run_state.yaml` | `run_state.yaml` (unchanged; run-level) | design | design | — |
| `gate-briefs/idea-to-pdd.md` | `1-design/idea-to-pdd_gate-brief.md` | design | design | gate-brief |
| `apps/learn-app.json` | `2-commcare/pdd-to-learn-app_snapshot.json` (optional) | commcare | commcare | snapshot |
| `apps/deliver-app.json` | `2-commcare/pdd-to-deliver-app_snapshot.json` (optional) | commcare | commcare | snapshot |
| `app-summaries/learn-app-summary.md` | `2-commcare/pdd-to-learn-app_summary.md` | commcare | commcare | summary |
| `app-summaries/deliver-app-summary.md` | `2-commcare/pdd-to-deliver-app_summary.md` | commcare | commcare | summary |
| `deployment-summary.md` | `2-commcare/app-deploy_summary.md` | commcare | commcare | summary |
| `gate-briefs/app-deploy.md` | `2-commcare/app-deploy_gate-brief.md` | commcare | commcare | gate-brief |
| `test-results/test-plan.md` | `2-commcare/app-test/test-plan.md` | commcare | commcare | — |
| `test-results/test-results.md` | `2-commcare/app-test/test-results.md` | commcare | commcare | — |
| `test-results/bugs.md` | `2-commcare/app-test/bugs.md` | commcare | commcare | — |
| `training-materials/llo-manager-guide.md` | `5-qa-and-training/training-llo-guide.md` | commcare | qa-and-training | — |
| `training-materials/flw-training-guide.md` | `5-qa-and-training/training-flw-guide.md` | commcare | qa-and-training | — |
| `training-materials/quick-reference.md` | `5-qa-and-training/training-quick-reference.md` | commcare | qa-and-training | — |
| `training-materials/faq.md` | `5-qa-and-training/training-faq.md` | commcare | qa-and-training | — |
| `training-materials/onboarding-email-body.md` | `5-qa-and-training/training-onboarding-email.md` | commcare | qa-and-training | — |
| `training-materials/training-deck-outline.md` | `5-qa-and-training/training-deck-outline.md` | commcare | qa-and-training | — |
| `connect-setup/program.md` | `3-connect/connect-program-setup.md` | connect | connect | — |
| `connect-setup/opportunity.md` | `3-connect/connect-opp-setup.md` | connect | connect | — |
| `ocs-agent-config.md` | `4-ocs/ocs-agent-setup.md` | ocs | ocs | — |
| `ocs-setup/widget-handoff.md` | `4-ocs/ocs-setup_widget-handoff.md` | ocs | ocs | widget-handoff |
| `qa-captures/YYYY-MM-DD-ocs-chat-quick.md` | `4-ocs/ocs-chatbot-qa_transcript-quick.md` | ocs | ocs | transcript |
| `qa-captures/YYYY-MM-DD-ocs-chat-deep.md` | `4-ocs/ocs-chatbot-qa_transcript-deep.md` | ocs | ocs | transcript |
| `verdicts/ocs-chatbot-eval-quick.yaml` | `4-ocs/ocs-chatbot-eval_verdict-quick.yaml` | ocs | ocs | verdict |
| `verdicts/ocs-chatbot-eval-deep.yaml` | `4-ocs/ocs-chatbot-eval_verdict-deep.yaml` | ocs | ocs | verdict |
| `gate-briefs/ocs-chatbot-eval-deep.md` | `4-ocs/ocs-chatbot-eval_gate-brief-deep.md` | ocs | ocs | gate-brief |
| `mobile-recipes/learn/manifest.yaml` | `5-qa-and-training/mobile-recipes/learn/manifest.yaml` | operate | qa-and-training | — |
| `mobile-recipes/deliver/manifest.yaml` | `5-qa-and-training/mobile-recipes/deliver/manifest.yaml` | operate | qa-and-training | — |
| `screenshots/manifest.yaml` | `5-qa-and-training/app-screenshot-capture_manifest.yaml` | operate | qa-and-training | manifest |
| `connect-setup/invites.md` | `6-llo-manager/llo-invite_list.md` | operate | llo-manager | list |
| `gate-briefs/llo-invite.md` | `6-llo-manager/llo-invite_gate-brief.md` | operate | llo-manager | gate-brief |
| `comms-log/onboarding-emails.md` | `6-llo-manager/llo-onboarding_comms-log.md` | operate | llo-manager | comms-log |
| `uat/uat-results.md` | `6-llo-manager/llo-uat_results.md` | operate | llo-manager | results |
| `launch/launch-record.md` | `6-llo-manager/llo-launch_record.md` | operate | llo-manager | record |
| `gate-briefs/llo-launch.md` | `6-llo-manager/llo-launch_gate-brief.md` | operate | llo-manager | gate-brief |
| `qa-captures/YYYY-MM-DD-ocs-chat-monitor.md` | `6-llo-manager/ocs-chatbot-qa_transcript-monitor.md` | operate | llo-manager | transcript |
| `verdicts/ocs-chatbot-eval-monitor.yaml` | `6-llo-manager/ocs-chatbot-eval_verdict-monitor.yaml` | operate | llo-manager | verdict |
| `eval-reports/YYYY-MM-DD-ocs-eval.md` | (DROPPED — replaced by `4-ocs/ocs-chatbot-eval_report-deep.md`) | ocs | ocs | report |
| `eval-reports/trend.md` | `6-llo-manager/ocs-chatbot-eval_trend.md` | operate | llo-manager | — |
| `monitoring/YYYY-MM-DD-timeline-check.md` | `6-llo-manager/timeline-monitor/YYYY-MM-DD.md` | operate | llo-manager | — |
| `data-reviews/YYYY-MM-DD-review.md` | `6-llo-manager/flw-data-review/YYYY-MM-DD.md` | operate | llo-manager | — |
| `closeout/invoices.md` | `7-closeout/opp-closeout_invoices.md` | closeout | closeout | invoices |
| `closeout/llo-feedback.md` | `7-closeout/llo-feedback.md` | closeout | closeout | — |
| `closeout/learnings.md` | `7-closeout/learnings-summary.md` | closeout | closeout | — |
| `closeout/new-pdd.md` | `7-closeout/learnings-summary_new-pdd.md` | closeout | closeout | new-pdd |
| `closeout/cycle-grade.md` | `7-closeout/cycle-grade.md` | closeout | closeout | — |
| `scorecards/YYYY-MM-DD-opp-eval-quick.md` | `7-closeout/opp-eval/opp-eval_scorecard-quick.md` | closeout | closeout | scorecard |
| `scorecards/YYYY-MM-DD-opp-eval-deep.md` | `7-closeout/opp-eval/opp-eval_scorecard-deep.md` | closeout | closeout | scorecard |
| `scorecards/YYYY-MM-DD-opp-eval-monitor.md` | `7-closeout/opp-eval/opp-eval_scorecard-monitor.md` | closeout | closeout | scorecard |
| `scorecards/trend.md` | `7-closeout/opp-eval/trend.md` | closeout | closeout | — |
| `verdicts/opp-eval-deep.yaml` | `7-closeout/opp-eval/opp-eval_verdict-deep.yaml` | closeout | closeout | verdict |
| `verdicts/opp-eval-monitor.yaml` | `7-closeout/opp-eval/opp-eval_verdict-monitor.yaml` | closeout | closeout | verdict |
| `gate-briefs/opp-eval-deep.md` | `7-closeout/opp-eval/opp-eval_gate-brief-deep.md` | closeout | closeout | gate-brief |
| `verdicts/<other-skill>.yaml` (any not listed above) | `<phase-folder>/<skill>_verdict.yaml` | (per-skill) | (per-skill) | verdict |

- [ ] **Step 2: Apply the rewrite mechanically**

Open `lib/artifact-manifest.ts` and update each `ArtifactEntry` block. For each entry: rewrite `path` per the table; update `phase` if it changed; add `role: '<role>'` if the table says so. Keep `producedBy`, `consumedBy`, `required`, `description` unchanged.

Group entries under section comments by their NEW phase so the file structure mirrors the new layout: `// ── Design phase (Phase 1) ──`, `// ── CommCare phase (Phase 2) ──`, etc. The new phase grouping will move some entries (training-materials moves from CommCare to QA section, etc).

- [ ] **Step 3: Run the existing fixture test to see the rewrite blow up**

Run: `npm test -- test/fixtures/artifact-manifest.test.ts`
Expected: FAIL — fixtures don't yet have phase-prefixed paths; expected files like `1-design/idea-to-pdd.md` are missing.

That failure is expected; fixtures move in Phase D.

- [ ] **Step 4: Commit (manifest fully rewritten; fixture test now red until Phase D)**

```bash
git add lib/artifact-manifest.ts
git commit -m "refactor(manifest): rewrite all paths to phase-prefixed _role form

Fixtures still use the old layout — fixture tests will stay red until
Phase D moves them. The manifest is now the source of truth for the
new layout."
```

## Task 6: Manifest lint test (path conformance + role vocabulary)

**Files:**
- Create: `test/lib/artifact-manifest-lint.test.ts`
- Modify: `test/fixtures/artifact-manifest.test.ts` (drop the now-stale `'has all six phases represented'` assertion; replace with 7-phase form)

A self-contained test that asserts every manifest entry conforms to the new contract. Catches drift on every PR.

- [ ] **Step 1: Write the lint test**

```typescript
// test/lib/artifact-manifest-lint.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest.js';
import { PHASE_FOLDERS, ROLE_VOCAB, baseRole } from '../../lib/artifact-manifest-roles.js';

const SKILLS_DIR = path.resolve(import.meta.dirname, '../../skills');
const OPP_LEVEL = new Set(['inputs/', 'opp.yaml', 'run_state.yaml']);
const RUN_LEVEL_EXEMPT = new Set(['1-design/idea.md']); // input copy

describe('artifact manifest lint', () => {
  it('every path is opp-level OR <phase-folder>/<skill>[_<role>].<ext> OR exempt', () => {
    const phaseFolderRe = Object.values(PHASE_FOLDERS).join('|');
    const re = new RegExp(`^(${phaseFolderRe})/[a-z][a-z0-9-]*([a-z0-9-]+/)?[a-z][a-z0-9-]*(_[a-z][a-z0-9-]*)?\\.(md|yaml|json)$`);
    const errors: string[] = [];
    for (const a of ARTIFACT_MANIFEST) {
      if (OPP_LEVEL.has(a.path)) continue;
      if (RUN_LEVEL_EXEMPT.has(a.path)) continue;
      // Allow placeholder paths with YYYY-MM-DD or `<latest>/` as-is
      if (a.path.includes('YYYY-MM-DD')) continue;
      if (!re.test(a.path)) errors.push(a.path);
    }
    expect(errors).toEqual([]);
  });

  it('every <skill> in a path exists under skills/', () => {
    const knownSkills = new Set(fs.readdirSync(SKILLS_DIR).filter(n =>
      fs.statSync(path.join(SKILLS_DIR, n)).isDirectory(),
    ));
    const errors: string[] = [];
    for (const a of ARTIFACT_MANIFEST) {
      if (OPP_LEVEL.has(a.path)) continue;
      if (RUN_LEVEL_EXEMPT.has(a.path)) continue;
      if (a.path.includes('YYYY-MM-DD')) continue;
      // Extract <skill> from <phase-folder>/<skill>[_<role>].ext or <phase-folder>/<skill>/<file>
      const segments = a.path.split('/');
      const filename = segments[segments.length - 1];
      // For app-test/ files, the skill is `app-test`, derived from the folder
      const skill = segments.length > 2 && filename.includes('.')
        ? segments[1]
        : filename.split('_')[0].replace(/\.(md|yaml|json)$/, '');
      if (!knownSkills.has(skill)) errors.push(`${a.path} → skill '${skill}' not under skills/`);
    }
    expect(errors).toEqual([]);
  });

  it('every role is in ROLE_VOCAB (or its base form is)', () => {
    const errors: string[] = [];
    for (const a of ARTIFACT_MANIFEST) {
      if (!a.role) continue;
      if (!ROLE_VOCAB.has(baseRole(a.role)) && !ROLE_VOCAB.has(a.role)) {
        errors.push(`${a.path} → role '${a.role}' not in ROLE_VOCAB`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('phase tag matches phase folder in path', () => {
    const errors: string[] = [];
    for (const a of ARTIFACT_MANIFEST) {
      if (OPP_LEVEL.has(a.path)) continue;
      if (RUN_LEVEL_EXEMPT.has(a.path)) continue;
      const expectedFolder = PHASE_FOLDERS[a.phase];
      if (!a.path.startsWith(expectedFolder + '/')) {
        errors.push(`${a.path} tagged ${a.phase} but path doesn't start with ${expectedFolder}/`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('no duplicate paths', () => {
    const paths = ARTIFACT_MANIFEST.map(a => a.path);
    const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
    expect(dupes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the lint test to verify it passes**

Run: `npm test -- test/lib/artifact-manifest-lint.test.ts`
Expected: PASS, all 5 lint cases green (because manifest was rewritten in Task 5).

- [ ] **Step 3: Update `test/fixtures/artifact-manifest.test.ts:42-44` to the 7-phase form**

Replace:
```typescript
it('has all six phases represented', () => {
  const phases = new Set(ARTIFACT_MANIFEST.map((a) => a.phase));
  expect(phases).toEqual(new Set(['design', 'commcare', 'connect', 'ocs', 'operate', 'closeout']));
});
```
With:
```typescript
it('has all seven phases represented', () => {
  const phases = new Set(ARTIFACT_MANIFEST.map((a) => a.phase));
  expect(phases).toEqual(new Set(['design', 'commcare', 'connect', 'ocs', 'qa-and-training', 'llo-manager', 'closeout']));
});
```

- [ ] **Step 4: Commit**

```bash
git add test/lib/artifact-manifest-lint.test.ts test/fixtures/artifact-manifest.test.ts
git commit -m "test(manifest): lint path conformance, role vocabulary, phase-tag agreement"
```

## Task 7: Update `validateFixture` to walk phase-prefixed paths

**Files:**
- Modify: `lib/artifact-manifest.ts` (the `validateFixture` function at lines 597-643)

The current `validateFixture` matches paths verbatim against the manifest. With phase-prefixed paths it still works because the manifest paths now ARE phase-prefixed. The only adjustment is around `app-test/` (a sub-folder under `2-commcare/`) — directory-prefix matching needs to recognize `2-commcare/app-test/` as a known prefix.

- [ ] **Step 1: Read the current `validateFixture` to confirm what needs adjusting**

Run: `sed -n '597,643p' lib/artifact-manifest.ts`

- [ ] **Step 2: Confirm no changes needed**

Re-read the function: it already infers directory prefixes from manifest paths ending in `/`. The new manifest declares `2-commcare/app-test/test-plan.md` as a leaf entry, not a directory entry — so the function correctly treats it as a known leaf. No code change needed.

- [ ] **Step 3: Add a regression test asserting the new layout validates cleanly**

Append to `test/fixtures/artifact-manifest.test.ts`:

```typescript
describe('validateFixture under new phase-prefixed layout', () => {
  it('recognizes 2-commcare/app-test/ files as known', () => {
    const result = validateFixture(
      ['2-commcare/app-test/test-plan.md', '2-commcare/app-test/bugs.md'],
      'commcare',
      [],
    );
    expect(result.unexpected).toEqual([]);
  });

  it('treats 1-design/idea.md as the input copy (known)', () => {
    const result = validateFixture(['1-design/idea.md'], 'design', []);
    expect(result.unexpected).toEqual([]);
  });
});
```

- [ ] **Step 4: Run and verify the new tests pass**

Run: `npm test -- test/fixtures/artifact-manifest.test.ts`
Expected: PASS for the 2 new cases; the 3 fixture-existence cases still FAIL until Phase D.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/artifact-manifest.test.ts
git commit -m "test(manifest): regression for validateFixture under new phase-prefixed layout"
```

## Task 8: Cross-check skill prose against manifest paths

**Files:**
- Create: `test/lib/skill-path-references.test.ts`

Catches drift between skill prose and the manifest. If a skill says `ACE/<opp-name>/runs/<run-id>/old-path.md` but the manifest now declares `1-design/new-path.md`, the test fails.

- [ ] **Step 1: Write the test**

```typescript
// test/lib/skill-path-references.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listMarkdown(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const REF_RE = /ACE\/<opp[^/]*>\/(?:runs\/<run-id>\/)?([a-z0-9_/.-]+\.(?:md|yaml|json))/g;

describe('skill path references resolve to manifest entries', () => {
  const knownPaths = new Set(ARTIFACT_MANIFEST.map(a => a.path));

  it.each([
    ['skills', path.join(ROOT, 'skills')],
    ['agents', path.join(ROOT, 'agents')],
    ['commands', path.join(ROOT, 'commands')],
  ])('every ACE/<opp>/... reference under %s/ resolves to a manifest entry', (_, dir) => {
    const errors: Array<{ file: string; ref: string }> = [];
    for (const file of listMarkdown(dir)) {
      const body = fs.readFileSync(file, 'utf8');
      const matches = [...body.matchAll(REF_RE)];
      for (const m of matches) {
        const ref = m[1];
        // Strip <run-id> prefix wildcards if any leaked through
        if (knownPaths.has(ref)) continue;
        // Allow YYYY-MM-DD as a placeholder match
        const placeholder = ref.replace(/\d{4}-\d{2}-\d{2}/, 'YYYY-MM-DD');
        if (knownPaths.has(placeholder)) continue;
        errors.push({ file: path.relative(ROOT, file), ref });
      }
    }
    if (errors.length) {
      console.log('Stale path references:', errors);
    }
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (skills/agents/commands still use old paths)**

Run: `npm test -- test/lib/skill-path-references.test.ts`
Expected: FAIL with a long list of stale references — that's the work to be done in Phase E.

- [ ] **Step 3: Mark the test as `it.skip` for now with an explanatory comment**

Change `it.each(...)` to `it.skip.each(...)` and add a comment:

```typescript
// SKIPPED until Phase E re-points skill prose at the new manifest paths.
// Re-enable as the last step of Phase E (Task 21).
```

- [ ] **Step 4: Commit**

```bash
git add test/lib/skill-path-references.test.ts
git commit -m "test(manifest): cross-check skill prose against manifest paths (skipped pending Phase E)"
```

---

# Phase C — Migration tooling

The migration script is the user-facing tool that restructures live Drive opps. We exercise it against fixtures first, then run it against the user's real Drive in Phase H.

## Task 9: `scripts/migrate-drive-layout.ts` skeleton with `--check`

**Files:**
- Create: `scripts/migrate-drive-layout.ts`
- Create: `test/scripts/migrate-drive-layout.test.ts`

Dry-run by default. Walks the Drive root, lists every opp folder, lists every run, lists every artifact, and prints a planned-moves table. No writes in `--check` mode.

- [ ] **Step 1: Write the failing planner test**

```typescript
// test/scripts/migrate-drive-layout.test.ts
import { describe, it, expect, vi } from 'vitest';
import { planMoves } from '../../scripts/migrate-drive-layout.js';

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';

describe('planMoves: migration planner', () => {
  it('plans a move from old path to new manifest path', async () => {
    const drive = {
      list: vi.fn(async (folderId: string) => {
        if (folderId === 'opp') return [
          { id: 'inputs', name: 'inputs', mimeType: FOLDER },
          { id: 'runs', name: 'runs', mimeType: FOLDER },
        ];
        if (folderId === 'runs') return [
          { id: 'r1', name: '20260503-2128', mimeType: FOLDER },
        ];
        if (folderId === 'r1') return [
          { id: 'pdd', name: 'pdd.md', mimeType: DOC },
          { id: 'idea', name: 'idea.md', mimeType: DOC },
        ];
        return [];
      }),
    };
    const moves = await planMoves('opp', drive as any);
    expect(moves).toContainEqual({
      fileId: 'pdd',
      from: 'pdd.md',
      to: '1-design/idea-to-pdd.md',
      action: 'move',
    });
    expect(moves).toContainEqual({
      fileId: 'idea',
      from: 'idea.md',
      to: '1-design/idea.md',
      action: 'move',
    });
  });

  it('emits a coalesce action for duplicate verdicts/ folders', async () => {
    const drive = {
      list: vi.fn(async (folderId: string) => {
        if (folderId === 'r1') return [
          { id: 'v1', name: 'verdicts', mimeType: FOLDER },
          { id: 'v2', name: 'verdicts', mimeType: FOLDER },
        ];
        if (folderId === 'v1') return [{ id: 'fa', name: 'idea-to-pdd.yaml', mimeType: DOC }];
        if (folderId === 'v2') return [{ id: 'fb', name: 'pdd-to-learn-app.yaml', mimeType: DOC }];
        return [];
      }),
    };
    const moves = await planMoves('r1', drive as any, { rootIsRun: true });
    expect(moves.filter(m => m.action === 'coalesce-folder')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/scripts/migrate-drive-layout.test.ts`
Expected: FAIL ("Cannot find module 'scripts/migrate-drive-layout'").

- [ ] **Step 3: Implement `scripts/migrate-drive-layout.ts` skeleton**

```typescript
// scripts/migrate-drive-layout.ts
//
// One-shot tool that restructures live Drive opps from the old flat layout
// to the 0.12.0 phase-prefixed _role layout. Dry-run by default.
//
// Usage:
//   npx tsx scripts/migrate-drive-layout.ts --check    # plan, print, no writes
//   npx tsx scripts/migrate-drive-layout.ts --apply    # plan + execute
//   npx tsx scripts/migrate-drive-layout.ts --apply --opp <slug>   # one opp only

import { ARTIFACT_MANIFEST } from '../lib/artifact-manifest.js';
import { PHASE_FOLDERS } from '../lib/artifact-manifest-roles.js';

interface DriveEntry { id: string; name: string; mimeType: string; }
interface DriveLike { list: (folderId: string) => Promise<DriveEntry[]>; }

export type MoveAction = 'move' | 'coalesce-folder' | 'create-shortcut' | 'delete-empty';
export interface PlannedMove {
  fileId: string;
  from: string;
  to: string;
  action: MoveAction;
}

// Map every old manifest path to its new equivalent. The list is the same
// table from Plan Task 5 step 1; embedded here for the migrator to consume.
const OLD_TO_NEW: Record<string, string> = {
  'idea.md': '1-design/idea.md',
  'pdd.md': '1-design/idea-to-pdd.md',
  'test-prompts.md': '1-design/pdd-to-test-prompts.md',
  'gate-briefs/idea-to-pdd.md': '1-design/idea-to-pdd_gate-brief.md',
  'app-summaries/learn-app-summary.md': '2-commcare/pdd-to-learn-app_summary.md',
  'app-summaries/deliver-app-summary.md': '2-commcare/pdd-to-deliver-app_summary.md',
  'deployment-summary.md': '2-commcare/app-deploy_summary.md',
  'gate-briefs/app-deploy.md': '2-commcare/app-deploy_gate-brief.md',
  'test-results/test-plan.md': '2-commcare/app-test/test-plan.md',
  'test-results/test-results.md': '2-commcare/app-test/test-results.md',
  'test-results/bugs.md': '2-commcare/app-test/bugs.md',
  'training-materials/llo-manager-guide.md': '5-qa-and-training/training-llo-guide.md',
  'training-materials/flw-training-guide.md': '5-qa-and-training/training-flw-guide.md',
  'training-materials/quick-reference.md': '5-qa-and-training/training-quick-reference.md',
  'training-materials/faq.md': '5-qa-and-training/training-faq.md',
  'training-materials/onboarding-email-body.md': '5-qa-and-training/training-onboarding-email.md',
  'training-materials/training-deck-outline.md': '5-qa-and-training/training-deck-outline.md',
  'connect-setup/program.md': '3-connect/connect-program-setup.md',
  'connect-setup/opportunity.md': '3-connect/connect-opp-setup.md',
  'connect-setup/invites.md': '6-llo-manager/llo-invite_list.md',
  'gate-briefs/llo-invite.md': '6-llo-manager/llo-invite_gate-brief.md',
  'ocs-agent-config.md': '4-ocs/ocs-agent-setup.md',
  'ocs-setup/widget-handoff.md': '4-ocs/ocs-setup_widget-handoff.md',
  'verdicts/ocs-chatbot-eval-quick.yaml': '4-ocs/ocs-chatbot-eval_verdict-quick.yaml',
  'verdicts/ocs-chatbot-eval-deep.yaml': '4-ocs/ocs-chatbot-eval_verdict-deep.yaml',
  'verdicts/ocs-chatbot-eval-monitor.yaml': '6-llo-manager/ocs-chatbot-eval_verdict-monitor.yaml',
  'verdicts/idea-to-pdd.yaml': '1-design/idea-to-pdd_verdict.yaml',
  'verdicts/pdd-to-learn-app.yaml': '2-commcare/pdd-to-learn-app_verdict.yaml',
  'verdicts/pdd-to-deliver-app.yaml': '2-commcare/pdd-to-deliver-app_verdict.yaml',
  'verdicts/app-release.yaml': '2-commcare/app-release_verdict.yaml',
  'verdicts/connect-program-setup.yaml': '3-connect/connect-program-setup_verdict.yaml',
  'verdicts/llo-launch.yaml': '6-llo-manager/llo-launch_verdict.yaml',
  'verdicts/cycle-grade.yaml': '7-closeout/cycle-grade_verdict.yaml',
  'verdicts/flw-data-review-monitor.yaml': '6-llo-manager/flw-data-review_verdict-monitor.yaml',
  'verdicts/opp-eval-deep.yaml': '7-closeout/opp-eval/opp-eval_verdict-deep.yaml',
  'verdicts/opp-eval-monitor.yaml': '7-closeout/opp-eval/opp-eval_verdict-monitor.yaml',
  'gate-briefs/ocs-chatbot-eval-deep.md': '4-ocs/ocs-chatbot-eval_gate-brief-deep.md',
  'gate-briefs/llo-launch.md': '6-llo-manager/llo-launch_gate-brief.md',
  'gate-briefs/opp-eval-deep.md': '7-closeout/opp-eval/opp-eval_gate-brief-deep.md',
  'comms-log/onboarding-emails.md': '6-llo-manager/llo-onboarding_comms-log.md',
  'uat/uat-results.md': '6-llo-manager/llo-uat_results.md',
  'launch/launch-record.md': '6-llo-manager/llo-launch_record.md',
  'eval-reports/trend.md': '6-llo-manager/ocs-chatbot-eval_trend.md',
  'closeout/invoices.md': '7-closeout/opp-closeout_invoices.md',
  'closeout/llo-feedback.md': '7-closeout/llo-feedback.md',
  'closeout/learnings.md': '7-closeout/learnings-summary.md',
  'closeout/new-pdd.md': '7-closeout/learnings-summary_new-pdd.md',
  'closeout/cycle-grade.md': '7-closeout/cycle-grade.md',
  'screenshots/manifest.yaml': '5-qa-and-training/app-screenshot-capture_manifest.yaml',
  'scorecards/trend.md': '7-closeout/opp-eval/trend.md',
};

export async function planMoves(
  rootFolderId: string,
  drive: DriveLike,
  opts: { rootIsRun?: boolean } = {},
): Promise<PlannedMove[]> {
  const moves: PlannedMove[] = [];
  if (opts.rootIsRun) {
    await planRunMoves(rootFolderId, '', drive, moves);
  } else {
    // rootFolderId is an opp folder; walk its `runs/` subfolder
    const oppChildren = await drive.list(rootFolderId);
    const runsFolder = oppChildren.find(c => c.name === 'runs' && c.mimeType.endsWith('folder'));
    if (!runsFolder) return moves;
    const runs = await drive.list(runsFolder.id);
    for (const r of runs) {
      if (r.mimeType.endsWith('folder')) {
        await planRunMoves(r.id, '', drive, moves);
      }
    }
  }
  return moves;
}

async function planRunMoves(
  folderId: string,
  prefix: string,
  drive: DriveLike,
  moves: PlannedMove[],
): Promise<void> {
  const children = await drive.list(folderId);
  // Detect duplicate folder names and emit coalesce actions
  const folderNamesSeen = new Map<string, string[]>();
  for (const c of children.filter(c => c.mimeType.endsWith('folder'))) {
    if (!folderNamesSeen.has(c.name)) folderNamesSeen.set(c.name, []);
    folderNamesSeen.get(c.name)!.push(c.id);
  }
  for (const [name, ids] of folderNamesSeen.entries()) {
    if (ids.length > 1) {
      moves.push({ fileId: ids[1], from: `${prefix}${name}/`, to: `${prefix}${name}/`, action: 'coalesce-folder' });
    }
  }
  // Map files via OLD_TO_NEW
  for (const c of children) {
    const childPath = prefix + c.name;
    if (c.mimeType.endsWith('folder')) {
      await planRunMoves(c.id, childPath + '/', drive, moves);
    } else {
      const newPath = OLD_TO_NEW[childPath];
      if (newPath && newPath !== childPath) {
        moves.push({ fileId: c.id, from: childPath, to: newPath, action: 'move' });
      }
    }
  }
}

// CLI entry — only runs when invoked directly via `npx tsx`.
if (import.meta.url === `file://${process.argv[1]}`) {
  // Implementation of --check / --apply CLI follows in Tasks 10-12.
  console.log('migrate-drive-layout CLI not yet wired; see Task 10');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/scripts/migrate-drive-layout.test.ts`
Expected: PASS, 2 planner tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-drive-layout.ts test/scripts/migrate-drive-layout.test.ts
git commit -m "feat(migrate): plan-only skeleton for Drive layout migration"
```

## Task 10: CLI wrapper for `--check` mode (read-only walk + report)

**Files:**
- Modify: `scripts/migrate-drive-layout.ts` (add CLI entry)

Wires `planMoves` to a real Drive client so the user can see planned moves against their actual Drive root before any `--apply`.

- [ ] **Step 1: Implement CLI entry that takes `--check` and walks the Drive root**

In `scripts/migrate-drive-layout.ts`, replace the placeholder CLI block at the bottom:

```typescript
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

async function loadDriveClient() {
  const keyPath = process.env.GWS_KEY_PATH ||
    path.join(os.homedir(), '.claude/plugins/data/ace-ace/gws-sa-key.json');
  if (!fs.existsSync(keyPath)) throw new Error(`SA key not found at ${keyPath}`);
  const auth = new GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function listFolder(driveClient: any, folderId: string) {
  const out: DriveEntry[] = [];
  let pageToken: string | undefined;
  do {
    const r = await driveClient.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken,
    });
    out.push(...(r.data.files ?? []));
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const check = args.includes('--check') || !apply;
  const oppFilter = args[args.indexOf('--opp') + 1];
  const rootId = process.env.ACE_DRIVE_ROOT_FOLDER_ID;
  if (!rootId) { console.error('ACE_DRIVE_ROOT_FOLDER_ID not set'); process.exit(2); }

  const driveClient = await loadDriveClient();
  const drive = { list: (id: string) => listFolder(driveClient, id) };
  const oppFolders = (await drive.list(rootId)).filter(c =>
    c.mimeType.endsWith('folder') && (!oppFilter || c.name === oppFilter),
  );

  let total = 0;
  for (const opp of oppFolders) {
    const moves = await planMoves(opp.id, drive);
    if (!moves.length) continue;
    console.log(`\n# ${opp.name} (${moves.length} moves)`);
    for (const m of moves) {
      console.log(`  ${m.action.padEnd(18)} ${m.from}  →  ${m.to}`);
    }
    total += moves.length;
  }

  console.log(`\nTotal planned moves: ${total}`);
  if (check) console.log('Dry-run mode (--check). Re-run with --apply to execute.');
  // --apply implementation in Task 11.
}
```

- [ ] **Step 2: Run dry-run against the user's local Drive root**

Run: `ACE_DRIVE_ROOT_FOLDER_ID=$(grep ACE_DRIVE_ROOT_FOLDER_ID ~/.claude/plugins/data/ace-ace/.env | cut -d= -f2) npx tsx scripts/migrate-drive-layout.ts --check 2>&1 | head -80`
Expected: A printout of planned moves, one block per opp folder, showing `move` actions for files that match `OLD_TO_NEW` and `coalesce-folder` for the duplicate `verdicts/` under `leep-paint-collection`.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-drive-layout.ts
git commit -m "feat(migrate): --check mode walks Drive and prints planned moves"
```

## Task 11: `--apply` mode — execute file moves + folder coalesce

**Files:**
- Modify: `scripts/migrate-drive-layout.ts`

Each `move` action calls `drive_create_folder` (find-or-create — gives us the new parent folder ID) then `files.update` to change the file's parent. `coalesce-folder` moves all children of the duplicate folder into the canonical one, then deletes the empty duplicate.

- [ ] **Step 1: Add `executeMoves` function**

```typescript
export async function executeMoves(
  oppFolderId: string,
  moves: PlannedMove[],
  driveClient: any,
): Promise<void> {
  // Walk the run folder hierarchy on demand to resolve current parents.
  // For each move, ensure the target phase folder exists (find-or-create),
  // then update the file's parent.
  const folderCache = new Map<string, string>(); // path → folder id

  async function ensureFolder(parentId: string, segments: string[]): Promise<string> {
    let current = parentId;
    let pathKey = '';
    for (const seg of segments) {
      pathKey = pathKey ? `${pathKey}/${seg}` : seg;
      if (folderCache.has(pathKey)) { current = folderCache.get(pathKey)!; continue; }
      const children = await listFolder(driveClient, current);
      const existing = children.find(c => c.name === seg && c.mimeType.endsWith('folder'));
      if (existing) {
        folderCache.set(pathKey, existing.id);
        current = existing.id;
      } else {
        const created = await driveClient.files.create({
          requestBody: { name: seg, mimeType: 'application/vnd.google-apps.folder', parents: [current] },
          fields: 'id',
          supportsAllDrives: true,
        });
        folderCache.set(pathKey, created.data.id!);
        current = created.data.id!;
      }
    }
    return current;
  }

  for (const m of moves) {
    if (m.action === 'move') {
      // 'to' is `<phase-folder>/<...>/<filename>`; the run folder ID is the parent of the move's source path's first segment
      // For simplicity, resolve the run folder by walking up via the file's parents — we need the run folder ID.
      // Pass it explicitly via a lookup: see Task 11 step 2.
      const segs = m.to.split('/');
      const filename = segs.pop()!;
      const targetFolder = await ensureFolder(/* runFolderId */ '__set_per_move__', segs);
      // Get current parents of the file
      const meta = await driveClient.files.get({
        fileId: m.fileId, fields: 'parents,name', supportsAllDrives: true,
      });
      const prevParent = meta.data.parents?.[0];
      await driveClient.files.update({
        fileId: m.fileId,
        addParents: targetFolder,
        removeParents: prevParent ?? '',
        requestBody: filename === meta.data.name ? {} : { name: filename },
        supportsAllDrives: true,
      });
    } else if (m.action === 'coalesce-folder') {
      // Implementation in Step 3
    }
  }
}
```

- [ ] **Step 2: Refactor `planMoves` to attach the run folder ID to each move**

Add `runFolderId` to the `PlannedMove` type and populate it in `planRunMoves`. Update `executeMoves` to use `m.runFolderId` instead of the placeholder.

- [ ] **Step 3: Implement `coalesce-folder` action**

When two folders share a name (`verdicts/` and `verdicts/`), the planner emits a coalesce for the second. Execution: list children of the duplicate, move each one into the first folder (`addParents`/`removeParents`), then delete the now-empty duplicate via `files.delete`.

```typescript
} else if (m.action === 'coalesce-folder') {
  // m.fileId is the duplicate folder's id; we need the canonical sibling's id.
  // Look up by re-listing the parent and finding both folders by name.
  const parentMeta = await driveClient.files.get({
    fileId: m.fileId, fields: 'parents', supportsAllDrives: true,
  });
  const parentId = parentMeta.data.parents![0];
  const siblings = await listFolder(driveClient, parentId);
  const folderName = m.from.replace(/\/$/, '').split('/').pop()!;
  const sameName = siblings.filter(s => s.name === folderName && s.mimeType.endsWith('folder'));
  const canonical = sameName.find(s => s.id !== m.fileId)?.id;
  if (!canonical) continue;
  const dupChildren = await listFolder(driveClient, m.fileId);
  for (const child of dupChildren) {
    await driveClient.files.update({
      fileId: child.id, addParents: canonical, removeParents: m.fileId, supportsAllDrives: true,
    });
  }
  await driveClient.files.delete({ fileId: m.fileId, supportsAllDrives: true });
}
```

- [ ] **Step 4: Wire `--apply` in the CLI block**

```typescript
if (apply) {
  for (const opp of oppFolders) {
    const moves = await planMoves(opp.id, drive);
    if (!moves.length) continue;
    console.log(`Applying ${moves.length} moves for ${opp.name}...`);
    await executeMoves(opp.id, moves, driveClient);
    console.log(`  ✓ done`);
  }
}
```

- [ ] **Step 5: Test against a single fixture-like opp manually first**

Don't run `--apply` against the full Drive root yet — that happens in Phase H after fixture migration validates the script. For now, scope to one opp:

Run: `npx tsx scripts/migrate-drive-layout.ts --apply --opp leep-paint-collection 2>&1 | tail -20`

Wait — this executes against live Drive. Hold off until Phase H. Replace this step with:

- [ ] **Step 5: Add an integration-test-style smoke (manual, behind GDRIVE_INTEGRATION env gate)**

```typescript
// test/scripts/migrate-drive-layout.integration.test.ts
import { describe, it } from 'vitest';
const RUN_INTEGRATION = process.env.GDRIVE_INTEGRATION === '1';

describe.runIf(RUN_INTEGRATION)('migrate-drive-layout integration', () => {
  it.skip('manually exercise --check on live Drive root in dev', () => {});
});
```

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-drive-layout.ts test/scripts/migrate-drive-layout.integration.test.ts
git commit -m "feat(migrate): --apply mode executes moves and coalesces dup folders"
```

## Task 12: Add `current/` shortcut creation + dead-folder cleanup

**Files:**
- Modify: `scripts/migrate-drive-layout.ts`
- Modify: `mcp/google-drive-server.ts` (add `drive_create_shortcut` atom — see Task 13)

After file moves complete, the migrator creates `current/` shortcuts pointing at the latest run's canonical artifacts, and deletes now-dead folders (`gate-briefs/`, `verdicts/` at run root, `eval-reports/`, etc.).

- [ ] **Step 1: Add `create-shortcut` and `delete-empty` plan actions to `planMoves`**

After the `move` loop, identify dead folders (no children left after planned moves) and emit `delete-empty` actions for them.

For `current/` shortcuts, find the latest `runs/<run-id>/` per opp (lex-largest folder name) and emit one `create-shortcut` per `current/` artifact:

```typescript
const CURRENT_TARGETS = [
  { name: 'connect-opp-summary.md', target: '3-connect/connect-opp-setup.md' },
  { name: 'connect-program-summary.md', target: '3-connect/connect-program-setup.md' },
  { name: 'ocs-agent-config.md', target: '4-ocs/ocs-agent-setup.md' },
];
```

- [ ] **Step 2: Implement execution for `delete-empty` and `create-shortcut`**

```typescript
} else if (m.action === 'delete-empty') {
  const children = await listFolder(driveClient, m.fileId);
  if (children.length === 0) {
    await driveClient.files.delete({ fileId: m.fileId, supportsAllDrives: true });
  }
} else if (m.action === 'create-shortcut') {
  // m.from = name of shortcut to create under <opp>/current/
  // m.to   = path relative to the latest run folder
  // m.fileId = the latest run folder id
  // Resolve the target file id by walking m.to from m.fileId, then create a shortcut under <opp>/current/.
  const targetId = await resolvePath(driveClient, m.fileId, m.to.split('/'));
  if (!targetId) continue;
  const oppMeta = await driveClient.files.get({
    fileId: m.fileId, fields: 'parents', supportsAllDrives: true,
  });
  const runsParentId = oppMeta.data.parents![0];
  const runsParentMeta = await driveClient.files.get({
    fileId: runsParentId, fields: 'parents', supportsAllDrives: true,
  });
  const oppFolderId = runsParentMeta.data.parents![0];
  const currentFolder = await ensureFolder(oppFolderId, ['current']);
  // Use find-or-create semantics for the shortcut too: delete prior same-name shortcut if any
  const existing = (await listFolder(driveClient, currentFolder)).find(c => c.name === m.from);
  if (existing) await driveClient.files.delete({ fileId: existing.id, supportsAllDrives: true });
  await driveClient.files.create({
    requestBody: {
      name: m.from,
      mimeType: 'application/vnd.google-apps.shortcut',
      parents: [currentFolder],
      shortcutDetails: { targetId },
    },
    supportsAllDrives: true,
  });
}
```

- [ ] **Step 3: Add unit tests for the new action types**

Append to `test/scripts/migrate-drive-layout.test.ts`:

```typescript
it('plans current/ shortcuts for the latest run', async () => {
  const drive = { list: vi.fn(/* ... mock with one opp, two runs, files at the new paths ... */) };
  const moves = await planMoves('opp', drive as any);
  expect(moves.filter(m => m.action === 'create-shortcut').length).toBeGreaterThan(0);
});

it('plans delete-empty for now-empty old folders', async () => {
  // After moves, gate-briefs/ verdicts/ etc should be empty → emit delete-empty
});
```

- [ ] **Step 4: Run all migration tests**

Run: `npm test -- test/scripts/migrate-drive-layout.test.ts`
Expected: PASS, all planner cases green.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-drive-layout.ts test/scripts/migrate-drive-layout.test.ts
git commit -m "feat(migrate): create current/ shortcuts and clean up dead folders"
```

## Task 13: Add `drive_create_shortcut` MCP atom

**Files:**
- Modify: `mcp/google-drive-server.ts`
- Create: `test/mcp/gdrive/create-shortcut.test.ts`

The migrator uses this directly via `googleapis`, but the orchestrator (Task 22 below) needs to call it via MCP when updating `current/` shortcuts on every run.

- [ ] **Step 1: Write the failing test**

```typescript
// test/mcp/gdrive/create-shortcut.test.ts
import { describe, it, expect, vi } from 'vitest';
import { handleCreateShortcut } from '../../../mcp/google-drive-server.js';

describe('drive_create_shortcut', () => {
  it('creates a shortcut pointing at the target file', async () => {
    const drive = { files: { create: vi.fn().mockResolvedValue({ data: { id: 'shortcut-id' } }) } };
    await handleCreateShortcut(
      { name: 'connect-opp-summary.md', parentFolderId: 'parent', targetId: 'target' },
      drive as any,
    );
    expect(drive.files.create).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: expect.objectContaining({
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutDetails: { targetId: 'target' },
      }),
    }));
  });

  it('replaces an existing same-name shortcut when findOrReplace=true', async () => {
    const drive = {
      files: {
        list: vi.fn().mockResolvedValue({ data: { files: [{ id: 'old-shortcut' }] } }),
        delete: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({ data: { id: 'new-shortcut' } }),
      },
    };
    const result = await handleCreateShortcut(
      { name: 'x.md', parentFolderId: 'parent', targetId: 'target', findOrReplace: true },
      drive as any,
    );
    expect(drive.files.delete).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'old-shortcut' }));
    expect(result.id).toBe('new-shortcut');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/mcp/gdrive/create-shortcut.test.ts`
Expected: FAIL ("handleCreateShortcut not exported").

- [ ] **Step 3: Implement `handleCreateShortcut` and wire it as an MCP tool**

```typescript
export async function handleCreateShortcut(
  args: { name: string; parentFolderId: string; targetId: string; findOrReplace?: boolean },
  drive: drive_v3.Drive,
): Promise<{ id: string; name: string }> {
  const { name, parentFolderId, targetId, findOrReplace = false } = args;
  if (findOrReplace) {
    const escaped = name.replace(/'/g, "\\'");
    const list = await drive.files.list({
      q: `name='${escaped}' and '${parentFolderId}' in parents and trashed=false`,
      fields: 'files(id)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const existing of list.data.files ?? []) {
      await drive.files.delete({ fileId: existing.id!, supportsAllDrives: true });
    }
  }
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.shortcut',
      parents: [parentFolderId],
      shortcutDetails: { targetId },
    },
    fields: 'id,name',
    supportsAllDrives: true,
  });
  return { id: created.data.id!, name: created.data.name! };
}
```

Add the MCP tool registration alongside `drive_create_folder` with the same schema pattern.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/mcp/gdrive/create-shortcut.test.ts`
Expected: PASS, both tests green.

- [ ] **Step 5: Commit**

```bash
git add mcp/google-drive-server.ts test/mcp/gdrive/create-shortcut.test.ts
git commit -m "feat(gdrive): add drive_create_shortcut MCP atom for current/ layer"
```

---

# Phase D — Apply migration to fixtures

Move test fixtures to the new layout using a local-filesystem analog of the migration script. This validates the OLD_TO_NEW mapping against three real fixtures before we touch live Drive.

## Task 14: Local-filesystem migrator for fixtures

**Files:**
- Create: `scripts/migrate-fixture-layout.ts`

A simpler script that does the same OLD_TO_NEW rename but on local files (no Drive). One-shot tool.

- [ ] **Step 1: Implement the local migrator**

```typescript
// scripts/migrate-fixture-layout.ts
//
// Migrate a test fixture from the pre-0.12.0 flat layout to the
// phase-prefixed _role layout. Reuses OLD_TO_NEW from the Drive migrator.
//
// Usage: npx tsx scripts/migrate-fixture-layout.ts <fixture-dir>
//   e.g. npx tsx scripts/migrate-fixture-layout.ts test/fixtures/CRISPR-Test-001

import * as fs from 'node:fs';
import * as path from 'node:path';
import { OLD_TO_NEW } from './migrate-drive-layout.js';  // export OLD_TO_NEW from there

function migrateRunFolder(runDir: string): void {
  const allFiles: string[] = [];
  function walk(dir: string, rel: string = '') {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(p, r);
      else allFiles.push(r);
    }
  }
  walk(runDir);

  for (const rel of allFiles) {
    const newRel = OLD_TO_NEW[rel];
    if (!newRel || newRel === rel) continue;
    const src = path.join(runDir, rel);
    const dst = path.join(runDir, newRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    console.log(`  ${rel}  →  ${newRel}`);
  }

  // Clean up empty directories
  function pruneEmpty(dir: string): boolean {
    if (!fs.existsSync(dir)) return true;
    const entries = fs.readdirSync(dir);
    let allEmpty = true;
    for (const e of entries) {
      const p = path.join(dir, e);
      if (fs.statSync(p).isDirectory()) {
        if (!pruneEmpty(p)) allEmpty = false;
      } else {
        allEmpty = false;
      }
    }
    if (allEmpty && dir !== runDir) {
      fs.rmdirSync(dir);
      return true;
    }
    return false;
  }
  pruneEmpty(runDir);
}

const fixtureDir = process.argv[2];
if (!fixtureDir) {
  console.error('Usage: npx tsx scripts/migrate-fixture-layout.ts <fixture-dir>');
  process.exit(2);
}

// Fixture may be the run folder itself, or contain runs/<run-id>/
if (fs.existsSync(path.join(fixtureDir, 'runs'))) {
  for (const r of fs.readdirSync(path.join(fixtureDir, 'runs'))) {
    const runDir = path.join(fixtureDir, 'runs', r);
    if (fs.statSync(runDir).isDirectory()) {
      console.log(`\nMigrating ${runDir}`);
      migrateRunFolder(runDir);
    }
  }
} else {
  console.log(`\nMigrating ${fixtureDir}`);
  migrateRunFolder(fixtureDir);
}
```

- [ ] **Step 2: Export `OLD_TO_NEW` from `scripts/migrate-drive-layout.ts`**

Add `export const OLD_TO_NEW = { ... }` to the existing declaration.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-fixture-layout.ts scripts/migrate-drive-layout.ts
git commit -m "feat(migrate): local-filesystem fixture migrator"
```

## Task 15: Migrate CRISPR-Test-001 fixture

**Files:**
- Restructure: `test/fixtures/CRISPR-Test-001/runs/<run-id>/*`

- [ ] **Step 1: Inspect current layout**

Run: `find test/fixtures/CRISPR-Test-001 -type f | head -30`

- [ ] **Step 2: Run the fixture migrator**

Run: `npx tsx scripts/migrate-fixture-layout.ts test/fixtures/CRISPR-Test-001`
Expected: Logs of each rename; one renamed entry per file in `OLD_TO_NEW` that exists in this fixture.

- [ ] **Step 3: Run fixture validation tests**

Run: `npm test -- test/fixtures/artifact-manifest.test.ts`
Expected: CRISPR-Test-001 case now PASSES (or at least its `unexpected` set is `[]`).

- [ ] **Step 4: If unexpected files surface, decide per-file: rename to manifest-known path, or add a manifest entry, or delete**

Inspect each unexpected file. Most are old gate-briefs / verdicts; the rename should have caught them. If any remain, the migration table is incomplete — update `OLD_TO_NEW` and re-run.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/CRISPR-Test-001
git commit -m "test(fixtures): migrate CRISPR-Test-001 to phase-prefixed layout"
```

## Task 16: Migrate CRISPR-Test-002 fixture

(Same shape as Task 15, applied to `CRISPR-Test-002`.)

- [ ] **Step 1: Run the fixture migrator**

Run: `npx tsx scripts/migrate-fixture-layout.ts test/fixtures/CRISPR-Test-002`

- [ ] **Step 2: Run fixture validation; resolve any unexpected**

Run: `npm test -- test/fixtures/artifact-manifest.test.ts`

- [ ] **Step 3: Commit**

```bash
git add test/fixtures/CRISPR-Test-002
git commit -m "test(fixtures): migrate CRISPR-Test-002 to phase-prefixed layout"
```

## Task 17: Migrate CRISPR-Test-003-Turmeric fixture

- [ ] **Step 1: Run the fixture migrator**

Run: `npx tsx scripts/migrate-fixture-layout.ts test/fixtures/CRISPR-Test-003-Turmeric`

- [ ] **Step 2: Run fixture validation; resolve any unexpected**

Run: `npm test -- test/fixtures/artifact-manifest.test.ts`
Expected: All three fixtures now PASS.

- [ ] **Step 3: Commit**

```bash
git add test/fixtures/CRISPR-Test-003-Turmeric
git commit -m "test(fixtures): migrate CRISPR-Test-003-Turmeric to phase-prefixed layout"
```

---

# Phase E — Update skill prose to new manifest paths

Per-phase batches. Each task scopes to one phase (one folder of `agents/` and the corresponding `skills/`). The skill-path-references test (Task 8) gets re-enabled at the end of this phase.

## Task 18: Update Phase 1 (design) — design-review agent + design skills

**Files:**
- Modify: `agents/design-review.md`
- Modify: `skills/idea-to-pdd/SKILL.md`, `skills/pdd-to-test-prompts/SKILL.md`, `skills/idea-to-pdd-eval/SKILL.md`

For each file: find every `ACE/<opp[^/]*>/[^/]+` reference and replace with the new manifest path. Concretely:

| Old | New |
|---|---|
| `ACE/<opp-name>/idea.md` | `ACE/<opp-name>/runs/<run-id>/1-design/idea.md` |
| `ACE/<opp-name>/pdd.md` | `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md` |
| `ACE/<opp-name>/test-prompts.md` | `ACE/<opp-name>/runs/<run-id>/1-design/pdd-to-test-prompts.md` |
| `ACE/<opp-name>/gate-briefs/idea-to-pdd.md` | `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd_gate-brief.md` |
| `ACE/<opp-name>/verdicts/idea-to-pdd.yaml` | `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd_verdict.yaml` |

- [ ] **Step 1: Grep each file for the old paths**

Run: `for f in agents/design-review.md skills/idea-to-pdd/SKILL.md skills/pdd-to-test-prompts/SKILL.md skills/idea-to-pdd-eval/SKILL.md; do echo "=== $f"; grep -nE 'ACE/<opp[^/]*>/' $f; done`

- [ ] **Step 2: Apply rewrites file by file**

For each file, use the Edit tool with the old→new mapping above. Be careful: some skills reference paths under `<run-id>` already (post-multi-run-revival from 0.11.0); those need the phase folder inserted, not the whole prefix.

- [ ] **Step 3: Verify**

Run: `for f in agents/design-review.md skills/idea-to-pdd/SKILL.md skills/pdd-to-test-prompts/SKILL.md skills/idea-to-pdd-eval/SKILL.md; do grep -E 'ACE/<opp[^/]*>/(pdd\.md|idea\.md|test-prompts\.md|gate-briefs/|verdicts/)' $f; done`
Expected: No matches (all old paths replaced).

- [ ] **Step 4: Commit**

```bash
git add agents/design-review.md skills/idea-to-pdd skills/pdd-to-test-prompts skills/idea-to-pdd-eval
git commit -m "refactor(skills): point Phase 1 prose at new phase-prefixed paths"
```

## Task 19: Update Phase 2 (commcare) — commcare-setup agent + commcare skills

**Files:**
- Modify: `agents/commcare-setup.md`
- Modify: `skills/pdd-to-learn-app/SKILL.md`, `skills/pdd-to-deliver-app/SKILL.md`, `skills/app-deploy/SKILL.md`, `skills/app-test/SKILL.md`, `skills/app-release/SKILL.md`, `skills/app-connect-coverage/SKILL.md`, `skills/commcare-form-patch/SKILL.md`, `skills/pdd-to-learn-app-eval/SKILL.md`, `skills/pdd-to-deliver-app-eval/SKILL.md`, `skills/app-release-eval/SKILL.md`

Old → new mapping for Phase 2 (use Task 5 reference table). Apply per file as in Task 18.

- [ ] **Step 1: Grep each file for old paths**

Run: `for d in agents/commcare-setup.md skills/{pdd-to-learn-app,pdd-to-deliver-app,app-deploy,app-test,app-release,app-connect-coverage,commcare-form-patch,pdd-to-learn-app-eval,pdd-to-deliver-app-eval,app-release-eval}/SKILL.md; do echo "=== $d"; grep -nE 'ACE/<opp[^/]*>/' $d 2>/dev/null; done`

- [ ] **Step 2: Apply rewrites file by file using Task 5 mapping table**

- [ ] **Step 3: Verify no old paths remain**

Run: `grep -rE 'ACE/<opp[^/]*>/(app-summaries|deployment-summary|test-results/|training-materials/)' skills/ agents/`
Expected: No matches.

- [ ] **Step 4: Commit**

```bash
git add agents/commcare-setup.md skills/pdd-to-learn-app skills/pdd-to-deliver-app skills/app-deploy skills/app-test skills/app-release skills/app-connect-coverage skills/commcare-form-patch skills/pdd-to-learn-app-eval skills/pdd-to-deliver-app-eval skills/app-release-eval
git commit -m "refactor(skills): point Phase 2 prose at new phase-prefixed paths"
```

## Task 20: Update Phase 3 (connect) — connect-setup agent + connect skills

**Files:**
- Modify: `agents/connect-setup.md`
- Modify: `skills/connect-program-setup/SKILL.md`, `skills/connect-opp-setup/SKILL.md`, `skills/connect-program-setup-eval/SKILL.md`

- [ ] **Step 1: Grep + rewrite per Task 5 mapping**

Run: `for d in agents/connect-setup.md skills/{connect-program-setup,connect-opp-setup,connect-program-setup-eval}/SKILL.md; do echo "=== $d"; grep -nE 'ACE/<opp[^/]*>/' $d; done`

- [ ] **Step 2: Verify**

Run: `grep -rE 'ACE/<opp[^/]*>/(connect-setup/|verdicts/connect-)' skills/ agents/`
Expected: No matches.

- [ ] **Step 3: Commit**

```bash
git add agents/connect-setup.md skills/connect-program-setup skills/connect-opp-setup skills/connect-program-setup-eval
git commit -m "refactor(skills): point Phase 3 prose at new phase-prefixed paths"
```

## Task 21: Update Phase 4 (ocs) — ocs-setup, ocs-tester agents + ocs skills

**Files:**
- Modify: `agents/ocs-setup.md`, `agents/ocs-tester.md`
- Modify: `skills/ocs-agent-setup/SKILL.md`, `skills/ocs-chatbot-qa/SKILL.md`, `skills/ocs-chatbot-eval/SKILL.md`, `skills/ocs-widget-handoff-eval/SKILL.md`

- [ ] **Step 1: Grep + rewrite per Task 5 mapping**

- [ ] **Step 2: Verify**

Run: `grep -rE 'ACE/<opp[^/]*>/(ocs-agent-config|ocs-setup/|verdicts/ocs-|gate-briefs/ocs-|qa-captures/|eval-reports/)' skills/ agents/`
Expected: No matches.

- [ ] **Step 3: Commit**

```bash
git add agents/ocs-setup.md agents/ocs-tester.md skills/ocs-agent-setup skills/ocs-chatbot-qa skills/ocs-chatbot-eval skills/ocs-widget-handoff-eval
git commit -m "refactor(skills): point Phase 4 prose at new phase-prefixed paths"
```

## Task 22: Update Phase 5 (qa-and-training) — qa-and-training agent + qa/training skills

**Files:**
- Modify: `agents/qa-and-training.md`
- Modify: `skills/qa-plan/SKILL.md`, `skills/app-screenshot-capture/SKILL.md`, `skills/training-llo-guide/SKILL.md`, `skills/training-flw-guide/SKILL.md`, `skills/training-quick-reference/SKILL.md`, `skills/training-faq/SKILL.md`, `skills/training-onboarding-email/SKILL.md`, `skills/training-deck-outline/SKILL.md`, `skills/training-deck-build/SKILL.md`, `skills/connect-baseline-screenshots/SKILL.md`

- [ ] **Step 1: Grep + rewrite per Task 5 mapping**

- [ ] **Step 2: Verify**

Run: `grep -rE 'ACE/<opp[^/]*>/(training-materials/|screenshots/|mobile-recipes/)' skills/ agents/`
Expected: No matches.

- [ ] **Step 3: Commit**

```bash
git add agents/qa-and-training.md skills/qa-plan skills/app-screenshot-capture skills/training-llo-guide skills/training-flw-guide skills/training-quick-reference skills/training-faq skills/training-onboarding-email skills/training-deck-outline skills/training-deck-build skills/connect-baseline-screenshots
git commit -m "refactor(skills): point Phase 5 prose at new phase-prefixed paths"
```

## Task 23: Update Phase 6 (llo-manager) — llo-manager agent + llo skills

**Files:**
- Modify: `agents/llo-manager.md`
- Modify: `skills/llo-invite/SKILL.md`, `skills/llo-onboarding/SKILL.md`, `skills/llo-uat/SKILL.md`, `skills/llo-launch/SKILL.md`, `skills/llo-feedback/SKILL.md`, `skills/timeline-monitor/SKILL.md`, `skills/flw-data-review/SKILL.md`, `skills/flw-data-review-eval/SKILL.md`, `skills/llo-launch-eval/SKILL.md`, `skills/email-communicator/SKILL.md`

- [ ] **Step 1: Grep + rewrite per Task 5 mapping**

- [ ] **Step 2: Verify**

Run: `grep -rE 'ACE/<opp[^/]*>/(connect-setup/invites|comms-log/|uat/|launch/|monitoring/|data-reviews/)' skills/ agents/`
Expected: No matches.

- [ ] **Step 3: Commit**

```bash
git add agents/llo-manager.md skills/llo-invite skills/llo-onboarding skills/llo-uat skills/llo-launch skills/llo-feedback skills/timeline-monitor skills/flw-data-review skills/flw-data-review-eval skills/llo-launch-eval skills/email-communicator
git commit -m "refactor(skills): point Phase 6 prose at new phase-prefixed paths"
```

## Task 24: Update Phase 7 (closeout) — closeout agent + closeout skills + opp-eval

**Files:**
- Modify: `agents/closeout.md`
- Modify: `skills/opp-closeout/SKILL.md`, `skills/learnings-summary/SKILL.md`, `skills/cycle-grade/SKILL.md`, `skills/cycle-grade-eval/SKILL.md`, `skills/opp-eval/SKILL.md`

- [ ] **Step 1: Grep + rewrite per Task 5 mapping**

- [ ] **Step 2: Verify**

Run: `grep -rE 'ACE/<opp[^/]*>/(closeout/|scorecards/|verdicts/opp-eval|verdicts/cycle-grade)' skills/ agents/`
Expected: No matches.

- [ ] **Step 3: Commit**

```bash
git add agents/closeout.md skills/opp-closeout skills/learnings-summary skills/cycle-grade skills/cycle-grade-eval skills/opp-eval
git commit -m "refactor(skills): point Phase 7 prose at new phase-prefixed paths"
```

## Task 25: Update commands and re-enable the cross-check test

**Files:**
- Modify: `commands/run.md`, `commands/step.md`, `commands/eval.md`, `commands/status.md`
- Modify: `test/lib/skill-path-references.test.ts` (un-skip)

- [ ] **Step 1: Update each command file's path references**

For each `commands/*.md`, grep for `ACE/<opp...>` references and update per Task 5 mapping.

- [ ] **Step 2: Un-skip the cross-check test**

In `test/lib/skill-path-references.test.ts`, change `it.skip.each(...)` back to `it.each(...)`.

- [ ] **Step 3: Run the cross-check test**

Run: `npm test -- test/lib/skill-path-references.test.ts`
Expected: PASS for all three directories. Any FAIL identifies a stale path that wasn't caught — fix and re-run.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: All unit tests PASS, including all 3 fixture validations and the new lint + cross-check tests.

- [ ] **Step 5: Commit**

```bash
git add commands test/lib/skill-path-references.test.ts
git commit -m "refactor(commands): point command prose at new paths; enable manifest cross-check"
```

---

# Phase F — Orchestrator changes (produce the new layout at runtime)

The orchestrator is what actually CREATES the phase folders, the README, and the `current/` shortcuts on every fresh run.

## Task 26: Orchestrator creates `<N>-<phase>/` folders and threads `phaseFolderId`

**Files:**
- Modify: `agents/ace-orchestrator.md`

The orchestrator's phase loop currently calls `Agent(<phase-agent>)` with the run folder ID. It now creates the phase subfolder first (find-or-create) and passes that ID instead.

- [ ] **Step 1: Read the current phase loop in `ace-orchestrator.md` to find the dispatch site**

Run: `grep -nA 20 'Agent.*design-review' agents/ace-orchestrator.md | head -30`

- [ ] **Step 2: Update the phase-loop instructions**

In `agents/ace-orchestrator.md`, find the `## Phase loop` (or `## Running the lifecycle`) section. Add an explicit instruction that for each phase, BEFORE dispatching the phase agent:

```markdown
For each phase:
1. Look up the phase folder name from `lib/artifact-manifest-roles.ts` `PHASE_FOLDERS`
   (e.g. design → `1-design`, commcare → `2-commcare`, ...).
2. Call `drive_create_folder(name=<phase-folder>, parentFolderId=<run-folder-id>, findOrCreate=true)`
   to get a `phaseFolderId`.
3. Dispatch the phase agent (`Agent(<phase-agent>)`) with `phaseFolderId` in the prompt
   alongside `runFolderId`. Phase agents pass `phaseFolderId` to skills as their
   parent folder for writes.
```

Phase agents then pass `phaseFolderId` (not `runFolderId`) to their skills. Update each phase-agent file to receive `phaseFolderId` and forward it.

- [ ] **Step 3: Update each phase agent to receive `phaseFolderId`**

For each `agents/{design-review,commcare-setup,connect-setup,ocs-setup,qa-and-training,llo-manager,closeout}.md`, find the section that dispatches skills and instruct it to pass `phaseFolderId` as the `parentFolderId` for writes.

- [ ] **Step 4: Commit**

```bash
git add agents/ace-orchestrator.md agents/design-review.md agents/commcare-setup.md agents/connect-setup.md agents/ocs-setup.md agents/qa-and-training.md agents/llo-manager.md agents/closeout.md
git commit -m "feat(orchestrator): create per-phase folders and thread phaseFolderId"
```

## Task 27: Run-start writes `README.md` index

**Files:**
- Modify: `agents/ace-orchestrator.md`

The README is a 3-column table (phase, artifact, status) regenerated at run-start and updated as phases complete. It serves as the human-readable "what's where" for anyone landing on a run folder cold.

- [ ] **Step 1: Add the README.md generation step to the orchestrator's run-start instructions**

In `agents/ace-orchestrator.md`, find the section that runs after creating the run folder and before dispatching Phase 1. Add:

```markdown
After creating the run folder, generate `README.md` and write it via `drive_create_file`:

​```markdown
# Run <run-id>

| Phase | Artifact | Producing skill | Status |
|---|---|---|---|
| 1-design | idea.md | (input copy) | done |
| 1-design | idea-to-pdd.md | idea-to-pdd | pending |
| 1-design | idea-to-pdd_gate-brief.md | idea-to-pdd | pending |
| 1-design | idea-to-pdd_verdict.yaml | idea-to-pdd-eval | pending |
| 1-design | pdd-to-test-prompts.md | pdd-to-test-prompts | pending |
| 2-commcare | pdd-to-learn-app_summary.md | pdd-to-learn-app | pending |
[... one row per ARTIFACT_MANIFEST entry under runs/<run-id>/, sorted by phase ...]

Run state: `run_state.yaml`
Latest: `../current/`
​```

The table is generated by walking `ARTIFACT_MANIFEST` filtered to non-opp-level entries and sorted by `PHASES.indexOf(phase)`. Update the `Status` column on every phase completion.
```

- [ ] **Step 2: Add a small helper in `lib/run-readme.ts`**

```typescript
// lib/run-readme.ts
import { ARTIFACT_MANIFEST, PHASES } from './artifact-manifest.js';

export function generateRunReadme(runId: string, phaseStatus: Record<string, 'pending' | 'done' | 'skipped'>): string {
  const rows = ARTIFACT_MANIFEST
    .filter(a => !['inputs/', 'opp.yaml'].includes(a.path))
    .filter(a => !a.path.includes('YYYY-MM-DD'))
    .sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || a.path.localeCompare(b.path));
  let body = `# Run ${runId}\n\n| Phase | Artifact | Producing skill | Status |\n|---|---|---|---|\n`;
  for (const a of rows) {
    const segs = a.path.split('/');
    const phaseFolder = segs[0];
    const filename = segs.slice(1).join('/');
    body += `| ${phaseFolder} | ${filename} | ${a.producedBy} | ${phaseStatus[a.phase] ?? 'pending'} |\n`;
  }
  body += `\nRun state: \`run_state.yaml\`\nLatest: \`../current/\`\n`;
  return body;
}
```

- [ ] **Step 3: Add a unit test for `generateRunReadme`**

```typescript
// lib/run-readme.test.ts
import { describe, it, expect } from 'vitest';
import { generateRunReadme } from './run-readme.js';

describe('generateRunReadme', () => {
  it('groups rows by phase and includes manifest entries', () => {
    const md = generateRunReadme('20260503-2128', { design: 'done', commcare: 'pending' });
    expect(md).toContain('Run 20260503-2128');
    expect(md).toContain('1-design');
    expect(md).toContain('idea-to-pdd.md');
    expect(md).toContain('| done |');
  });
});
```

- [ ] **Step 4: Run the test**

Run: `npm test -- lib/run-readme.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/ace-orchestrator.md lib/run-readme.ts lib/run-readme.test.ts
git commit -m "feat(orchestrator): write run README.md index at run start"
```

## Task 28: Phase-completion updates `current/` shortcuts

**Files:**
- Modify: `agents/ace-orchestrator.md`

After each phase completes, the orchestrator refreshes the `current/` shortcuts so they point at this run's outputs (overwriting any prior shortcut for the same name).

- [ ] **Step 1: Add the shortcut-refresh step to phase-completion instructions**

In `agents/ace-orchestrator.md`, find the phase-completion handler and add:

```markdown
After Phase 3 completes:
- Resolve the file IDs for `runs/<run-id>/3-connect/connect-opp-setup.md` and
  `runs/<run-id>/3-connect/connect-program-setup.md` via `drive_list_folder`.
- Call `drive_create_shortcut(name='connect-opp-summary.md', parentFolderId=<opp>/current/, targetId=<file-id>, findOrReplace=true)`.
- Same for connect-program-summary.md.

After Phase 4 completes:
- Same pattern for `ocs-agent-setup.md` → `<opp>/current/ocs-agent-config.md`.
```

(`<opp>/current/` is created via `drive_create_folder(name='current', parentFolderId=<opp-folder-id>, findOrCreate=true)` on first use.)

- [ ] **Step 2: Commit**

```bash
git add agents/ace-orchestrator.md
git commit -m "feat(orchestrator): refresh current/ shortcuts on phase completion"
```

## Task 29: Update `/ace:status` to show phase folders

**Files:**
- Modify: `commands/status.md`

The current `/ace:status` lists artifacts as a flat tree. Update the output specification to group by phase folder.

- [ ] **Step 1: Update the output template in `commands/status.md`**

Replace the existing artifact-listing block with one that walks `runs/<run-id>/` and groups by `<N>-<phase>/` folder; under each phase folder, list each file with its producing skill (from manifest lookup).

Example output:

```
opp: leep-paint-collection
  run: 20260503-2128 (initiated by ace@dimagi-ai.com, last_actor 2026-05-04T04:20)
    1-design/
      idea.md                           (input copy)
      idea-to-pdd.md                    [done]   (idea-to-pdd)
      idea-to-pdd_gate-brief.md         [done]   (idea-to-pdd)
      idea-to-pdd_verdict.yaml          [done]   (idea-to-pdd-eval)
      pdd-to-test-prompts.md            [done]   (pdd-to-test-prompts)
    2-commcare/
      pdd-to-learn-app_summary.md       [done]   (pdd-to-learn-app)
      pdd-to-learn-app_verdict.yaml     [done]   (pdd-to-learn-app-eval)
      app-deploy_summary.md             [done]   (app-deploy)
      ...
    3-connect/
      [pending — phase not started]
```

- [ ] **Step 2: Commit**

```bash
git add commands/status.md
git commit -m "feat(status): group output by phase folder"
```

---

# Phase G — Live-Drive migration

This is the irreversible step. Migration script gets exercised against fixtures (Phase D) before any of this. The user must approve the dry-run output before `--apply`.

## Task 30: Dry-run on user's live Drive root; review output

**Files:** None — operational task.

- [ ] **Step 1: Run dry-run against the live Drive root**

Run: `ACE_DRIVE_ROOT_FOLDER_ID=$(grep ACE_DRIVE_ROOT_FOLDER_ID ~/.claude/plugins/data/ace-ace/.env | cut -d= -f2) npx tsx scripts/migrate-drive-layout.ts --check 2>&1 | tee /tmp/migrate-plan.txt`
Expected: A printout, one block per opp (`leep-paint-collection`, `cosmetics-fgd-pilot`, `turmeric`, plus any others), listing `move`, `coalesce-folder`, `delete-empty`, and `create-shortcut` actions.

- [ ] **Step 2: User reviews `/tmp/migrate-plan.txt` and signs off**

Pause here for explicit user sign-off before proceeding to `--apply`. Print the file count summary (total moves per opp) and ask:

> "Reviewed the planned moves? Reply `apply` to execute, or call out specific moves to skip."

- [ ] **Step 3: Commit nothing (this is a runtime task)**

## Task 31: Apply migration to live Drive

**Files:** None.

- [ ] **Step 1: Apply per-opp, one at a time, with the smallest opp first**

For safety, apply to a single opp first (the smallest one — likely `cosmetics-fgd-pilot`):

Run: `ACE_DRIVE_ROOT_FOLDER_ID=... npx tsx scripts/migrate-drive-layout.ts --apply --opp cosmetics-fgd-pilot 2>&1 | tee /tmp/migrate-cosmetics.log`
Expected: One log line per move (`✓ move: pdd.md → 1-design/idea-to-pdd.md`); ends with "✓ done".

- [ ] **Step 2: Open the migrated opp in Drive and visually confirm the new layout**

User opens `ACE/cosmetics-fgd-pilot/runs/<run-id>/` in Drive UI and confirms phase folders + new filenames are correct.

- [ ] **Step 3: Apply to the remaining opps**

Run: `ACE_DRIVE_ROOT_FOLDER_ID=... npx tsx scripts/migrate-drive-layout.ts --apply 2>&1 | tee /tmp/migrate-all.log`
Expected: Iterates through remaining opps; each ends with "✓ done".

- [ ] **Step 4: Run doctor — should now report no duplicate folders, no stray opp-root files**

Run: `bin/ace-doctor 2>&1 | grep -E '(FAIL|WARN|\[Drive layout\])' | head -20`
Expected: `[Drive layout]` section reports PASS for both new checks.

## Task 32: Fresh `/ace:run` end-to-end on a small opp

**Files:** None — exercises the new orchestrator end-to-end.

- [ ] **Step 1: Pick a small opp with an inputs pack and run it**

Pick the smallest opp that has `inputs/pdd.md` populated. Run a fresh `/ace:run <opp>` and let it execute through Phase 1 at minimum (gate-pause is fine after).

- [ ] **Step 2: Confirm the new run lands in the new layout**

Open the resulting `runs/<run-id>/` in Drive. Verify:
- `README.md` is present at run root and lists every expected artifact.
- `1-design/` folder exists with `idea.md`, `idea-to-pdd.md`, `idea-to-pdd_gate-brief.md`.
- `run_state.yaml` is present and shows `phase: design` after Phase 1 completes.
- No stray opp-root file appeared.
- No duplicate folder names.

- [ ] **Step 3: Run `/ace:status <opp>` and confirm new output format**

Expected: Phase-grouped tree printed; new format from Task 29.

## Task 33: Bump version; update CHANGELOG

**Files:**
- Modify: `VERSION`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump VERSION to 0.12.0 (breaking Drive-layout change)**

Run: `scripts/version-bump.sh 0.12.0` or edit `VERSION` directly.
Expected: `VERSION`, `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` all updated to `0.12.0` via the pre-commit hook.

- [ ] **Step 2: Add CHANGELOG entry**

```markdown
## 0.12.0 — 2026-05-XX

### Drive layout: phase-prefixed folders + skill-named artifacts (BREAKING)

Restructures `ACE/<opp>/runs/<run-id>/` so every artifact lives under a
phase folder (`1-design/`, `2-commcare/`, ..., `7-closeout/`) and is named
`<producing-skill>[_<role>].<ext>`. Existing opps must be migrated via
`npx tsx scripts/migrate-drive-layout.ts --apply`.

- `lib/artifact-manifest.ts` is the canonical path source; `Phase` enum
  expanded to 7 phases (drops the old `operate` umbrella).
- Three layout bugs fixed: duplicate `verdicts/` folders (find-or-create
  on `drive_create_folder`); stray opp-root retry files (doctor check);
  empty `eval-reports/` (folded into `4-ocs/`).
- New `current/` shortcuts under each opp point at the latest run's
  canonical artifacts (replaces the prior loose-files-at-opp-root pattern).
- `README.md` auto-generated per run as a phase→artifact→skill→status table.
- Two new doctor checks for the duplicate-folder and stray-file classes.
```

- [ ] **Step 3: Commit + merge to main**

```bash
git add VERSION package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json CHANGELOG.md
git commit -m "release: 0.12.0 — phase-prefixed Drive layout + 3 layout-bug fixes

BREAKING: opp folders restructured under runs/<run-id>/<N>-<phase>/.
Migrate live opps with: npx tsx scripts/migrate-drive-layout.ts --apply"
```

Then merge to main (per CLAUDE.md merging convention):

```bash
cd ~/emdash/repositories/ace && git merge emdash/improve-drive-sowa0 --no-ff && git push
```

- [ ] **Step 4: Run `/ace:update` immediately after pushing**

`/ace:update` (per CLAUDE.md "NEVER locally patch" rule).
Expected: New version installed; subsequent sessions use the new layout end-to-end.

---

# Self-review checklist (run after Task 33)

- [ ] Every spec section has at least one task implementing it (run `grep '^##' docs/superpowers/specs/2026-05-03-run-folder-readability-design.md` and walk through).
- [ ] Every artifact in `lib/artifact-manifest.ts` follows `<phase-folder>/<skill>[_<role>].<ext>` (the lint test enforces this).
- [ ] Every `ACE/<opp...>` reference in skills/agents/commands resolves to a manifest entry (the cross-check test enforces this).
- [ ] All three fixtures pass validation under the new layout.
- [ ] `bin/ace-doctor` reports clean on the user's live Drive (no duplicate folders, no stray opp-root files, no missing `current/` shortcuts).
- [ ] A fresh `/ace:run` produces a `README.md` index, phase-folder structure, and updated `current/` shortcuts.
- [ ] Version bumped, CHANGELOG entry written, merged to main, `/ace:update` executed.
