/**
 * Guard for ace#1912 — subprocess-spawning tests must not run under a
 * timeout that measures how busy the box is rather than whether the code
 * works.
 *
 * 20 test files in this repo spawn REAL subprocesses via `node:child_process`
 * (version-bump.sh, the doctor probe, lock holders, hook guards, schema
 * dumpers). Not one of them declared a timeout, so every one ran under
 * vitest's 5000ms default. Process startup under a saturated box routinely
 * crosses that, and the failures land just over the line — measured on main
 * @ 7336f2f0 with two full suites running concurrently, 6 runs: 10 failures
 * across session-lock-e2e (5), version-bump (4) and run-xform-patch (1),
 * every one `Error: Test timed out in 5000ms` at 5003-5699ms.
 *
 * The fix is a raised global testTimeout/hookTimeout in vitest.config.ts,
 * which covers all 20 and every file added later — the 4 that #1912 happened
 * to name were not special, they were just the ones that fired that day.
 *
 * This test is the ratchet. It fails if someone "tidies" the config back
 * toward the default, and it re-derives the file list rather than hardcoding
 * it, so a new subprocess-spawning test is covered the moment it lands.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Floor below which the ace#1912 flake class comes back. */
const MIN_TIMEOUT_MS = 20_000;

function walkTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'eval') continue;
      walkTestFiles(full, out);
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function readConfigTimeout(key: 'testTimeout' | 'hookTimeout'): number | null {
  const cfg = fs.readFileSync(path.join(REPO_ROOT, 'vitest.config.ts'), 'utf8');
  // Matches `testTimeout: 30_000,` and `testTimeout: 30000,`
  const m = cfg.match(new RegExp(`^\\s*${key}:\\s*([0-9_]+)`, 'm'));
  return m ? Number(m[1].replace(/_/g, '')) : null;
}

describe('subprocess-spawning tests run under a timeout that bounds the code, not the box', () => {
  it('still finds subprocess-spawning test files (guard is not inert)', () => {
    const spawners = walkTestFiles(path.join(REPO_ROOT, 'test')).filter((f) =>
      fs.readFileSync(f, 'utf8').includes('node:child_process'),
    );
    // If this hits zero the repo stopped spawning subprocesses in tests
    // (then delete this guard) or the detection rotted.
    expect(spawners.length).toBeGreaterThan(0);
  });

  it('vitest.config.ts sets testTimeout well above the 5000ms default', () => {
    const t = readConfigTimeout('testTimeout');
    expect(
      t,
      'vitest.config.ts must set an explicit testTimeout — the 5000ms default ' +
        'reds subprocess tests under load (ace#1912).',
    ).not.toBeNull();
    expect(t!).toBeGreaterThanOrEqual(MIN_TIMEOUT_MS);
  });

  it('vitest.config.ts sets hookTimeout above its 10000ms default too', () => {
    // beforeEach/afterEach in these files spawn as well, so raising only
    // testTimeout moves the flake rather than removing it.
    const t = readConfigTimeout('hookTimeout');
    expect(
      t,
      'vitest.config.ts must set an explicit hookTimeout (ace#1912).',
    ).not.toBeNull();
    expect(t!).toBeGreaterThanOrEqual(MIN_TIMEOUT_MS);
  });
});
