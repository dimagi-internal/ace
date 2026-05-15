# `/ace:sweep` PR 1 — Foundation + Drive Sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/ace:sweep drive` end-to-end: walks Drive, builds a live-set of referenced identifiers from active opps, lists everything under `ACE/`, diffs to find orphans, scores them by ACE-fingerprint confidence, renders a markdown report, and trashes approved items via `drive_trash_file`. Lays the skill/procedure-doc/lib scaffolding that PRs 2–5 (Connect, OCS, HQ, labs) will extend.

**Architecture:** Pure-function library (`lib/sweep-*.ts`) for the testable logic — live-set extraction from YAML strings, fingerprint scoring against a live set, markdown report rendering — following the existing `lib/doctor-drive-layout.ts` `DriveLike` pattern (pure logic, dispatcher injects authed client). Skill markdown files (`skills/sweep-*/SKILL.md`) describe agent procedures that call MCP Drive atoms and feed the lib functions. A procedure doc (`agents/sweep.md`) orchestrates the flow, dispatched by a slash command (`commands/sweep.md`). No new MCP atoms — Drive trash uses existing `drive_trash_file`.

**Tech Stack:** TypeScript (ESM, no build step — `npx tsx`); vitest for unit tests; YAML via `yaml` package (already in deps); ACE plugin conventions per `CLAUDE.md` and `skills/README.md`.

---

## File Structure

**Create:**
- `lib/sweep-types.ts` — shared types: `LiveSet`, `Orphan`, `Confidence`, `OrphanReport`
- `lib/sweep-live-set.ts` — pure extractor: `extractIdentifiers(oppYaml, runStateYamls): LiveSet`
- `lib/sweep-fingerprint.ts` — pure scorer: `scoreDriveFolder(folder, liveSet): Confidence`
- `lib/sweep-report.ts` — pure renderer: `renderOrphanReport(orphans, system): string`
- `test/lib/sweep-live-set.test.ts`
- `test/lib/sweep-fingerprint.test.ts`
- `test/lib/sweep-report.test.ts`
- `skills/sweep-live-set/SKILL.md` — agent procedure: walks Drive, parses YAMLs, calls `extractIdentifiers`, writes `live-set.yaml`
- `skills/sweep-drive/SKILL.md` — agent procedure: reads `live-set.yaml`, lists Drive `ACE/`, calls `scoreDriveFolder` + `renderOrphanReport`, prompts for approval, calls `drive_trash_file`
- `agents/sweep.md` — procedure doc orchestrating live-set → per-system sweep
- `commands/sweep.md` — `/ace:sweep [system]` slash command

**Modify:** none. Skills and commands are auto-discovered from `skills/` and `commands/` by Claude Code's plugin loader; no `plugin.json` registration needed (verify via Task 9).

---

## Type contracts (referenced across tasks)

These types are defined in Task 1 and used unchanged in later tasks. If you need to deviate, update Task 1 first.

```typescript
// lib/sweep-types.ts
export type Confidence = 'high' | 'medium' | 'low';

export interface LiveSet {
  /** Generated at this UTC ISO timestamp. */
  generatedAt: string;
  /** Opp slugs visible under ACE/ at generation time. */
  oppSlugs: string[];
  /** External identifiers referenced by any active opp's opp.yaml or run_state.yaml. */
  identifiers: {
    connectProgramIds: string[];
    connectOpportunityIds: string[];
    connectPaymentUnitIds: string[];
    ocsChatbotIds: string[];
    ocsCollectionIds: string[];
    ocsSessionIds: string[];
    commcareAppIds: string[];
    labsWorkflowIds: string[];
    labsPipelineIds: string[];
    labsSyntheticIds: string[];
    labsRecordIds: string[];  // solicitation/fund/review/response
    driveFileIds: string[];   // explicit Drive references (rare)
  };
}

export interface DriveFolderInfo {
  id: string;
  name: string;
  /** ISO timestamp from Drive `createdTime`. */
  createdTime: string;
  /** Parent folder id; for ACE-root sweep this is `ACE_DRIVE_ROOT_FOLDER_ID`. */
  parentId: string;
}

export interface Orphan {
  /** Drive file/folder id. */
  id: string;
  /** Display name (folder name). */
  name: string;
  /** ISO timestamp. */
  createdTime: string;
  confidence: Confidence;
  /** Human-readable signals that contributed to the score. */
  signals: string[];
}

export interface OrphanReport {
  system: 'drive' | 'connect' | 'ocs' | 'hq' | 'labs';
  generatedAt: string;
  liveSetGeneratedAt: string;
  totals: { high: number; medium: number; low: number };
  orphans: Orphan[];
}
```

---

### Task 1: Shared types

**Files:**
- Create: `lib/sweep-types.ts`

- [ ] **Step 1: Write the types file**

Create `lib/sweep-types.ts` with the full content from the **Type contracts** section above (verbatim — copy from the spec block above). No runtime code, types only; nothing to test.

- [ ] **Step 2: Verify TS compiles**

Run: `npx tsc --noEmit lib/sweep-types.ts`
Expected: no output (success). If you see "Cannot find module" errors, this file has no imports, so the error is environmental — check `tsconfig.json` is being picked up.

- [ ] **Step 3: Commit**

```bash
git add lib/sweep-types.ts
git commit -m "feat(sweep): add shared types for /ace:sweep"
```

---

### Task 2: live-set extractor (pure function)

**Files:**
- Create: `lib/sweep-live-set.ts`
- Test: `test/lib/sweep-live-set.test.ts`

