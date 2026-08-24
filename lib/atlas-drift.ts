// lib/atlas-drift.ts
//
// Pure helpers behind scripts/probe-atlas-drift.ts. Walks Phase 6
// ui-dump XMLs (the .xml siblings runRecipeWithDumps writes alongside
// every PNG since 0.13.229) and reports which on-device resource-ids
// the active selector map does not yet cover, and which mapped ids
// were never seen in the dumps.
//
// Why this is a library, not just a script: the diff logic is reused
// by future automations (selector-map-suggest CLI, atlas auto-update
// proposer). Keeping it pure + test-covered makes those reuses cheap.
//
// What this is NOT: an auto-updater of the selector map. Adding a new
// row is always a judgment call about whether the id is a stable
// logical anchor (an `id:` matcher) or a transient layout id worth
// matching by text instead. The harvester surfaces candidates; a
// human decides.

import * as path from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** Extract every non-empty `resource-id="..."` value from an Android
 * uiautomator dump XML. The dump format is well-defined enough that a
 * simple regex sweep is more robust than spinning up an XML parser
 * (some Android builds emit slightly non-standard escaping that DOM
 * parsers reject). */
export function extractResourceIdsFromDump(xml: string): Set<string> {
  const out = new Set<string>();
  const re = /resource-id\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const value = m[1] ?? m[2] ?? '';
    if (value) out.add(value);
  }
  return out;
}

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

/** Extract every non-empty `package="..."` value from a uiautomator dump.
 *  Which app owns the nodes on screen is the cheapest possible answer to
 *  "is this an app surface at all?" — see `isNonAppSurfaceDump`. */
export function extractPackagesFromDump(xml: string): Set<string> {
  const out = new Set<string>();
  const re = /\spackage\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const value = (m[1] ?? m[2] ?? '').trim();
    if (value) out.add(value);
  }
  return out;
}

/** Packages that are the phone's own furniture — the home screen and the
 *  system chrome drawn over every app. A recipe that dies here did not reach
 *  an unmapped APP screen; it reached NO app screen, because the app was not
 *  foregrounded (force-stopped, crashed, backgrounded by a heal).
 *
 *  Deliberately a DENYLIST of home-screen/system-chrome packages, not an
 *  allowlist of app packages: the selector map legitimately anchors rows on
 *  `com.android.camera2`, `com.android.settings`, `com.google.android.gms`
 *  and even `com.android.systemui:id/lockPassword`, so an allowlist would
 *  silence real coverage gaps on system dialogs the recipes genuinely drive.
 *
 *  dimagi-internal/ace#1571: a dump whose 33/33 nodes were
 *  `com.google.android.apps.nexuslauncher` was classified `unmapped-surface`,
 *  and the documented routing sends that to `skills/selector-map-heal` — i.e.
 *  it asked an operator to author selector rows for the Android launcher. */
const NON_APP_PACKAGE_PATTERNS: readonly RegExp[] = [
  /^com\.google\.android\.apps\.nexuslauncher$/, // Pixel launcher (the #1571 case)
  /(^|\.)launcher\d*$/, // com.android.launcher3, com.sec.android.app.launcher, …
  /^com\.android\.systemui$/, // status bar, nav bar, notification shade
  /^android$/, // bare framework dialogs (ANR, resolver)
];

export function isNonAppPackage(pkg: string): boolean {
  return NON_APP_PACKAGE_PATTERNS.some((re) => re.test(pkg));
}

/** True when the dump names at least one package and EVERY package it names
 *  is phone furniture. The "at least one" guard is load-bearing: a dump with
 *  no `package=` attributes at all (a trimmed fixture, a truncated capture)
 *  would otherwise satisfy "all packages are non-app" vacuously and get
 *  silenced. Absence of evidence is not evidence here. */
export function isNonAppSurfaceDump(xml: string): boolean {
  const packages = extractPackagesFromDump(xml);
  if (packages.size === 0) return false;
  for (const pkg of packages) {
    if (!isNonAppPackage(pkg)) return false;
  }
  return true;
}

