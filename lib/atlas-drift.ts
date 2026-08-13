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

import { parse as parseYaml } from 'yaml';

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