The extractor takes one `opp.yaml` body string and an array of `run_state.yaml` body strings (one per run under that opp), parses them, and returns a `LiveSet` fragment for that opp. A separate helper (Task 5's skill) walks Drive and merges fragments across all opps.

Per `CLAUDE.md` § Conventions: `opp.yaml` holds the durable `connect.program.{id, url, labs_int_id}`; `run_state.yaml` holds per-run `phases.<phase>.products.*`. Both are YAML.

- [ ] **Step 1: Write the failing test**

Create `test/lib/sweep-live-set.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { extractOppFragment, mergeFragments } from '../../lib/sweep-live-set';
import type { LiveSet } from '../../lib/sweep-types';

const OPP_YAML = `
display_name: Turmeric
connect:
  program:
    id: prog-abc-123
    url: https://connect.dimagi.com/programs/prog-abc-123
    labs_int_id: 42
`;

const RUN_STATE_YAML = `
opp: turmeric
run_id: 20260502-1830
phases:
  connect-setup:
    products:
      opportunity:
        id: opp-xyz-789
      payment_units:
        - id: pu-001
        - id: pu-002
  ocs-setup:
    products:
      chatbot:
        id: chat-555
        collection_id: coll-666
  solicitation-management:
    products:
      solicitation:
        id: labs-rec-1001
        url: https://labs.connect.dimagi.com/solicitations/1001
  synthetic-data-and-workflows:
    products:
      workflow_id: wf-200
      pipeline_id: pl-300
      synthetic_opp_id: syn-400
  commcare-setup:
    products:
      learn_app:
        hq_app_id: app-aaa
      deliver_app:
        hq_app_id: app-bbb
`;

describe('extractOppFragment', () => {
  it('extracts Connect program id from opp.yaml', () => {
    const frag = extractOppFragment('turmeric', OPP_YAML, []);
    expect(frag.identifiers.connectProgramIds).toEqual(['prog-abc-123']);
    expect(frag.oppSlugs).toEqual(['turmeric']);
  });

  it('extracts per-phase products from run_state.yaml', () => {
    const frag = extractOppFragment('turmeric', OPP_YAML, [RUN_STATE_YAML]);
    expect(frag.identifiers.connectOpportunityIds).toEqual(['opp-xyz-789']);
    expect(frag.identifiers.connectPaymentUnitIds).toEqual(['pu-001', 'pu-002']);
    expect(frag.identifiers.ocsChatbotIds).toEqual(['chat-555']);
    expect(frag.identifiers.ocsCollectionIds).toEqual(['coll-666']);
    expect(frag.identifiers.labsRecordIds).toEqual(['labs-rec-1001']);
    expect(frag.identifiers.labsWorkflowIds).toEqual(['wf-200']);
    expect(frag.identifiers.labsPipelineIds).toEqual(['pl-300']);
    expect(frag.identifiers.labsSyntheticIds).toEqual(['syn-400']);
    expect(frag.identifiers.commcareAppIds).toEqual(['app-aaa', 'app-bbb']);
  });

  it('tolerates missing phases', () => {
    const frag = extractOppFragment('turmeric', OPP_YAML, ['opp: turmeric\nrun_id: x\nphases: {}\n']);
    expect(frag.identifiers.connectOpportunityIds).toEqual([]);
    expect(frag.identifiers.connectProgramIds).toEqual(['prog-abc-123']);
  });

  it('tolerates invalid YAML by treating it as empty', () => {
    const frag = extractOppFragment('turmeric', 'this: is: not: yaml: [', []);
    expect(frag.oppSlugs).toEqual(['turmeric']);
    expect(frag.identifiers.connectProgramIds).toEqual([]);
  });
});

describe('mergeFragments', () => {
  it('merges identifiers, dedupes, sorts opp slugs', () => {
    const a: LiveSet = {
      generatedAt: '2026-05-15T00:00:00Z',
      oppSlugs: ['turmeric'],
      identifiers: {
        connectProgramIds: ['p1'],
        connectOpportunityIds: ['o1'],
        connectPaymentUnitIds: [],
        ocsChatbotIds: ['c1'],
        ocsCollectionIds: [],
        ocsSessionIds: [],
        commcareAppIds: [],
        labsWorkflowIds: [],
        labsPipelineIds: [],
        labsSyntheticIds: [],
        labsRecordIds: [],
        driveFileIds: [],
      },
    };
    const b: LiveSet = {
      generatedAt: '2026-05-15T00:00:00Z',
      oppSlugs: ['arnica'],
      identifiers: {
        connectProgramIds: ['p2'],
        connectOpportunityIds: ['o1'],  // dup
        connectPaymentUnitIds: [],
        ocsChatbotIds: ['c2'],
        ocsCollectionIds: [],
        ocsSessionIds: [],
        commcareAppIds: [],
        labsWorkflowIds: [],
        labsPipelineIds: [],
        labsSyntheticIds: [],
        labsRecordIds: [],
        driveFileIds: [],
      },
    };
    const merged = mergeFragments([a, b], '2026-05-15T12:00:00Z');
    expect(merged.oppSlugs).toEqual(['arnica', 'turmeric']);
    expect(merged.identifiers.connectProgramIds.sort()).toEqual(['p1', 'p2']);
    expect(merged.identifiers.connectOpportunityIds).toEqual(['o1']);
    expect(merged.generatedAt).toBe('2026-05-15T12:00:00Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/sweep-live-set.test.ts`
Expected: FAIL — "Cannot find module '../../lib/sweep-live-set'".

- [ ] **Step 3: Implement `lib/sweep-live-set.ts`**

```typescript
/**
 * Pure live-set extraction. Parses one opp's opp.yaml + run_state.yaml bodies
 * and returns a LiveSet fragment scoped to that opp. The caller (the
 * sweep-live-set skill) walks Drive, fetches each opp's YAMLs, calls
 * extractOppFragment for each, then mergeFragments to produce the final
 * cross-opp LiveSet.
 *
 * No I/O. No Drive auth. Pure parsing + shape extraction so tests can
 * exercise the path-extraction logic without mocking Drive.
 */

import { parse as parseYaml } from 'yaml';
import type { LiveSet } from './sweep-types';

function emptyIdentifiers(): LiveSet['identifiers'] {
  return {
    connectProgramIds: [],
    connectOpportunityIds: [],
    connectPaymentUnitIds: [],
    ocsChatbotIds: [],
    ocsCollectionIds: [],
    ocsSessionIds: [],
    commcareAppIds: [],
    labsWorkflowIds: [],
    labsPipelineIds: [],
    labsSyntheticIds: [],
    labsRecordIds: [],
    driveFileIds: [],
  };
}

function tryParse(yamlText: string): unknown {
  try {
    return parseYaml(yamlText) ?? {};
  } catch {
    return {};
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function pushIfString(arr: string[], v: unknown): void {
  const s = asString(v);
  if (s) arr.push(s);
}

/**
 * Extract identifier fragment for one opp.
 *
 * `runStateYamls` is an array — one entry per `runs/<run-id>/run_state.yaml`
 * under this opp's folder. Pass [] if the opp has no runs yet.
 */
export function extractOppFragment(
  oppSlug: string,
  oppYaml: string,
  runStateYamls: string[],
): LiveSet {
  const ids = emptyIdentifiers();

  // opp.yaml: durable Connect program reference
  const opp = tryParse(oppYaml) as Record<string, unknown>;
  const connect = (opp.connect ?? {}) as Record<string, unknown>;
  const program = (connect.program ?? {}) as Record<string, unknown>;
  pushIfString(ids.connectProgramIds, program.id);

  // run_state.yaml: per-phase products
  for (const text of runStateYamls) {
    const run = tryParse(text) as Record<string, unknown>;
    const phases = (run.phases ?? {}) as Record<string, unknown>;
    for (const phaseBody of Object.values(phases)) {
      const products = ((phaseBody as Record<string, unknown> | undefined)?.products
        ?? {}) as Record<string, unknown>;

      // Connect setup phase products
      const opportunity = (products.opportunity ?? {}) as Record<string, unknown>;
      pushIfString(ids.connectOpportunityIds, opportunity.id);
      const paymentUnits = (products.payment_units ?? []) as unknown[];
      if (Array.isArray(paymentUnits)) {
        for (const pu of paymentUnits) {
          pushIfString(ids.connectPaymentUnitIds, (pu as Record<string, unknown>)?.id);
        }
      }

      // OCS phase products
      const chatbot = (products.chatbot ?? {}) as Record<string, unknown>;
      pushIfString(ids.ocsChatbotIds, chatbot.id);
      pushIfString(ids.ocsCollectionIds, chatbot.collection_id);

      // Solicitation / labs records
      const solicitation = (products.solicitation ?? {}) as Record<string, unknown>;
      pushIfString(ids.labsRecordIds, solicitation.id);

      // Synthetic / workflow phase products (flat fields on products)
      pushIfString(ids.labsWorkflowIds, products.workflow_id);
      pushIfString(ids.labsPipelineIds, products.pipeline_id);
      pushIfString(ids.labsSyntheticIds, products.synthetic_opp_id);

      // CommCare apps
      const learnApp = (products.learn_app ?? {}) as Record<string, unknown>;
      const deliverApp = (products.deliver_app ?? {}) as Record<string, unknown>;
      pushIfString(ids.commcareAppIds, learnApp.hq_app_id);
      pushIfString(ids.commcareAppIds, deliverApp.hq_app_id);
    }
  }

  return {
    generatedAt: '',  // set by mergeFragments
    oppSlugs: [oppSlug],
    identifiers: ids,
  };
}

function dedupeSort(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

/** Merge fragments from many opps into one LiveSet, deduping and sorting. */
export function mergeFragments(fragments: LiveSet[], generatedAt: string): LiveSet {
  const out = emptyIdentifiers();
  const slugs: string[] = [];
  for (const frag of fragments) {
    slugs.push(...frag.oppSlugs);
    for (const k of Object.keys(out) as Array<keyof LiveSet['identifiers']>) {
      out[k].push(...frag.identifiers[k]);
    }
  }
  for (const k of Object.keys(out) as Array<keyof LiveSet['identifiers']>) {
    out[k] = dedupeSort(out[k]);
  }
  return {
    generatedAt,
    oppSlugs: dedupeSort(slugs),
    identifiers: out,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/sweep-live-set.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/sweep-live-set.ts test/lib/sweep-live-set.test.ts
git commit -m "feat(sweep): pure live-set extractor with vitest coverage"
```

---

### Task 3: fingerprint scorer (pure function)

**Files:**
- Create: `lib/sweep-fingerprint.ts`
- Test: `test/lib/sweep-fingerprint.test.ts`

Drive-specific scoring rules (per the spec):
- **high** — folder is directly under `ACE/`, name doesn't appear in `liveSet.oppSlugs`, AND name looks ACE-shaped (matches one of: starts with `CRISPR-`, contains a known archetype keyword, is lowercase-kebab and 3–40 chars).
- **medium** — folder is directly under `ACE/`, name doesn't appear in `liveSet.oppSlugs`, but doesn't match an ACE-shaped pattern.
- **low** — folder doesn't match either above (shouldn't normally be returned as an orphan; placeholder so callers always get a tier).

