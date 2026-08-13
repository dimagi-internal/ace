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

- [ ] **Step 5: Fix the probe's default APK, which is wrong three ways**

`scripts/probe-atlas-drift.ts` sets `DEFAULT_APK = '2.63.0'`, its doc comment
claims `2.62.0`, and `.env.tpl:210` pins `ACE_CONNECT_APK_VERSION=2.63.2`. So
the probe compares dumps against the wrong selector map by default and would
mis-report coverage before this feature ever ran. Read the pin instead of
hardcoding:

```ts
const DEFAULT_APK = process.env.ACE_CONNECT_APK_VERSION || '2.63.2';
```

Update the doc comment above `--apk` to say so rather than naming a version
that will drift again.

- [ ] **Step 6: Wire the probe to write the yaml**

Add `--yaml-out <path>` to `CliArgs` and `parseArgs` in
`scripts/probe-atlas-drift.ts`, alongside the existing `--out`:

```ts
} else if (a === '--yaml-out') {
  yamlOutPath = argv[++i] ?? null;
  if (!yamlOutPath) throw new Error('--yaml-out requires a path');
}
```

Then, after the markdown report is written, add:

```ts
if (args.yamlOutPath) {
  const failureDumps = dumpFiles.filter((f) => isFailureDumpFile(f));
  if (failureDumps.length === 0) {
    process.stderr.write('no *-FAILURE.xml under the dump dir; skipping yaml report\n');
  } else {
    // The newest failure dump is the one that stopped the walk.
    const dumpPath = failureDumps.sort()[failureDumps.length - 1];
    const stderrPath = dumpPath.replace(/\.xml$/, '.txt');
    const stderrExcerpt = fs.existsSync(stderrPath)
      ? fs.readFileSync(stderrPath, 'utf8')
      : '';
    const result = classifyScreenCoverage({
      dumpXml: fs.readFileSync(dumpPath, 'utf8'),
      selectorMapYaml: fs.readFileSync(selectorPath, 'utf8'),
      wanted: extractWantedMatchers(stderrExcerpt),
    });
    fs.writeFileSync(
      args.yamlOutPath,
      renderReportYaml({
        apkVersion: args.apkVersion,
        dumpFile: path.basename(dumpPath),
        result,
      }),
      'utf8',
    );
    // Print it too: a caller that never opens the file still sees the verdict.
    process.stdout.write(
      `atlas: ${result.classification} on ${path.basename(dumpPath)}` +
        (result.classification === 'unmapped-surface' ? ' — tier 2 warranted\n' : '\n'),
    );
  }
}
```

Add `classifyScreenCoverage`, `extractWantedMatchers`, and `renderReportYaml`
to the existing import from `../lib/atlas-drift.js`.

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

In `mcp/mobile/recipe-splitter.ts`, add the options parameter and the
`runFlow` boundary rule. The existing loop already identifies top-level steps
with `topLevelStepRe = /^-\s+/` and only ever splits *between* them, so nested
`takeScreenshot` inside `commands:` is already invisible to it — the same
property makes nested `runFlow` invisible for free. Add:

```ts
export interface SplitOptions {
  /** Open a dump window at every top-level `runFlow` boundary, not just at
   *  top-level `takeScreenshot`. EXPENSIVE — one extra `maestro test`
   *  invocation per window. Default false; only a tier-1 `unmapped-surface`
   *  classification justifies turning it on. */
  captureAllBoundaries?: boolean;
}

const topLevelRunFlowRe = /^-\s+runFlow:/;
```

Change the signature to
`export function splitRecipeAtScreenshots(body: string, opts: SplitOptions = {}): RecipeChunk[]`
and, inside the loop's `if (isTopLevelStep)` branch, replace the existing
split-decision with:

```ts
    if (isTopLevelStep) {
      const startsRunFlow = topLevelRunFlowRe.test(line);
      // Split BEFORE a runFlow (the `-pre` window) and AFTER the previous
      // step if it was a runFlow (the `-post` window). A takeScreenshot
      // split still wins its own name.
      if (pendingScreenshotName !== undefined) {
        finalize();
      } else if (opts.captureAllBoundaries && (startsRunFlow || pendingRunFlowClose)) {
        pendingScreenshotName = pendingRunFlowClose
          ? `branch${runFlowIndex - 1}-post`
          : `branch${runFlowIndex}-pre`;
        finalize();
      }
      if (startsRunFlow) {
        pendingRunFlowClose = true;
        runFlowIndex++;
      } else {
        pendingRunFlowClose = false;
      }
      inTopLevelStep = true;

      const match = line.match(takeScreenshotRe);
      if (match) {
        pendingScreenshotName = match[1] ?? match[2] ?? match[3];
      }
    }
```

