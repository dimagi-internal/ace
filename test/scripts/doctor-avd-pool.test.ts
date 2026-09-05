/**
 * The COLLECTOR half of the avd_pool probe (ace#1821).
 *
 * `test/lib/avd-pool-report.test.ts` pins the decision logic. This pins the
 * wiring: that the script actually reads disk images, markers and holders
 * through the existing helpers and emits a line `bin/ace-doctor` can parse.
 *
 * The two failures worth catching here are wiring failures, not logic ones —
 * a probe that reads the wrong AVD home, or emits a verdict token the doctor's
 * `case` never matches, is silently absent rather than wrong. Both are exactly
 * the shape of the defect this whole PR exists to prevent.
 *
 * Classification: unit-test truth. Runs against temp directories and a canned
 * `ps` capture; no emulator, no Android SDK, no device.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveActiveSelectorMapId } from '../../mcp/mobile/recipe-resolver';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/**
 * The identity of the selector map in force, resolved the SAME way the
 * script resolves it (ace#1993). A marker fixture that omits it is no longer
 * proof — that is the whole point of the fix — so the fixtures record it,
 * exactly as a real `registerTestUser` now does.
 */
const ACTIVE_MAP = resolveActiveSelectorMapId();
const SCRIPT = path.join(ROOT, 'scripts', 'doctor-avd-pool.ts');

let home: string;
let psFixture: string;

/** A live `-read-only` emulator holding ACE_Pixel_API_34, in real `ps` shape. */
const PS_ROWS = [
  'acedimagi 41133 1 Fri Sep  5 07:57:11 2026 /Users/x/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd ACE_Pixel_API_34 -read-only -port 5554',
  'acedimagi 41100 1 Fri Sep  5 07:57:10 2026 /usr/bin/login -pf someone',
].join('\n');

function makeAvd(name: string, opts: { images?: boolean; marker?: boolean | 'stale' }): void {
  const dir = path.join(home, `${name}.avd`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.ini'), 'tag.id=google_apis_playstore\n');
  if (opts.images) writeFileSync(path.join(dir, 'userdata.img'), '');
  if (opts.marker) {
    writeFileSync(
      path.join(dir, '.ace-provisioned.json'),
      JSON.stringify({
        marked_at: '2026-09-01T14:00:21.449Z',
        // `opts.marker: 'stale'` writes a marker from a DIFFERENT selector map —
        // the ace#1993 positive control. Before the fix it read as proven.
        selector_map: opts.marker === 'stale' ? 'connect-2.62.0@deadbeefcafe' : ACTIVE_MAP,
      }),
    );
  }
}

function run(list: string | undefined): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ACE_AVD_POOL_HOME: home,
    ACE_AVD_POOL_PS_FIXTURE: psFixture,
    ACE_AVD_NAME: 'ACE_Pixel_API_34',
  };
  if (list === undefined) {
    // Force the unreadable-list path: no seam, and an SDK root with no emulator.
    delete env.ACE_AVD_POOL_LIST;
    env.ANDROID_SDK_ROOT = path.join(home, 'no-such-sdk');
    env.ANDROID_HOME = env.ANDROID_SDK_ROOT;
  } else {
    env.ACE_AVD_POOL_LIST = list;
  }
  // The script resolves the active selector map from the repo (ace#1993), so
  // the only ambient variable that can move it is the APK pin. Both sides —
  // `ACTIVE_MAP` above and the child process — read the same `process.env`, so
  // they agree by construction; nothing needs deleting.
  return execFileSync('npx', ['tsx', SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    timeout: 120_000,
  });
}

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'ace-avd-pool-'));
  psFixture = path.join(home, 'ps.txt');
  writeFileSync(psFixture, PS_ROWS);
  makeAvd('ACE_Pixel_API_34', { images: true, marker: true });
  makeAvd('ACE_Pixel_API_34_b', { images: true, marker: false }); // the measured `_b`
  makeAvd('ACE_Pixel_API_34_c', { images: true, marker: true }); // a healthy sibling
  makeAvd('ACE_Pixel_API_34_gone', { images: false, marker: false });
  makeAvd('ACE_Pixel_API_34_stale', { images: true, marker: 'stale' }); // ace#1993 control
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('doctor-avd-pool collector — the both-directions control', () => {
  it('WARNs on the measured one-eligible pool', () => {
    const out = run('ACE_Pixel_API_34\nACE_Pixel_API_34_b');
    expect(out).toMatch(/^WARN avd_pool:/);
    expect(out).toContain('1 eligible, 2 needed');
  });

  it('PASSes once a second AVD is provisioned AND proven', () => {
    const out = run('ACE_Pixel_API_34\nACE_Pixel_API_34_c');
    expect(out).toMatch(/^PASS avd_pool:/);
    expect(out).toContain('2 of 2');
  });
});

