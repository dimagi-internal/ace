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
  renderForkInvocation,
  extractPackagesFromDump,
  isNonAppSurfaceDump,
  isSupersededFailureDump,
  isPreservedArtifactName,
  selectFailureDumpForClassification,
} from '../../lib/atlas-drift.js';
import { classifyMaestroFailure } from '../../lib/maestro-failure-class.js';
import { isPreservedArtifact } from '../../mcp/mobile/screenshot-dir.js';

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

  // These are the ACTUAL strings this repo's own Maestro runs produce —
  // not a paraphrase. Neither the "matching regex:" pattern nor the bare
  // `pkg:id/name` pattern above matches either shape, so before this
  // pattern was added, extractWantedMatchers returned [] for both —
  // which made `matcher-miss` structurally unreachable for every
  // text-matcher failure (classifyScreenCoverage requires
  // `wantedPresent.length > 0`, and an empty `wanted` can never satisfy
  // that). See test/lib/maestro-failure-class.test.ts and
  // test/lib/no-invite-detector.test.ts for the source captures.
  it('parses `Element not found: text "..."` (test/lib/maestro-failure-class.test.ts\'s real capture)', () => {
    expect(extractWantedMatchers('Element not found: text "Start Learning"')).toEqual([
      'Start Learning',
    ]);
  });

  it('parses `Element not found: id "..."` (test/lib/no-invite-detector.test.ts\'s real capture)', () => {
    expect(extractWantedMatchers('Element not found: id "btn_continue"')).toEqual([
      'btn_continue',
    ]);
  });
});

