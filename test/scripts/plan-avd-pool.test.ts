/**
 * `--pool N` must ask the SAME eligibility question the doctor asks (ace#2089).
 *
 * `scripts/doctor-avd-pool.ts` (via `lib/avd-pool-report.ts`) and
 * `scripts/plan-avd-pool.ts` both answer "is this AVD usable as a `selectAvd`
 * fallback?". The doctor borrowed the runtime's predicate —
 * `markerProvesFor(readProvisionedMarker(...), resolveActiveSelectorMapId())`.
 * The planner re-derived a weaker one: does the marker FILE exist?
 *
 * Marker PRESENCE and marker VALIDITY are not the same question, and the gap
 * between them is the #591/#593 selector-map drift trap. So on a host where
 * every marker was written under a previous map the two disagreed completely,
 * and disagreed in the direction that ends the conversation:
 *
 *     $ doctor-avd-pool
 *     WARN avd_pool: NO AVD … is both provisioned and proven — 0 eligible, 2 needed
 *       fix: /ace:mobile-bootstrap --pool 2
 *     $ plan-avd-pool --size 2
 *       reference: ACE_Pixel_API_34 (proven)
 *       nothing to do.
 *
 * The doctor's remediation is the command that reports nothing to do. And the
 * `unproven` list the planner suppressed is not decoration: `--pool` never
 * boots anything itself, so that list IS the instruction set the command prose
 * iterates ("for each member that is missing or `unproven`", step 4 of
 * `commands/mobile-bootstrap.md`). An empty list means no member is
 * re-provisioned and the pool stays at zero eligible.
 *
 * The last test here is the one that matters most: it runs BOTH scripts
 * against ONE fixture home and asserts their answers are complements. A future
 * change that makes either drift again fails there, whichever side moves.
 *
 * Classification: unit-test truth. Temp directories, a canned `ps` capture, and
 * two subprocesses. No emulator, no SDK, no device — the inputs are a directory
 * listing and a JSON file, and nothing is sent to or matched against a device.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveActiveSelectorMapId } from '../../mcp/mobile/recipe-resolver';
import { MARKER_FILENAME } from '../../mcp/mobile/avd-provisioned-marker';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLANNER = path.join(ROOT, 'scripts', 'plan-avd-pool.ts');
const DOCTOR = path.join(ROOT, 'scripts', 'doctor-avd-pool.ts');

/** Resolved the same way both scripts resolve it, so the sides agree by construction. */
const ACTIVE_MAP = resolveActiveSelectorMapId();
const BASE = 'ACE_Pixel_API_34';

/** A live `-read-only` emulator, in real `ps` shape — the doctor wants one. */
const PS_ROWS = [
  'acedimagi 41133 1 Fri Sep  5 07:57:11 2026 /Users/x/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd ACE_Pixel_API_34 -read-only -port 5554',
].join('\n');

/**
 * A pool member on disk. `marker: 'stale'` writes one recorded under a
 * DIFFERENT selector map — a real file, which is exactly why marker PRESENCE
 * could never tell it apart from a good one.
 */
function makeAvd(
  home: string,
  name: string,
  opts: { marker?: boolean | 'stale' } = {},
): void {
  const dir = path.join(home, `${name}.avd`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(home, `${name}.ini`), `path=${dir}\n`);
  writeFileSync(
    path.join(dir, 'config.ini'),
    'tag.id=google_apis_playstore\nimage.sysdir.1=system-images/android-34/google_apis_playstore/arm64-v8a/\nhw.ramSize=4096\n',
  );
  writeFileSync(path.join(dir, 'userdata.img'), '');
  if (opts.marker) {
    writeFileSync(
      path.join(dir, MARKER_FILENAME),
      JSON.stringify({
        marked_at: '2026-09-01T14:00:21.449Z',
        selector_map: opts.marker === 'stale' ? 'connect-2.62.0@deadbeefcafe' : ACTIVE_MAP,
      }),
    );
  }
}

function plan(home: string, size = 2): string {
  return execFileSync('npx', ['tsx', PLANNER, '--size', String(size), '--avd-home', home], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ACE_AVD_NAME: BASE },
    timeout: 120_000,
  });
}

function planJson(home: string, size = 2): Record<string, unknown> {
  const out = execFileSync(
    'npx',
    ['tsx', PLANNER, '--size', String(size), '--avd-home', home, '--json'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ACE_AVD_NAME: BASE }, timeout: 120_000 },
  );
  // Parsed WHOLE, deliberately. This used to hunt for the first line that was
  // exactly `{`, because `loadPluginEnv` let dotenv print its banner on stdout
  // ahead of the JSON — and since five of dotenv's eight rotating tips contain
  // a `{`, slicing at the first brace landed inside the banner. ace#2095 moved
  // that diagnostic to stderr where it belongs, so the workaround is gone and
  // its absence is now the regression anchor: restore the banner and every
  // caller of this helper fails.
  return JSON.parse(out) as Record<string, unknown>;
}

function doctor(home: string, list: string, psFixture: string): string {
  return execFileSync('npx', ['tsx', DOCTOR], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ACE_AVD_POOL_HOME: home,
      ACE_AVD_POOL_LIST: list,
      ACE_AVD_POOL_PS_FIXTURE: psFixture,
      ACE_AVD_NAME: BASE,
    },
    timeout: 120_000,
  });
}