The scorer doesn't filter — the caller does the live-set diff first; the scorer just classifies confidence on items already determined to be orphans.

- [ ] **Step 1: Write the failing test**

Create `test/lib/sweep-fingerprint.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { scoreDriveFolder } from '../../lib/sweep-fingerprint';
import type { LiveSet, DriveFolderInfo } from '../../lib/sweep-types';

const LIVE_SET: LiveSet = {
  generatedAt: '2026-05-15T12:00:00Z',
  oppSlugs: ['turmeric', 'arnica'],
  identifiers: {
    connectProgramIds: [], connectOpportunityIds: [], connectPaymentUnitIds: [],
    ocsChatbotIds: [], ocsCollectionIds: [], ocsSessionIds: [],
    commcareAppIds: [], labsWorkflowIds: [], labsPipelineIds: [],
    labsSyntheticIds: [], labsRecordIds: [], driveFileIds: [],
  },
};

const folder = (overrides: Partial<DriveFolderInfo> = {}): DriveFolderInfo => ({
  id: 'fld-x',
  name: 'something',
  createdTime: '2026-04-01T00:00:00Z',
  parentId: 'ace-root',
  ...overrides,
});

describe('scoreDriveFolder', () => {
  it('returns high for ACE-shaped name (CRISPR-prefix)', () => {
    const r = scoreDriveFolder(folder({ name: 'CRISPR-Test-001' }), LIVE_SET, 'ace-root');
    expect(r.confidence).toBe('high');
    expect(r.signals.some((s) => s.toLowerCase().includes('crispr'))).toBe(true);
  });

  it('returns high for kebab-case opp-style name', () => {
    const r = scoreDriveFolder(folder({ name: 'paprika-pilot' }), LIVE_SET, 'ace-root');
    expect(r.confidence).toBe('high');
  });

  it('returns medium for unrecognized name at ACE root', () => {
    const r = scoreDriveFolder(folder({ name: 'README' }), LIVE_SET, 'ace-root');
    expect(r.confidence).toBe('medium');
  });

  it('does not return high for an active opp slug', () => {
    // Caller is responsible for filtering active opps out before scoring,
    // but the scorer defensively avoids "high" if the name is in liveSet.oppSlugs.
    const r = scoreDriveFolder(folder({ name: 'turmeric' }), LIVE_SET, 'ace-root');
    expect(r.confidence).not.toBe('high');
  });

  it('returns low for folders not under ACE root', () => {
    const r = scoreDriveFolder(
      folder({ name: 'CRISPR-Test-001', parentId: 'some-other-folder' }),
      LIVE_SET,
      'ace-root',
    );
    expect(r.confidence).toBe('low');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/sweep-fingerprint.test.ts`
