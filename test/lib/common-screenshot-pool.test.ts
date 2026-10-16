// common_screenshot_pool: the pinned APK must have its own usable pool in Drive
// (dimagi-internal/ace#3060). Controls are the real 2.63.0 manifest shape, read
// from Drive 2026-10-16 (Google Doc text export, CRLF line endings).
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { classifyCommonPool, parsePoolManifest, REQUIRED_LIVE_ALIASES } from '../../lib/common-screenshot-pool.js';

const live = (id: string) => `    drive: "${id}"\r\n    source: live\r\n`;
const ph = '    source: fixture\r\n    placeholder: true\r\n';

/** The 2.63.0 pool as it stands: connect-home + claim-opp downgraded for opp-name leakage. */
const MANIFEST_2_63_0 =
  'connect_apk_version: "2.63.0"\r\nscreenshots:\r\n' +
  `  commcare-welcome:\r\n${live('1rEPfgO-ahSFT29Tu3xcSV0odhvvdN4o2')}` +
  `  learn-install:\r\n${live('1pHd6Ixz5xVuQmai9vfTgNfnbaSu1gZqo')}` +
  `  personal-id-start:\r\n${live('1up1FIYAbx059EqiflRoKUTWGEKU7uJoW')}` +
  `  personal-id-phone:\r\n${live('1bBJM2FjPG8E2RVFEtLABkRUr3rTwZQEx')}` +
  `  personal-id-name:\r\n${live('1oujk0rkrnS7CX0SP_gu76CrgyMnm3IX5')}` +
  `  connect-home:\r\n${ph}  sync-button:\r\n${ph}  claim-opp:\r\n${ph}` +
  `  personal-id-verify:\r\n${ph}  play-store-search:\r\n${ph}`;

const fullManifest = (v: string, ids: Record<string, string> = {}) =>
  `connect_apk_version: "${v}"\nscreenshots:\n` +
  REQUIRED_LIVE_ALIASES.map((a) => `  ${a}:\n    drive: "${ids[a] ?? `id-${a}`}"\n    source: live\n`).join('') +
  `  sync-button:\n    source: fixture\n    placeholder: true\n`;

describe('classifyCommonPool', () => {
  it('FAILS when the pinned version has no pool, even though an older one exists (the 2.64.0 incident)', () => {
    const v = classifyCommonPool({ pinnedVersion: '2.64.0', versionsPresent: ['2.63.0'], manifestText: null });
    expect(v.status).toBe('fail');
    expect(v.summary).toMatch(/no pool for the pinned APK 2\.64\.0/);
    expect(v.summary).toMatch(/present: 2\.63\.0/);
    expect(v.remediation).toMatch(/common-screenshot-capture/);
  });

  it('FAILS when the folder exists but has no manifest', () => {
    const v = classifyCommonPool({ pinnedVersion: '2.64.0', versionsPresent: ['2.64.0'], manifestText: null });
    expect(v).toMatchObject({ status: 'fail' });
    expect(v.summary).toMatch(/no manifest\.yaml/);
  });

  it('FAILS on an unreadable manifest rather than counting zero aliases as a result', () => {
    const v = classifyCommonPool({ pinnedVersion: '2.64.0', versionsPresent: ['2.64.0'], manifestText: 'connect_apk_version: "2.64.0"\n' });
    expect(v.status).toBe('fail');
    expect(v.summary).toMatch(/unreadable/);
  });

  it('FAILS the real 2.63.0 pool (CRLF Doc export): 5/7 live, names the two placeholders', () => {
    const v = classifyCommonPool({ pinnedVersion: '2.63.0', versionsPresent: ['2.63.0'], manifestText: MANIFEST_2_63_0 });
    expect(v.status).toBe('fail');
    expect(v.live).toHaveLength(5);
    expect(v.missingLive).toEqual(['connect-home', 'claim-opp']);
    expect(v.summary).toMatch(/5\/7/);
  });

  it('PASSES a full pool; quarantined sync-button and template assets do not count against it', () => {
    const v = classifyCommonPool({ pinnedVersion: '2.64.0', versionsPresent: ['2.63.0', '2.64.0'], manifestText: fullManifest('2.64.0') });
    expect(v).toMatchObject({ status: 'pass', missingLive: [], duplicateIds: [] });
    expect(v.summary).toMatch(/7\/7/);
  });

  it('a placeholder:true entry is not live even when it says source: live and carries an id', () => {
    const text = fullManifest('2.64.0').replace(
      '  claim-opp:\n    drive: "id-claim-opp"\n    source: live\n',
      '  claim-opp:\n    drive: "id-claim-opp"\n    source: live\n    placeholder: true\n',
    );
    const v = classifyCommonPool({ pinnedVersion: '2.64.0', versionsPresent: ['2.64.0'], manifestText: text });
    expect(v.missingLive).toEqual(['claim-opp']);
  });

  it('FAILS when two aliases point at one Drive file (the ace#1832 shape, caught by id)', () => {
    const text = fullManifest('2.64.0', { 'claim-opp': 'id-connect-home' });
    const v = classifyCommonPool({ pinnedVersion: '2.64.0', versionsPresent: ['2.64.0'], manifestText: text });
    expect(v.status).toBe('fail');
    expect(v.duplicateIds).toEqual(['connect-home=claim-opp']);
  });
});

describe('parsePoolManifest', () => {
  it('reads a CRLF Google-Doc export', () => {
    expect(Object.keys(parsePoolManifest(MANIFEST_2_63_0))).toContain('commcare-welcome');
  });
});

describe('wiring', () => {
  const read = (p: string) => fs.readFileSync(p, 'utf8');

  it('bin/ace-doctor runs the probe through run_line_probe, so a probe that cannot run is not silent', () => {
    const doctor = read('bin/ace-doctor');
    expect(doctor).toContain('run_line_probe scripts/doctor-common-screenshot-pool.ts');
    expect(doctor).toMatch(/emit_line_probe common_screenshot_pool/);
  });

  it.each(['skills/training-deck-generate/SKILL.md', 'skills/training-flw-guide/SKILL.md'])(
    '%s preflights the pool and never silently borrows another version',
    (p) => {
      const s = read(p);
      expect(s).toMatch(/\$ACE_ROOT\/scripts\/doctor-common-screenshot-pool\.ts" --format=json/);
      expect(s).toContain('[COMMON-POOL-MISSING]');
      expect(s).not.toMatch(/use the most recent and emit an INFO note/);
    },
  );

  it('the APK upgrade procedure gates on the probe', () => {
    expect(read('skills/connect-apk-upgrade/SKILL.md')).toContain('common_screenshot_pool');
  });
});
