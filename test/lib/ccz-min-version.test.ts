/**
 * dimagi-internal/ace#1997 — a released CCZ declared a minimum CommCare of
 * 2.64.0 while ACE's mobile stack pins APK 2.63.2. CommCare showed a
 * version-gate screen instead of launching the app, so EVERY Phase 6 device
 * walk died at the Connect→CommCare app-launch handoff — after burning an AVD
 * boot, a PersonalID login and an opportunity claim, and presenting under the
 * misleading `claim-START-HANDOFF-WEDGED-issue629` label.
 *
 * The device said so in 16pt type (`journey-learn-FAILURE.xml`, live capture,
 * bednet-check-2-visit/20260902-1555):
 *
 *   org.commcare.dalvik:id/prompt_title
 *     "The application requires CommCare version 2.64.0. You are currently
 *      running 2.63.2."
 *
 * and the released Learn CCZ's own profile agreed (re-confirmed live
 * 2026-09-05 against `connect-ace-prod` app `cb980f9c…`):
 *
 *   <profile version="10" requiredMajor="2" requiredMinor="64"
 *            requiredMinimal="0" …>
 *
 * ## Why Phase 3 never saw it
 *
 * `app-release-qa` Step 4.5 validates the CCZ with `commcare-cli validate` +
 * `play`. Those are a JVM runtime with NO minimum-version gate — so a CCZ that
 * no ACE-provisioned device can open passes every Phase 3 gate cleanly. The
 * mismatch was only observable by burning a Phase 6 walk.
 *
 * This suite covers the preventer: a static comparison of the released CCZ's
 * `profile.ccpr` required triple against the APK Phase 6 will actually run,
 * evaluated in Phase 3 where the app can still be rebuilt.
 *
 * ## Evidence class: STATIC PARSING + VERSION COMPARISON, not device truth
 *
 * Nothing here is sent to, or matched against, a device — no selector string,
 * no tap coordinate, no recipe step order. Both inputs are text ACE already
 * holds in Phase 3 (a zip member and an env var), and the output is an
 * arithmetic comparison. Per CLAUDE.md § "The trigger is the CLAIM, not the
 * directory", that puts this squarely in the unit-test class, and these tests
 * are complete evidence for it.
 *
 * ## The lexicographic trap, specifically
 *
 * `'2.64.0' < '2.9.0'` as strings ('6' < '9') and `'2.63.10' < '2.63.9'`.
 * A string comparison therefore gets the ace#1997 case itself right by luck
 * ('2.64.0' > '2.63.2') while being wrong in both directions elsewhere — the
 * exact shape of bug that ships green and fails a year later. Asserted below
 * in both directions so a lexicographic implementation cannot pass.
 */
import { describe, it, expect } from 'vitest';
import {
  parseVersionTriple,
  compareVersionTriples,
  parseCczRequiredVersion,
  checkCczMinVersion,
} from '../../lib/ccz-min-version.js';

/** The real profile head, verbatim from the ace#1997 released Learn CCZ. */
const REAL_PROFILE = `<?xml version='1.0' encoding='UTF-8'?>
<profile version="10"
         update="https://www.commcarehq.org/a/connect-ace-prod/apps/download/332a38d6dbc5433c9806744f1e77cc1a/media_profile.ccpr?latest=true&amp;profile=None"
         requiredMajor="2"
         requiredMinor="64"
         requiredMinimal="0"
         uniqueid="cb980f9c2d264fd69c3cb5d3d8223d6f"
         name="Bednet Check Two-Visit Learn app">
  <property key="cc-entry-mode" value="cc-entry-review"/>
</profile>`;

function profileWith(major: string, minor: string, minimal: string): string {
  return `<?xml version='1.0' encoding='UTF-8'?>
<profile version="10" requiredMajor="${major}" requiredMinor="${minor}" requiredMinimal="${minimal}" uniqueid="x" name="y"/>`;
}