Expected: FAIL — "Cannot find module".

- [ ] **Step 3: Implement `lib/sweep-fingerprint.ts`**

```typescript
/**
 * Pure ACE-fingerprint scoring for Drive folders. Used by the sweep-drive
 * skill after the live-set diff has identified candidate orphans; this module
 * decides high / medium / low confidence so the human can triage in chunks.
 *
 * Per-system fingerprint helpers will be added in subsequent PRs (PR 2 for
 * Connect, PR 3 for OCS, PR 4 for HQ, PR 5 for labs). Each gets its own
 * exported function so the heuristics can be tuned independently.
 */

import type { Confidence, DriveFolderInfo, LiveSet } from './sweep-types';

const CRISPR_PREFIX = /^CRISPR-/i;
const KEBAB_OPP_NAME = /^[a-z][a-z0-9-]{2,39}$/;

export interface ScoreResult {
  confidence: Confidence;
  signals: string[];
}

/**
 * Score a Drive folder. Does NOT do the live-set diff itself — the caller is
 * expected to have already determined this folder is an orphan candidate
 * (i.e. its name does not match an active opp slug). The scorer defensively
 * downgrades to medium if it sees a name that IS in liveSet.oppSlugs in case
 * the caller passed it through.
 */
export function scoreDriveFolder(
  folder: DriveFolderInfo,
  liveSet: LiveSet,
  aceRootFolderId: string,
): ScoreResult {
  const signals: string[] = [];

  if (folder.parentId !== aceRootFolderId) {
    signals.push(`not under ACE root (parent=${folder.parentId})`);
    return { confidence: 'low', signals };
  }

  if (liveSet.oppSlugs.includes(folder.name)) {
    signals.push('name matches an active opp slug');
    return { confidence: 'medium', signals };
  }

  if (CRISPR_PREFIX.test(folder.name)) {
    signals.push('name has CRISPR- prefix (canonical test opp pattern)');
    return { confidence: 'high', signals };
  }

  if (KEBAB_OPP_NAME.test(folder.name)) {
    signals.push('name is kebab-case opp-style (3-40 chars, lowercase)');
    return { confidence: 'high', signals };
  }

  signals.push('under ACE root but does not match a known ACE name pattern');
  return { confidence: 'medium', signals };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/sweep-fingerprint.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/sweep-fingerprint.ts test/lib/sweep-fingerprint.test.ts
git commit -m "feat(sweep): Drive-folder fingerprint scorer with confidence tiers"
```

---

### Task 4: report renderer (pure function)

**Files:**
- Create: `lib/sweep-report.ts`
- Test: `test/lib/sweep-report.test.ts`

Renders an `OrphanReport` to markdown. The same renderer is used by every per-system sweep (PRs 2–5), so the table shape needs to be system-agnostic; system-specific notes go in the `signals` field per orphan.

- [ ] **Step 1: Write the failing test**

