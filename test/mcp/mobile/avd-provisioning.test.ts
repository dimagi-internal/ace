/**
 * dimagi-internal/ace#1357 — a de-provisioned AVD reported as an opaque dadb
 * broken pipe from `register_test_user`, naming neither the cause nor the
 * remediation.
 *
 * Phase 6 on bednet-check-2-visit/20260814-0856, local AVD backend. Three
 * consecutive `mobile_ensure_avd_running` calls, all failing at
 * `register_test_user part B`:
 *
 *   register_test_user part B failed: Exception in thread "Thread-5"
 *     java.net.SocketException: Broken pipe ... dadb.AdbWriter.writeClose
 *
 *   register_test_user part B failed: Failed to install apk
 *     /var/.../maestro-app*.apk: Connection refused ... dadb.DadbImpl.newConnection
 *
 * Neither mentions the emulator, the AVD, or `/ace:mobile-bootstrap`. Worse,
 * the attached probe disclaimer routes the operator to "fix the probe path
 * first", which is the wrong lead entirely.
 *
 * The real cause, from the MCP's OWN boot log:
 *
 *   qemu-system-aarch64-headless: Could not open
 *     '.../ACE_Pixel_API_34.avd/cache.img': No such file or directory
 *   WARNING | QEMU main loop exits abnormally with code 1
 *
 * `~/.android/avd/ACE_Pixel_API_34.avd/` held ZERO `*.img` files — no
 * cache.img, userdata-qemu.img, encryptionkey.img or sdcard.img — only
 * config.ini, initrd, emu-launch-params.txt and ~120 stale
 * `snapshot.lock.tmp-*` / `hardware-qemu.ini.tmp-*` residue files. The sibling
 * `ACE_Pixel_API_34_PS.avd` still had a complete image set, so this was
 * specific to the canonical AVD.
 *
 * A pre-spawn check turns a 60-second doomed boot plus an opaque dadb error
 * into an immediate named error pointing at `/ace:mobile-bootstrap`.
 *
 * Classification: unit-test. This is a filesystem check on the AVD directory
 * BEFORE any emulator is spawned — nothing is sent to or matched against a
 * device.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkAvdProvisioned } from '../../../mcp/mobile/avd-provisioning.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-prov-'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function makeAvd(name: string, files: string[]) {
  const dir = path.join(home, `${name}.avd`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  return dir;
}

describe('checkAvdProvisioned (#1357)', () => {
  it('passes a healthy AVD', () => {
    makeAvd('ACE_Pixel_API_34_PS', ['config.ini', 'userdata-qemu.img', 'cache.img', 'sdcard.img']);
    const r = checkAvdProvisioned(home, 'ACE_Pixel_API_34_PS');
    expect(r.provisioned).toBe(true);
  });

  it('catches the exact live shape: config.ini and initrd, ZERO *.img', () => {
    makeAvd('ACE_Pixel_API_34', ['config.ini', 'initrd', 'emu-launch-params.txt']);
    const r = checkAvdProvisioned(home, 'ACE_Pixel_API_34');
    expect(r.provisioned).toBe(false);
    expect(r.detail).toMatch(/no disk images/i);
    expect(r.detail, 'must name the remediation').toMatch(/mobile-bootstrap/);
  });

  it('reports the stale-residue signature as corroboration, not as the finding', () => {
    makeAvd('ACE_Pixel_API_34', [
      'config.ini',
      'snapshot.lock.tmp-aaa',
      'snapshot.lock.tmp-bbb',
      'hardware-qemu.ini.tmp-ccc',
    ]);
    const r = checkAvdProvisioned(home, 'ACE_Pixel_API_34');
    expect(r.provisioned).toBe(false);
    expect(r.staleResidueCount).toBe(3);
    expect(r.detail).toMatch(/residue/i);
  });

  it('does NOT fail a healthy AVD that also carries residue', () => {
    makeAvd('ok', ['config.ini', 'userdata-qemu.img', 'snapshot.lock.tmp-a']);
    expect(checkAvdProvisioned(home, 'ok').provisioned).toBe(true);
  });

  it('says UNKNOWN when the AVD directory is absent — a different failure, not this one', () => {
    const r = checkAvdProvisioned(home, 'never-created');
    expect(r.provisioned).toBe('unknown');
    expect(r.detail).toMatch(/does not exist/i);
  });

  it('never claims de-provisioning it cannot see — an unreadable dir is unknown too', () => {
    const r = checkAvdProvisioned('/definitely/not/a/path', 'x');
    expect(r.provisioned).toBe('unknown');
  });

  it('lists the images it did find, so the message is diagnosable at a glance', () => {
    makeAvd('partial', ['config.ini', 'cache.img']);
    const r = checkAvdProvisioned(home, 'partial');
    expect(r.provisioned).toBe(true);
    expect(r.images).toEqual(['cache.img']);
  });
});
