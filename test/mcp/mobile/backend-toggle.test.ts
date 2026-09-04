import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveBackend,
  setSessionBackend,
  clearSessionBackend,
  preflightMobileBackend,
  mobileStateDir,
  type ResolvedBackend,
} from '../../../mcp/mobile/backend-toggle.js';

// Resolved through the seam, not hardcoded to $HOME — under `npm test`
// this is the per-worker tempdir set by test/setup/isolate-ace-home-state.ts.
const STATE_DIR = mobileStateDir();
const SESSION_FILE = path.join(STATE_DIR, `mobile-backend.${process.ppid}`);

describe('backend-toggle: resolveBackend', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.ACE_MOBILE_BACKEND;
    delete process.env.ACE_MOBILE_BACKEND;
    clearSessionBackend();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = savedEnv;
    clearSessionBackend();
  });

  it('defaults to local when neither env nor session file is set', () => {
    const r = resolveBackend();
    expect(r.backend).toBe('local');
    expect(r.source).toBe('default');
    expect(r.ppid).toBe(process.ppid);
  });

  it('reads cloud from the session file', () => {
    setSessionBackend('cloud');
    const r = resolveBackend();
    expect(r.backend).toBe('cloud');
    expect(r.source).toBe('session-file');
    expect(r.sessionFile).toBe(SESSION_FILE);
  });

  it('reads local from the session file (explicit override of default)', () => {
    setSessionBackend('local');
    const r = resolveBackend();
    expect(r.backend).toBe('local');
    expect(r.source).toBe('session-file');
  });

  it('process env wins over session file', () => {
    setSessionBackend('local');
    process.env.ACE_MOBILE_BACKEND = 'cloud';
    const r = resolveBackend();
    expect(r.backend).toBe('cloud');
    expect(r.source).toBe('env');
  });

  it('case-insensitive env values are accepted', () => {
    process.env.ACE_MOBILE_BACKEND = 'CLOUD';
    expect(resolveBackend().backend).toBe('cloud');
    process.env.ACE_MOBILE_BACKEND = 'Local';
    expect(resolveBackend().backend).toBe('local');
  });

  it('invalid env values fall through to session file / default', () => {
    process.env.ACE_MOBILE_BACKEND = 'nonsense';
    const r = resolveBackend();
    expect(r.backend).toBe('local');
    expect(r.source).toBe('default');
  });

  it('invalid file contents fall through to default', () => {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, 'banana\n');
    const r = resolveBackend();
    expect(r.backend).toBe('local');
    expect(r.source).toBe('default');
  });

  it('reads fresh from disk on every call (no caching)', () => {
    setSessionBackend('cloud');
    expect(resolveBackend().backend).toBe('cloud');
    setSessionBackend('local');
    expect(resolveBackend().backend).toBe('local');
    clearSessionBackend();
    expect(resolveBackend().backend).toBe('local');
    expect(resolveBackend().source).toBe('default');
  });
});

describe('backend-toggle: setSessionBackend', () => {
  afterEach(() => clearSessionBackend());

  it('rejects unknown backend names', () => {
    expect(() => setSessionBackend('weird' as 'cloud')).toThrow(/invalid backend/);
  });

  it('writes a file containing the backend name + newline', () => {
    const file = setSessionBackend('cloud');
    expect(fs.readFileSync(file, 'utf8')).toBe('cloud\n');
  });

  it('supports a custom ppid (used by the slash command)', () => {
    const customPpid = 999999;
    const file = setSessionBackend('local', customPpid);
    expect(file).toBe(path.join(STATE_DIR, `mobile-backend.${customPpid}`));
    expect(fs.readFileSync(file, 'utf8')).toBe('local\n');
    fs.unlinkSync(file);
  });
});