Create `test/lib/sweep-report.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { renderOrphanReport } from '../../lib/sweep-report';
import type { OrphanReport } from '../../lib/sweep-types';

const baseReport: OrphanReport = {
  system: 'drive',
  generatedAt: '2026-05-15T18:00:00Z',
  liveSetGeneratedAt: '2026-05-15T17:58:00Z',
  totals: { high: 0, medium: 0, low: 0 },
  orphans: [],
};

describe('renderOrphanReport', () => {
  it('renders header with system, timestamps, and totals', () => {
    const md = renderOrphanReport({
      ...baseReport,
      totals: { high: 2, medium: 1, low: 0 },
      orphans: [
        { id: 'a', name: 'CRISPR-Test-001', createdTime: '2026-04-01T00:00:00Z',
          confidence: 'high', signals: ['CRISPR- prefix'] },
        { id: 'b', name: 'paprika-pilot', createdTime: '2026-04-02T00:00:00Z',
          confidence: 'high', signals: ['kebab opp style'] },
        { id: 'c', name: 'README', createdTime: '2026-03-01T00:00:00Z',
          confidence: 'medium', signals: ['under ACE root, unknown pattern'] },
      ],
    });
    expect(md).toContain('# Sweep report — drive');
    expect(md).toContain('Generated: 2026-05-15T18:00:00Z');
    expect(md).toContain('Live set: 2026-05-15T17:58:00Z');
    expect(md).toContain('high: 2');
    expect(md).toContain('medium: 1');
    expect(md).toContain('low: 0');
  });

  it('groups orphans by confidence with high first', () => {
    const md = renderOrphanReport({
      ...baseReport,
      totals: { high: 1, medium: 1, low: 0 },
      orphans: [
        { id: 'm', name: 'unknown', createdTime: '2026-04-02T00:00:00Z',
          confidence: 'medium', signals: ['?'] },
        { id: 'h', name: 'CRISPR-Test-X', createdTime: '2026-04-01T00:00:00Z',
          confidence: 'high', signals: ['CRISPR-'] },
      ],
    });
    expect(md.indexOf('## High confidence')).toBeLessThan(md.indexOf('## Medium confidence'));
    expect(md.indexOf('CRISPR-Test-X')).toBeLessThan(md.indexOf('unknown'));
  });

  it('skips empty confidence sections', () => {
    const md = renderOrphanReport({
      ...baseReport,
      totals: { high: 1, medium: 0, low: 0 },
      orphans: [
        { id: 'h', name: 'h', createdTime: '2026-04-01T00:00:00Z',
          confidence: 'high', signals: ['x'] },
      ],
    });
    expect(md).toContain('## High confidence');
    expect(md).not.toContain('## Medium confidence');
    expect(md).not.toContain('## Low confidence');
  });

  it('renders "No orphans found" when totals are all zero', () => {
    const md = renderOrphanReport(baseReport);
    expect(md).toContain('No orphans found.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/sweep-report.test.ts`
Expected: FAIL — "Cannot find module".

- [ ] **Step 3: Implement `lib/sweep-report.ts`**

```typescript
/**
 * Pure markdown renderer for sweep orphan reports. Used by every per-system
 * sweep skill (PRs 2-5 add Connect, OCS, HQ, labs). Output is human-readable
 * markdown plus enough structure that a human can copy individual rows or
 * approve in chunks.
 */

import type { Confidence, Orphan, OrphanReport } from './sweep-types';

const ORDER: Confidence[] = ['high', 'medium', 'low'];

const HEADER: Record<Confidence, string> = {
  high: '## High confidence',
  medium: '## Medium confidence',
  low: '## Low confidence',
};

function rowsFor(orphans: Orphan[], tier: Confidence): Orphan[] {
  return orphans.filter((o) => o.confidence === tier);
}

function renderTable(rows: Orphan[]): string {
  const lines: string[] = [
    '| ID | Name | Created | Signals |',
    '|----|------|---------|---------|',
  ];
  for (const o of rows) {
    const signals = o.signals.join('; ').replaceAll('|', '\\|');
    lines.push(`| ${o.id} | ${o.name} | ${o.createdTime} | ${signals} |`);
  }
  return lines.join('\n');
}

export function renderOrphanReport(report: OrphanReport): string {
  const parts: string[] = [];
  parts.push(`# Sweep report — ${report.system}`);
  parts.push('');
  parts.push(`Generated: ${report.generatedAt}`);
  parts.push(`Live set: ${report.liveSetGeneratedAt}`);
  parts.push('');
  parts.push(
    `Totals — high: ${report.totals.high}, medium: ${report.totals.medium}, low: ${report.totals.low}`,
  );
  parts.push('');

  const total = report.totals.high + report.totals.medium + report.totals.low;
  if (total === 0) {
    parts.push('No orphans found.');
    return parts.join('\n') + '\n';
  }

  for (const tier of ORDER) {
    const rows = rowsFor(report.orphans, tier);
    if (rows.length === 0) continue;
    parts.push(HEADER[tier]);
    parts.push('');
    parts.push(renderTable(rows));
    parts.push('');
  }

  return parts.join('\n') + '\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/sweep-report.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/sweep-report.ts test/lib/sweep-report.test.ts
git commit -m "feat(sweep): markdown orphan-report renderer"
```

---

### Task 5: `sweep-live-set` skill (agent procedure)

**Files:**
- Create: `skills/sweep-live-set/SKILL.md`

This is a markdown skill (no code in this file). It tells the agent how to walk Drive, fetch YAMLs, call the Task 2 lib functions, and write the resulting `live-set.yaml` back to Drive under `ACE/_sweep/<timestamp>/live-set.yaml`.

- [ ] **Step 1: Write the SKILL.md**

Create `skills/sweep-live-set/SKILL.md`:

```markdown
---
name: sweep-live-set
description: >
  Walk Drive ACE/ and build a live-set of identifiers still referenced by
  visible opps. Use before any per-system sweep.
disable-model-invocation: true
---

# sweep-live-set

Build the cross-opp live-set that every per-system `/ace:sweep` consumes. The live-set is the safety mechanism: anything in a target system NOT in the live-set is a candidate orphan. This skill produces it; per-system skills consume it.

## Inputs

- `ACE_DRIVE_ROOT_FOLDER_ID` from `.env` — the Drive folder that contains every opp directory.

## Products

