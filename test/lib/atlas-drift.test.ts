import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  extractResourceIdsFromDump,
  loadSelectorMapIds,
  diffResourceIds,
  renderReportMarkdown,
  isFailureDumpFile,
  failureScreenDriftSuspects,
  extractTextValuesFromDump,
  loadSelectorMapMatchers,
  classifyScreenCoverage,
  extractWantedMatchers,
  renderReportYaml,
} from '../../lib/atlas-drift.js';

// Pure helpers behind the atlas-drift harvester (scripts/probe-atlas-
// drift.ts). The harvester walks a Phase 6 run's ui-dump XMLs and
// reports which on-device resource-ids are missing from the active
// selector map (potential new logical selectors to add), and which
// `id:` matchers in the map were not seen in the dumps (potentially
// dead or out-of-coverage rows).

describe('extractResourceIdsFromDump', () => {
  it('extracts every resource-id attribute from a uiautomator dump', () => {
    const xml = `
      <hierarchy rotation="0">
        <node resource-id="org.commcare.dalvik:id/btn_start" class="android.widget.Button">
          <node resource-id="org.commcare.dalvik:id/btn_label" />
        </node>
        <node resource-id="" class="android.widget.FrameLayout">
          <node resource-id="org.commcare.dalvik:id/screen_suite_menu_list" />
        </node>
      </hierarchy>
    `;
    const ids = extractResourceIdsFromDump(xml);
    expect(ids.has('org.commcare.dalvik:id/btn_start')).toBe(true);
    expect(ids.has('org.commcare.dalvik:id/btn_label')).toBe(true);
    expect(ids.has('org.commcare.dalvik:id/screen_suite_menu_list')).toBe(true);
    expect(ids.size).toBe(3);
  });

  it('skips empty resource-id attributes (the empty-string case is common in Android)', () => {
    const xml = `<node resource-id="" /><node resource-id="x:id/y" /><node resource-id="" />`;
    const ids = extractResourceIdsFromDump(xml);
    expect(ids.has('x:id/y')).toBe(true);
    expect(ids.has('')).toBe(false);
    expect(ids.size).toBe(1);
  });

  it('handles single and double quotes in attribute values', () => {
    const xml = `<node resource-id='org.commcare.dalvik:id/a' /><node resource-id="org.commcare.dalvik:id/b" />`;
    const ids = extractResourceIdsFromDump(xml);
    expect(ids.has('org.commcare.dalvik:id/a')).toBe(true);
    expect(ids.has('org.commcare.dalvik:id/b')).toBe(true);
  });

  it('returns an empty set for malformed or empty input rather than throwing', () => {
    expect(extractResourceIdsFromDump('').size).toBe(0);
    expect(extractResourceIdsFromDump('not xml').size).toBe(0);
  });
});

describe('loadSelectorMapIds', () => {
  it('extracts every `id:` matcher value from a selector map YAML', () => {
    const yaml = `
apk_version: "2.62.0"
selectors:
  nav-drawer-sign-in:
    type: id
    value: "org.commcare.dalvik:id/nav_drawer_sign_in_button"
  opp-tile-by-name:
    type: text
    value: "View Opportunity"
  form-nav-next:
    type: id
    value: "org.commcare.dalvik:id/nav_btn_next"
`;
    const ids = loadSelectorMapIds(yaml);
    expect(ids.has('org.commcare.dalvik:id/nav_drawer_sign_in_button')).toBe(true);
    expect(ids.has('org.commcare.dalvik:id/nav_btn_next')).toBe(true);
    // text matchers are not ids — must be excluded.
    expect(ids.has('View Opportunity')).toBe(false);
    expect(ids.size).toBe(2);
  });

  it('returns an empty set when the selectors block is absent', () => {
    expect(loadSelectorMapIds('apk_version: "1.0"').size).toBe(0);
  });
});