describe('the full production round-trip: aggregated marker-prefixed stderr -> classifyMaestroFailure -> extractWantedMatchers -> classifyScreenCoverage', () => {
  // Mirrors what mcp/mobile/backends/maestro.ts's runRecipeWithDumps
  // actually builds: one `# --- chunk N (screenshot=X) ---` block per
  // sub-recipe, joined with '\n'. Phase 6 recipes with captureAllBoundaries
  // on routinely split into 9-10 chunks (deliver-launch: 9; see the
  // measured window-count table in
  // docs/superpowers/specs/2026-08-12-mobile-mapping-completeness-design.md)
  // — this reproduces that shape with 8 short, successful preceding
  // chunks ahead of a failing 9th.
  const precedingChunks = Array.from(
    { length: 8 },
    (_, i) => `# --- chunk ${i} (screenshot=branch${i}-post) ---\n[OK] launchApp\n[OK] tapOn id=action_sync\n`,
  );
  const failingChunkBlock =
    '# --- chunk 8 (screenshot=none) ---\n[FAIL] Element not found: text "Start Learning"\n';
  const fullAggregate = [...precedingChunks, failingChunkBlock].join('\n');

  const dumpXml = `<?xml version='1.0'?><hierarchy>
    <node resource-id="org.commcare.dalvik:id/actionBarTitle" text="Learn" />
    <node resource-id="org.commcare.dalvik:id/startLearningButton" text="Start Learning" />
  </hierarchy>`;
  const selectorMapYaml = `
apk_version: "2.63.2"
selectors:
  learn-home-start-button:
    type: text
    value: "Start Learning"
`;

  it('documents the pre-threading trap: the head of the FULL joined aggregate never reaches the failing chunk\'s own text — this is why maestro.ts must thread the failing chunk alone, not classify from stderrParts.join(\'\\n\')', () => {
    // The realistic multi-chunk aggregate already exceeds the 240-char
    // excerpt window before the failing chunk's own content begins.
    expect(fullAggregate.length).toBeGreaterThan(240);
    const failure = classifyMaestroFailure({ stderr: fullAggregate, stdout: '', exitCode: 1 });
    expect(failure.stderrExcerpt).not.toContain('Start Learning');
    const wanted = extractWantedMatchers(failure.stderrExcerpt);
    const result = classifyScreenCoverage({ dumpXml, selectorMapYaml, wanted });
    expect(result.classification).not.toBe('matcher-miss');
  });

  it('classifies matcher-miss when the FAILING CHUNK alone (correctly threaded — the maestro.ts fix) is fed through the pipeline, for the real "Element not found: text ..." shape', () => {
    // What mcp/mobile/backends/maestro.ts now threads into forensics on a
    // multi-chunk failure: just the failing chunk's own marker-prefixed
    // block, not the full run history. Well within the excerpt window.
    const failure = classifyMaestroFailure({
      stderr: failingChunkBlock,
      stdout: '',
      exitCode: 1,
    });
    expect(failure.stderrExcerpt).toContain('Element not found: text "Start Learning"');

    const wanted = extractWantedMatchers(failure.stderrExcerpt);
    expect(wanted).toEqual(['Start Learning']);

    const result = classifyScreenCoverage({ dumpXml, selectorMapYaml, wanted });
    expect(result.classification).toBe('matcher-miss');
    expect(result.wantedPresent).toEqual(['Start Learning']);
  });

  it('same round-trip for the `Element not found: id "..."` shape (no-invite-detector.test.ts\'s real capture) — the #893 differentiator is type: text, but ids hit the same bug', () => {
    const idFailingChunkBlock =
      '# --- chunk 3 (screenshot=none) ---\n[FAIL] Element not found: id "btn_continue"\n';
    const idDumpXml = `<?xml version='1.0'?><hierarchy>
      <node resource-id="btn_continue" text="Continue" />
    </hierarchy>`;
    const idSelectorMapYaml = `
apk_version: "2.63.2"
selectors:
  connect-continue-button:
    type: id
    value: "btn_continue"
`;
    const failure = classifyMaestroFailure({
      stderr: idFailingChunkBlock,
      stdout: '',
      exitCode: 1,
    });
    const wanted = extractWantedMatchers(failure.stderrExcerpt);
    const result = classifyScreenCoverage({
      dumpXml: idDumpXml,
      selectorMapYaml: idSelectorMapYaml,
      wanted,
    });
    expect(result.classification).toBe('matcher-miss');
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

describe('renderForkInvocation', () => {
  it('emits parameter labels and values using the real fork-run SKILL field names', () => {
    const invocation = renderForkInvocation({
      oppSlug: 'bednet-spot-check',
      sourceRunId: '20260812-1030',
      forkAtSkill: 'app-screenshot-capture',
    });

    // Names the fork-run skill and points to its documentation
    expect(invocation).toContain('fork-run');
    expect(invocation).toContain('skills/fork-run/SKILL.md');

    // Emits the real field names the SKILL.md body accepts
    expect(invocation).toContain('opp_slug:      bednet-spot-check');
    expect(invocation).toContain('source_run_id: 20260812-1030');
    expect(invocation).toContain('fork_at_skill: app-screenshot-capture');

    // Seeds feedback so the new run carries heal context
    expect(invocation).toContain('feedback:');
    expect(invocation).toContain('Selector map healed');
  });

  it('surfaces the skill name in the feedback', () => {
    const invocation = renderForkInvocation({
      oppSlug: 'malaria-itn-app',
      sourceRunId: '20260810-0900',
      forkAtSkill: 'connect-claim-opp',
    });
    expect(invocation).toContain('re-walk from connect-claim-opp');
  });
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1571 — the probe routed an operator to
// `selector-map-heal` for the ANDROID LAUNCHER, off a FAILURE dump that a
// later passing retry had superseded.
//
// Two independent defects, so two independent filters:
//   (a) SUPERSESSION — `*-FAILURE.*` deliberately survives the per-dispatch
//       wipe (#1034), so a leg that fails once and then passes leaves a stale
//       dump sitting next to the passing retry's captures. Nothing compared
//       the two.
//   (b) NON-APP SURFACE — a dump whose every node belongs to the home screen
//       or system chrome is not an app screen at all, so no selector row
//       should ever be authored for it.
//
// Both are pure classification over recorded dumps: unit-test class, no
// device (precedent ace#1235).
// ---------------------------------------------------------------------------

// Same shape as the dump quoted in ace#1571, where 33/33 nodes were
// `com.google.android.apps.nexuslauncher` — captured while the app was
// force-stopped and therefore not foregrounded.
const LAUNCHER_DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" package="com.google.android.apps.nexuslauncher" resource-id="com.google.android.apps.nexuslauncher:id/launcher" text="" />
  <node index="1" package="com.google.android.apps.nexuslauncher" resource-id="com.google.android.apps.nexuslauncher:id/workspace" text="" />
  <node index="2" package="com.google.android.apps.nexuslauncher" resource-id="com.google.android.apps.nexuslauncher:id/hotseat" text="Phone" />
</hierarchy>`;

const APP_DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" package="org.commcare.dalvik" resource-id="org.commcare.dalvik:id/brand_new_surface" text="Confirm household" />
</hierarchy>`;

const HEAL_MAP = `
apk_version: "2.63.2"
selectors:
  deliver-home-job-card:
    type: id
    value: "org.commcare.dalvik:id/viewJobCard"
  deliver-home-daily-visits:
    type: text
    value: "Daily Visits"
`;

describe('extractPackagesFromDump', () => {
  it('extracts every package attribute, ignoring blanks', () => {
    expect([...extractPackagesFromDump(LAUNCHER_DUMP)]).toEqual([
      'com.google.android.apps.nexuslauncher',
    ]);
    expect([...extractPackagesFromDump(APP_DUMP)]).toEqual(['org.commcare.dalvik']);
  });

  it('returns an empty set when the dump carries no package attributes', () => {
    expect(extractPackagesFromDump('<hierarchy><node text="x" /></hierarchy>').size).toBe(0);
  });
});

describe('isNonAppSurfaceDump — the launcher/system-chrome filter (#1571b)', () => {
  it('calls the ace#1571 launcher dump a non-app surface', () => {
    expect(isNonAppSurfaceDump(LAUNCHER_DUMP)).toBe(true);
  });

  it.each([
    'com.android.launcher3',
    'com.android.launcher',
    'com.sec.android.app.launcher',
    'com.android.systemui',
    'android',
  ])('treats %s as non-app chrome', (pkg) => {
    expect(isNonAppSurfaceDump(`<hierarchy><node package="${pkg}" /></hierarchy>`)).toBe(true);
  });

  it('does NOT fire on a real app surface', () => {
    expect(isNonAppSurfaceDump(APP_DUMP)).toBe(false);
  });

  it('does NOT fire when the app is present under system chrome (status-bar overlay)', () => {
    const mixed = `<hierarchy>
      <node package="com.android.systemui" resource-id="com.android.systemui:id/status_bar" />
      <node package="org.commcare.dalvik" resource-id="org.commcare.dalvik:id/btn_start" />
    </hierarchy>`;
    expect(isNonAppSurfaceDump(mixed)).toBe(false);
  });

  it('does NOT fire on a dump with no package attributes at all — an empty set is not evidence', () => {
    expect(isNonAppSurfaceDump('<hierarchy><node resource-id="a:id/b" /></hierarchy>')).toBe(false);
  });

  it('does NOT fire on system surfaces the map legitimately anchors (camera, settings PIN, gms)', () => {
    for (const pkg of ['com.android.camera2', 'com.android.settings', 'com.google.android.gms']) {
      expect(isNonAppSurfaceDump(`<hierarchy><node package="${pkg}" /></hierarchy>`)).toBe(false);
    }
  });
});

describe('isSupersededFailureDump — the outcome filter (#1571a)', () => {
  const dir = '/run/screenshots/journey-deliver';
  const failure = { path: `${dir}/journey-deliver-FAILURE.xml`, mtimeMs: 1_000 };

  it('is superseded when the passing retry wrote ordinary captures afterwards', () => {
    expect(
      isSupersededFailureDump(failure, [
        failure,
        { path: `${dir}/03-deliver-home.png`, mtimeMs: 2_000 },
        { path: `${dir}/03-deliver-home.xml`, mtimeMs: 2_000 },
      ]),
    ).toBe(true);
  });

  it('is NOT superseded when every ordinary capture predates it — the failing dispatch is the latest word', () => {
    expect(
      isSupersededFailureDump(failure, [
        failure,
        { path: `${dir}/01-home.png`, mtimeMs: 500 },
        { path: `${dir}/02-list.xml`, mtimeMs: 900 },
      ]),
    ).toBe(false);
  });

  it("ignores the dump's OWN forensics siblings, which are written after it", () => {
    expect(
      isSupersededFailureDump(failure, [
        failure,
        { path: `${dir}/journey-deliver-FAILURE.png`, mtimeMs: 1_100 },
        { path: `${dir}/journey-deliver-FAILURE.txt`, mtimeMs: 1_200 },
      ]),
    ).toBe(false);
  });

  it('ignores `00-` pre-recipe ground truth — captured BEFORE the recipe, never by a later dispatch', () => {
    expect(
      isSupersededFailureDump(failure, [
        failure,
        { path: `${dir}/00-postlearn-landing.xml`, mtimeMs: 9_000 },
      ]),
    ).toBe(false);
  });

  it('ignores newer captures from a DIFFERENT recipe dir — the wipe is dispatch-scoped (#1130)', () => {
    expect(
      isSupersededFailureDump(failure, [
        failure,
        { path: '/run/screenshots/journey-learn/03-learn.png', mtimeMs: 9_000 },
      ]),
    ).toBe(false);
  });

  it('needs a strictly newer capture — an equal mtime is not evidence of a later dispatch', () => {
    expect(
      isSupersededFailureDump(failure, [failure, { path: `${dir}/03.png`, mtimeMs: 1_000 }]),
    ).toBe(false);
  });
});

describe('classifyScreenCoverage — #1571 never routes a heal at noise', () => {
  it('a superseded dump classifies as `superseded`, not `unmapped-surface`', () => {
    const r = classifyScreenCoverage({
      dumpXml: APP_DUMP,
      selectorMapYaml: HEAL_MAP,
      wanted: [],
      superseded: true,
    });
    expect(r.classification).toBe('superseded');
  });

  it('the ace#1571 launcher dump classifies as `non-app-surface`, not `unmapped-surface`', () => {
    const r = classifyScreenCoverage({
      dumpXml: LAUNCHER_DUMP,
      selectorMapYaml: HEAL_MAP,
      wanted: [],
    });
    expect(r.classification).toBe('non-app-surface');
  });

  it('NON-VACUOUS: the same empty map coverage on a real APP dump is still `unmapped-surface`', () => {
    const r = classifyScreenCoverage({
      dumpXml: APP_DUMP,
      selectorMapYaml: HEAL_MAP,
      wanted: [],
    });
    expect(r.classification).toBe('unmapped-surface');
    expect(r.mappedOnScreen).toEqual([]);
  });

  it('supersession outranks everything — a stale dump says nothing about the current map', () => {
    const r = classifyScreenCoverage({
      dumpXml:
        '<hierarchy><node package="org.commcare.dalvik" resource-id="org.commcare.dalvik:id/viewJobCard" /></hierarchy>',
      selectorMapYaml: HEAL_MAP,
      wanted: ['org.commcare.dalvik:id/viewJobCard'],
      superseded: true,
    });
    expect(r.classification).toBe('superseded');
  });

  it('the non-app filter only refines `unmapped-surface` — it never masks a real matcher-miss on system chrome', () => {
    const map = `
apk_version: "2.63.2"
selectors:
  device-lock-password:
    type: id
    value: "com.android.systemui:id/lockPassword"
`;
    const r = classifyScreenCoverage({
      dumpXml:
        '<hierarchy><node package="com.android.systemui" resource-id="com.android.systemui:id/lockPassword" /></hierarchy>',
      selectorMapYaml: map,
      wanted: ['com.android.systemui:id/lockPassword'],
    });
    expect(r.classification).toBe('matcher-miss');
  });

  it('CLASS-LEVEL PREVENTER: `needs_tier2` is never true for a non-app package or a superseded dump', () => {
    const cases: Array<Parameters<typeof classifyScreenCoverage>[0]> = [
      { dumpXml: LAUNCHER_DUMP, selectorMapYaml: HEAL_MAP, wanted: [] },
      { dumpXml: LAUNCHER_DUMP, selectorMapYaml: HEAL_MAP, wanted: ['anything'] },
      { dumpXml: APP_DUMP, selectorMapYaml: HEAL_MAP, wanted: [], superseded: true },
      { dumpXml: LAUNCHER_DUMP, selectorMapYaml: HEAL_MAP, wanted: [], superseded: true },
    ];
    for (const c of cases) {
      const yaml = parseYaml(
        renderReportYaml({
          apkVersion: '2.63.2',
          dumpFile: 'journey-deliver-FAILURE.xml',
          result: classifyScreenCoverage(c),
        }),
      ) as { classification: string; needs_tier2: boolean };
      expect(yaml.needs_tier2).toBe(false);
      expect(yaml.classification).not.toBe('unmapped-surface');
    }
  });
});

describe('selectFailureDumpForClassification — the fixture dump set from #1571', () => {
  const dir = '/run/screenshots/journey-deliver';
  const learnDir = '/run/screenshots/journey-learn';

  // The shape of hh-poverty-targeting/20260819-1435: a launcher FAILURE dump
  // at 13:37:04, superseded by the passing dispatch's captures at 13:45.
  const supersededLauncher = {
    path: `${dir}/journey-deliver-FAILURE.xml`,
    mtimeMs: 133_704,
    xml: LAUNCHER_DUMP,
    siblings: [
      { path: `${dir}/journey-deliver-FAILURE.xml`, mtimeMs: 133_704 },
      { path: `${dir}/03-deliver-home.png`, mtimeMs: 134_500 },
      { path: `${dir}/03-deliver-home.xml`, mtimeMs: 134_500 },
    ],
  };
  const liveAppFailure = {
    path: `${learnDir}/journey-learn-FAILURE.xml`,
    mtimeMs: 133_000,
    xml: APP_DUMP,
    siblings: [
      { path: `${learnDir}/journey-learn-FAILURE.xml`, mtimeMs: 133_000 },
      { path: `${learnDir}/01-learn-home.png`, mtimeMs: 132_000 },
    ],
  };

  it('skips the superseded launcher dump and selects the genuine, older app failure', () => {
    const sel = selectFailureDumpForClassification([supersededLauncher, liveAppFailure]);
    expect(sel.selected?.path).toBe(liveAppFailure.path);
    expect(sel.selected?.superseded).toBe(false);
    expect(sel.selected?.nonAppSurface).toBe(false);
    expect(sel.skipped).toEqual([{ path: supersededLauncher.path, reason: 'superseded' }]);
  });

  it('NON-VACUOUS: the newest-by-mtime rule still wins among eligible dumps', () => {
    const newerApp = { ...liveAppFailure, path: `${dir}/other-FAILURE.xml`, mtimeMs: 900_000 };
    const sel = selectFailureDumpForClassification([liveAppFailure, newerApp]);
    expect(sel.selected?.path).toBe(newerApp.path);
    expect(sel.skipped).toEqual([]);
  });

  it('when NOTHING is eligible it still reports the newest dump, flagged, rather than inventing a verdict', () => {
    const sel = selectFailureDumpForClassification([supersededLauncher]);
    expect(sel.selected?.path).toBe(supersededLauncher.path);
    expect(sel.selected?.superseded).toBe(true);
    expect(sel.selected?.nonAppSurface).toBe(true);
    // The selected dump is not ALSO listed as skipped — its state is carried
    // by the flags, which become the classification.
    expect(sel.skipped).toEqual([]);
  });

  it('returns nothing for an empty candidate set', () => {
    expect(selectFailureDumpForClassification([])).toEqual({ selected: null, skipped: [] });
  });

  it('labels a live-but-launcher dump `non-app-surface`, not `superseded`', () => {
    const launcherOnly = {
      path: `${dir}/journey-deliver-FAILURE.xml`,
      mtimeMs: 500_000,
      xml: LAUNCHER_DUMP,
      siblings: [{ path: `${dir}/journey-deliver-FAILURE.xml`, mtimeMs: 500_000 }],
    };
    const sel = selectFailureDumpForClassification([launcherOnly, liveAppFailure]);
    expect(sel.selected?.path).toBe(liveAppFailure.path);
    expect(sel.skipped).toEqual([{ path: launcherOnly.path, reason: 'non-app-surface' }]);
  });
});

describe('renderReportYaml — the skipped ledger keeps the silence auditable', () => {
  it('names every dump the filters dropped, and why', () => {
    const yaml = parseYaml(
      renderReportYaml({
        apkVersion: '2.63.2',
        dumpFile: 'journey-learn-FAILURE.xml',
        result: classifyScreenCoverage({
          dumpXml: APP_DUMP,
          selectorMapYaml: HEAL_MAP,
          wanted: [],
        }),
        skipped: [{ path: 'journey-deliver/journey-deliver-FAILURE.xml', reason: 'superseded' }],
      }),
    ) as { skipped: Array<{ file: string; reason: string }> };
    expect(yaml.skipped).toEqual([
      { file: 'journey-deliver/journey-deliver-FAILURE.xml', reason: 'superseded' },
    ]);
  });

  it('omits the skipped block entirely when nothing was dropped', () => {
    const yaml = parseYaml(
      renderReportYaml({
        apkVersion: '2.63.2',
        dumpFile: 'x-FAILURE.xml',
        result: classifyScreenCoverage({
          dumpXml: APP_DUMP,
          selectorMapYaml: HEAL_MAP,
          wanted: [],
        }),
      }),
    ) as Record<string, unknown>;
    expect(yaml).not.toHaveProperty('skipped');
  });
});

describe('the preserved-artifact predicate must not drift from the mobile wipe', () => {
  it('agrees with mcp/mobile/screenshot-dir.ts § isPreservedArtifact on every shape it guards', () => {
    for (const name of [
      '00-postlearn-landing.xml',
      'journey-deliver-FAILURE.xml',
      'journey-deliver-FAILURE.png',
      'journey-deliver-FAILURE.txt',
      '03-deliver-home.png',
      '03-deliver-home.xml',
      'journey-deliver.mp4',
    ]) {
      expect(isPreservedArtifactName(name)).toBe(isPreservedArtifact(name));
    }
  });
});