- `ACE/_sweep/<YYYYMMDD-HHMMSS>/live-set.yaml` — the merged `LiveSet` (schema: `lib/sweep-types.ts:LiveSet`).
- Echoes the timestamped path so the caller (the sweep procedure doc) can pass it to per-system sweep skills.

## Process

1. **Compute the timestamp** for this sweep run: UTC `YYYYMMDD-HHMMSS`.
2. **Ensure `ACE/_sweep/<timestamp>/` exists** via `drive_create_folder` under `ACE_DRIVE_ROOT_FOLDER_ID`. If `_sweep/` does not yet exist as the parent, create it first.
3. **List opps:** call `drive_list_folder` on `ACE_DRIVE_ROOT_FOLDER_ID`. For each child folder, treat it as an opp if it contains an `opp.yaml` at the root OR an `inputs/` subfolder (matches `lib/doctor-drive-layout.ts:isOppFolder`). Skip `_sweep/` and any other reserved/leading-underscore folder.
4. **For each opp:**
   a. `drive_read_file` on `<opp>/opp.yaml` (if present; else empty string).
   b. `drive_list_folder` on `<opp>/runs/` (if present; else empty list).
   c. For each run folder, `drive_read_file` on `<opp>/runs/<run-id>/run_state.yaml` (skip if absent).
   d. Call `extractOppFragment(oppSlug, oppYaml, runStateYamls)` from `lib/sweep-live-set.ts` to get a fragment.
5. **Merge fragments:** call `mergeFragments(fragments, generatedAtIso)` to produce the final `LiveSet`.
6. **Serialize as YAML** and `drive_create_file` to `ACE/_sweep/<timestamp>/live-set.yaml`.
7. **Echo the Drive path and folder id** of the live-set file to the caller.

## Implementation notes for agents

- Use `npx tsx` to invoke a one-shot script that imports `lib/sweep-live-set.ts` if you need to run the merge from the terminal; or call the functions directly via the in-process TypeScript boundary if your harness allows it. Prefer one-shot script to keep the agent-side logic to MCP calls.
- The script lives at `scripts/sweep-live-set.ts` if/when an agent needs to execute it directly. (Not in scope for this PR — agents read YAMLs via MCP and call the lib functions inline.)
- If any opp folder is missing `opp.yaml`, that's a legacy/incomplete opp — still parse its runs but use `''` for the opp.yaml input; the fragment will simply omit `connectProgramIds`.

## Failure modes

- **No opps under `ACE/`** — produce an empty live-set; downstream sweeps will flag everything as an orphan candidate. That's intentional.
- **Malformed YAML in an opp's files** — `extractOppFragment` silently treats unparseable input as `{}`. Surface a warning in the agent's chat output for each opp where this happens, but don't abort.

## Related skills

- `sweep-drive` consumes this skill's output.
- Per-system sweep skills `sweep-connect`, `sweep-ocs`, `sweep-hq`, `sweep-labs` (added in PRs 2-5) will also consume it.
```

- [ ] **Step 2: Verify frontmatter is conformant**

Run: `head -6 skills/sweep-live-set/SKILL.md`
Expected output shows `name: sweep-live-set` matching the directory name and a `description:` ≤200 chars.

- [ ] **Step 3: Commit**

```bash
git add skills/sweep-live-set/SKILL.md
git commit -m "feat(sweep): add sweep-live-set skill (Drive walk → live-set.yaml)"
```

---

### Task 6: `sweep-drive` skill (agent procedure)

**Files:**
- Create: `skills/sweep-drive/SKILL.md`

The Drive sweep proper. Reads the live-set, lists everything under `ACE/`, diffs, scores via `lib/sweep-fingerprint.ts`, renders the report via `lib/sweep-report.ts`, prompts for approval, calls `drive_trash_file`.

- [ ] **Step 1: Write the SKILL.md**

Create `skills/sweep-drive/SKILL.md`:

```markdown
---
name: sweep-drive
description: >
  Diff Drive ACE/ against the live-set, score orphan candidates, render a
  triage report, and trash approved items. Use when sweeping Drive.
disable-model-invocation: true
---

# sweep-drive

Find Drive folders under `ACE/` that no current opp references, score them, present them to the human for triage, and trash approved items via `drive_trash_file` (reversible — 30-day Drive bin).

## Inputs

- Live-set file path/id from `sweep-live-set` skill output (a Drive path like `ACE/_sweep/<timestamp>/live-set.yaml`).

## Products

- `ACE/_sweep/<timestamp>/drive-orphans.md` — human-readable triage report (markdown).
- `ACE/_sweep/<timestamp>/drive-orphans.yaml` — machine-readable `OrphanReport` (for replay / per-item approval).
- For each approved orphan: a Drive trash operation via `drive_trash_file`.

## Process

1. **Read the live-set:** `drive_read_file` on the path produced by `sweep-live-set`. Parse it as YAML into a `LiveSet`.
2. **List `ACE/` children:** `drive_list_folder` on `ACE_DRIVE_ROOT_FOLDER_ID`. Filter to folders (mimeType `application/vnd.google-apps.folder`) and skip names starting with `_` (e.g. `_sweep/`).
3. **Diff:** for each folder whose name is NOT in `liveSet.oppSlugs`, it is an orphan candidate.
4. **Score:** call `scoreDriveFolder(folder, liveSet, ACE_DRIVE_ROOT_FOLDER_ID)` from `lib/sweep-fingerprint.ts` for each candidate. Collect into an `Orphan[]`.
5. **Build the `OrphanReport`** with `system: 'drive'`, `generatedAt: now ISO`, `liveSetGeneratedAt: liveSet.generatedAt`, totals, and orphans.
6. **Render the report** via `renderOrphanReport()` from `lib/sweep-report.ts`. `drive_create_file` to `ACE/_sweep/<timestamp>/drive-orphans.md`. Also serialize the YAML form to `drive-orphans.yaml` in the same folder.
7. **Surface the report** to the human in chat: print the markdown report directly, then prompt for approval. Suggested chunks:
   - "Approve all `high` confidence orphans? (N items)"
   - "Approve all `medium`? (N items)"
   - "Review individually?"
