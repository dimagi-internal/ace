import { describe, it, expect } from 'vitest';
import { scopeOrphanQemuKills, type LiveSessionClaim } from '../../lib/avd-orphan-scope.js';
import { parseEmulatorProcesses, parsePsRows } from '../../lib/mobile-contention.js';

/**
 * ace#1821 — `sweepStaleEmulatorState` SIGKILLed every peer session's
 * emulator at dispatch start.
 *
 * The controls below are the point of this file. A test that passes against
 * BOTH the old and the new logic proves nothing, so the pre-fix decision is
 * reproduced verbatim as `legacyKillDecision` and asserted to kill the peer.
 * If a future change makes the fixture stop discriminating, the positive
 * control fails and says so.
 */

// ───────────────────────────────────────────────────────────────────────────
// The fixture: two sessions on one macOS account, one live and one crashed.
//
// Shaped like a real `ps -eo user=,pid=,ppid=,lstart=,command=` capture, with
// the three-process tsx chain omitted (emulators are detached, ppid 1 — see
// lib/mobile-contention.ts § "the one thing that is easy to get wrong").
//
//   pid 62329  console 5554  — LIVE peer session, mcp_pid 40001 holds the lock
//   pid 62777  console 5556  — OUR OWN session's emulator
//   pid 51002  console 5558  — TRUE orphan: its session crashed, lock reaped
// ───────────────────────────────────────────────────────────────────────────

const PS_CAPTURE = [
  'acedimagi 62329 1 Fri Sep  5 08:12:03 2026 /Users/acedimagi/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd ACE_Pixel_API_34 -read-only -port 5554 -no-snapshot-load',
  'acedimagi 62777 1 Fri Sep  5 09:01:44 2026 /Users/acedimagi/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd ACE_Pixel_API_34_b -read-only -port 5556 -no-snapshot-load',
  'acedimagi 51002 1 Fri Sep  5 06:30:10 2026 /Users/acedimagi/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd ACE_Pixel_API_34_c -read-only -port 5558 -no-snapshot-load',
  'acedimagi 99001 1 Fri Sep  5 07:00:00 2026 /usr/sbin/notifyd',
].join('\n');

/** What `pgrep -u <uid> -f qemu-system` returns for that capture. */
const QEMU_PIDS = [51002, 62329, 62777];

const PEER_PID = 62329;
const SELF_PID = 62777;
const ORPHAN_PID = 51002;

const SELF_CONSOLE_PORT = 5556;

/** Only the peer's session is alive; the orphan's lock was reaped with its pid. */
const LIVE_CLAIMS: LiveSessionClaim[] = [
  { mcpPid: 40001, consolePort: 5554, avdName: 'ACE_Pixel_API_34', oppSlug: 'bednet-check-2-visit' },
  { mcpPid: 40002, consolePort: 5556, avdName: 'ACE_Pixel_API_34_b', oppSlug: 'malaria-rdt' },
];

const processes = parseEmulatorProcesses(parsePsRows(PS_CAPTURE));

// ───────────────────────────────────────────────────────────────────────────
// POSITIVE CONTROL — the pre-fix logic, reproduced verbatim from
// mcp/mobile/backends/avd.ts as it stood on origin/main @ e506d597.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The decision this PR deletes. `liveCount` is the number of `emulator-*`
 * serials on THIS session's adb server — freshly allocated at dispatch start,
 * so it has scanned nothing and reports 0 while peers run on their own
 * servers.
 */
function legacyKillDecision(qemuPids: readonly number[], liveCount: number): number[] {
  if (liveCount === 0) return [...qemuPids];
  if (qemuPids.length > liveCount) return qemuPids.slice(0, qemuPids.length - liveCount);
  return [];
}