describe('doctor-avd-pool collector — wiring', () => {
  it('reads the provisioning marker, not just the disk images', () => {
    // `_b` HAS a userdata.img, so every cheaper check calls it provisioned.
    // Only the marker read separates it from an eligible AVD.
    const out = run('ACE_Pixel_API_34\nACE_Pixel_API_34_b');
    expect(out).toMatch(/ACE_Pixel_API_34_b: has disk images but NO provisioning marker/);
  });

  it('reads holders through lib/mobile-contention.ts, not a second detector', () => {
    // pid 41133 exists only in the canned ps capture. Seeing it here proves the
    // borrowed parser ran — and that a `-read-only` holder is visible at all,
    // which the retired hardware-qemu.ini.lock detector never managed.
    const out = run('ACE_Pixel_API_34\nACE_Pixel_API_34_b');
    expect(out).toContain('held by live pid 41133');
  });

  it('reports a de-provisioned AVD without counting it', () => {
    const out = run('ACE_Pixel_API_34\nACE_Pixel_API_34_gone');
    expect(out).toMatch(/ACE_Pixel_API_34_gone: de-provisioned/);
    expect(out).toContain('1 eligible, 2 needed');
  });

  it('SKIPs — never WARNs — when the AVD list cannot be read', () => {
    const out = run(undefined);
    expect(out).toMatch(/^SKIP avd_pool:/);
    expect(out).not.toMatch(/^WARN/m);
  });

  it('emits a first token bin/ace-doctor can actually match', () => {
    // The doctor `case` switches on WARN* / PASS* / anything-else. A verdict
    // token outside that set is silently dropped — absent, not wrong.
    for (const list of ['ACE_Pixel_API_34\nACE_Pixel_API_34_b', 'ACE_Pixel_API_34\nACE_Pixel_API_34_c']) {
      expect(run(list).split('\n')[0]).toMatch(/^(WARN|PASS|SKIP) /);
    }
  });

  it('routes remediation to /ace:mobile-bootstrap --pool, naming no image tag', () => {
    const out = run('ACE_Pixel_API_34\nACE_Pixel_API_34_b');
    expect(out).toContain('/ace:mobile-bootstrap --pool 2');
    expect(out).not.toMatch(/google_apis/);
    expect(out).not.toMatch(/avdmanager create avd/);
  });
});

/**
 * ace#1993 — a marker recorded under a DIFFERENT selector map is not proof.
 *
 * `_stale` has disk images AND a provisioning marker, so every check short of
 * the map comparison calls it eligible. Before the fix the comparison never
 * ran: `markerProvesFor` was handed `process.env.ACE_SELECTOR_MAP`, which is
 * set nowhere, and returned `true` on the spot. This pool would have reported
 * PASS with a device provisioned under a map ACE no longer drives — the
 * #591/#593 trap, arriving through the probe that exists to prevent it.
 */
describe('doctor-avd-pool collector — selector-map drift (ace#1993)', () => {
  it('does NOT count an AVD proven under a different selector map', () => {
    const out = run('ACE_Pixel_API_34\nACE_Pixel_API_34_stale');
    expect(out).toMatch(/^WARN avd_pool:/);
    expect(out).toContain('1 eligible, 2 needed');
  });

  // Non-inertness: the same fixture shape, differing ONLY in the recorded map,
  // is eligible. So the WARN above is the map comparison, not an unrelated
  // fixture defect.
  it('DOES count the same AVD when its marker carries the active map', () => {
    const out = run('ACE_Pixel_API_34\nACE_Pixel_API_34_c');
    expect(out).toMatch(/^PASS avd_pool:/);
    expect(out).toContain('2 of 2');
  });
});