describe('parseVersionTriple', () => {
  it('parses a three-component version', () => {
    expect(parseVersionTriple('2.63.2')).toEqual({ major: 2, minor: 63, patch: 2 });
  });

  it('treats a missing patch component as 0', () => {
    expect(parseVersionTriple('2.64')).toEqual({ major: 2, minor: 64, patch: 0 });
  });

  it('returns null rather than throwing on garbage', () => {
    for (const bad of ['', '   ', 'latest', '2.x.1', 'v2.63.2-beta', '..']) {
      expect(parseVersionTriple(bad), `expected null for ${JSON.stringify(bad)}`).toBeNull();
    }
  });
});

describe('compareVersionTriples — NUMERIC, never lexicographic', () => {
  const t = (s: string) => parseVersionTriple(s)!;

  it('the ace#1997 case: 2.64.0 is above 2.63.2', () => {
    expect(compareVersionTriples(t('2.64.0'), t('2.63.2'))).toBe(1);
  });

  it('equal triples compare equal', () => {
    expect(compareVersionTriples(t('2.63.2'), t('2.63.2'))).toBe(0);
  });

  // THE TRAP. String-compare says '2.64.0' < '2.9.0' because '6' < '9'.
  it('2.64.0 is ABOVE 2.9.0 (string compare says below)', () => {
    expect(compareVersionTriples(t('2.64.0'), t('2.9.0'))).toBe(1);
  });

  it('2.9.0 is BELOW 2.64.0 (string compare says above)', () => {
    expect(compareVersionTriples(t('2.9.0'), t('2.64.0'))).toBe(-1);
  });

  it('2.63.10 is above 2.63.9 (string compare says below)', () => {
    expect(compareVersionTriples(t('2.63.10'), t('2.63.9'))).toBe(1);
  });

  it('major dominates minor', () => {
    expect(compareVersionTriples(t('3.0.0'), t('2.99.99'))).toBe(1);
  });
});

describe('parseCczRequiredVersion', () => {
  it('reads the required triple off the real profile.ccpr', () => {
    const got = parseCczRequiredVersion(REAL_PROFILE);
    expect(got.status).toBe('parsed');
    expect(got.version).toEqual({ major: 2, minor: 64, patch: 0 });
  });

  it('requiredMinimal is the PATCH component, not a fourth field', () => {
    const got = parseCczRequiredVersion(profileWith('2', '63', '2'));
    expect(got.version).toEqual({ major: 2, minor: 63, patch: 2 });
  });

  it('defaults an absent requiredMinimal to patch 0', () => {
    const xml = `<profile version="10" requiredMajor="2" requiredMinor="64" uniqueid="x"/>`;
    const got = parseCczRequiredVersion(xml);
    expect(got.status).toBe('parsed');
    expect(got.version).toEqual({ major: 2, minor: 64, patch: 0 });
  });

  it('reports `absent` when the profile declares no minimum at all', () => {
    const got = parseCczRequiredVersion(`<profile version="10" uniqueid="x" name="y"/>`);
    expect(got.status).toBe('absent');
    expect(got.version).toBeNull();
  });

  it('reports `malformed` — never throws — on unparseable input', () => {
    for (const bad of ['', '<profile', 'not xml at all', profileWith('two', '64', '0')]) {
      const got = parseCczRequiredVersion(bad);
      expect(got.status, `expected malformed for ${JSON.stringify(bad).slice(0, 40)}`).toBe('malformed');
      expect(got.version).toBeNull();
    }
  });
});

