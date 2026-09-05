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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'doctor-avd-pool.ts');

let home: string;
let psFixture: string;

/** A live `-read-only` emulator holding ACE_Pixel_API_34, in real `ps` shape. */
const PS_ROWS = [
  'acedimagi 41133 1 Fri Sep  5 07:57:11 2026 /Users/x/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd ACE_Pixel_API_34 -read-only -port 5554',
  'acedimagi 41100 1 Fri Sep  5 07:57:10 2026 /usr/bin/login -pf someone',
].join('\n');

function makeAvd(name: string, opts: { images?: boolean; marker?: boolean }): void {
  const dir = path.join(home, `${name}.avd`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.ini'), 'tag.id=google_apis_playstore\n');
  if (opts.images) writeFileSync(path.join(dir, 'userdata.img'), '');
  if (opts.marker) {
    writeFileSync(
      path.join(dir, '.ace-provisioned.json'),
      JSON.stringify({ marked_at: '2026-09-01T14:00:21.449Z' }),
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
  // `ACE_SELECTOR_MAP` must not leak in from the ambient environment — it would
  // flip every marker to unproven and make these assertions lie.
  delete env.ACE_SELECTOR_MAP;
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

  it('never names a hard-coded system image in the remediation', () => {
    const out = run('ACE_Pixel_API_34\nACE_Pixel_API_34_b');
    expect(out).toContain('system-images;android-34;<tag>;arm64-v8a');
    expect(out).not.toMatch(/system-images;android-34;google_apis(_playstore)?;/);
  });

  it('suggests a name that does not collide with an existing AVD', () => {
    const out = run('ACE_Pixel_API_34\nACE_Pixel_API_34_b');
    expect(out).toMatch(/avdmanager create avd -n ACE_Pixel_API_34_c/);
  });
});
