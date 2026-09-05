#!/usr/bin/env npx tsx
/**
 * `/ace:doctor`'s AVD-pool probe (dimagi-internal/ace#1821).
 *
 * The impure half of `lib/avd-pool-report.ts`: enumerate AVDs, read each one's
 * disk images, provisioning marker and live holders, and print a doctor-shaped
 * PASS / WARN / SKIP line. All decision logic lives in the pure helper and is
 * unit-tested there.
 *
 * ## Everything here is BORROWED
 *
 * Nothing in this file re-implements a check ACE already has:
 *
 *   - `checkAvdProvisioned`  (mcp/mobile/avd-provisioning.ts)      — disk images
 *   - `readProvisionedMarker` / `markerProvesFor`
 *                            (mcp/mobile/avd-provisioned-marker.ts) — proven
 *   - `parsePsRows` / `parseAvdHolders` (lib/mobile-contention.ts)  — holders
 *
 * The holder read in particular MUST come from `lib/mobile-contention.ts` and
 * not from a fresh `ps` parser: that module's own header records why two
 * contention detectors that disagree are worse than one dead one, and the
 * detector it replaced (`mcp/mobile/avd-contention.ts`, reading
 * `hardware-qemu.ini.lock`) reported "free to boot" against every ACE-launched
 * emulator for five weeks precisely because `-read-only` never writes that
 * lock. One `ps` capture, one parser.
 *
 * Scope note: this stays inside `/ace:doctor`'s charter — "is this machine set
 * up to run ACE". It reports pool CAPACITY, never artifact correctness; it
 * makes no claim about any opportunity, app or run.
 *
 * Never exits non-zero on its own failure — a diagnostic that breaks the
 * diagnostic is worse than a missing line.
 *
 * Test seam: `ACE_AVD_POOL_HOME` overrides the AVD home, `ACE_AVD_POOL_LIST`
 * supplies a newline-separated AVD list in place of `emulator -list-avds`, and
 * `ACE_AVD_POOL_PS_FIXTURE` points at a canned `ps` capture — so the whole
 * collector is exercisable in CI without an Android SDK or a live emulator.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { classifyAvdPool, type AvdPoolFacts } from '../lib/avd-pool-report.js';
import { parsePsRows, parseAvdHolders } from '../lib/mobile-contention.js';
import {
  readProvisionedMarker,
  markerProvesFor,
  markerPath,
} from '../mcp/mobile/avd-provisioned-marker.js';
import { checkAvdProvisioned } from '../mcp/mobile/avd-provisioning.js';
import { resolveActiveSelectorMapId } from '../mcp/mobile/recipe-resolver.js';

function avdHome(): string {
  return (
    process.env.ACE_AVD_POOL_HOME ??
    process.env.ANDROID_AVD_HOME ??
    path.join(os.homedir(), '.android', 'avd')
  );
}

/** Mirrors `AvdBackend.resolveEmulatorBin`'s search order, without importing the backend. */
function emulatorBin(): string | null {
  const sdk =
    process.env.ANDROID_SDK_ROOT ??
    process.env.ANDROID_HOME ??
    path.join(os.homedir(), 'Library', 'Android', 'sdk');
  for (const c of [path.join(sdk, 'emulator', 'emulator'), '/usr/local/bin/emulator']) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Returns null (→ SKIP), never [], when the list cannot be read at all. */
function listAvds(): string[] | null {
  if (process.env.ACE_AVD_POOL_LIST !== undefined) {
    return process.env.ACE_AVD_POOL_LIST.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const bin = emulatorBin();
  if (!bin) return null;
  try {
    return execFileSync(bin, ['-list-avds'], { encoding: 'utf8', timeout: 10_000 })
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('INFO') && !s.includes('Storing crashdata'));
  } catch {
    return null;
  }
}

function psCapture(): string {
  const fixture = process.env.ACE_AVD_POOL_PS_FIXTURE;
  if (fixture) {
    try {
      return readFileSync(fixture, 'utf8');
    } catch {
      return '';
    }
  }
  try {
    return execFileSync('ps', ['-eo', 'user=,pid=,ppid=,lstart=,command='], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

function main(): void {
  const home = avdHome();
  const names = listAvds();
  const requested = process.env.ACE_AVD_NAME || 'ACE_Pixel_API_34';

  if (names === null) {
    const report = classifyAvdPool([], { listed: false, requested });
    console.log(`SKIP avd_pool: ${report.reason}`);
    return;
  }

  // One `ps` capture for the whole pool — one read per probe, not one per AVD.
  const rows = parsePsRows(psCapture());

  const facts: AvdPoolFacts[] = names.map((name) => {
    const marker = readProvisionedMarker(home, name);
    return {
      name,
      provisioned: checkAvdProvisioned(home, name).provisioned,
      // Exactly the predicate `mcp/mobile/backends/avd.ts` applies when it
      // decides whether an entry may be a fallback. Borrowed, not re-derived —
      // including the selector-map identity, so a probe can never disagree with
      // the runtime about which AVDs are eligible (ace#1993).
      proven: markerProvesFor(marker, resolveActiveSelectorMapId()),
      markerPresent: existsSync(markerPath(home, name)),
      holders: parseAvdHolders(rows, name),
    };
  });

  const report = classifyAvdPool(facts, { listed: true, requested });

  if (report.verdict === 'warn') {
    console.log(`WARN ${report.reason}`);
    for (const m of report.members) console.log(`  - ${m.detail}`);
    if (report.remediation) {
      console.log('  fix: add a second AVD to the pool —');
      for (const line of report.remediation.split('\n')) console.log(`  ${line}`);
    }
  } else if (report.verdict === 'pass') {
    console.log(`PASS avd_pool: ${report.reason}`);
    for (const m of report.members) console.log(`  - ${m.detail}`);
  } else {
    console.log(`SKIP avd_pool: ${report.reason}`);
  }
}

try {
  main();
} catch (err) {
  console.log(`SKIP avd_pool: probe failed (${(err as Error).message})`);
}
