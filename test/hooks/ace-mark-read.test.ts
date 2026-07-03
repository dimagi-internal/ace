/**
 * bin/ace-mark-read preventer suite.
 *
 * The tool must clear UNREAD via `gog gmail thread modify` (gog's own token
 * bucket) — NEVER by minting a Gmail token through the macOS Keychain
 * `security` call, which hangs forever on a GUI prompt in non-interactive
 * agent shells (jjackson/ace#827). These tests run the real script against a
 * fake `gog` on PATH and pin the command shape, so a refactor back toward
 * direct token minting (or a gog-CLI flag drift) fails loudly offline.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = path.join(REPO_ROOT, 'bin', 'ace-mark-read');

function withFakeGog(script: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gog-'));
  const gog = path.join(dir, 'gog');
  fs.writeFileSync(gog, `#!/bin/bash\n${script}\n`, { mode: 0o755 });
  return dir;
}

function run(args: string[], fakeGogDir: string, env: Record<string, string> = {}) {
  return spawnSync('python3', [TOOL, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeGogDir}:${process.env.PATH}`, ...env },
  });
}

describe('bin/ace-mark-read', () => {
  it('invokes gog gmail thread modify --remove UNREAD per thread with the ACE identity', () => {
    const dir = withFakeGog('echo "$@" >> "$FAKE_GOG_LOG"; exit 0');
    const log = path.join(dir, 'calls.log');
    const r = run(['t1', 't2'], dir, { FAKE_GOG_LOG: log });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('t1 -> read');
    expect(r.stdout).toContain('t2 -> read');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(
      'gmail thread modify t1 --remove UNREAD --account ace@dimagi-ai.com --client ace',
    );
  });

  it('respects ACE_GMAIL_ACCOUNT/CLIENT env overrides', () => {
    const dir = withFakeGog('echo "$@" >> "$FAKE_GOG_LOG"; exit 0');
    const log = path.join(dir, 'calls.log');
    run(['t1'], dir, {
      FAKE_GOG_LOG: log,
      ACE_GMAIL_ACCOUNT: 'other@dimagi-ai.com',
      ACE_GMAIL_CLIENT: 'other',
    });
    expect(fs.readFileSync(log, 'utf8')).toContain('--account other@dimagi-ai.com --client other');
  });

  it('keeps going after a per-thread failure and exits non-zero', () => {
    const dir = withFakeGog('if [ "$4" = "bad" ]; then echo "boom" >&2; exit 1; fi; exit 0');
    const r = run(['bad', 'good'], dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('bad -> ERROR');
    expect(r.stdout).toContain('good -> read');
  });

  it('never invokes the macOS Keychain (the #827 hang class)', () => {
    const dir = withFakeGog('echo "$@" >> "$FAKE_GOG_LOG"; exit 0');
    const log = path.join(dir, 'calls.log');
    // a fake `security` that records if anything calls it
    const sec = path.join(dir, 'security');
    fs.writeFileSync(sec, `#!/bin/bash\necho CALLED >> "${log}.sec"\nexit 0\n`, { mode: 0o755 });
    run(['t1'], dir, { FAKE_GOG_LOG: log });
    expect(fs.existsSync(`${log}.sec`)).toBe(false);
  });

  it('prints usage and exits 1 with no args', () => {
    const dir = withFakeGog('exit 0');
    const r = run([], dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('usage');
  });
});