describe('positive control: the pre-fix logic kills a live peer (ace#1821)', () => {
  it('kills EVERY qemu — peer included — when this session sees no devices', () => {
    // A freshly-allocated adb server has scanned nothing: liveCount === 0.
    const killed = legacyKillDecision(QEMU_PIDS, 0);

    expect(killed).toEqual([51002, 62329, 62777]);
    expect(killed).toHaveLength(3);
    // The defect, named: the live peer's emulator is in the kill list.
    expect(killed).toContain(PEER_PID);
  });

  it('still kills the peer via the partial "excess" branch when one device is visible', () => {
    // Even once our own emulator registers, peers inflate qemuPids and can
    // never appear in our `adb devices` — so the excess branch fires, and it
    // slices lowest-pid-first, which is not an ownership test either.
    const killed = legacyKillDecision(QEMU_PIDS, 1);

    expect(killed).toHaveLength(2);
    expect(killed).toContain(PEER_PID);
  });

  it('the fixture actually discriminates — the two decisions differ', () => {
    // Guards against an inert suite: if this ever passes trivially, the
    // negative control below proves nothing.
    const legacy = legacyKillDecision(QEMU_PIDS, 0);
    const fixed = scopeOrphanQemuKills({
      qemuPids: QEMU_PIDS,
      processes,
      liveClaims: LIVE_CLAIMS,
      selfConsolePort: SELF_CONSOLE_PORT,
    }).killable;

    expect(legacy).not.toEqual(fixed);
    expect(legacy).toHaveLength(3);
    expect(fixed).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// NEGATIVE CONTROL — post-fix, the peer survives and the true orphan dies.
// ───────────────────────────────────────────────────────────────────────────

describe('negative control: attribution spares the peer and still reaps the orphan', () => {
  const result = scopeOrphanQemuKills({
    qemuPids: QEMU_PIDS,
    processes,
    liveClaims: LIVE_CLAIMS,
    selfConsolePort: SELF_CONSOLE_PORT,
  });

  it('kills exactly one pid: the true orphan', () => {
    expect(result.killable).toEqual([ORPHAN_PID]);
  });

  it('spares the live peer, naming the session that holds it', () => {
    expect(result.spared).toContain(PEER_PID);
    const v = result.verdicts.find((x) => x.pid === PEER_PID)!;
    expect(v.kill).toBe(false);
    expect(v.reason).toBe('held-by-live-session');
    expect(v.heldByMcpPid).toBe(40001);
    expect(v.consolePort).toBe(5554);
  });

  it('spares our own emulator — the cold-boot path owns it, not the sweep', () => {
    const v = result.verdicts.find((x) => x.pid === SELF_PID)!;
    expect(v.kill).toBe(false);
    expect(v.reason).toBe('self');
  });

  it('reaps the crashed session\'s emulator because its lock was reaped with its pid', () => {
    const v = result.verdicts.find((x) => x.pid === ORPHAN_PID)!;
    expect(v.kill).toBe(true);
    expect(v.reason).toBe('orphan');
    expect(v.consolePort).toBe(5558);
  });

  it('returns a verdict for every candidate, in input order', () => {
    expect(result.verdicts.map((v) => v.pid)).toEqual(QEMU_PIDS);
    expect(result.killable.length + result.spared.length).toBe(QEMU_PIDS.length);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The capability that must NOT be lost.
// ───────────────────────────────────────────────────────────────────────────

describe('malaria-itn-fgd attempt-10: this session\'s own orphan still dies', () => {
  it('kills every qemu when NO session lock is live', () => {
    // The original reproducer: 2 orphan qemu from prior crashed boots, no
    // live session, wedged adb daemon. Every lock is reaped, so nothing is
    // claimed and everything is killable — the recovery is intact.
    const result = scopeOrphanQemuKills({
      qemuPids: QEMU_PIDS,
      processes,
      liveClaims: [],
      selfConsolePort: null,
    });
    expect(result.killable).toEqual([51002, 62329, 62777]);
    expect(result.spared).toEqual([]);
  });

  it('a dead session\'s stale lock cannot protect its emulator', () => {
    // listLiveSessionLocks() drops dead mcp_pids before we ever see them, so
    // a crashed session contributes no claim. Pinned here so a future change
    // that starts passing ALL locks through is caught.
    const result = scopeOrphanQemuKills({
      qemuPids: [ORPHAN_PID],
      processes,
      liveClaims: [],
      selfConsolePort: null,
    });
    expect(result.killable).toEqual([ORPHAN_PID]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The deliberate asymmetry: unattributable spares.
// ───────────────────────────────────────────────────────────────────────────

describe('unattributable candidates are spared, not killed', () => {
  it('spares a pid with no process-table row', () => {
    const result = scopeOrphanQemuKills({
      qemuPids: [777777],
      processes,
      liveClaims: LIVE_CLAIMS,
      selfConsolePort: SELF_CONSOLE_PORT,
    });
    expect(result.killable).toEqual([]);
    expect(result.verdicts[0].reason).toBe('unattributable-no-ps-row');
  });

  it('spares an emulator whose argv carries no -port', () => {
    const rows = parsePsRows(
      'acedimagi 63000 1 Fri Sep  5 08:00:00 2026 /opt/android/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Some_Other_AVD',
    );
    const result = scopeOrphanQemuKills({
      qemuPids: [63000],
      processes: parseEmulatorProcesses(rows),
      liveClaims: LIVE_CLAIMS,
      selfConsolePort: SELF_CONSOLE_PORT,
    });
    expect(result.killable).toEqual([]);
    expect(result.verdicts[0].reason).toBe('unattributable-no-console-port');
  });

  it('empty input yields empty output rather than throwing', () => {
    const result = scopeOrphanQemuKills({
      qemuPids: [],
      processes: [],
      liveClaims: [],
      selfConsolePort: null,
    });
    expect(result.killable).toEqual([]);
    expect(result.verdicts).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// `adb devices` must not come back.
// ───────────────────────────────────────────────────────────────────────────

describe('the deleted inference stays deleted', () => {
  it('the decision module never mentions adb', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      new URL('../../lib/avd-orphan-scope.ts', import.meta.url).pathname,
      'utf8',
    );
    // Prose in the header explains WHY adb devices is gone; the code must not
    // consult it. Strip block comments before asserting.
    const code = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/adb/i);
  });

  it('the sweep no longer branches on an adb device count', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      new URL('../../mcp/mobile/backends/avd.ts', import.meta.url).pathname,
      'utf8',
    );
    // `liveCount` was the variable that carried the false inference.
    expect(src).not.toMatch(/const liveCount\b/);
    expect(src).not.toMatch(/no adb devices visible/);
  });
});