8. **On approval:** for each approved orphan, call `drive_trash_file` with `fileId: orphan.id`. Report success/failure per item back to the human.
9. **Re-verify (optional sanity check):** after trashing, `drive_list_folder` `ACE/` again and confirm the trashed names are gone. This catches partial failures.

## Failure modes

- **Live-set path doesn't resolve:** abort with a clear "Run `sweep-live-set` first" message.
- **`drive_trash_file` fails on a Shared-Drive permission error:** report the item as "trash failed — needs admin"; don't retry, don't abort the rest of the batch.
- **An approved orphan was already deleted by something else between report and execution:** treat as success.

## Implementation notes for agents

- This skill must be invoked AFTER `sweep-live-set` in the same `/ace:sweep` run — the live-set is the safety boundary. If the live-set is more than 24 hours old, regenerate it first (active opps may have changed).
- All scoring is done locally via the `lib/sweep-fingerprint.ts` function; do not paraphrase the scoring rules into prompts.

## Related skills

- `sweep-live-set` produces the live-set this skill diffs against.
- Future: `sweep-connect`, `sweep-ocs`, `sweep-hq`, `sweep-labs` follow the same pattern for their respective systems.
```

- [ ] **Step 2: Verify frontmatter**

Run: `head -6 skills/sweep-drive/SKILL.md`
Expected: `name: sweep-drive` matches directory.

- [ ] **Step 3: Commit**

```bash
git add skills/sweep-drive/SKILL.md
git commit -m "feat(sweep): add sweep-drive skill (live-set diff → trash)"
```

---

### Task 7: `sweep.md` orchestrator procedure doc

**Files:**
- Create: `agents/sweep.md`

A procedure doc (not a subagent) per `CLAUDE.md` § Agent topology — it dispatches sub-skills, so it MUST run at level 0. Frontmatter retains `name:` / `description:` / `model:` for `/ace:status` and `/ace:docs` to keep working.

- [ ] **Step 1: Write the procedure doc**

Create `agents/sweep.md`:

```markdown
---
name: sweep
description: >
  Procedure doc for /ace:sweep — orchestrates live-set build then per-system
  orphan sweep with human triage. Currently supports drive; per-system
  expansions land in PRs 2-5.
model: inherit
---

# /ace:sweep — Orchestrator (procedure doc)

This is a procedure doc, not a subagent. The `/ace:sweep` slash command reads it and executes the steps inline at level 0 (so it can call the `Agent` tool to dispatch leaf skills, per `CLAUDE.md` § Agent topology).

## Arguments

- `<system>` (optional) — one of `drive`, `connect`, `ocs`, `hq`, `labs`. If omitted, prompt the user to pick. Today only `drive` is implemented; the others print "not yet implemented; ships in PR <N>".

## Process

### Step 1: Determine system

If the user passed `<system>`, use it. Otherwise, present:

```
Which system?
  drive   — Drive folders under ACE/ (this PR)
  connect — Connect programs / opportunities / payment-units (PR 2)
  ocs     — OCS chatbots / collections / sessions (PR 3)
  hq      — CommCare HQ apps (PR 4)
  labs    — connect-labs workflows / pipelines / synthetic / records (PR 5)
```

If they pick a system other than `drive`, respond "Not yet implemented. Ships in PR <N>." and stop.

### Step 2: Build the live-set

Dispatch the `sweep-live-set` skill:

```
Agent(sweep-live-set)
```

Wait for it to return the live-set Drive path. Capture the timestamped sweep folder (e.g. `ACE/_sweep/20260515-180000/`) — every subsequent step writes into that same folder.

### Step 3: Per-system sweep

For `system == 'drive'`, dispatch `sweep-drive`:

```
Agent(sweep-drive, with: { liveSetPath: <from step 2>, sweepFolder: <from step 2> })
```

`sweep-drive` handles the human triage and trash loop itself; this orchestrator only waits for completion.

### Step 4: Summary

Print:

```
/ace:sweep drive — complete

Sweep folder: ACE/_sweep/<timestamp>/
Report:       ACE/_sweep/<timestamp>/drive-orphans.md
Trashed:      <N> high-confidence items, <M> medium-confidence items
Skipped:      <K> items (low confidence or human-rejected)
```

## Notes

- The procedure doc is the only thing that calls `Agent`. Each sub-skill (`sweep-live-set`, `sweep-drive`) is a leaf — no nested `Agent` dispatch.
- Per `CLAUDE.md` § Phase preconditions are restored, not adapted: do not try to detect "is there a stale live-set" — just regenerate it every time. The live-set is cheap (~seconds to build).
- This procedure doc is invoked once per sweep run; it doesn't persist state across runs. Persistent state (the sweep folders themselves) lives in Drive under `ACE/_sweep/`.
```

- [ ] **Step 2: Verify frontmatter conforms**

Run: `head -6 agents/sweep.md`
Expected: `name: sweep` and `model: inherit` present.

- [ ] **Step 3: Commit**

```bash
git add agents/sweep.md
git commit -m "feat(sweep): add /ace:sweep orchestrator procedure doc"
```

---

### Task 8: `/ace:sweep` slash command

**Files:**
- Create: `commands/sweep.md`

The slash command. Reads `agents/sweep.md` and executes it inline. Follows the pattern in `commands/status.md` and `commands/run.md`.

- [ ] **Step 1: Inspect an existing command for the exact frontmatter pattern**

Run: `cat commands/status.md | head -10`
Look at the `allowed-tools:` list — we need analogous tools (Read for the procedure doc, Bash for any inline shell, the Drive MCP atoms for live-set + sweep-drive, and the Agent tool implicitly).

- [ ] **Step 2: Write the command**

Create `commands/sweep.md`:

```markdown
---
description: Sweep orphaned ACE artifacts in a given system (drive supported; connect, ocs, hq, labs coming)
allowed-tools: [Read, Bash, mcp__plugin_ace_ace-gdrive__drive_list_folder, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__drive_create_file, mcp__plugin_ace_ace-gdrive__drive_create_folder, mcp__plugin_ace_ace-gdrive__drive_trash_file]
---

