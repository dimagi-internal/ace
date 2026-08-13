# Mobile Mapping Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ACE detect "we have no map for this device surface" from artifacts it already captures, then spend device time deliberately — and only on detection — to map it, prove it, ship it, and report where to fork.

**Architecture:** A cost ladder. Tier 0 (the `*-FAILURE.xml` ui-dump captured on every recipe failure) already ships. Tier 1 classifies that dump against the selector map three ways — `drift` / `unmapped-surface` / `matcher-miss` — as a pure function, at zero run cost. Only a tier-1 `unmapped-surface` may trigger tier 2, an opt-in full-boundary instrumented re-walk scoped to one leg. Tier 3 heals from that evidence and proves it on-device before merging. Tier 4 reports the fork point.

**Tech Stack:** TypeScript (ESM, `npx tsx`, no build step), vitest, Maestro, Android uiautomator dumps, `yaml`, Zod.

**Spec:** `docs/superpowers/specs/2026-08-12-mobile-mapping-completeness-design.md`

## Global Constraints

- **`main` is branch-protected.** Never push to it. Branch, PR, then `gh pr merge <n> --auto --merge`. The `clean-install` check must pass.
- **The repo `origin` still redirects to `jjackson/ace`.** Always pass `-R dimagi-internal/ace --head <branch>` to `gh pr create`.
- **Version bump every PR:** `bash scripts/version-bump.sh` (worktree-safe). Never hand-edit `VERSION`, `package.json`, `.claude-plugin/plugin.json`, or `.claude-plugin/marketplace.json`.
- **Land the failing test in the same PR as the fix.** An issue is not a regression test. CI runs `npm test`.
- **Never paraphrase an MCP atom schema inline in a skill** — grep `docs/atom-schemas.md`.
- **Mobile recipe and selector changes are validated on a live device before merge.** Tier 3's green on-device re-run is what satisfies this; nothing else in this plan may waive it.
- **Selector-map edits are additive.** Never mutate a row carrying a `Live-verified` note.
- **After any merge, run `/ace:update`** — a merged bump nobody distributes did not ship.
- Test command shape: `npx vitest run <file> -t "<test name>"`. Full suite: `npm test`.

---

## File Structure

**PR 1 — Detect**
- Modify `lib/atlas-drift.ts` — add text-matcher awareness and the three-way classifier. Pure functions only; no I/O, no device.
- Modify `test/mcp/mobile/atlas-drift.test.ts` — the existing suite for this module.
- Modify `scripts/probe-atlas-drift.ts` — emit `atlas-report.yaml` alongside the markdown.
- Modify `skills/app-screenshot-capture/SKILL.md`, `agents/qa-and-training.md` — run the probe at close-out; put the classification in the phase verdict.

**PR 2 — Instrument**
- Modify `mcp/mobile/recipe-splitter.ts` — opt-in boundary splitting.
- Modify `test/mcp/mobile/recipe-splitter.test.ts` (create if absent).
- Modify `mcp/mobile/backends/maestro.ts`, `mcp/mobile/client.ts` — thread the option through.

**PR 3 — Heal**
- Create `skills/selector-map-heal/SKILL.md`.
- Create `test/skills/selector-map-heal.test.ts` — the additive-only guard.

**PR 4 — Resume**
- Modify `skills/selector-map-heal/SKILL.md` — fork-point reporting section.
- Modify `lib/atlas-drift.ts` — `renderForkPointCommand`.

---

# PR 1 — Detect (tier 1)

Ships value alone: it makes every failure ACE has already recorded legible, without touching the run path.

### Task 1: Teach atlas-drift to see `text` matchers

`loadSelectorMapIds` reads only `type: 'id'` rows, so the map's `text` anchors are invisible to it — including `deliver-home-daily-visits`, the live-verified #893 Learn-vs-Deliver differentiator. A classifier built on ids alone would call a screen `unmapped-surface` while its only anchor is a text row sitting right there.

**Files:**
- Modify: `lib/atlas-drift.ts`
- Test: `test/mcp/mobile/atlas-drift.test.ts`

**Interfaces:**
- Consumes: existing `extractResourceIdsFromDump(xml: string): Set<string>`, the module-private `SelectorMap` / `SelectorMapEntry` interfaces.
- Produces: `extractTextValuesFromDump(xml: string): Set<string>`; `interface SelectorMatchers { ids: Set<string>; texts: Set<string> }`; `loadSelectorMapMatchers(yamlText: string): SelectorMatchers`. `loadSelectorMapIds` stays exported and unchanged — `scripts/probe-atlas-drift.ts` still calls it.

