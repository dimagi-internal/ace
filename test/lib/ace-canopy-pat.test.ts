// lib/ace-canopy-pat.ts is the ONE place ACE decides its canopy-web token, and the decision is
// canopy's: `canopy agent token --slug ace` (canopy agent-core/agent-runtime.md § Session
// identity). Three outcomes: a token; an older canopy ("No such command") or no canopy CLI →
// the phase-1 stored-PAT fallback; any other refusal → FINAL, no fallback.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canopyIdentity,
  canopyToken,
  canopyTokenProblem,
  resetCanopyTokenCache,
} from '../../lib/ace-canopy-pat.js';

let dir = '';
const saved = { bin: process.env.ACE_CANOPY_BIN, env: process.env.ACE_ENV_FILE, pat: process.env.CANOPY_WEB_PAT };

function fakeCanopy(body: string): string {
  const exe = path.join(dir, `canopy-${Math.random().toString(36).slice(2)}`);
  // Records its argv and whether stdout was a TTY, then answers per `body`.
  fs.writeFileSync(
    exe,
    `#!/bin/sh\necho "$*" >> "${dir}/calls"\n[ -t 1 ] && echo tty >> "${dir}/calls"\n${body}\n`,
  );
  fs.chmodSync(exe, 0o755);
  return exe;
}
const calls = () => (fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n') : []);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-canopy-pat-'));
  const env = path.join(dir, 'ace.env');
  fs.writeFileSync(env, 'CANOPY_WEB_PAT=stored-pat\n');
  process.env.ACE_ENV_FILE = env;
  process.env.CANOPY_WEB_PAT = 'inherited-human-pat';
  resetCanopyTokenCache();
});
afterEach(() => {
  for (const [k, v] of [['ACE_CANOPY_BIN', saved.bin], ['ACE_ENV_FILE', saved.env], ['CANOPY_WEB_PAT', saved.pat]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetCanopyTokenCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('canopyToken — canopy decides', () => {
  it('uses canopy\'s answer, asking with --slug ace and a piped (non-TTY) stdout', () => {
    process.env.ACE_CANOPY_BIN = fakeCanopy('echo canopy-issued-token');
    expect(canopyIdentity()).toEqual({ token: 'canopy-issued-token', source: 'canopy' });
    expect(calls()).toEqual(['agent token --slug ace']);
  });

  it('asks canopy once per process', () => {
    process.env.ACE_CANOPY_BIN = fakeCanopy('echo t1');
    expect(canopyToken()).toBe('t1');
    expect(canopyToken()).toBe('t1');
    expect(canopyTokenProblem()).toBe('');
    expect(calls()).toHaveLength(1);
  });

  it('falls back to the stored PAT in ACE\'s .env ONLY for an older canopy ("No such command")', () => {
    process.env.ACE_CANOPY_BIN = fakeCanopy('echo "Error: No such command \'token\'." >&2; exit 2');
    expect(canopyIdentity()).toEqual({ token: 'stored-pat', source: 'stored-pat' });
  });

  it('falls back to the stored PAT when there is no canopy CLI — never to an inherited CANOPY_WEB_PAT', () => {
    process.env.ACE_CANOPY_BIN = path.join(dir, 'absent');
    expect(canopyToken()).toBe('stored-pat');
    fs.writeFileSync(process.env.ACE_ENV_FILE!, 'FOO=1\n');
    expect(canopyToken()).toBeNull();
    expect(canopyTokenProblem()).toMatch(/no stored PAT to fall back to/);
  });

  it('a refusal is FINAL: no token, canopy\'s reason surfaced, the stored PAT NOT used', () => {
    process.env.ACE_CANOPY_BIN = fakeCanopy('echo "context line" >&2; echo "refused: no identity for ace in this session" >&2; exit 3');
    expect(canopyToken()).toBeNull();
    expect(canopyTokenProblem()).toBe('canopy has no canopy-web identity for ace here: refused: no identity for ace in this session');
  });

  it('an exit 0 with empty stdout is a refusal too', () => {
    process.env.ACE_CANOPY_BIN = fakeCanopy('exit 0');
    expect(canopyToken()).toBeNull();
    expect(canopyTokenProblem()).toMatch(/no canopy-web identity for ace here/);
  });
});