declaring alongside the other loop state:

```ts
  let pendingRunFlowClose = false;
  let runFlowIndex = 0;
```

The caller prefixes the recipe id, so `branch0-pre` becomes
`<recipe-id>-branch0-pre.xml` on disk — matching the naming the tests assert.
If the resulting counts differ from 13/13, adjust the boundary rule to match
the measured table in the spec rather than editing the test to match the code:
the table was computed from the real palette, and the test is the contract.

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

Add to the recipe-run options interface in `mcp/mobile/types.ts`:

```ts
  /** Tier 2 of the mapping ladder: open a dump window at every top-level
   *  `runFlow` boundary. Costs one extra `maestro test` invocation per
   *  window. Default false. Turn on only after an atlas-report.yaml says
   *  `classification: unmapped-surface`. */
  captureAllBoundaries?: boolean;
```

In `mcp/mobile/backends/maestro.ts:93`, forward it:

```ts
    if (opts.serial) {
      return this.runRecipeWithDumps(recipePath, envVars, screenshotDir, opts as {
        adbPort?: number;
        serial: string;
        captureAllBoundaries?: boolean;
      });
    }
```

and inside `runRecipeWithDumps`, change the split call:

```ts
    const chunks = splitRecipeAtScreenshots(body, {
      captureAllBoundaries: opts.captureAllBoundaries === true,
    });
```

The `=== true` is deliberate: an `undefined` or a truthy-but-not-true value
must never turn the expensive mode on. In `mcp/mobile/client.ts`, pass the
caller's flag through to the backend at the `mobile_run_recipe` entry point.

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

Task 6 lands before Task 7 deliberately: build the fence before you let the
thing into the field.

### Task 6: The mechanical `Live-verified` guard

The spec asks that the heal path *cannot* mutate a row carrying a
`Live-verified` note. A skill-prose assertion is not that — and "prose
invariants fail under load" is this spec's own thesis, so the plan must not
fall to it. A diff is a diff: this check does not care whether an LLM, a human,
or a subagent produced it. There are 34 `Live-verified` rows across the two
live maps today.

**Files:**
- Create: `lib/selector-map-guard.ts`
- Create: `scripts/check-selector-map-diff.ts`
- Modify: `scripts/hooks/pre-commit`
- Test: `test/lib/selector-map-guard.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (deliberately standalone).
- Produces: `isLiveVerified(row: SelectorRow | undefined): boolean`;
  `findLiveVerifiedViolations(oldYaml: string, newYaml: string): LiveVerifiedViolation[]`.
  Task 7's skill cites this check by name as the thing that enforces its Guard 1.

- [ ] **Step 1: Write the failing tests**

Create `test/lib/selector-map-guard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { findLiveVerifiedViolations } from '../../lib/selector-map-guard.js';

const base = `
apk_version: "2.63.2"
selectors:
  deliver-home-daily-visits:
    type: text
    value: "Daily Visits"
    purpose: "THE differentiator (#893). Live-verified 2026-07-30."
  unverified-row:
    type: id
    value: "org.commcare.dalvik:id/guess"
    purpose: "Transcribed from 2.62.0; not yet confirmed."
`;