# /ace:sweep

Find and clean up orphaned artifacts ACE has created across the systems it touches.

## Arguments

- `<system>` (optional) — one of `drive`, `connect`, `ocs`, `hq`, `labs`. Omit to be prompted.

## Process

Read `agents/sweep.md` and execute its procedure inline (this is a procedure doc, not a subagent — see `CLAUDE.md` § Agent topology). Pass `<system>` through if provided.

## Examples

```
/ace:sweep              # prompts for system
/ace:sweep drive        # sweeps Drive end-to-end
/ace:sweep connect      # "Not yet implemented — ships in PR 2"
```
```

- [ ] **Step 3: Commit**

```bash
git add commands/sweep.md
git commit -m "feat(sweep): add /ace:sweep slash command"
```

---

### Task 9: Verify auto-discovery + end-to-end smoke

**Files:**
- Modify: (potentially) `.claude-plugin/plugin.json` if skills/commands are NOT auto-discovered

- [ ] **Step 1: Check whether plugin.json registers skills/commands explicitly**

Run: `grep -E 'skills|commands' .claude-plugin/plugin.json | head -20`

If the file lists skills/commands explicitly (e.g. an array of paths), you'll need to add the new entries. If it uses a glob or directory pattern, no change needed. The existing `commands/status.md` and `skills/<existing>/SKILL.md` files weren't registered manually based on prior work — verify by inspection.

Expected: no manual registration required (ACE relies on Claude Code's auto-discovery from `skills/` and `commands/`).

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all existing tests still pass; the 3 new test files (sweep-live-set, sweep-fingerprint, sweep-report) report a total of 14 tests passing.

- [ ] **Step 3: Run version bump (worktree-safe)**

Per `CLAUDE.md` § Plugin updates: bump via `scripts/version-bump.sh`. This updates VERSION, package.json, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` atomically.

Run: `bash scripts/version-bump.sh`
Expected: prints the new version (e.g. `0.13.213`) and the four files updated.

- [ ] **Step 4: Smoke test on a live machine (optional, only if local 1Password + Drive auth is set up)**

In a fresh Claude Code session with this branch checked out and `/reload-plugins` run:

```
/ace:sweep drive
```

Expected: it walks `ACE/`, produces a live-set, prints a Drive orphan report. Don't approve trash unless you're prepared for the trash to actually happen.

If you can't smoke test locally, that's fine — the unit tests cover the pure logic and the SKILL.md / procedure-doc are exercised by code review.

- [ ] **Step 5: Commit version bump and any auto-discovery findings**

```bash
git add VERSION package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump version for /ace:sweep PR 1"
```

- [ ] **Step 6: Push and open PR per `CLAUDE.md` § Git worktrees and merging to main**

```bash
git push -u origin HEAD
gh pr create --title "feat(sweep): /ace:sweep PR 1 — foundation + Drive" --body "$(cat <<'EOF'
## Summary

Ships `/ace:sweep drive` end-to-end and lays the foundation that PRs 2-5 (Connect / OCS / HQ / labs) will extend.

- Pure-function libs: `sweep-live-set.ts`, `sweep-fingerprint.ts`, `sweep-report.ts`
- Skills: `sweep-live-set`, `sweep-drive`
- Procedure doc: `agents/sweep.md`
- Slash command: `/ace:sweep`

Spec: `docs/superpowers/specs/2026-05-15-ace-sweep-design.md`
Plan: `docs/superpowers/plans/2026-05-15-ace-sweep-pr1-foundation-and-drive.md`

## Test plan

- [ ] `npm test` — all unit tests pass (3 new files, 14 new tests)
- [ ] `/ace:sweep drive` walks ACE/, produces live-set + orphan report
- [ ] `/ace:sweep connect` (and ocs/hq/labs) prints "Not yet implemented — ships in PR N"
- [ ] Approving high-confidence orphans trashes them via `drive_trash_file`
EOF
)"
gh pr merge $(gh pr view --json number -q .number) --auto --merge
```

- [ ] **Step 7: After PR merges, run `/ace:update` in the current session per CLAUDE.md**

```
/ace:update
```

---

## Self-review (already done by plan author — kept as a record)

**Spec coverage:**
- `live-set diff` mechanism → Tasks 2, 5
- Drive sweep with fingerprint scoring → Tasks 3, 6
- Triage report → Tasks 4, 6
- Auto-delete via `drive_trash_file` → Task 6
- Procedure doc + slash command → Tasks 7, 8
- Per-system skills as a pattern PRs 2–5 can extend → all skill files are shaped generically (`renderOrphanReport` is system-agnostic; fingerprint module has system-specific functions added per PR)

**Placeholder scan:** no TBDs. Type contracts are pinned at top of plan; every task uses the same names.

**Type consistency:** `LiveSet`, `Orphan`, `OrphanReport`, `DriveFolderInfo`, `Confidence` defined in Task 1, referenced verbatim in Tasks 2–4 and 6. Function names match across plan and code: `extractOppFragment`, `mergeFragments`, `scoreDriveFolder`, `renderOrphanReport`.
