/**
 * dimagi-internal/ace#1909 — the #1047 contention detector read a file that
 * ACE's own `-read-only` flag guarantees is absent.
 *
 * `checkAvdContention` decided contention by reading exactly one file,
 * `<avd>.avd/hardware-qemu.ini.lock`. That observation was true when it was
 * written (2026-08-14) and was invalidated 16 days EARLIER in the same tree by
 * the flag that makes concurrent instances possible in the first place:
 *
 *     f089bd49  2026-07-29  fix(mobile): pass -read-only so two sessions can share one AVD
 *     a78c27d2  2026-08-14  fix(mobile): refuse a CONTENDED AVD before spawning (#1047 fix #3)
 *
 * Not taking the AVD lock is precisely HOW `-read-only` permits concurrency,
 * so under the flag the file is never created and the detector's read always
 * threw into the `catch` that returns `free to boot`.
 *
 * Measured on the affected host 2026-09-02, with a live ACE emulator up:
 *
 *   $ ps -eo user=,pid=,ppid=,command= | grep -- '-avd '
 *   acedimagi 29670 1 .../qemu-system-aarch64-headless -avd ACE_Pixel_API_34 \
 *       -no-window -no-audio -wipe-data -no-snapshot-load -no-snapshot-save \
 *       -read-only -port 5554
 *
 *   $ ls -la ~/.android/avd/ACE_Pixel_API_34.avd/ | grep -i lock
 *   -rw-r--r--@ 1 acedimagi staff 0 Sep 1 09:56 multiinstance.lock
 *
 *   $ ls ~/.android/avd/ACE_Pixel_API_34.avd/hardware-qemu.ini.lock
 *   ls: ...: No such file or directory
 *
 * The process table is therefore the only surface that can see an ACE-launched
 * holder, which is the same conclusion PR #1911 reached for cross-session MCP
 * contention (ace#1821) — so this reuses that module's `ps` substrate rather
 * than inventing a second, disagreeing contention signal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { checkAvdContention } from '../../../mcp/mobile/avd-contention.js';
import { parsePsRows } from '../../../lib/mobile-contention.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-ro-')); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/**
 * The AVD directory as `-read-only` actually leaves it: an EMPTY
 * `multiinstance.lock` marker and NO `hardware-qemu.ini.lock`.
 */
function makeReadOnlyAvdDir(name: string) {
  const dir = path.join(home, `${name}.avd`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'multiinstance.lock'), '');
  return dir;
}

const QEMU = '/opt/homebrew/share/android-commandlinetools/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless';

/** One verbatim-shaped `ps -eo user=,pid=,ppid=,lstart=,command=` line. */
function psLine(user: string, pid: number, ppid: number, command: string): string {
  return `${user} ${pid} ${ppid} Tue Sep  1 09:56:11 2026 ${command}`;
}

describe('checkAvdContention under -read-only (#1909)', () => {
  it('names a LIVE holder for an AVD dir that has only multiinstance.lock', () => {
    makeReadOnlyAvdDir('ACE_Pixel_API_34');
    const rows = parsePsRows(
      psLine('acedimagi', 29670, 1,
        `${QEMU} -avd ACE_Pixel_API_34 -no-window -no-audio -wipe-data ` +
        '-no-snapshot-load -no-snapshot-save -read-only -port 5554'),
    );

    const r = checkAvdContention(home, 'ACE_Pixel_API_34', { psRows: rows, selfPid: 999 });

    // THE REGRESSION: pre-#1909 this whole branch was unreachable and the
    // function returned `free to boot` against a live ACE emulator.
    expect(r.held).toBe(true);
    expect(r.heldBy.map((h) => h.pid)).toEqual([29670]);
    expect(r.detail).not.toMatch(/free to boot/);
  });

  it('marks an all-`-read-only` holder set SHAREABLE, and does not refuse the boot', () => {
    makeReadOnlyAvdDir('ACE_Pixel_API_34');
    const rows = parsePsRows(
      psLine('jjackson', 31002, 1,
        `${QEMU} -avd ACE_Pixel_API_34 -read-only -port 5558`),
    );

    const r = checkAvdContention(home, 'ACE_Pixel_API_34', { psRows: rows, selfPid: 999 });

    // `-read-only` exists SO THAT two instances may share one AVD. Refusing
    // here would convert every peer session on a one-AVD host from "limps to a
    // partial walk" into "dies immediately" (ace#1821 risk finding), while
    // Phase 6's one-way Learn precondition is burned either way.
    expect(r.held).toBe(true);
    expect(r.shareable).toBe(true);
    expect(r.contended).toBe(false);
  });

  it('REFUSES a read-write holder — the case the emulator itself rejects', () => {
    makeReadOnlyAvdDir('ACE_Pixel_API_34');
    const rows = parsePsRows(
      psLine('acedimagi', 40100, 1, `${QEMU} -avd ACE_Pixel_API_34 -port 5560`),
    );

    const r = checkAvdContention(home, 'ACE_Pixel_API_34', { psRows: rows, selfPid: 999 });

    expect(r.contended).toBe(true);
    expect(r.shareable).toBe(false);
    expect(r.holderPid).toBe(40100);
  });

  it('does not report OUR OWN emulator as a holder — matched on the allocated console port', () => {
    makeReadOnlyAvdDir('ACE_Pixel_API_34');
    const rows = parsePsRows(
      psLine('acedimagi', 29670, 1,
        `${QEMU} -avd ACE_Pixel_API_34 -read-only -port 5554`),
    );

    const r = checkAvdContention(home, 'ACE_Pixel_API_34', {
      psRows: rows,
      selfPid: 999,
      selfEmulatorPort: 5554,
    });

    expect(r.held).toBe(false);
    expect(r.heldBy).toEqual([]);
  });

  it('ignores an emulator holding a DIFFERENT AVD', () => {
    makeReadOnlyAvdDir('ACE_Pixel_API_34');
    const rows = parsePsRows(
      psLine('acedimagi', 29670, 1, `${QEMU} -avd ACE_Probe_API_34 -read-only -port 5554`),
    );

    const r = checkAvdContention(home, 'ACE_Pixel_API_34', { psRows: rows, selfPid: 999 });

    expect(r.held).toBe(false);
    expect(r.contended).toBe(false);
  });

  it('CONTROL: the lock-file path is untouched — a live pid in hardware-qemu.ini.lock still refuses', () => {
    const dir = makeReadOnlyAvdDir('ACE_Pixel_API_34');
    fs.writeFileSync(path.join(dir, 'hardware-qemu.ini.lock'), '39908\n');

    const r = checkAvdContention(home, 'ACE_Pixel_API_34', { isPidAlive: () => true });

    expect(r.contended).toBe(true);
    expect(r.holderPid).toBe(39908);
  });
});