describe('findLiveVerifiedViolations', () => {
  it('flags a mutated value on a Live-verified row', () => {
    const after = base.replace('"Daily Visits"', '"Daily visits"');
    const v = findLiveVerifiedViolations(base, after);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      selector: 'deliver-home-daily-visits',
      kind: 'mutated',
      field: 'value',
      before: 'Daily Visits',
      after: 'Daily visits',
    });
  });

  it('flags a deleted Live-verified row', () => {
    const after = `
apk_version: "2.63.2"
selectors:
  unverified-row:
    type: id
    value: "org.commcare.dalvik:id/guess"
    purpose: "Transcribed from 2.62.0; not yet confirmed."
`;
    const v = findLiveVerifiedViolations(base, after);
    expect(v).toEqual([{ selector: 'deliver-home-daily-visits', kind: 'deleted' }]);
  });

  it('ALLOWS editing the purpose prose of a Live-verified row', () => {
    // Load-bearing: connect-2.63.2.yaml:483 currently carries stale prose
    // that must stay fixable. Only `type` and `value` are frozen.
    const after = base.replace('Live-verified 2026-07-30.', 'Live-verified 2026-07-30. See #863.');
    expect(findLiveVerifiedViolations(base, after)).toEqual([]);
  });

  it('ALLOWS adding a new row, and mutating an unverified one', () => {
    const withNew = base + `  brand-new:\n    type: id\n    value: "x"\n`;
    expect(findLiveVerifiedViolations(base, withNew)).toEqual([]);
    const mutatedUnverified = base.replace('org.commcare.dalvik:id/guess', 'org.commcare.dalvik:id/better');
    expect(findLiveVerifiedViolations(base, mutatedUnverified)).toEqual([]);
  });

  it('returns [] rather than throwing on unparseable yaml', () => {
    expect(findLiveVerifiedViolations(base, ':::not yaml:::')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/selector-map-guard.test.ts`
Expected: FAIL — cannot resolve `../../lib/selector-map-guard.js`.

- [ ] **Step 3: Implement**

Create `lib/selector-map-guard.ts`:

```ts
import { parse as parseYaml } from 'yaml';

export interface SelectorRow {
  type?: string;
  value?: string;
  purpose?: string;
}

interface SelectorMapDoc {
  apk_version?: string;
  selectors?: Record<string, SelectorRow>;
}

export interface LiveVerifiedViolation {
  selector: string;
  kind: 'mutated' | 'deleted';
  field?: 'type' | 'value';
  before?: string;
  after?: string;
}

const LIVE_VERIFIED = /live-verified/i;

export function isLiveVerified(row: SelectorRow | undefined): boolean {
  return !!row && typeof row.purpose === 'string' && LIVE_VERIFIED.test(row.purpose);
}

/** A row whose `purpose` records a live-device verification is EVIDENCE, not
 *  an opinion — someone stood in front of a device and looked. Overwriting it
 *  with a fresh guess is the exact failure class jjackson/ace#893 documents:
 *  `viewJobCard`'s "absent in Learn" claim was asserted, never observed, and
 *  survived for months because nothing stopped it being written.
 *
 *  Frozen: `type` and `value` (what it matches, and how).
 *  Free: `purpose` (the prose) — documentation must stay improvable, and
 *  connect-2.63.2.yaml:483 currently carries stale prose that needs fixing.
 *  Deleting the row entirely counts as a mutation. */
export function findLiveVerifiedViolations(
  oldYaml: string,
  newYaml: string,
): LiveVerifiedViolation[] {
  // Track parse failure separately from "parsed to no selectors". Conflating
  // them makes an unparseable NEW map look like every Live-verified row was
  // deleted — a false accusation the committer cannot act on. A broken map is
  // a real problem, but it is not evidence of a mutation, and this guard only
  // speaks to mutations. `npm test` catches the malformed map elsewhere.
  // A try/catch alone is NOT enough: `yaml.parse(':::not yaml:::')` does not
  // throw, it returns a string. Without the shape check below, `selectors`
  // reads as undefined and every Live-verified row looks deleted. Verified by
  // executing this function — the try/catch version reported a false deletion.
  const rows = (text: string): { ok: boolean; rows: Record<string, SelectorRow> } => {
    let doc: unknown;
    try {
      doc = parseYaml(text);
    } catch {
      return { ok: false, rows: {} };
    }
    if (!doc || typeof doc !== 'object') return { ok: false, rows: {} };
    const selectors = (doc as SelectorMapDoc).selectors;
    if (!selectors || typeof selectors !== 'object') return { ok: false, rows: {} };
    return { ok: true, rows: selectors };
  };
  const beforeParse = rows(oldYaml);
  const afterParse = rows(newYaml);
  if (!beforeParse.ok || !afterParse.ok) return [];
  const before = beforeParse.rows;
  const after = afterParse.rows;
  const out: LiveVerifiedViolation[] = [];

  for (const [name, oldRow] of Object.entries(before)) {
    if (!isLiveVerified(oldRow)) continue;
    const newRow = after[name];
    if (!newRow) {
      out.push({ selector: name, kind: 'deleted' });
      continue;
    }
    for (const field of ['type', 'value'] as const) {
      if (oldRow[field] !== newRow[field]) {
        out.push({
          selector: name,
          kind: 'mutated',
          field,
          before: oldRow[field],
          after: newRow[field],
        });
      }
    }
  }
  return out.sort((a, b) => a.selector.localeCompare(b.selector));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/lib/selector-map-guard.test.ts`
Expected: PASS, all five.

- [ ] **Step 5: Add the CLI that runs it against a real diff**

Create `scripts/check-selector-map-diff.ts`:

```ts
#!/usr/bin/env npx tsx
/** Fail if a commit mutates or deletes a `Live-verified` selector row.
 *  Usage: check-selector-map-diff.ts [--staged | --base <ref>] */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { findLiveVerifiedViolations } from '../lib/selector-map-guard.js';

const argv = process.argv.slice(2);
const staged = argv.includes('--staged');
const base = staged ? 'HEAD' : (argv[argv.indexOf('--base') + 1] ?? 'origin/main');

const git = (args: string[]): string =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

const changed = git(['diff', '--name-only', staged ? '--cached' : base])
  .split('\n')
  .filter((p) => /^mcp\/mobile\/selectors\/.*\.yaml$/.test(p));

let failed = false;
for (const file of changed) {
  let oldText = '';
  try {
    oldText = git(['show', `${base}:${file}`]);
  } catch {
    continue; // new file — nothing to protect yet
  }
  const newText = staged ? git(['show', `:${file}`]) : fs.readFileSync(file, 'utf8');
  for (const v of findLiveVerifiedViolations(oldText, newText)) {
    failed = true;
    const detail =
      v.kind === 'deleted'
        ? 'row deleted'
        : `${v.field}: ${JSON.stringify(v.before)} -> ${JSON.stringify(v.after)}`;
    process.stderr.write(`${file}: Live-verified row '${v.selector}' ${detail}\n`);
  }
}

if (failed) {
  process.stderr.write(
    '\nA Live-verified row records a live-device observation. Re-verify on a ' +
      'device and update the purpose note in the same commit, or add a NEW row ' +
      'instead of overwriting this one. See jjackson/ace#893.\n',
  );
  process.exit(1);
}
```

- [ ] **Step 6: Wire it into the pre-commit hook**

Append to `scripts/hooks/pre-commit`, after the existing VERSION block:

```bash
if git diff --cached --name-only | grep -qE '^mcp/mobile/selectors/.*\.yaml$'; then
  npx tsx "$(git rev-parse --show-toplevel)/scripts/check-selector-map-diff.ts" --staged
fi
```

- [ ] **Step 7: Prove the hook actually blocks**

```bash
sed -i '' 's/value: "Daily Visits"/value: "Daily visits"/' mcp/mobile/selectors/connect-2.63.2.yaml
git add mcp/mobile/selectors/connect-2.63.2.yaml
git commit -m "should be rejected"   # expect: exit 1, names deliver-home-daily-visits
git restore --staged mcp/mobile/selectors/connect-2.63.2.yaml
git checkout -- mcp/mobile/selectors/connect-2.63.2.yaml
```

Expected: the commit is refused and the message names the row. A guard nobody has seen fire is a guard nobody knows works.

- [ ] **Step 8: Commit**

```bash
git add lib/selector-map-guard.ts scripts/check-selector-map-diff.ts \
        scripts/hooks/pre-commit test/lib/selector-map-guard.test.ts
git commit -m "feat(mobile): mechanically forbid overwriting a Live-verified selector row

A row whose purpose records a live-device observation is evidence.
#893's viewJobCard claim was asserted, never observed, and survived
months because nothing stopped it being written."
```

---

### Task 7: `selector-map-heal`

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

  it('forbids mutating a Live-verified row AND names its mechanical enforcer', () => {
    const body = readFileSync(P, 'utf8');
    expect(body).toMatch(/Live-verified/);
    expect(body).toMatch(/additive|never mutate|only add/i);
    // Guard 1 is enforced by Task 6's pre-commit check, not by this prose.
    // If the skill stops naming it, an implementer may believe the rule is
    // advisory — which is how it got written as advisory the first time.
    expect(body).toMatch(/check-selector-map-diff/);
  });

  it('branches correctly on matcher-miss — the #811/#893 inversion', () => {
    const body = readFileSync(P, 'utf8');
    expect(body).toMatch(/matcher-miss/);
    // Must tell the implementer to STOP, not to author a new anchor.
    expect(body).toMatch(/matcher-miss[\s\S]{0,400}?(STOP|do NOT add|Fix the recipe)/i);
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

Create `skills/selector-map-heal/SKILL.md`:

````markdown
---
name: selector-map-heal
description: >
  Repair the mobile selector map from a live failure dump when a Phase 6 walk
  hits a surface the map has never covered. Triggered by an atlas-report.yaml
  carrying `classification: unmapped-surface`. Proposes NEW selector rows from
  the dump, proves them by re-running the blocked leg on-device, and ships them
  only on green. Narrow sibling of selector-map-calibrate, which stays manual.
---

# Selector-Map Heal

## When to run — and when to stop

Read `atlas-report.yaml` from the run folder and branch on `classification`:

| classification | action |
|---|---|
| `unmapped-surface` | **Run this skill.** The map has no anchor on that screen. |
| `matcher-miss` | **STOP.** The element IS on screen; the recipe reached for it wrongly. Fix the recipe. Do NOT add a selector row. |
| `drift` | **STOP.** An anchor moved. Update the existing row via `selector-map-calibrate`. |
| `mapped` | **STOP.** Nothing to heal; the failure is elsewhere. |

Adding a row on a `matcher-miss` is the inversion that produced
jjackson/ace#811 and #893 — both shipped a new anchor for a screen whose
anchors were fine.

## Guard 1 — additive only

You may ADD rows. You may **never mutate a row carrying a `Live-verified`
note** — that row records a live-device observation, and overwriting evidence
with a fresh guess is the #893 failure class.

This is enforced mechanically, not on trust: `scripts/check-selector-map-diff.ts`
runs in the pre-commit hook and rejects the commit. Do not try to route around
it — if you believe a `Live-verified` row is genuinely wrong, re-verify on a
device and update its purpose note in the same commit.

## Guard 2 — green or nothing

Propose rows from the dump, apply them, then **re-run the blocked leg
on-device**.

- Green ⇒ open a PR and arm auto-merge (`gh pr merge <n> --auto --merge`).
- Red after 2 attempts ⇒ **stop and file** an issue with the dump attached.

Never ship an unproven row. Shipping a plausible guess is precisely the class
this skill exists to end, and a red re-run is the only thing that can tell you
your guess was one.

## Guard 3 — never cold-boot over a human's emulator

`mobile_ensure_avd_running` kills and wipes the running emulator. Confirm
before cold-booting over an AVD someone may be driving by hand.

## Provenance

Every new row's `purpose` string names the dump file and the run it came from,
so the next reader checks provenance instead of trusting the note. A row that
cannot say where it came from is a guess wearing a citation.

## Why auto-merge is legitimate here

ACE's standing rule is that selector and recipe changes are validated on a live
device before merge. Here the green re-run in Guard 2 **is** that validation,
performed immediately before the merge. This is the one path where self-heal
and the live-validation rule agree rather than conflict — which is exactly why
the loop closes here and nowhere else.
````

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

### Task 8: Report the fork point

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

**Spec coverage.** Tier 0 — no task, correctly (already ships). Tier 1 — Tasks 1-3. Tier 2 — Tasks 4-5, including the measurement the spec's circuit breaker requires. Tier 3 — Tasks 6-7. Tier 4 — Task 8. Deferred CCZ work correctly has no task.

**The `Live-verified` invariant is now mechanical, not prose.** An earlier draft
of this plan carried it as a known gap, reasoning that the heal path is a skill
rather than a function and therefore had no diff to intercept. That was wrong: a
commit has a diff regardless of who authored it. Task 6 makes the invariant a
pure function (`findLiveVerifiedViolations`) with five unit tests, a CLI, and a
pre-commit hook — and Step 7 requires *watching it reject a real commit*, because
a guard nobody has seen fire is a guard nobody knows works. It protects the 34
`Live-verified` rows in the live maps against humans and agents alike, which is
strictly more than the spec asked for. The plan no longer falls to the thesis it
argues from.

**Deliberate scope boundary:** the guard freezes `type` and `value` but leaves
`purpose` editable. Freezing the prose would make
`connect-2.63.2.yaml:483`'s stale note — which claims a validated Deliver anchor
"still needs a live dump," thirteen lines above the one that shipped —
permanently unfixable. Documentation must stay improvable; evidence must not be
overwritten. Task 6's third test pins that distinction.

**Two live bugs found while writing this plan, both fixed inside it:**
`loadSelectorMapIds` is blind to `type: text` rows, so it cannot see the #893
differentiator (Task 1); and `probe-atlas-drift.ts` hardcodes
`DEFAULT_APK = '2.63.0'` while `.env.tpl:210` pins `2.63.2` and its own doc
comment says `2.62.0` — three values, so the probe compares against the wrong
map by default (Task 3, Step 5).

**Type consistency.** `ScreenCoverageResult` is produced in Task 2 and consumed by name in Task 3's `AtlasYamlInput`. `SplitOptions.captureAllBoundaries` is spelled identically in Tasks 4 and 5, and read with `=== true` at the one place that matters. `loadSelectorMapIds` is left exported and untouched so `scripts/probe-atlas-drift.ts` keeps compiling. `SelectorRow` in Task 6 is intentionally independent of `SelectorMatchers` in Task 1 — the guard must parse maps that the classifier would reject, so coupling them would make a malformed map silently unguarded.

**Placeholder scan.** One intentional `<fill in from Step 4>` in PR 2's body — a measured number that cannot exist until the step runs. `<n>` in `gh pr merge` is the PR number GitHub assigns. No step describes code without showing it.
