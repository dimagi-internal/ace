/**
 * bin/ace-email + bin/ace-mark-read shim preventer suite.
 *
 * Both are thin shims over the shared canopy email engine (jjackson/canopy#266/#281,
 * ace#826): identity pinned to THIS repo via --repo, all behavior (HTML wrapper,
 * reply-all, keychain-free mark-read, timeouts) engine-side so fixes propagate
 * fleet-wide. These tests run the real shims against a fake `canopy` on PATH and pin
 * the exec shape, so a refactor back toward a local implementation (or an argument
 * drift) fails loudly offline. The missing-CLI path must exit with a remediation, not
 * a bare traceback.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function withFakeCanopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-canopy-'));
  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'canopy');
  fs.writeFileSync(bin, `#!/bin/bash\necho "$@" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  return { dir, log };
}

function runShim(tool: string, args: string[], pathPrefix: string) {
  return spawnSync('python3', [path.join(REPO_ROOT, 'bin', tool), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${pathPrefix}:${process.env.PATH}` },
  });
}

describe('email shims over the canopy engine', () => {
  it('ace-email execs `canopy email send --repo <this repo>` with args passed through', () => {
    const { dir, log } = withFakeCanopy();
    const r = runShim('ace-email', ['--to', 'x@y.z', '--subject', 's', '--body-file', 'b.txt', '--dry-run'], dir);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(log, 'utf8').trim()).toBe(
      `email send --repo ${REPO_ROOT} --to x@y.z --subject s --body-file b.txt --dry-run`,
    );
  });

  it('ace-mark-read execs `canopy email mark-read --repo <this repo>` with thread ids', () => {
    const { dir, log } = withFakeCanopy();
    const r = runShim('ace-mark-read', ['t1', 't2'], dir);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(log, 'utf8').trim()).toBe(
      `email mark-read --repo ${REPO_ROOT} t1 t2`,
    );
  });

  it('both shims exit with a remediation (not a traceback) when canopy is missing', () => {
    // an empty dir shadows nothing; strip the rest of PATH down to essentials so the
    // real canopy (if installed) is not found
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-canopy-'));
    for (const tool of ['ace-email', 'ace-mark-read']) {
      const r = spawnSync('python3', [path.join(REPO_ROOT, 'bin', tool), '--help'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${empty}:/usr/bin:/bin` },
      });
      expect(r.status, tool).toBe(1);
      expect(r.stderr, tool).toContain('canopy CLI not on PATH');
      expect(r.stderr, tool).not.toContain('Traceback');
    }
  });
});
