/**
 * dimagi-internal/ace#1357 fix #1 — the boot log was attached only inside the
 * cold-boot's own catch, so any failure that surfaced LATER lost it.
 *
 * Phase 6 on bednet-check-2-visit/20260814-0856: three consecutive
 * `mobile_ensure_avd_running` calls failed at `register_test_user part B` with
 * errors naming neither the emulator, the AVD, nor `/ace:mobile-bootstrap`:
 *
 *   register_test_user part B failed: Exception in thread "Thread-5"
 *     java.net.SocketException: Broken pipe ... dadb.AdbWriter.writeClose
 *   register_test_user part B failed: Failed to install apk
 *     /var/.../maestro-app*.apk: Connection refused ... dadb.DadbImpl.newConnection
 *
 * The cause was sitting in the MCP's own boot log the whole time:
 *
 *   qemu-system-aarch64-headless: Could not open '.../cache.img': No such file
 *   WARNING | QEMU main loop exits abnormally with code 1
 *
 * Recovering it took hunting `${TMPDIR}/ace-emulator-*.log` by hand. The
 * attached probe disclaimer meanwhile routed the operator to "fix the probe
 * path first", which is the wrong lead entirely.
 *
 * `requireRunningAvd` is where a downstream caller discovers there is no
 * device, and it is the natural place to say WHY — but it does not know which
 * console port the dead boot used, so the log has to be found by recency.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  findLatestBootLog,
  bootLogTail,
  fatalBootLine,
  BOOT_LOG_MAX_AGE_MS,
} from '../../../mcp/mobile/boot-log.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootlog-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeLog(name: string, body: string, ageMs = 0) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  if (ageMs) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(p, t, t);
  }
  return p;
}

const LIVE_LOG = [
  'INFO | Storing crashdata',
  "qemu-system-aarch64-headless: Could not open '/Users/j/.android/avd/../avd/ACE_Pixel_API_34.avd/cache.img': No such file or directory",
  'WARNING | QEMU main loop exits abnormally with code 1',
].join('\n');

describe('findLatestBootLog (#1357)', () => {
  it('finds the most recent ace-emulator-*.log', () => {
    writeLog('ace-emulator-5554.log', 'old', 60_000);
    const newest = writeLog('ace-emulator-5556.log', 'new');
    expect(findLatestBootLog(dir)).toBe(newest);
  });

  it('ignores files that are not emulator boot logs', () => {
    writeLog('some-other.log', 'x');
    expect(findLatestBootLog(dir)).toBeUndefined();
  });

  it('ignores a log too old to be about this failure', () => {
    writeLog('ace-emulator-5554.log', LIVE_LOG, BOOT_LOG_MAX_AGE_MS + 60_000);
    expect(findLatestBootLog(dir)).toBeUndefined();
  });

  it('returns undefined for a directory that does not exist, rather than throwing', () => {
    expect(findLatestBootLog(path.join(dir, 'nope'))).toBeUndefined();
  });
});

describe('bootLogTail (#1357)', () => {
  it('returns the last N lines — the fatal is emitted last', () => {
    writeLog('ace-emulator-5554.log', Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'));
    const tail = bootLogTail(path.join(dir, 'ace-emulator-5554.log'), 12);
    expect(tail.split('\n')).toHaveLength(12);
    expect(tail).toMatch(/line 199$/);
  });

  it('is empty for an unreadable path rather than throwing', () => {
    expect(bootLogTail(path.join(dir, 'missing.log'), 12)).toBe('');
  });
});

describe('fatalBootLine (#1357)', () => {
  it('extracts the qemu fatal from the live log', () => {
    expect(fatalBootLine(LIVE_LOG)).toMatch(/Could not open .*cache\.img/);
  });

  it('extracts the abnormal-exit line when there is no Could-not-open', () => {
    expect(fatalBootLine('INFO | x\nWARNING | QEMU main loop exits abnormally with code 1')).toMatch(
      /exits abnormally/,
    );
  });

  it('returns undefined on a healthy log rather than inventing a cause', () => {
    expect(fatalBootLine('INFO | boot completed\nINFO | all good')).toBeUndefined();
  });
});
