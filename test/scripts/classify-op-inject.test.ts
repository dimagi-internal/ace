/**
 * Tests for `scripts/classify-op-inject.sh` — the doctor's env_tpl_render
 * classifier (dimagi-internal/ace#1613).
 *
 * The probe used to classify with a catch-all `else -> fail`: any non-zero
 * `op inject` whose stderr did not match a sign-in denylist was asserted to be
 * "an unresolvable op:// ref". That made a transient the run's only FAIL, which
 * flips the doctor summary to "BROKEN — ACE will not function" on a healthy
 * machine — observed 2026-08-24, two runs four minutes apart, 1 FAIL then 0.
 *
 * The fix classifies on POSITIVE evidence for the defect. These fixtures are the
 * REAL `op` messages, captured by running `op inject` against deliberately
 * broken references — not invented, because inventing another tool's error
 * vocabulary is the bug this file exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'classify-op-inject.sh');

// The script reads the stderr text on stdin, so drive it with spawn and close
// the pipe — execFile's `input` option does not exist and silently hangs.
function classify(rc: number, stderr: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT, String(rc)]);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', () => resolve(out.trim()));
    child.stdin.write(stderr);
    child.stdin.end();
  });
}

describe('classify-op-inject', () => {
  it('rc=0 is ok', async () => {
    expect(await classify(0, '')).toBe('ok');
  });

  describe('real unresolvable-reference errors (captured from op, 2026-08-24)', () => {
    // Each string below was produced by an actual `op inject` run.
    const cases: Array<[string, string]> = [
      [
        'missing item',
        '[ERROR] 2026/08/24 14:05:06 could not resolve item UUID for item this-item-does-not-exist-xyz: could not find item this-item-does-not-exist-xyz in vault 3krbvotxjulf6nvqm2k4xfb2p4',
      ],
      [
        'missing field on a real item',
        "[ERROR] 2026/08/24 14:05:30 item 'Agent-Ace/ACE - Open Chat Studio' does not have a field 'definitely-no-such-field'",
      ],
      [
        'malformed reference',
        "[ERROR] 2026/08/24 14:05:16 invalid secret reference 'op://Agent-Ace/no-such-field-xyz': too few '/': secret references should have at least vault, item and field specified",
      ],
    ];
    it.each(cases)('%s -> unresolvable', async (_label, stderr) => {
      expect(await classify(1, stderr)).toBe('unresolvable');
    });
  });

  describe('auth / not-configured is an informational skip, never a FAIL', () => {
    const cases = [
      'You are not currently signed in. Please run `op signin`.',
      'could not find account for the specified account identifier',
      'session expired, please sign in again',
    ];
    it.each(cases)('%s -> auth_skip', async (stderr) => {
      expect(await classify(1, stderr)).toBe('auth_skip');
    });
  });

  describe('THE REGRESSION: an unrecognised error must NOT be called a broken ref', () => {
    // These are the transients that used to flip the whole verdict to BROKEN.
    const cases = [
      'dial tcp: lookup my.1password.com: no such host',
      'context deadline exceeded',
      'Error: connection reset by peer',
      '429 too many requests',
      '',
    ];
    it.each(cases)('%s -> unknown', async (stderr) => {
      expect(await classify(1, stderr)).toBe('unknown');
    });
  });
});
