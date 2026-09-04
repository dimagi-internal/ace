/**
 * Static guard for the ace#1797 half of the mobile backend-toggle
 * test-isolation family.
 *
 * Several mobile suites pin `process.env.ACE_MOBILE_BACKEND = 'local'` at
 * MODULE SCOPE (outside any beforeEach/afterEach) so their result does not
 * depend on which worker they share. That pin is load-bearing for the whole
 * file's lifetime.
 *
 * A bare `delete process.env.ACE_MOBILE_BACKEND` inside such a file drops
 * that pin permanently rather than restoring it — the exact defect at
 * client-recording.test.ts:378. With the pin gone, `resolveBackend()` falls
 * through to the session file, and every subsequent test in that file (and
 * any file that follows it in the worker) is exposed to whatever another
 * worker last left there.
 *
 * The seam in mcp/mobile/backend-toggle.ts now makes that file per-worker,
 * so the leak has no shared source to draw from. This test keeps the second
 * half honest anyway: within a file, a module-scope pin must be restored,
 * not deleted. The correct idiom is save-then-restore:
 *
 *     const prev = process.env.ACE_MOBILE_BACKEND;
 *     process.env.ACE_MOBILE_BACKEND = 'cloud';
 *     try { ... } finally {
 *       if (prev === undefined) delete process.env.ACE_MOBILE_BACKEND;
 *       else process.env.ACE_MOBILE_BACKEND = prev;
 *     }
 *
 * A `delete` guarded by an `if (prev === undefined)` is the restore idiom
 * and is allowed; a bare one is not.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE_TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const VAR = 'ACE_MOBILE_BACKEND';

/** Module-scope = a bare assignment at column 0, not indented inside a hook. */
function hasModuleScopePin(src: string): boolean {
  return src
    .split('\n')
    .some((line) => line.startsWith(`process.env.${VAR}`) && line.includes('='));
}

function mobileTestFiles(): string[] {
  return fs
    .readdirSync(MOBILE_TEST_DIR)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => path.join(MOBILE_TEST_DIR, f));
}

describe('mobile suites must not drop a module-scope ACE_MOBILE_BACKEND pin', () => {
  it('finds the files this guard is meant to cover', () => {
    const pinned = mobileTestFiles().filter((f) =>
      hasModuleScopePin(fs.readFileSync(f, 'utf8')),
    );
    // If this drops to zero the guard has gone silently inert — either the
    // pins were removed (fine, delete this test) or the regex rotted.
    expect(pinned.length).toBeGreaterThan(0);
  });

  it('never deletes the pin instead of restoring it', () => {
    const offenders: string[] = [];

    for (const file of mobileTestFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      if (!hasModuleScopePin(src)) continue;

      src.split('\n').forEach((line, i) => {
        if (!line.includes(`delete process.env.${VAR}`)) return;
        // The restore idiom guards the delete with an undefined-check on
        // the saved value, on the same line.
        if (/===\s*undefined/.test(line)) return;
        offenders.push(`${path.basename(file)}:${i + 1}: ${line.trim()}`);
      });
    }

    expect(
      offenders,
      `A module-scope ${VAR} pin is dropped by a bare delete (ace#1797).\n` +
        `Save the previous value and restore it instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