describe('diffResourceIds', () => {
  it('partitions ids into onlyInDumps / onlyInMap / inBoth', () => {
    const observed = new Set(['x:id/a', 'x:id/b', 'x:id/c']);
    const mapped = new Set(['x:id/b', 'x:id/c', 'x:id/d']);
    const diff = diffResourceIds(observed, mapped);
    expect(diff.onlyInDumps).toEqual(['x:id/a']);
    expect(diff.onlyInMap).toEqual(['x:id/d']);
    expect(diff.inBoth.sort()).toEqual(['x:id/b', 'x:id/c']);
  });

  it('sorts each partition for stable report output', () => {
    const observed = new Set(['x:id/c', 'x:id/a', 'x:id/b']);
    const mapped = new Set<string>();
    const diff = diffResourceIds(observed, mapped);
    expect(diff.onlyInDumps).toEqual(['x:id/a', 'x:id/b', 'x:id/c']);
  });
});

describe('isFailureDumpFile', () => {
  it('recognizes `*-FAILURE.xml` dumps (case-insensitive) and ignores normal dumps', () => {
    expect(isFailureDumpFile('j1/connect-claim-opp-FAILURE.xml')).toBe(true);
    expect(isFailureDumpFile('/abs/path/learn-walk-FAILURE.XML')).toBe(true);
    expect(isFailureDumpFile('j1/step-3.xml')).toBe(false);
    expect(isFailureDumpFile('j1/FAILURE-but-not-suffix.xml.bak')).toBe(false);
  });
});

describe('failureScreenDriftSuspects', () => {
  it('returns sorted ids seen on failure screens that are NOT in the map', () => {
    const observedOnFailure = new Set(['x:id/c', 'x:id/a', 'x:id/mapped']);
    const mapped = new Set(['x:id/mapped']);
    expect(failureScreenDriftSuspects(observedOnFailure, mapped)).toEqual(['x:id/a', 'x:id/c']);
  });

  it('returns empty when every failure-screen id is already mapped', () => {
    const observedOnFailure = new Set(['x:id/a']);
    expect(failureScreenDriftSuspects(observedOnFailure, new Set(['x:id/a']))).toEqual([]);
  });
});

