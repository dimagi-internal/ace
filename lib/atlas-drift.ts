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

export interface AtlasReportInput {
  apkVersion: string;
  dumpFiles: string[];
  onlyInDumps: string[];
  onlyInMap: string[];
  inBoth: string[];
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