- [ ] **Step 1: Write the failing tests**

Append to `test/mcp/mobile/atlas-drift.test.ts`:

```ts
describe('text-matcher awareness (#893 differentiator is type: text)', () => {
  const DUMP = `<?xml version='1.0'?>
<hierarchy>
  <node resource-id="org.commcare.dalvik:id/viewJobCard" text="Household Poverty Targeting" />
  <node resource-id="" text="Daily Visits" />
  <node resource-id="" hint-text="should not be captured" />
  <node resource-id="" text="   " />
</hierarchy>`;

  it('extracts text values, ignoring blanks and hyphenated look-alike attributes', () => {
    const texts = extractTextValuesFromDump(DUMP);
    expect(texts.has('Daily Visits')).toBe(true);
    expect(texts.has('Household Poverty Targeting')).toBe(true);
    expect(texts.has('should not be captured')).toBe(false);
    expect([...texts].some((t) => t.trim() === '')).toBe(false);
  });

  it('loads id and text rows into separate sets', () => {
    const mapYaml = `
apk_version: "2.63.2"
selectors:
  deliver-home-job-card:
    type: id
    value: "org.commcare.dalvik:id/viewJobCard"
  deliver-home-daily-visits:
    type: text
    value: "Daily Visits"
  some-point:
    type: point
    value: "254,1410"
`;
    const m = loadSelectorMapMatchers(mapYaml);
    expect(m.ids.has('org.commcare.dalvik:id/viewJobCard')).toBe(true);
    expect(m.texts.has('Daily Visits')).toBe(true);
    expect(m.ids.has('254,1410')).toBe(false);
    expect(m.texts.has('254,1410')).toBe(false);
  });

  it('returns empty sets on unparseable yaml rather than throwing', () => {
    const m = loadSelectorMapMatchers(':::not yaml:::');
    expect(m.ids.size).toBe(0);
    expect(m.texts.size).toBe(0);
  });
});
```

Add `extractTextValuesFromDump` and `loadSelectorMapMatchers` to the existing import from `../../../lib/atlas-drift.js` at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/mcp/mobile/atlas-drift.test.ts -t "text-matcher awareness"`
Expected: FAIL — `extractTextValuesFromDump is not a function`.

- [ ] **Step 3: Implement**

Add to `lib/atlas-drift.ts`, directly below `extractResourceIdsFromDump`:

```ts
/** Extract every non-empty `text="..."` value from a uiautomator dump.
 *  The leading `\s` is load-bearing: without it `hint-text="..."` and any
 *  other hyphenated attribute ending in `text` would match, since `-` is a
 *  non-word character and `\b` would happily anchor mid-attribute. */
export function extractTextValuesFromDump(xml: string): Set<string> {
  const out = new Set<string>();
  const re = /\stext\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const value = (m[1] ?? m[2] ?? '').trim();
    if (value) out.add(value);
  }
  return out;
}

/** The selector map's matchers, partitioned by how they match on-device.
 *  `point` rows are deliberately excluded: a coordinate proves nothing
 *  about which screen is rendered, so it cannot contribute to coverage. */
export interface SelectorMatchers {
  ids: Set<string>;
  texts: Set<string>;
}

/** Like `loadSelectorMapIds`, but keeps `type: text` rows too. Required
 *  because the live-verified Learn-vs-Deliver differentiator
 *  (`deliver-home-daily-visits`, #893) is a text anchor — an id-only view
 *  of the map is blind to it. */
