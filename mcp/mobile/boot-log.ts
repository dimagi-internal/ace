/**
 * Recover the emulator boot log when a failure surfaces somewhere that never
 * saw the boot.
 *
 * Why this exists (dimagi-internal/ace#1357, fix #1). The cold-boot path
 * already attaches the log's tail — but only inside its OWN catch. Any
 * failure that surfaces later loses it, and "later" is where these failures
 * actually appear. Phase 6 on bednet-check-2-visit/20260814-0856 produced
 * three consecutive errors that named neither the emulator, the AVD, nor
 * `/ace:mobile-bootstrap`:
 *
 * ```
 * register_test_user part B failed: Exception in thread "Thread-5"
 *   java.net.SocketException: Broken pipe ... dadb.AdbWriter.writeClose
 * register_test_user part B failed: Failed to install apk
 *   /var/.../maestro-app*.apk: Connection refused ... dadb.DadbImpl.newConnection
 * ```
 *
 * while the cause sat in the MCP's own log the whole time:
 *
 * ```
 * qemu-system-aarch64-headless: Could not open '…/cache.img': No such file
 * WARNING | QEMU main loop exits abnormally with code 1
 * ```
 *
 * Recovering it meant hunting `${TMPDIR}/ace-emulator-*.log` by hand — and the
 * probe disclaimer attached to the first error actively routed the operator to
 * "fix the probe path first", which is the wrong lead.
 *
 * ## Why by RECENCY rather than by port
 *
 * `requireRunningAvd` is where a downstream caller discovers there is no
 * device, which makes it the right place to say why — but it does not know
 * which console port the dead boot used (the port is allocated inside the
 * cold-boot it never ran). So the log is found by mtime, bounded by an age
 * window so a stale log from an unrelated boot hours ago cannot be presented
 * as this failure's cause.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Boot logs older than this are not evidence about the failure in hand. */
export const BOOT_LOG_MAX_AGE_MS = 15 * 60 * 1000;

const BOOT_LOG = /^ace-emulator-\d+\.log$/;

/** The most recent emulator boot log in `dir`, if one is recent enough. */
export function findLatestBootLog(dir: string, nowMs: number = Date.now()): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: { file: string; mtimeMs: number } | undefined;
  for (const f of entries) {
    if (!BOOT_LOG.test(f)) continue;
    try {
      const { mtimeMs } = fs.statSync(path.join(dir, f));
      if (nowMs - mtimeMs > BOOT_LOG_MAX_AGE_MS) continue;
      if (!best || mtimeMs > best.mtimeMs) best = { file: f, mtimeMs };
    } catch {
      /* raced away between readdir and stat */
    }
  }
  return best ? path.join(dir, best.file) : undefined;
}

/**
 * The last `lines` lines. The fatal is emitted LAST and a full boot log runs
 * to hundreds of lines of device/GL chatter, so the tail is the signal.
 */
export function bootLogTail(logPath: string, lines = 12): string {
  try {
    return fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * The one line that says what actually went wrong, when there is one.
 * Returns undefined on a healthy log rather than inventing a cause.
 */
export function fatalBootLine(logText: string): string | undefined {
  const lines = logText.split('\n');
  return (
    lines.find((l) => /could not open/i.test(l)) ??
    lines.find((l) => /exits abnormally|fatal|cannot boot/i.test(l))
  );
}