describe('renderReportMarkdown', () => {
  it('surfaces a priority FAILURE-screen section when failureScreenCandidates is non-empty', () => {
    const md = renderReportMarkdown({
      apkVersion: '2.63.0',
      dumpFiles: ['j1/claim-FAILURE.xml'],
      onlyInDumps: ['org.commcare.dalvik:id/btn_moved', 'org.commcare.dalvik:id/btn_other'],
      onlyInMap: [],
      inBoth: [],
      failureScreenCandidates: ['org.commcare.dalvik:id/btn_moved'],
    });
    expect(md).toContain('Drift suspects on FAILURE screens');
    expect(md).toMatch(/review FIRST/i);
    expect(md).toContain('org.commcare.dalvik:id/btn_moved');
  });

  it('omits the FAILURE-screen section entirely when there are no failure candidates', () => {
    const md = renderReportMarkdown({
      apkVersion: '2.63.0',
      dumpFiles: ['j1/step-1.xml'],
      onlyInDumps: ['x:id/a'],
      onlyInMap: [],
      inBoth: [],
    });
    expect(md).not.toContain('Drift suspects on FAILURE screens');
  });

  it('produces a markdown report with both sections + the active APK header', () => {
    const md = renderReportMarkdown({
      apkVersion: '2.62.0',
      dumpFiles: ['j1/step-1.xml', 'j1/step-2.xml'],
      onlyInDumps: ['org.commcare.dalvik:id/btn_new_thing'],
      onlyInMap: ['org.commcare.dalvik:id/legacy_drawer'],
      inBoth: ['org.commcare.dalvik:id/nav_btn_next'],
    });
    expect(md).toContain('# Atlas drift report');
    expect(md).toContain('connect-2.62.0.yaml');
    expect(md).toContain('## Resource-ids in dumps but NOT in selector map');
    expect(md).toContain('org.commcare.dalvik:id/btn_new_thing');
    expect(md).toContain('## `id:` matchers in selector map but NOT in dumps');
    expect(md).toContain('org.commcare.dalvik:id/legacy_drawer');
    expect(md).toMatch(/2 dump file/);
  });

  it('renders an empty-state message when there is no drift', () => {
    const md = renderReportMarkdown({
      apkVersion: '2.62.0',
      dumpFiles: ['j1/a.xml'],
      onlyInDumps: [],
      onlyInMap: [],
      inBoth: ['x:id/y'],
    });
    expect(md).toMatch(/no new resource-ids/i);
    expect(md).toMatch(/no orphan/i);
  });
});

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

  it('matcher-miss outranks unmapped-surface when both conditions hold', () => {
    // The wanted element IS on screen but NOT in the selector map.
    // This yields wantedPresent: [thatId] AND mappedOnScreen: [] simultaneously.
    // matcher-miss must win because the map is not the problem — the recipe reached
    // for an unmapped element that actually exists.
    const r = classifyScreenCoverage({
      dumpXml: dump('<node resource-id="org.commcare.dalvik:id/unmapped_element" text="x" />'),
      selectorMapYaml: MAP,
      wanted: ['org.commcare.dalvik:id/unmapped_element'],
    });
    expect(r.classification).toBe('matcher-miss');
    expect(r.wantedPresent).toEqual(['org.commcare.dalvik:id/unmapped_element']);
    expect(r.mappedOnScreen).toEqual([]);
  });

  it('matcher-miss outranks drift when both conditions hold', () => {
    // The dump contains a mapped anchor plus one wanted matcher, with a SECOND
    // wanted matcher absent. This yields wantedPresent: [present], wantedAbsent: [absent],
    // and non-empty mappedOnScreen. matcher-miss must win.
    const r = classifyScreenCoverage({
      dumpXml: dump(
        '<node resource-id="org.commcare.dalvik:id/viewJobCard" text="x" />' +
          '<node resource-id="org.commcare.dalvik:id/nsv_home_screen" text="y" />',
      ),
      selectorMapYaml: MAP,
      wanted: ['org.commcare.dalvik:id/viewJobCard', 'org.commcare.dalvik:id/other_missing'],
    });
    expect(r.classification).toBe('matcher-miss');
    expect(r.wantedPresent).toEqual(['org.commcare.dalvik:id/viewJobCard']);
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

  it('the full chain reports matcher-miss when the stderr excerpt names an element that IS on screen (regression: PR3 review round 1 — matcher-miss was unreachable because nothing ever wrote the stderr excerpt the classifier needs)', () => {
    // A dump where the element the recipe reached for genuinely is present.
    const dumpXml = `<?xml version='1.0'?><hierarchy>
      <node resource-id="org.commcare.dalvik:id/viewJobCard" text="Household Poverty Targeting" />
    </hierarchy>`;
    const selectorMapYaml = `
apk_version: "2.63.2"
selectors:
  deliver-home-job-card:
    type: id
    value: "org.commcare.dalvik:id/viewJobCard"
`;
    // The shape a real `<recipeId>-FAILURE.txt` carries (Maestro's own
    // "matching regex: <value>" line) once the producer (captureFailureForensics
    // in mcp/mobile/client.ts) writes it next to the dump.
    const stderrExcerpt =
      'Element not found: Id matching regex: org.commcare.dalvik:id/viewJobCard';

    const wanted = extractWantedMatchers(stderrExcerpt);
    const result = classifyScreenCoverage({ dumpXml, selectorMapYaml, wanted });
    const text = renderReportYaml({
      apkVersion: '2.63.2',
      dumpFile: 'connect-claim-opp-FAILURE.xml',
      result,
    });
    const parsed = parseYaml(text) as { classification: string; needs_tier2: boolean };

    expect(result.classification).toBe('matcher-miss');
    expect(parsed.classification).toBe('matcher-miss');
    expect(parsed.needs_tier2).toBe(false);
  });
});