export function loadSelectorMapMatchers(yamlText: string): SelectorMatchers {
  const ids = new Set<string>();
  const texts = new Set<string>();
  let parsed: SelectorMap;
  try {
    parsed = parseYaml(yamlText) as SelectorMap;
  } catch {
    return { ids, texts };
  }
  if (!parsed || !parsed.selectors) return { ids, texts };
  for (const entry of Object.values(parsed.selectors)) {
    if (!entry || typeof entry.value !== 'string' || !entry.value) continue;
    if (entry.type === 'id') ids.add(entry.value);
    else if (entry.type === 'text') texts.add(entry.value);
  }
  return { ids, texts };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/mcp/mobile/atlas-drift.test.ts`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add lib/atlas-drift.ts test/mcp/mobile/atlas-drift.test.ts
git commit -m "feat(atlas): see text matchers, not just resource-ids

The map's live-verified Learn-vs-Deliver differentiator is a text row,
so an id-only view classifies a fully-anchored screen as unmapped."
```

---

### Task 2: The three-way classifier

`unmapped-surface` and `matcher-miss` have **opposite fixes**, and guessing between them by hand is exactly what #811 and #893 each did wrong. This is the function that stops the guessing.

**Files:**
- Modify: `lib/atlas-drift.ts`
- Test: `test/mcp/mobile/atlas-drift.test.ts`

**Interfaces:**
- Consumes: `extractResourceIdsFromDump`, `extractTextValuesFromDump`, `loadSelectorMapMatchers` (Task 1).
- Produces: `type ScreenCoverage = 'mapped' | 'drift' | 'unmapped-surface' | 'matcher-miss'`; `interface ScreenCoverageResult`; `classifyScreenCoverage(input: ClassifyScreenInput): ScreenCoverageResult`; `extractWantedMatchers(stderrExcerpt: string): string[]`. PR 3's heal skill branches on `ScreenCoverageResult.classification`.

- [ ] **Step 1: Write the failing tests**

Append to `test/mcp/mobile/atlas-drift.test.ts`:

```ts
describe('classifyScreenCoverage — the three-way split', () => {
  const MAP = `
apk_version: "2.63.2"
selectors:
  deliver-home-job-card:
    type: id
    value: "org.commcare.dalvik:id/viewJobCard"
  deliver-home-daily-visits:
    type: text
    value: "Daily Visits"
  learn-home-screen:
    type: id
    value: "org.commcare.dalvik:id/nsv_home_screen"
`;
  const dump = (nodes: string) => `<?xml version='1.0'?><hierarchy>${nodes}</hierarchy>`;

  it('matcher-miss: the wanted element IS on screen', () => {
    const r = classifyScreenCoverage({
      dumpXml: dump('<node resource-id="org.commcare.dalvik:id/viewJobCard" text="Daily Visits" />'),
      selectorMapYaml: MAP,
      wanted: ['org.commcare.dalvik:id/viewJobCard'],
    });
    expect(r.classification).toBe('matcher-miss');
    expect(r.wantedPresent).toEqual(['org.commcare.dalvik:id/viewJobCard']);
  });

  it('unmapped-surface: nothing in the map is on this screen', () => {
    const r = classifyScreenCoverage({
      dumpXml: dump('<node resource-id="org.commcare.dalvik:id/repeat_juncture_add" text="Add another" />'),
      selectorMapYaml: MAP,
      wanted: ['org.commcare.dalvik:id/viewJobCard'],
    });
    expect(r.classification).toBe('unmapped-surface');
    expect(r.mappedOnScreen).toEqual([]);
  });

  it('drift: map anchors are present but the wanted one is gone', () => {
    const r = classifyScreenCoverage({
      dumpXml: dump('<node resource-id="org.commcare.dalvik:id/nsv_home_screen" text="x" />'),
      selectorMapYaml: MAP,
      wanted: ['org.commcare.dalvik:id/viewJobCard'],
    });
    expect(r.classification).toBe('drift');
    expect(r.wantedAbsent).toEqual(['org.commcare.dalvik:id/viewJobCard']);
  });

  it('a text anchor counts as coverage — the #893 case', () => {
    const r = classifyScreenCoverage({
      dumpXml: dump('<node resource-id="" text="Daily Visits" />'),
      selectorMapYaml: MAP,
      wanted: ['org.commcare.dalvik:id/viewJobCard'],
    });
    expect(r.classification).toBe('drift');
    expect(r.mappedOnScreen).toEqual(['Daily Visits']);
  });

  it('mapped: everything wanted is present and nothing is missing', () => {
    const r = classifyScreenCoverage({
      dumpXml: dump('<node resource-id="org.commcare.dalvik:id/nsv_home_screen" text="x" />'),
      selectorMapYaml: MAP,
      wanted: [],
    });
    expect(r.classification).toBe('mapped');
  });
});

describe('extractWantedMatchers', () => {
  it('pulls Maestro regex matchers and bare resource-ids out of stderr', () => {
    const stderr = [
      'Element not found: Id matching regex: org.commcare.dalvik:id/viewJobCard',
      'Assertion is false: Text matching regex: Daily Visits',
    ].join('\n');
    const w = extractWantedMatchers(stderr);
    expect(w).toContain('org.commcare.dalvik:id/viewJobCard');
    expect(w).toContain('Daily Visits');
  });

  it('returns an empty array when nothing matches, and never duplicates', () => {
    expect(extractWantedMatchers('some unrelated failure')).toEqual([]);
    const dup = extractWantedMatchers(
      'Id matching regex: org.commcare.dalvik:id/a\nId matching regex: org.commcare.dalvik:id/a',
    );
    expect(dup).toEqual(['org.commcare.dalvik:id/a']);
  });
});
```

Add `classifyScreenCoverage` and `extractWantedMatchers` to the import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/mcp/mobile/atlas-drift.test.ts -t "three-way split"`
Expected: FAIL — `classifyScreenCoverage is not a function`.

- [ ] **Step 3: Implement**

Append to `lib/atlas-drift.ts`:

```ts
/** How a captured screen relates to the active selector map.
 *
 *  The distinction that matters operationally is `unmapped-surface` vs
 *  `matcher-miss`: they have OPPOSITE fixes. Unmapped means author a new
 *  anchor and probably a new palette step. Matcher-miss means the anchor
 *  exists and the recipe reached for it wrongly. jjackson/ace#811 and #893
 *  were each a confident hand-guess between these two, and each was wrong. */
export type ScreenCoverage = 'mapped' | 'drift' | 'unmapped-surface' | 'matcher-miss';

export interface ClassifyScreenInput {
  /** A uiautomator dump — normally `<recipe-id>-FAILURE.xml`. */
  dumpXml: string;
  /** Raw text of `mcp/mobile/selectors/connect-<apk>.yaml`. */
  selectorMapYaml: string;
  /** Matcher VALUES the recipe reached for. Use `extractWantedMatchers`
   *  on the Maestro stderr excerpt. Empty is legal (a non-selector
   *  failure); classification then reports coverage only. */
  wanted: string[];
}

export interface ScreenCoverageResult {
  classification: ScreenCoverage;
  /** Map values (id or text) actually rendered on this screen. Empty is
   *  what makes a surface `unmapped-surface`. */
  mappedOnScreen: string[];
  /** Of `wanted`, those genuinely on screen. Non-empty ⇒ `matcher-miss`. */
  wantedPresent: string[];
  /** Of `wanted`, those absent. */
  wantedAbsent: string[];
  /** Observed values not in the map — the candidate rows a heal would add. */
  candidates: string[];
}

export function classifyScreenCoverage(input: ClassifyScreenInput): ScreenCoverageResult {
  const observed = new Set<string>([
    ...extractResourceIdsFromDump(input.dumpXml),
    ...extractTextValuesFromDump(input.dumpXml),
  ]);
  const { ids, texts } = loadSelectorMapMatchers(input.selectorMapYaml);
  const mapped = new Set<string>([...ids, ...texts]);

  const mappedOnScreen = [...observed].filter((v) => mapped.has(v)).sort();
  const candidates = [...observed].filter((v) => !mapped.has(v)).sort();
  const wantedPresent = input.wanted.filter((w) => observed.has(w)).sort();
  const wantedAbsent = input.wanted.filter((w) => !observed.has(w)).sort();

  // Order is the contract. `matcher-miss` outranks everything: if what we
  // reached for is demonstrably on screen, the map is not the problem and
  // no amount of new anchors will help. Only once that is ruled out does
  // total absence of map coverage mean "we have never built this shape".
  let classification: ScreenCoverage;
  if (wantedPresent.length > 0) classification = 'matcher-miss';
  else if (mappedOnScreen.length === 0) classification = 'unmapped-surface';
  else if (wantedAbsent.length > 0) classification = 'drift';
  else classification = 'mapped';

  return { classification, mappedOnScreen, wantedPresent, wantedAbsent, candidates };
}

/** Recover the matcher values a Maestro run reached for, from its stderr.
 *  Two shapes: Maestro's own `... matching regex: <value>` lines, and any
 *  bare `pkg:id/name` token appearing anywhere in the excerpt. */
export function extractWantedMatchers(stderrExcerpt: string): string[] {
  const out = new Set<string>();
  const regexLine = /matching regex:\s*(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = regexLine.exec(stderrExcerpt)) !== null) {
    const v = (m[1] ?? '').trim();
    if (v) out.add(v);
  }
  const bareId = /[\w.]+:id\/\w+/g;
  while ((m = bareId.exec(stderrExcerpt)) !== null) out.add(m[0]);
  return [...out].sort();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/mcp/mobile/atlas-drift.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/atlas-drift.ts test/mcp/mobile/atlas-drift.test.ts
git commit -m "feat(atlas): three-way screen classification

unmapped-surface and matcher-miss have opposite fixes; #811 and #893
were each a confident hand-guess between them, and each was wrong."
```

---

### Task 3: Emit `atlas-report.yaml` and surface it in the phase verdict

On-disk-only is how the FAILURE dumps sat unread for two months (4 of 24 issues cited one). The classification has to reach the verdict.

**Files:**
- Modify: `scripts/probe-atlas-drift.ts`
- Modify: `skills/app-screenshot-capture/SKILL.md`
- Modify: `agents/qa-and-training.md`
- Test: `test/mcp/mobile/atlas-drift.test.ts`

**Interfaces:**
- Consumes: `classifyScreenCoverage`, `extractWantedMatchers` (Task 2).
- Produces: `renderReportYaml(input: AtlasYamlInput): string`. PR 3 reads `atlas-report.yaml`.

- [ ] **Step 1: Write the failing test**

Append to `test/mcp/mobile/atlas-drift.test.ts`:

```ts
describe('renderReportYaml', () => {
  it('emits parseable yaml carrying the classification and candidates', () => {
    const text = renderReportYaml({
      apkVersion: '2.63.2',
      dumpFile: 'connect-claim-opp-FAILURE.xml',
      result: {
        classification: 'unmapped-surface',
        mappedOnScreen: [],
        wantedPresent: [],
        wantedAbsent: ['org.commcare.dalvik:id/viewJobCard'],
        candidates: ['org.commcare.dalvik:id/repeat_juncture_add', 'Add another'],
      },
    });
    const parsed = parseYaml(text) as {
      apk_version: string;
      classification: string;
      candidates: string[];
      needs_tier2: boolean;
    };
    expect(parsed.apk_version).toBe('2.63.2');
    expect(parsed.classification).toBe('unmapped-surface');
    expect(parsed.candidates).toContain('Add another');
    expect(parsed.needs_tier2).toBe(true);
  });

  it('does not request tier 2 for a matcher-miss', () => {
    const text = renderReportYaml({
      apkVersion: '2.63.2',
      dumpFile: 'x-FAILURE.xml',
      result: {
        classification: 'matcher-miss',
        mappedOnScreen: ['org.commcare.dalvik:id/viewJobCard'],
        wantedPresent: ['org.commcare.dalvik:id/viewJobCard'],
        wantedAbsent: [],
        candidates: [],
      },
    });
    expect((parseYaml(text) as { needs_tier2: boolean }).needs_tier2).toBe(false);
  });
});
```

Import `renderReportYaml` from `../../../lib/atlas-drift.js` and `parse as parseYaml` from `yaml`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/mcp/mobile/atlas-drift.test.ts -t "renderReportYaml"`
Expected: FAIL — `renderReportYaml is not a function`.

- [ ] **Step 3: Implement**

Append to `lib/atlas-drift.ts`:

```ts
export interface AtlasYamlInput {
  apkVersion: string;
  dumpFile: string;
  result: ScreenCoverageResult;
}

/** Machine-readable sibling of `renderReportMarkdown`. `needs_tier2` is the
 *  gate on the expensive instrumented re-walk: ONLY an unmapped surface
 *  earns it. A matcher-miss is fixed by correcting the recipe, and drift by
 *  updating a row — neither justifies re-walking a leg with full
 *  boundary dumps. */
export function renderReportYaml(input: AtlasYamlInput): string {
  const r = input.result;
  return stringifyYaml({
    apk_version: input.apkVersion,
    dump_file: input.dumpFile,
    classification: r.classification,
    needs_tier2: r.classification === 'unmapped-surface',
    mapped_on_screen: r.mappedOnScreen,
    wanted_present: r.wantedPresent,
    wanted_absent: r.wantedAbsent,
    candidates: r.candidates,
  });
}
```

Add `stringify as stringifyYaml` to the existing `yaml` import at the top of `lib/atlas-drift.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/mcp/mobile/atlas-drift.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the probe to write the file**

In `scripts/probe-atlas-drift.ts`, after the existing markdown report is produced, add a `--yaml-out <path>` argument. When given, for each `*-FAILURE.xml` found under the dump dir, call `classifyScreenCoverage` with `wanted: extractWantedMatchers(stderrExcerpt)` — reading the excerpt from the sibling `*-FAILURE.txt` if present, else `[]` — and write `renderReportYaml(...)` to the path. Print the classification line to stdout so a caller that ignores the file still sees it.

- [ ] **Step 6: Document the close-out step**

In `skills/app-screenshot-capture/SKILL.md`, in the failure-handling section that already discusses `*-FAILURE.xml` (~line 700-760), add: after any leg fails, run the probe with `--yaml-out <run-dir>/atlas-report.yaml`, and **copy `classification` into the step verdict's `notes`**. State plainly that a `matcher-miss` means the recipe is wrong and a new selector must NOT be authored — that inversion is the #811/#893 failure.

In `agents/qa-and-training.md`, in the § Verdict-gate rule, add that when `atlas-report.yaml` reports `unmapped-surface`, the phase summary names the surface and links the dump rather than reporting a generic selector failure.

- [ ] **Step 7: Run the full suite, bump, ship**

```bash
npm test
bash scripts/version-bump.sh
git add -A
git commit -m "feat(atlas): emit atlas-report.yaml and surface it in the phase verdict"
git push -u origin HEAD
gh pr create -R dimagi-internal/ace --head "$(git rev-parse --abbrev-ref HEAD)" --base main \
  --title "feat(atlas): tier-1 detection — classify failure dumps three ways" \
  --body "Implements PR 1 of docs/superpowers/specs/2026-08-12-mobile-mapping-completeness-design.md. Zero added run cost: classifies the FAILURE dump ACE already captures."
gh pr merge <n> -R dimagi-internal/ace --auto --merge
```

Then `/ace:update` once it lands.

---

# PR 2 — Instrument (tier 2)

### Task 4: Opt-in boundary splitting

**Files:**
- Modify: `mcp/mobile/recipe-splitter.ts`
- Test: `test/mcp/mobile/recipe-splitter.test.ts` (create if absent)

**Interfaces:**
- Consumes: `RecipeChunk`, `splitRecipeAtScreenshots(body: string): RecipeChunk[]`.
- Produces: `interface SplitOptions { captureAllBoundaries?: boolean }`; `splitRecipeAtScreenshots(body: string, opts?: SplitOptions): RecipeChunk[]` — the second parameter is optional, so every existing call site is unchanged. Boundary chunks set `screenshotName` to `<recipe-id>-branch<N>-pre` / `-post`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { splitRecipeAtScreenshots } from '../../../mcp/mobile/recipe-splitter.js';

const STATIC = 'mcp/mobile/recipes/static/';
const windows = (body: string, opts?: { captureAllBoundaries?: boolean }) =>
  splitRecipeAtScreenshots(body, opts).filter((c) => c.screenshotName).length;

describe('recipe-splitter — default path is unchanged (regression guard)', () => {
  it('keeps today window counts when the mode is off', () => {
    expect(windows(readFileSync(`${STATIC}connect-claim-opp.yaml`, 'utf8'))).toBe(3);
    expect(windows(readFileSync(`${STATIC}deliver-launch.yaml`, 'utf8'))).toBe(1);
  });
});

describe('recipe-splitter — captureAllBoundaries', () => {
  const opts = { captureAllBoundaries: true };

  it('opens a window at every top-level runFlow boundary', () => {
    expect(windows(readFileSync(`${STATIC}connect-claim-opp.yaml`, 'utf8'), opts)).toBe(13);
    expect(windows(readFileSync(`${STATIC}deliver-launch.yaml`, 'utf8'), opts)).toBe(13);
  });

  it('never splits inside a runFlow.commands block', () => {
    const chunks = splitRecipeAtScreenshots(
      readFileSync(`${STATIC}connect-claim-opp.yaml`, 'utf8'),
      opts,
    );
    for (const c of chunks) {
      const opens = (c.yaml.match(/^- runFlow:/gm) || []).length;
      const closes = (c.yaml.match(/^\s+commands:/gm) || []).length;
      expect(closes).toBeLessThanOrEqual(opens + 1);
    }
  });

  it('produces deterministic, collision-free boundary names', () => {
    const names = splitRecipeAtScreenshots(
      readFileSync(`${STATIC}deliver-launch.yaml`, 'utf8'),
      opts,
    )
      .map((c) => c.screenshotName)
      .filter(Boolean) as string[];
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((n) => /-branch\d+-pre$/.test(n))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/mcp/mobile/recipe-splitter.test.ts`
Expected: FAIL on the `captureAllBoundaries` counts (13/13); the regression guard should already PASS.

- [ ] **Step 3: Implement**

In `mcp/mobile/recipe-splitter.ts`, add the options parameter and, when `captureAllBoundaries` is set, emit an additional chunk break immediately before and immediately after each **top-level** `- runFlow:` list item. Detect top-level items by a zero-indentation `- ` prefix — the same rule the existing splitter uses to find top-level `takeScreenshot`. Never descend into `commands:`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/mcp/mobile/recipe-splitter.test.ts`
Expected: PASS, all four.

- [ ] **Step 5: Commit**

```bash
git add mcp/mobile/recipe-splitter.ts test/mcp/mobile/recipe-splitter.test.ts
git commit -m "feat(mobile): opt-in captureAllBoundaries splitting (default off)"
```

---

### Task 5: Thread the mode through the backend and measure it

**Files:**
- Modify: `mcp/mobile/backends/maestro.ts:93`, `mcp/mobile/client.ts`

**Interfaces:**
- Consumes: `SplitOptions` (Task 4).
- Produces: `mobile_run_recipe` accepts `captureAllBoundaries?: boolean`, default `false`.

- [ ] **Step 1: Pass the option down**

Add `captureAllBoundaries?: boolean` to the recipe-run opts type in `mcp/mobile/types.ts`, thread it from `client.ts` into `MaestroBackend.runRecipe`, and forward it to `splitRecipeAtScreenshots` inside `runRecipeWithDumps`.

- [ ] **Step 2: Add the default-off assertion**

In `test/mcp/mobile/maestro.test.ts`, assert that a `runRecipe` call with no `captureAllBoundaries` produces the same chunk count as before. This is the guard that the expensive mode can never become the default by accident — which is the entire premise of the cost ladder.

- [ ] **Step 3: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Measure the real cost on a live dispatch**

Run one Phase 6 claim leg with `captureAllBoundaries: true` on a booted AVD. Record wall-clock with and without. **Put both numbers in the PR body.** The spec projects ~54 extra invocations at 3-5s; if the measurement is materially worse, stop and report rather than proceeding to PR 3.

- [ ] **Step 5: Bump, ship**

```bash
npm test && bash scripts/version-bump.sh
git add -A && git commit -m "feat(mobile): thread captureAllBoundaries through the run path"
git push -u origin HEAD
gh pr create -R dimagi-internal/ace --head "$(git rev-parse --abbrev-ref HEAD)" --base main \
  --title "feat(mobile): tier-2 instrumented re-walk (opt-in)" \
  --body "PR 2 of the mapping-completeness spec. Default off. Measured overhead: <fill in from Step 4>."
gh pr merge <n> -R dimagi-internal/ace --auto --merge
```

---

# PR 3 — Heal (tier 3)

### Task 6: `selector-map-heal`

**Files:**
- Create: `skills/selector-map-heal/SKILL.md`
- Test: `test/skills/selector-map-heal.test.ts`

**Interfaces:**
- Consumes: `atlas-report.yaml` (Task 3) — branches on `classification` and `needs_tier2`.
- Produces: a merged selector-map PR, or a filed issue.

- [ ] **Step 1: Write the failing guard test**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';

describe('selector-map-heal — the three guards are stated in the skill', () => {
  const P = 'skills/selector-map-heal/SKILL.md';

  it('exists and declares its name', () => {
    expect(existsSync(P)).toBe(true);
    expect(readFileSync(P, 'utf8')).toMatch(/^name:\s*selector-map-heal$/m);
  });

  it('forbids mutating a Live-verified row', () => {
    expect(readFileSync(P, 'utf8')).toMatch(/Live-verified/);
    expect(readFileSync(P, 'utf8')).toMatch(/additive|never mutate|only add/i);
  });

  it('requires a green on-device re-run before any merge', () => {
    const body = readFileSync(P, 'utf8');
    expect(body).toMatch(/re-run/i);
    expect(body).toMatch(/green|pass/i);
    expect(body).toMatch(/never ship an unproven|stop and file/i);
  });

  it('does not claim to run selector-map-calibrate autonomously', () => {
    expect(readFileSync(P, 'utf8')).not.toMatch(/disable-model-invocation:\s*false/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/skills/selector-map-heal.test.ts`
Expected: FAIL — the file does not exist.

- [ ] **Step 3: Write the skill**

Create `skills/selector-map-heal/SKILL.md` with frontmatter `name: selector-map-heal` and a description naming its trigger (`atlas-report.yaml` with `classification: unmapped-surface`). Body sections, each stated explicitly enough for the test above to match:

1. **When to run** — only on `unmapped-surface`. On `matcher-miss` STOP: fix the recipe, do not add a row. On `drift`, update the existing row.
2. **Guard 1 — additive only.** Add rows; never mutate a row carrying a `Live-verified` note.
3. **Guard 2 — green or nothing.** Re-run the blocked leg on-device. Green ⇒ PR + `gh pr merge --auto --merge`. Red after a bounded attempt count ⇒ stop and file with the dump attached; never ship an unproven row.
4. **Guard 3 — never cold-boot over a human's emulator.**
5. **Provenance** — every new row's `purpose` string names the dump file and run it came from.
6. **Why auto-merge is legitimate here** — the green re-run *is* the live validation ACE's rule demands, performed immediately before merge.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/skills/selector-map-heal.test.ts`
Expected: PASS, all four.

- [ ] **Step 5: Bump, ship**

```bash
npm test && bash scripts/version-bump.sh
git add -A && git commit -m "feat(skills): selector-map-heal — additive, self-proving map repair"
git push -u origin HEAD
gh pr create -R dimagi-internal/ace --head "$(git rev-parse --abbrev-ref HEAD)" --base main \
  --title "feat(skills): tier-3 self-heal" --body "PR 3 of the mapping-completeness spec."
gh pr merge <n> -R dimagi-internal/ace --auto --merge
```

---

# PR 4 — Resume (tier 4)

### Task 7: Report the fork point

**Files:**
- Modify: `lib/atlas-drift.ts`
- Modify: `skills/selector-map-heal/SKILL.md`
- Test: `test/mcp/mobile/atlas-drift.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `renderForkPointCommand(input: { runId: string; phase: string; skill: string }): string`.

- [ ] **Step 1: Write the failing test**

```ts
describe('renderForkPointCommand', () => {
  it('prints a runnable fork invocation naming run, phase and skill', () => {
    const cmd = renderForkPointCommand({
      runId: '20260812-1030',
      phase: 'qa-and-training',
      skill: 'app-screenshot-capture',
    });
    expect(cmd).toContain('/ace:fork-run');
    expect(cmd).toContain('20260812-1030');
    expect(cmd).toContain('app-screenshot-capture');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/mcp/mobile/atlas-drift.test.ts -t "renderForkPointCommand"`
Expected: FAIL — not a function.

- [ ] **Step 3: Implement**

```ts
/** ACE reports the fork point; it never forks itself. Forking copies
 *  artifacts into a new run, which is the operator's call. */
export function renderForkPointCommand(input: {
  runId: string;
  phase: string;
  skill: string;
}): string {
  return `/ace:fork-run ${input.runId} --at ${input.phase}/${input.skill} --reason "selector map healed; re-walk from the last good boundary"`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/mcp/mobile/atlas-drift.test.ts`
Expected: PASS.

- [ ] **Step 5: Document and ship**

Add a § Resume section to `skills/selector-map-heal/SKILL.md`: after a successful heal, print `renderForkPointCommand(...)` and stop. Do not fork.

```bash
npm test && bash scripts/version-bump.sh
git add -A && git commit -m "feat(atlas): report the fork point after a successful heal"
git push -u origin HEAD
gh pr create -R dimagi-internal/ace --head "$(git rev-parse --abbrev-ref HEAD)" --base main \
  --title "feat(atlas): tier-4 fork-point reporting" --body "PR 4 of the mapping-completeness spec."
gh pr merge <n> -R dimagi-internal/ace --auto --merge
```

---

## Self-Review

**Spec coverage.** Tier 0 — no task, correctly (already ships). Tier 1 — Tasks 1-3. Tier 2 — Tasks 4-5, including the measurement the spec's circuit breaker requires. Tier 3 — Task 6, with all three guards as testable assertions. Tier 4 — Task 7. Deferred CCZ work correctly has no task.

**Known gap, deliberately carried:** the spec's § Testing asks for a static test that the heal path "cannot emit a diff mutating a `Live-verified` row." Task 6 asserts the skill *states* the rule; it does not mechanically block the diff, because the heal path is a skill (prose an LLM executes), not a function with a diff to intercept. A true mechanical preventer would need a pre-commit or CI check on selector-map diffs. That is worth doing and is **not** in this plan — flagged rather than silently downgraded, since the spec's own thesis is that prose invariants fail under load.

**Type consistency.** `ScreenCoverageResult` is produced in Task 2 and consumed by name in Task 3's `AtlasYamlInput`. `SplitOptions.captureAllBoundaries` is spelled identically in Tasks 4 and 5. `loadSelectorMapIds` is left exported and untouched so `scripts/probe-atlas-drift.ts` keeps compiling.

**Placeholder scan.** One intentional `<fill in from Step 4>` in PR 2's body — a measured number that cannot exist until the step runs. `<n>` in `gh pr merge` is the PR number GitHub assigns.