/** Local mirror of `isPreservedArtifact` in `mcp/mobile/screenshot-dir.ts`.
 *  Duplicated rather than imported to keep `lib/` free of a dependency on
 *  `mcp/` (the arrow points the other way everywhere else); the two are
 *  pinned together by a drift test in `test/lib/atlas-drift.test.ts`. */
export function isPreservedArtifactName(name: string): boolean {
  return name.startsWith('00-') || /-FAILURE\./.test(name);
}

/** Enough of a file for the supersession arithmetic. */
export interface ArtifactFileMeta {
  path: string;
  mtimeMs: number;
}

/** Is this `*-FAILURE.xml` stale — evidence from an attempt a LATER dispatch
 *  of the same recipe has already replaced?
 *
 *  The mechanism is `mcp/mobile/screenshot-dir.ts`. Since #1130 each dispatch
 *  owns `<root>/<recipeId>/` and wipes it at start; since #1034 the wipe
 *  SPARES `00-*` ground truth and `*-FAILURE.*` forensics. So inside one
 *  recipe dir:
 *    - ordinary captures (`.png` / `.xml` that are neither `00-` nor
 *      `-FAILURE.`) can only ever come from the MOST RECENT dispatch, and
 *    - the failure forensics are written AFTER that dispatch's own captures.
 *  An ordinary capture strictly newer than the FAILURE dump therefore has
 *  exactly one explanation: a later dispatch ran and got further. That dump
 *  describes a superseded attempt and says nothing about the current map.
 *
 *  Strictly newer, not newer-or-equal: on a coarse-granularity filesystem a
 *  fast recipe can stamp its last capture and its forensics in the same tick,
 *  and treating that tie as supersession would silence real failures.
 *
 *  Why mtime and not `dispatch_id`: ace#1571 suggests comparing provenance
 *  sidecars, but `MobileClient.runRecipe` stamps sidecars over
 *  `result.screenshots` and `videos` only — `captureFailureForensics` writes
 *  `<recipeId>-FAILURE.{xml,png,txt}` with no `.meta.json` at all
 *  (`mcp/mobile/client.ts`). There is no dispatch id on a FAILURE dump to
 *  compare, so mtime is the signal that actually exists on disk. */
export function isSupersededFailureDump(
  failureDump: ArtifactFileMeta,
  siblings: readonly ArtifactFileMeta[],
): boolean {
  const dir = path.dirname(failureDump.path);
  return siblings.some((s) => {
    if (s.path === failureDump.path) return false;
    if (path.dirname(s.path) !== dir) return false;
    const name = path.basename(s.path);
    if (!/\.(png|xml)$/i.test(name)) return false;
    if (isPreservedArtifactName(name)) return false;
    return s.mtimeMs > failureDump.mtimeMs;
  });
}

/** One `*-FAILURE.xml` plus everything needed to judge whether it is worth
 *  classifying: its own contents and the other files in its directory. */
export interface FailureDumpCandidate extends ArtifactFileMeta {
  xml: string;
  siblings: readonly ArtifactFileMeta[];
}

export type FailureDumpSkipReason = 'superseded' | 'non-app-surface';

export interface FailureDumpSelection {
  selected: { path: string; superseded: boolean; nonAppSurface: boolean } | null;
  skipped: Array<{ path: string; reason: FailureDumpSkipReason }>;
}

/** Choose which FAILURE dump the machine-readable verdict should describe.
 *
 *  Newest-first is right, but only among dumps that still mean something:
 *  a superseded dump or a non-app surface must never out-rank a live failure
 *  on a real app screen, because the verdict routes a HUMAN to
 *  `skills/selector-map-heal` and a false positive costs a device session.
 *
 *  When nothing is eligible, the newest dump is still reported — flagged, so
 *  `classifyScreenCoverage` labels it `superseded` / `non-app-surface`.
 *  Reporting the real dump with an honest label beats both alternatives:
 *  inventing a verdict, and going silent with no file at all. */