/** The pre-fix predicate, reproduced verbatim from `scripts/plan-avd-pool.ts` @ a402eabe. */
const legacyIsProven = (home: string, name: string): boolean =>
  existsSync(path.join(home, `${name}.avd`, MARKER_FILENAME));

// ───────────────────────────────────────────────────────────────────────────
// The affected host: every member carries a marker, none proves for this map.
// ───────────────────────────────────────────────────────────────────────────
let staleHome: string;
let healthyHome: string;
let psFixture: string;

beforeAll(() => {
  staleHome = mkdtempSync(path.join(os.tmpdir(), 'ace-plan-pool-stale-'));
  makeAvd(staleHome, BASE, { marker: 'stale' });
  makeAvd(staleHome, `${BASE}_b`, { marker: 'stale' });

  healthyHome = mkdtempSync(path.join(os.tmpdir(), 'ace-plan-pool-ok-'));
  makeAvd(healthyHome, BASE, { marker: true });
  makeAvd(healthyHome, `${BASE}_b`, { marker: true });

  psFixture = path.join(staleHome, 'ps.txt');
  writeFileSync(psFixture, PS_ROWS);
});

afterAll(() => {
  rmSync(staleHome, { recursive: true, force: true });
  rmSync(healthyHome, { recursive: true, force: true });
});

describe('positive control: the pre-fix predicate calls a stale-marker AVD proven', () => {
  it('marker PRESENCE is true for a marker that proves nothing', () => {
    expect(legacyIsProven(staleHome, BASE)).toBe(true);
    expect(legacyIsProven(staleHome, `${BASE}_b`)).toBe(true);
  });

  it('the fixture actually discriminates — the two predicates differ on it', () => {
    const report = planJson(staleHome);
    expect(legacyIsProven(staleHome, BASE)).toBe(true);
    expect(report.reference_is_proven).toBe(false);
  });
});

describe('the planner reports what the doctor reports', () => {
  it('lists every stale-marker member as unproven', () => {
    const report = planJson(staleHome);
    expect(report.missing).toEqual([]);
    expect(report.unproven).toEqual([BASE, `${BASE}_b`]);
  });

  it('names the active selector map, so a disagreement is diagnosable', () => {
    expect(planJson(staleHome).active_selector_map).toBe(ACTIVE_MAP ?? null);
  });

  it('distinguishes a stale marker from an absent one — the remediation differs', () => {
    const out = plan(staleHome);
    expect(out).toMatch(/marker recorded under a DIFFERENT selector map/);

    const absent = mkdtempSync(path.join(os.tmpdir(), 'ace-plan-pool-absent-'));
    try {
      makeAvd(absent, BASE, { marker: true });
      makeAvd(absent, `${BASE}_b`); // no marker at all
      expect(plan(absent)).toMatch(new RegExp(`no ${MARKER_FILENAME.replace('.', '\\.')}`));
    } finally {
      rmSync(absent, { recursive: true, force: true });
    }
  });
});

describe('"nothing to do" must mean there is nothing to do', () => {
  it('does NOT say it when members exist but are ineligible', () => {
    const out = plan(staleHome);
    expect(out).not.toMatch(/nothing to do/);
    expect(out).toMatch(/NOT eligible as a selectAvd fallback/);
  });

  it('still says it on a genuinely healthy pool — the fix is not a blanket alarm', () => {
    const out = plan(healthyHome);
    expect(out).toMatch(/nothing to do/);
    expect(out).not.toMatch(/unproven/);
  });
});

describe('the planner and the doctor cannot drift apart again', () => {
  it('agree that the stale pool has zero eligible members', () => {
    const planned = planJson(staleHome);
    const probed = doctor(staleHome, `${BASE}\n${BASE}_b`, psFixture);

    expect(probed).toMatch(/^WARN avd_pool:/);
    expect(probed).toMatch(/0 eligible, 2 needed/);
    // Every member the doctor calls ineligible, the planner calls unproven.
    expect(planned.unproven).toEqual([BASE, `${BASE}_b`]);
  });

  it('agree that the healthy pool has two eligible members', () => {
    const okPs = path.join(healthyHome, 'ps.txt');
    writeFileSync(okPs, PS_ROWS);
    const planned = planJson(healthyHome);
    const probed = doctor(healthyHome, `${BASE}\n${BASE}_b`, okPs);

    expect(probed).toMatch(/^PASS avd_pool:/);
    expect(probed).toMatch(/2 of 2 AVD\(s\) are provisioned and proven/);
    expect(planned.unproven).toEqual([]);
    expect(planned.reference_is_proven).toBe(true);
  });

  it('the planner borrows the predicate rather than re-deriving it', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'plan-avd-pool.ts'), 'utf8');
    expect(src).toMatch(/markerProvesFor\(readProvisionedMarker\(/);
    // The weaker question must not come back as the eligibility test. It may
    // still appear in `unprovenDetail`, which asks a DIFFERENT question — which
    // of the two ways to fail this is — so the assertion is scoped to the
    // `isProven` definition.
    const isProvenDef = src.slice(src.indexOf('const isProven'), src.indexOf('const unprovenDetail'));
    expect(isProvenDef).not.toMatch(/existsSync/);
  });
});
