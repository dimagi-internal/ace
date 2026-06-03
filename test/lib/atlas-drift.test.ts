import { describe, it, expect } from 'vitest';
import {
  extractResourceIdsFromDump,
  loadSelectorMapIds,
  diffResourceIds,
  renderReportMarkdown,
  isFailureDumpFile,
  failureScreenDriftSuspects,
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