export function selectFailureDumpForClassification(
  candidates: readonly FailureDumpCandidate[],
): FailureDumpSelection {
  const annotated = candidates.map((c) => ({
    path: c.path,
    mtimeMs: c.mtimeMs,
    superseded: isSupersededFailureDump(c, c.siblings),
    nonAppSurface: isNonAppSurfaceDump(c.xml),
  }));
  if (annotated.length === 0) return { selected: null, skipped: [] };

  // Path is the tiebreaker so the choice is deterministic when two dumps
  // share an mtime (coarse filesystem granularity, or a fast run).
  const newest = (list: typeof annotated) =>
    [...list].sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path)).pop() ?? null;

  const eligible = annotated.filter((a) => !a.superseded && !a.nonAppSurface);
  const selected = newest(eligible.length > 0 ? eligible : annotated)!;

  const skipped = annotated
    .filter((a) => a.path !== selected.path && (a.superseded || a.nonAppSurface))
    .map((a) => ({
      path: a.path,
      // Supersession is the stronger statement: a stale dump is irrelevant
      // whatever surface it caught.
      reason: (a.superseded ? 'superseded' : 'non-app-surface') as FailureDumpSkipReason,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    selected: {
      path: selected.path,
      superseded: selected.superseded,
      nonAppSurface: selected.nonAppSurface,
    },
    skipped,
  };
}

interface SelectorMapEntry {
  type: 'id' | 'text' | 'point';
  value: string;
}

interface SelectorMap {
  apk_version?: string;
  selectors?: Record<string, SelectorMapEntry>;
}

/** Extract every selector-map row whose `type: id` and return the set
 * of `value:` strings. These are the on-device resource-ids the map
 * currently anchors logical names against. */
export function loadSelectorMapIds(yamlText: string): Set<string> {
  const out = new Set<string>();
  let parsed: SelectorMap;
  try {
    parsed = parseYaml(yamlText) as SelectorMap;
  } catch {
    return out;
  }
  if (!parsed || !parsed.selectors) return out;
  for (const entry of Object.values(parsed.selectors)) {
    if (entry && entry.type === 'id' && typeof entry.value === 'string' && entry.value) {
      out.add(entry.value);
    }
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

/** Set-diff the observed dumps against the mapped ids. Each partition
 * is returned sorted for stable report output. */
export function diffResourceIds(
  observed: Set<string>,
  mapped: Set<string>,
): {
  onlyInDumps: string[];
  onlyInMap: string[];
  inBoth: string[];
} {
  const onlyInDumps: string[] = [];
  const onlyInMap: string[] = [];
  const inBoth: string[] = [];
  for (const id of observed) {
    if (mapped.has(id)) inBoth.push(id);
    else onlyInDumps.push(id);
  }
  for (const id of mapped) {
    if (!observed.has(id)) onlyInMap.push(id);
  }
  return {
    onlyInDumps: onlyInDumps.sort(),
    onlyInMap: onlyInMap.sort(),
    inBoth: inBoth.sort(),
  };
}

/** A `*-FAILURE.xml` dump is the ui-dump captured at a recipe failure
 * (screenshot-on-error). A resource-id present on a FAILURE screen but
 * absent from the selector map is the highest-priority drift suspect —
 * it is literally a candidate for *why a recipe failed* (the recipe
 * reached for a logical name whose mapped id no longer matches what the
 * APK renders). This predicate identifies those dumps by filename so the
 * harvester can partition observed ids by failure-vs-normal provenance. */
export function isFailureDumpFile(filePath: string): boolean {
  return /-FAILURE\.xml$/i.test(filePath);
}

/** The drift suspects worth looking at FIRST: resource-ids that showed up
 * on a failure screen but the selector map does not anchor. Returns the
 * sorted set-difference (observed-on-failure minus mapped). */
export function failureScreenDriftSuspects(
  observedOnFailure: Set<string>,
  mapped: Set<string>,
): string[] {
  const out: string[] = [];
  for (const id of observedOnFailure) {
    if (!mapped.has(id)) out.push(id);
  }
  return out.sort();
}

export interface AtlasReportInput {
  apkVersion: string;
  dumpFiles: string[];
  onlyInDumps: string[];
  onlyInMap: string[];
  inBoth: string[];
  /** Resource-ids observed specifically on `*-FAILURE.xml` screens that are
   *  not in the selector map. A subset of `onlyInDumps`, surfaced as a
   *  priority section because each one is a candidate root cause for a
   *  recipe failure in this run. Omit/empty when no failure dumps were
   *  present. */
  failureScreenCandidates?: string[];
  /** FAILURE dumps excluded from `failureScreenCandidates` because they are
   *  superseded or not app surfaces (ace#1571). Rendered as a short note so
   *  the omission is visible rather than silent. */
  excludedFailureDumps?: Array<{ file: string; reason: FailureDumpSkipReason }>;
}

/** Render the diff as a human-readable markdown report. Stable output
 * — the headings and ordering can be regex-matched by CI assertions
 * if a future iteration wires this into a per-PR comment. */
export function renderReportMarkdown(input: AtlasReportInput): string {
  const lines: string[] = [];
  lines.push('# Atlas drift report');
  lines.push('');
  lines.push(
    `Selector map: \`mcp/mobile/selectors/connect-${input.apkVersion}.yaml\``,
  );
  lines.push(`Source: ${input.dumpFiles.length} dump file(s) from the supplied run.`);
  lines.push('');

  const failureCandidates = input.failureScreenCandidates ?? [];
  if (failureCandidates.length > 0) {
    lines.push('## ⚠️ Drift suspects on FAILURE screens (review FIRST)');
    lines.push('');
    lines.push(
      'These resource-ids were seen on a `*-FAILURE.xml` screen (captured at a recipe failure) and are NOT in the selector map. Each is a candidate root cause for a failure in this run — the recipe likely reached for a logical name whose mapped `id:` no longer matches what this APK renders. Confirm against the matching `<recipe-id>-FAILURE.png` before proposing a selector-map row (close the loop to the source of truth — validate live).',
    );
    lines.push('');
    for (const id of failureCandidates) lines.push(`- \`${id}\``);
    lines.push('');
  }

  const excluded = input.excludedFailureDumps ?? [];
  if (excluded.length > 0) {
    lines.push('## FAILURE dumps excluded from the priority section');
    lines.push('');
    lines.push(
      'These `*-FAILURE.xml` dumps contributed no priority suspects (ace#1571). `superseded` = a later dispatch of the same recipe wrote captures after this dump, so it describes an attempt that has already been replaced. `non-app-surface` = every node belongs to the home screen or system chrome, so the recipe was not on an app screen at all (the app was not foregrounded) — never author a selector row for one.',
    );
    lines.push('');
    for (const e of excluded) lines.push(`- \`${e.file}\` — ${e.reason}`);
    lines.push('');
  }

  lines.push('## Resource-ids in dumps but NOT in selector map');
  if (input.onlyInDumps.length === 0) {
    lines.push('');
    lines.push('_no new resource-ids — every id seen in the dumps is already mapped._');
  } else {
    lines.push('');
    lines.push(
      'Candidates for new logical-selector rows. Review each — a stable id worth anchoring becomes a new `selectors.<logical-name>` entry; transient layout ids are usually better matched by text.',
    );
    lines.push('');
    for (const id of input.onlyInDumps) lines.push(`- \`${id}\``);
  }
  lines.push('');

  lines.push('## `id:` matchers in selector map but NOT in dumps');
  if (input.onlyInMap.length === 0) {
    lines.push('');
    lines.push('_no orphan rows — every mapped id was seen in the dumps._');
  } else {
    lines.push('');
    lines.push(
      'Possibly dead rows (the recipe paths used in this run never visited the screens they anchor) OR surface drift (the id changed in a new APK build). Confirm by running a recipe that should hit each anchor; if it does not, propose removal.',
    );
    lines.push('');
    for (const id of input.onlyInMap) lines.push(`- \`${id}\``);
  }
  lines.push('');

  lines.push('## Coverage summary');
  lines.push('');
  lines.push(`- ids seen in dumps:    ${input.onlyInDumps.length + input.inBoth.length}`);
  lines.push(`- ids in selector map:  ${input.onlyInMap.length + input.inBoth.length}`);
  lines.push(`- intersection:         ${input.inBoth.length}`);
  lines.push('');
  return lines.join('\n');
}

/** How a captured screen relates to the active selector map.
 *
 *  The distinction that matters operationally is `unmapped-surface` vs
 *  `matcher-miss`: they have OPPOSITE fixes. Unmapped means author a new
 *  anchor and probably a new palette step. Matcher-miss means the anchor
 *  exists and the recipe reached for it wrongly. jjackson/ace#811 and #893
 *  were each a confident hand-guess between these two, and each was wrong.
 *
 *  `superseded` and `non-app-surface` are the two NON-verdicts (ace#1571).
 *  Neither says anything about map coverage: the first means the dump is
 *  stale evidence a later dispatch replaced, the second means the recipe was
 *  not on an app screen at all. Both exist so the probe can stay SILENT
 *  legibly — an operator reading `non-app-surface` learns the real fact
 *  ("the app was not foregrounded"), which `unmapped-surface` actively hid. */
export type ScreenCoverage =
  | 'mapped'
  | 'drift'
  | 'unmapped-surface'
  | 'matcher-miss'
  | 'non-app-surface'
  | 'superseded';

export interface ClassifyScreenInput {
  /** A uiautomator dump — normally `<recipe-id>-FAILURE.xml`. */
  dumpXml: string;
  /** Raw text of `mcp/mobile/selectors/connect-<apk>.yaml`. */
  selectorMapYaml: string;
  /** Matcher VALUES the recipe reached for. Use `extractWantedMatchers`
   *  on the Maestro stderr excerpt. Empty is legal (a non-selector
   *  failure); classification then reports coverage only. */
  wanted: string[];
  /** True when a later dispatch of the same recipe already replaced this
   *  dump's attempt — see `isSupersededFailureDump`. Short-circuits to
   *  `superseded`. Absent/false means "this is the latest word". */
  superseded?: boolean;
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

  // Order is the contract.
  //
  // `superseded` outranks everything (ace#1571): a dump from an attempt a
  // later dispatch already replaced is not evidence about the current map at
  // all, so there is nothing to say about coverage, drift, or matchers.
  //
  // `matcher-miss` is next: if what we reached for is demonstrably on screen,
  // the map is not the problem and no amount of new anchors will help.
  //
  // Only once BOTH are ruled out does total absence of map coverage mean
  // anything — and even then it splits, because "no map coverage" on the
  // Android launcher is not a coverage gap, it is the app not being
  // foregrounded. The non-app test sits HERE rather than at the top on
  // purpose: it must refine `unmapped-surface` only, never mask a genuine
  // `matcher-miss` or `drift` on a system surface the map really does anchor
  // (`com.android.systemui:id/lockPassword` is a live row).
  let classification: ScreenCoverage;
  if (input.superseded === true) classification = 'superseded';
  else if (wantedPresent.length > 0) classification = 'matcher-miss';
  else if (mappedOnScreen.length === 0)
    classification = isNonAppSurfaceDump(input.dumpXml) ? 'non-app-surface' : 'unmapped-surface';
  else if (wantedAbsent.length > 0) classification = 'drift';
  else classification = 'mapped';

  return { classification, mappedOnScreen, wantedPresent, wantedAbsent, candidates };
}

export interface AtlasYamlInput {
  apkVersion: string;
  dumpFile: string;
  result: ScreenCoverageResult;
  /** FAILURE dumps the selection filters dropped, and why. Silence an
   *  operator cannot audit is worse than noise, so when the probe declines to
   *  classify a dump it says which one and on what grounds. Omit when empty —
   *  the key then does not appear at all. */
  skipped?: Array<{ path: string; reason: FailureDumpSkipReason }>;
}

/** Machine-readable sibling of `renderReportMarkdown`. `needs_tier2` is the
 *  gate on the expensive instrumented re-walk: ONLY an unmapped surface
 *  earns it. A matcher-miss is fixed by correcting the recipe, and drift by
 *  updating a row — neither justifies re-walking a leg with full
 *  boundary dumps, and neither do the two non-verdicts (`superseded`,
 *  `non-app-surface`), which by construction cannot equal
 *  `'unmapped-surface'` and so can never set the gate. */
export function renderReportYaml(input: AtlasYamlInput): string {
  const r = input.result;
  const skipped = input.skipped ?? [];
  return stringifyYaml({
    apk_version: input.apkVersion,
    dump_file: input.dumpFile,
    classification: r.classification,
    needs_tier2: r.classification === 'unmapped-surface',
    mapped_on_screen: r.mappedOnScreen,
    wanted_present: r.wantedPresent,
    wanted_absent: r.wantedAbsent,
    candidates: r.candidates,
    ...(skipped.length > 0
      ? { skipped: skipped.map((s) => ({ file: s.path, reason: s.reason })) }
      : {}),
  });
}

/** Recover the matcher values a Maestro run reached for, from its stderr.
 *  Three shapes:
 *   1. Maestro's own `... matching regex: <value>` lines.
 *   2. Any bare `pkg:id/name` token appearing anywhere in the excerpt.
 *   3. `Element not found: id "<value>"` / `Element not found: text
 *      "<value>"` — the shape Maestro ACTUALLY emits for a failed
 *      `assertVisible`/`tapOn` on this repo's own APK (see
 *      test/lib/maestro-failure-class.test.ts and
 *      test/lib/no-invite-detector.test.ts for real captured strings).
 *      Neither of the first two patterns matches this shape: there is no
 *      "matching regex:" line, and a quoted text value like `"Start
 *      Learning"` is not a `pkg:id/name` token. Missing this pattern
 *      meant a text-matcher failure (e.g. the #893 differentiator
 *      `deliver-home-daily-visits`, a `type: text` row) always yielded
 *      `wanted: []`, making `matcher-miss` structurally unreachable for
 *      it and misrouting straight to `unmapped-surface`. */
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
  const quotedIdOrText = /\b(?:id|text)\s+"([^"]+)"/gi;
  while ((m = quotedIdOrText.exec(stderrExcerpt)) !== null) {
    const v = (m[1] ?? '').trim();
    if (v) out.add(v);
  }
  return [...out].sort();
}

/** ACE reports fork parameters; it never forks itself. Forking copies
 *  artifacts into a new run, which is the operator's decision.
 *
 *  Emits parameter labels and values (not a command line) because the
 *  operator-facing invocation syntax is undocumented. The skill's body
 *  fields are specified in skills/fork-run/SKILL.md; this function names
 *  those fields exactly so the operator can dispatch fork-run with known
 *  correctness.
 *
 *  Uses fork_at_skill (not fork_at_phase) because a heal is always resuming
 *  from a specific blocked skill — re-running that skill + everything after it
 *  validates the healed selector. Choosing fork_at_phase would re-run a whole
 *  phase unnecessarily. */
export function renderForkInvocation(input: {
  oppSlug: string;
  sourceRunId: string;
  forkAtSkill: string;
}): string {
  const feedback = `Selector map healed; re-walk from ${input.forkAtSkill} to verify the fix`;
  return [
    `Fork from here — skill \`fork-run\` (see skills/fork-run/SKILL.md):`,
    `  opp_slug:      ${input.oppSlug}`,
    `  source_run_id: ${input.sourceRunId}`,
    `  fork_at_skill: ${input.forkAtSkill}`,
    `  feedback:      "${feedback}"`,
  ].join('\n');
}
