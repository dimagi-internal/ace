// Registration errors must name the failing Maestro step, not Maestro's
// trailing "Run your flows on Maestro Cloud" advert (ace#2934: three lease
// failures reported nothing but the banner). The fixture is the real part-B
// stdout of lease 3b83dd82 (2026-10-15), as the image CLI recorded it.
//
// The local backend (TypeScript) and the lease image CLI (Python) each build
// the message, so both are run on the same input and must agree.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { maestroFailureSummary } from '../../../mcp/mobile/maestro-failure-summary.js';

const FIXTURE = path.join(__dirname, '../../fixtures/maestro-register-partb-failed-stdout.txt');
const CLI_DIR = path.join(__dirname, '../../../infra/capabilities/android-emulator/image/cli');

function python(stdout: string, stderr = ''): string {
  const r = spawnSync(
    'python3',
    ['-I', '-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(CLI_DIR)}); import ace_mobile as m; a = json.load(sys.stdin); print(m.maestro_failure_summary(a[0], a[1]), end="")`],
    { input: JSON.stringify([stdout, stderr]), encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

describe('maestroFailureSummary', () => {
  const stdout = fs.readFileSync(FIXTURE, 'utf8');

  it('names the failing top-level step and its assertion, not the advert', () => {
    const s = maestroFailureSummary(stdout);
    expect(s).toBe(
      'Assert that id: org.commcare.dalvik:id/rvJobList is visible... FAILED | ' +
        'Assertion is false: id: org.commcare.dalvik:id/rvJobList is visible',
    );
    expect(s).not.toMatch(/Maestro Cloud/);
    // The fixture's tail really is the advert (the old message):
    expect(stdout.trimEnd().slice(-500)).toMatch(/Maestro Cloud/);
  });

  it('ignores optional-probe misses (indented FAILED, "Warning:" lines)', () => {
    const s = maestroFailureSummary(
      'Run flow... WARNED\n  Assert that id: probe is visible... FAILED\n Warning: Assertion is false: id: probe is visible\n' +
        'Tap on id: real... FAILED\nElement not found: id: real\n',
    );
    expect(s).toBe('Tap on id: real... FAILED | Element not found: id: real');
  });

  it('falls back to the output itself when nothing failed by name', () => {
    expect(maestroFailureSummary('', 'adb: device offline')).toBe('adb: device offline');
  });

  it('the lease image CLI produces the same summary', () => {
    expect(python(stdout)).toBe(maestroFailureSummary(stdout));
    expect(python('', 'adb: device offline')).toBe('adb: device offline');
  });
});