describe('checkCczMinVersion', () => {
  it('does NOT fire when the CCZ requires at or below the pinned APK', () => {
    const below = checkCczMinVersion({
      app: 'learn',
      profileXml: profileWith('2', '62', '0'),
      apkVersion: '2.63.2',
      selectorMapVersions: ['2.62.0', '2.63.0', '2.63.2'],
    });
    expect(below.severity).toBe('ok');
    expect(below.finding).toBeNull();
  });

  it('does NOT fire when the versions are exactly equal', () => {
    const equal = checkCczMinVersion({
      app: 'learn',
      profileXml: profileWith('2', '63', '2'),
      apkVersion: '2.63.2',
      selectorMapVersions: ['2.63.2'],
    });
    expect(equal.severity).toBe('ok');
    expect(equal.finding).toBeNull();
  });

  it('FIRES on the ace#1997 state, and names all three of required / pinned / remedy', () => {
    const out = checkCczMinVersion({
      app: 'learn',
      profileXml: REAL_PROFILE,
      apkVersion: '2.63.2',
      selectorMapVersions: ['2.62.0', '2.63.0', '2.63.2'],
    });
    expect(out.severity).not.toBe('ok');
    expect(out.finding).not.toBeNull();
    expect(out.finding!.kind).toBe('ccz-min-version-gate');
    expect(out.finding!.requiredVersion).toBe('2.64.0');
    expect(out.finding!.apkVersion).toBe('2.63.2');
    // The message must carry both versions and the consequence, or an
    // operator reading only the log cannot act on it.
    expect(out.finding!.message).toContain('2.64.0');
    expect(out.finding!.message).toContain('2.63.2');
    expect(out.finding!.message).toMatch(/app-launch handoff/i);
    expect(out.finding!.remedy).toBeTruthy();
  });

  it('is a WARN, not a BLOCKER, when no selector map covers the required version', () => {
    // The remedy is a NEW APK plus a calibrated selector map — human-owned,
    // out of reach inside the run. Halting here blocks every /ace:run behind
    // work no operator can do, which is how a gate gets disabled.
    const out = checkCczMinVersion({
      app: 'learn',
      profileXml: REAL_PROFILE,
      apkVersion: '2.63.2',
      selectorMapVersions: ['2.62.0', '2.63.0', '2.63.2'],
    });
    expect(out.severity).toBe('warn');
    expect(out.finding!.remedy).toMatch(/selector map/i);
  });

  it('is a BLOCKER when a selector map DOES cover the required version', () => {
    // Now the remedy is in-run and cheap: repin ACE_CONNECT_APK_VERSION.
    const out = checkCczMinVersion({
      app: 'learn',
      profileXml: REAL_PROFILE,
      apkVersion: '2.63.2',
      selectorMapVersions: ['2.63.2', '2.64.0'],
    });
    expect(out.severity).toBe('blocker');
    expect(out.finding!.remedy).toMatch(/ACE_CONNECT_APK_VERSION/);
  });

  it('picks the map by NUMERIC order — 2.9.0 does not satisfy a 2.64.0 requirement', () => {
    // Lexicographically '2.9.0' > '2.64.0', so a string-sorted "newest map"
    // would wrongly claim an in-run remedy exists.
    const out = checkCczMinVersion({
      app: 'learn',
      profileXml: REAL_PROFILE,
      apkVersion: '2.63.2',
      selectorMapVersions: ['2.9.0'],
    });
    expect(out.severity).toBe('warn');
  });

  it('degrades to INFO when the device phase will not run at all', () => {
    const out = checkCczMinVersion({
      app: 'learn',
      profileXml: REAL_PROFILE,
      apkVersion: '2.63.2',
      selectorMapVersions: ['2.63.2', '2.64.0'],
      devicePhasePlanned: false,
    });
    expect(out.severity).toBe('info');
    expect(out.finding!.message).toMatch(/no device walk/i);
  });

  it('WARNs — never crashes, never silently passes — on an absent or malformed profile', () => {
    for (const bad of ['', 'not xml', `<profile version="10" uniqueid="x"/>`]) {
      const out = checkCczMinVersion({
        app: 'deliver',
        profileXml: bad,
        apkVersion: '2.63.2',
        selectorMapVersions: ['2.63.2'],
      });
      expect(out.severity, `profile ${JSON.stringify(bad).slice(0, 30)}`).toBe('warn');
      expect(out.finding!.kind).toBe('ccz-profile-unreadable');
    }
  });

  it('WARNs when the pinned APK version itself is unparseable', () => {
    const out = checkCczMinVersion({
      app: 'learn',
      profileXml: REAL_PROFILE,
      apkVersion: 'latest',
      selectorMapVersions: ['2.63.2'],
    });
    expect(out.severity).toBe('warn');
    expect(out.finding!.kind).toBe('apk-version-unreadable');
  });

  it('never throws on any input shape', () => {
    expect(() =>
      checkCczMinVersion({
        app: 'learn',
        profileXml: undefined as unknown as string,
        apkVersion: undefined as unknown as string,
        selectorMapVersions: undefined,
      }),
    ).not.toThrow();
  });
});