describe('backend-toggle: preflightMobileBackend (jjackson/ace#839)', () => {
  const resolved = (
    backend: ResolvedBackend['backend'],
    source: ResolvedBackend['source'],
  ): ResolvedBackend => ({
    backend,
    source,
    sessionFile: '/tmp/unused',
    ppid: 1,
  });

  it('fails loud when cloud is resolved but cloud is not configured', () => {
    const pf = preflightMobileBackend({
      resolved: resolved('cloud', 'session-file'),
      cloudConfigured: false,
    });
    expect(pf.fatal).toBeDefined();
    expect(pf.fatal?.code).toBe('CLOUD_NOT_CONFIGURED');
    expect(pf.fatal?.remediation).toMatch(/ACE_WEB_BASE_URL/);
    expect(pf.note).toBeUndefined();
  });

  it('proceeds silently when cloud is resolved AND configured (happy path)', () => {
    const pf = preflightMobileBackend({
      resolved: resolved('cloud', 'env'),
      cloudConfigured: true,
    });
    expect(pf.fatal).toBeUndefined();
    expect(pf.note).toBeUndefined();
    expect(pf.backend).toBe('cloud');
  });

  it('notes the mismatch when local is a DEFAULT and cloud IS configured', () => {
    const pf = preflightMobileBackend({
      resolved: resolved('local', 'default'),
      cloudConfigured: true,
    });
    expect(pf.fatal).toBeUndefined();
    expect(pf.note).toMatch(/\/ace:mobile-backend cloud/);
  });

  it('does NOT nag when local is EXPLICITLY chosen even if cloud is configured', () => {
    const pf = preflightMobileBackend({
      resolved: resolved('local', 'session-file'),
      cloudConfigured: true,
    });
    expect(pf.fatal).toBeUndefined();
    expect(pf.note).toBeUndefined();
  });

  it('does NOT nag on the ordinary local-default, cloud-unconfigured dev case', () => {
    const pf = preflightMobileBackend({
      resolved: resolved('local', 'default'),
      cloudConfigured: false,
    });
    expect(pf.fatal).toBeUndefined();
    expect(pf.note).toBeUndefined();
  });
});

/**
 * The invariant behind ace#1883 and ace#1797.
 *
 * `resolveBackend()` keys the state file on `process.ppid`, which inside a
 * vitest worker is the vitest MAIN process — identical in every worker. So
 * without an isolation seam, `~/.ace/mobile-backend.<pid>` is ONE REAL FILE
 * in the developer's home directory that every worker reads, writes and
 * deletes concurrently. Measured on origin/main @ 0.13.1147: worker pid
 * 19783 (backend-toggle.test.ts) wrote `cloud` into it while worker pid
 * 19255 (client.test.ts) read `cloud` back out 12 times, in every one of 15
 * consecutive runs.
 *
 * These assertions are the structural preventer: they fail if the seam is
 * removed, if the setup file stops setting it, or if a future sibling piece
 * of state gets added straight into $HOME again.
 */
describe('backend-toggle: state dir is isolated from the real $HOME under test', () => {
  it('never resolves a session file under the real home directory', () => {
    const home = path.join(os.homedir(), '.ace');
    expect(mobileStateDir()).not.toBe(home);
    expect(resolveBackend().sessionFile.startsWith(home + path.sep)).toBe(false);
  });

  it('writes and clears inside the isolated dir, leaving $HOME untouched', () => {
    const homeFile = path.join(os.homedir(), '.ace', `mobile-backend.${process.ppid}`);
    const existedBefore = fs.existsSync(homeFile);

    const written = setSessionBackend('cloud');
    expect(written.startsWith(mobileStateDir())).toBe(true);
    expect(fs.existsSync(written)).toBe(true);
    expect(fs.existsSync(homeFile)).toBe(existedBefore);

    clearSessionBackend();
    expect(fs.existsSync(written)).toBe(false);
    expect(fs.existsSync(homeFile)).toBe(existedBefore);
  });

  it('honours an explicit ACE_MOBILE_STATE_DIR override end-to-end', () => {
    const prevDir = process.env.ACE_MOBILE_STATE_DIR;
    const prevEnv = process.env.ACE_MOBILE_BACKEND;
    delete process.env.ACE_MOBILE_BACKEND;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-state-seam-'));
    try {
      process.env.ACE_MOBILE_STATE_DIR = tmp;
      expect(mobileStateDir()).toBe(tmp);

      const file = setSessionBackend('cloud');
      expect(file).toBe(path.join(tmp, `mobile-backend.${process.ppid}`));

      const r = resolveBackend();
      expect(r.backend).toBe('cloud');
      expect(r.source).toBe('session-file');
      expect(r.sessionFile).toBe(file);

      clearSessionBackend();
      expect(resolveBackend().source).toBe('default');
    } finally {
      if (prevDir === undefined) delete process.env.ACE_MOBILE_STATE_DIR;
      else process.env.ACE_MOBILE_STATE_DIR = prevDir;
      if (prevEnv === undefined) delete process.env.ACE_MOBILE_BACKEND;
      else process.env.ACE_MOBILE_BACKEND = prevEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolves the dir at CALL time, so a later override still takes effect', () => {
    // A module-level `const` here is the exact defect ace#1704 fixed in
    // sessionLockDir(); this asserts backend-toggle did not reintroduce it.
    const prevDir = process.env.ACE_MOBILE_STATE_DIR;
    try {
      process.env.ACE_MOBILE_STATE_DIR = '/tmp/ace-call-time-probe';
      expect(mobileStateDir()).toBe('/tmp/ace-call-time-probe');
    } finally {
      if (prevDir === undefined) delete process.env.ACE_MOBILE_STATE_DIR;
      else process.env.ACE_MOBILE_STATE_DIR = prevDir;
    }
  });
});
