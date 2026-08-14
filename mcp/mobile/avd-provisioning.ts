/**
 * Is the target AVD actually provisioned, or is the emulator about to be
 * spawned onto a directory with no disk images?
 *
 * Why this exists (dimagi-internal/ace#1357). On
 * bednet-check-2-visit/20260814-0856 Phase 6, three consecutive
 * `mobile_ensure_avd_running` calls failed at `register_test_user part B`
 * with errors that named neither the cause nor the remediation:
 *
 * ```
 * register_test_user part B failed: Exception in thread "Thread-5"
 *   java.net.SocketException: Broken pipe ... dadb.AdbWriter.writeClose
 * register_test_user part B failed: Failed to install apk
 *   /var/.../maestro-app*.apk: Connection refused ... dadb.DadbImpl.newConnection
 * ```
 *
 * Neither mentions the emulator, the AVD, or `/ace:mobile-bootstrap` — and
 * the probe disclaimer attached to the first one actively routes the operator
 * to "fix the probe path first", which is the wrong lead.
 *
 * The real cause, from the MCP's own boot log:
 *
 * ```
 * qemu-system-aarch64-headless: Could not open
 *   '.../ACE_Pixel_API_34.avd/cache.img': No such file or directory
 * WARNING | QEMU main loop exits abnormally with code 1
 * ```
 *
 * `~/.android/avd/ACE_Pixel_API_34.avd/` held **zero** `*.img` files — only
 * `config.ini`, `initrd`, `emu-launch-params.txt` and ~120 stale
 * `snapshot.lock.tmp-*` / `hardware-qemu.ini.tmp-*` residue files. The sibling
 * `ACE_Pixel_API_34_PS.avd` still had a complete image set.
 *
 * Checked BEFORE the spawn, this turns a 60-second doomed boot plus an opaque
 * dadb error into an immediate error naming `/ace:mobile-bootstrap`.
 *
 * ## Why "zero images", not a required-file list
 *
 * Which images a given AVD needs varies by API level and system image, so a
 * list of required names would be a guess about another tool's layout — the
 * class ACE's conventions warn against. "The directory contains no `*.img` at
 * all" is unambiguous, is exactly what was observed, and cannot false-positive
 * on a healthy AVD.
 *
 * The stale-residue count is reported as CORROBORATION, never as the finding:
 * a healthy AVD carrying residue is still healthy.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AvdProvisioningReport {
  /** `'unknown'` when the directory cannot be read — never assume the worst. */
  provisioned: boolean | 'unknown';
  avdDir: string;
  /** The `*.img` files found, for a message that is diagnosable at a glance. */
  images: string[];
  /** `snapshot.lock.tmp-*` / `hardware-qemu.ini.tmp-*` leftovers. */
  staleResidueCount: number;
  detail: string;
}

const RESIDUE = /^(snapshot\.lock\.tmp-|hardware-qemu\.ini\.tmp-)/;

export function checkAvdProvisioned(avdHome: string, avdName: string): AvdProvisioningReport {
  const avdDir = path.join(avdHome, `${avdName}.avd`);
  let entries: string[];
  try {
    entries = fs.readdirSync(avdDir);
  } catch {
    return {
      provisioned: 'unknown',
      avdDir,
      images: [],
      staleResidueCount: 0,
      detail:
        `AVD directory ${avdDir} does not exist or cannot be read — that is a different failure ` +
        'from de-provisioning, so this check makes no claim about it',
    };
  }

  const images = entries.filter((e) => e.endsWith('.img')).sort();
  const staleResidueCount = entries.filter((e) => RESIDUE.test(e)).length;

  if (images.length > 0) {
    return {
      provisioned: true,
      avdDir,
      images,
      staleResidueCount,
      detail: `${avdDir} carries ${images.length} disk image(s): ${images.join(', ')}`,
    };
  }

  return {
    provisioned: false,
    avdDir,
    images,
    staleResidueCount,
    detail:
      `${avdDir} contains no disk images (*.img) — the AVD is de-provisioned and qemu will exit ` +
      `with "Could not open '…/cache.img'" the moment it is spawned. Re-provision it with ` +
      '`/ace:mobile-bootstrap`; do NOT reinstall the app or re-register the test user, which is ' +
      'where the downstream dadb error otherwise points' +
      (staleResidueCount > 0
        ? `. Corroborating: ${staleResidueCount} stale snapshot/hardware residue file(s) remain`
        : ''),
  };
}
