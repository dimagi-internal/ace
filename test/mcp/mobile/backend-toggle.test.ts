import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveBackend,
  setSessionBackend,
  clearSessionBackend,
  preflightMobileBackend,
  mobileStateDir,
  resetDeprecationWarnings,
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

  it('reads lease from the session file', () => {
    setSessionBackend('lease');
    const r = resolveBackend();
    expect(r.backend).toBe('lease');
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
    process.env.ACE_MOBILE_BACKEND = 'lease';
    const r = resolveBackend();
    expect(r.backend).toBe('lease');
    expect(r.source).toBe('env');
  });

  it('case-insensitive env values are accepted', () => {
    process.env.ACE_MOBILE_BACKEND = 'LEASE';
    expect(resolveBackend().backend).toBe('lease');
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
    setSessionBackend('lease');
    expect(resolveBackend().backend).toBe('lease');
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
    expect(() => setSessionBackend('weird' as 'lease')).toThrow(/invalid backend/);
  });

  it('writes a file containing the backend name + newline', () => {
    const file = setSessionBackend('lease');
    expect(fs.readFileSync(file, 'utf8')).toBe('lease\n');
  });

  it('writes the deprecated cloud alias as lease, so the file never carries the retired name', () => {
    const file = setSessionBackend('cloud');
    expect(fs.readFileSync(file, 'utf8')).toBe('lease\n');
  });

  it('supports a custom ppid (used by the slash command)', () => {
    const customPpid = 999999;
    const file = setSessionBackend('local', customPpid);
    expect(file).toBe(path.join(STATE_DIR, `mobile-backend.${customPpid}`));
    expect(fs.readFileSync(file, 'utf8')).toBe('local\n');
    fs.unlinkSync(file);
  });
});

// ── `cloud` is a deprecated alias for `lease` (ace-web's emulator retired 2026-10-14) ──
describe('backend-toggle: deprecated cloud alias', () => {
  let savedEnv: string | undefined;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedEnv = process.env.ACE_MOBILE_BACKEND;
    delete process.env.ACE_MOBILE_BACKEND;
    clearSessionBackend();
    resetDeprecationWarnings();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = savedEnv;
    clearSessionBackend();
    warn.mockRestore();
  });

  it('ACE_MOBILE_BACKEND=cloud resolves to lease, from env', () => {
    process.env.ACE_MOBILE_BACKEND = 'cloud';
    const r = resolveBackend();
    expect(r.backend).toBe('lease');
    expect(r.source).toBe('env');
  });

  it('a pre-retirement `cloud` session file resolves to lease, from the file', () => {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, 'cloud\n');
    const r = resolveBackend();
    expect(r.backend).toBe('lease');
    expect(r.source).toBe('session-file');
  });

  it('logs ONE deprecation line per source, not one per routing decision', () => {
    process.env.ACE_MOBILE_BACKEND = 'Cloud';
    resolveBackend();
    resolveBackend();
    resolveBackend();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/'cloud' \(ACE_MOBILE_BACKEND\) is deprecated.*using 'lease'/);
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

    const written = setSessionBackend('lease');
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

      const file = setSessionBackend('lease');
      expect(file).toBe(path.join(tmp, `mobile-backend.${process.ppid}`));

      const r = resolveBackend();
      expect(r.backend).toBe('lease');
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

// ── Default selection: local iff a provisioned AVD exists, else lease ──────
describe('backend-toggle: selection matrix (lease backend)', () => {
  let saved: Record<string, string | undefined>;
  let avdHome: string;

  beforeEach(() => {
    saved = {
      ACE_MOBILE_BACKEND: process.env.ACE_MOBILE_BACKEND,
      ACE_MOBILE_SELECTION_AVD_HOME: process.env.ACE_MOBILE_SELECTION_AVD_HOME,
    };
    delete process.env.ACE_MOBILE_BACKEND;
    clearSessionBackend();
    avdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-avd-home-'));
    process.env.ACE_MOBILE_SELECTION_AVD_HOME = avdHome;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    clearSessionBackend();
    fs.rmSync(avdHome, { recursive: true, force: true });
  });

  function makeAvd(name: string, marker: string | null) {
    const dir = path.join(avdHome, `${name}.avd`);
    fs.mkdirSync(dir, { recursive: true });
    if (marker !== null) fs.writeFileSync(path.join(dir, '.ace-provisioned.json'), marker);
  }
  const GOOD = JSON.stringify({ marked_at: '2026-10-01T00:00:00Z', selector_map: 'connect-2.63.0@abc' });

  // [env, session file, AVD-home contents] → expected backend + source
  const cases: Array<{
    name: string;
    env?: string;
    file?: 'local' | 'lease';
    rawFile?: string;
    avd: 'provisioned' | 'unmarked' | 'bad-marker' | 'none';
    want: string;
    source: string;
  }> = [
    { name: 'nothing set, provisioned AVD → local', avd: 'provisioned', want: 'local', source: 'default' },
    { name: 'nothing set, no AVD home contents → lease', avd: 'none', want: 'lease', source: 'default' },
    { name: 'nothing set, AVD exists but never bootstrapped → lease', avd: 'unmarked', want: 'lease', source: 'default' },
    { name: 'nothing set, unreadable marker → lease (fails closed)', avd: 'bad-marker', want: 'lease', source: 'default' },
    { name: 'session file lease beats a provisioned AVD', file: 'lease', avd: 'provisioned', want: 'lease', source: 'session-file' },
    { name: 'session file local beats no AVD', file: 'local', avd: 'none', want: 'local', source: 'session-file' },
    { name: 'session file cloud (deprecated alias) resolves to lease', rawFile: 'cloud', avd: 'provisioned', want: 'lease', source: 'session-file' },
    { name: 'env lease beats session file local', env: 'lease', file: 'local', avd: 'provisioned', want: 'lease', source: 'env' },
    { name: 'env local beats no AVD', env: 'local', avd: 'none', want: 'local', source: 'env' },
    { name: 'env cloud (deprecated alias) beats everything, as lease', env: 'cloud', file: 'local', avd: 'provisioned', want: 'lease', source: 'env' },
    { name: 'env is case/space-insensitive', env: '  LEASE ', avd: 'provisioned', want: 'lease', source: 'env' },
    { name: 'an unknown env value falls through to the default', env: 'remote', avd: 'none', want: 'lease', source: 'default' },
  ];

  it.each(cases)('$name', ({ env, file, rawFile, avd, want, source }) => {
    if (avd === 'provisioned') makeAvd('ACE_Pixel_API_34', GOOD);
    if (avd === 'unmarked') makeAvd('ACE_Pixel_API_34', null);
    if (avd === 'bad-marker') makeAvd('ACE_Pixel_API_34', '{not json');
    if (env !== undefined) process.env.ACE_MOBILE_BACKEND = env;
    if (file) setSessionBackend(file);
    if (rawFile) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(SESSION_FILE, `${rawFile}\n`);
    }
    const r = resolveBackend();
    expect(r.backend).toBe(want);
    expect(r.source).toBe(source);
  });

  it('a nonexistent AVD home defaults to lease with a reason naming it', () => {
    process.env.ACE_MOBILE_SELECTION_AVD_HOME = path.join(avdHome, 'missing');
    const r = resolveBackend();
    expect(r.backend).toBe('lease');
    expect(r.defaultReason).toContain('no provisioned AVD');
  });

  it('the default reason names the provisioned AVD it found', () => {
    makeAvd('ACE_Pixel_API_34', GOOD);
    expect(resolveBackend().defaultReason).toContain('ACE_Pixel_API_34');
  });

  it('setSessionBackend accepts lease and rejects junk', () => {
    setSessionBackend('lease');
    expect(resolveBackend().backend).toBe('lease');
    expect(() => setSessionBackend('remote' as never)).toThrow(/invalid backend/);
  });

  it('the suite-wide default is pinned to local by the isolation setup', () => {
    process.env.ACE_MOBILE_SELECTION_AVD_HOME = saved.ACE_MOBILE_SELECTION_AVD_HOME;
    expect(resolveBackend().backend).toBe('local');
  });
});

describe('backend-toggle: lease preflight', () => {
  const resolved = (backend: 'lease' | 'local', source: 'env' | 'session-file' | 'default' = 'default'): ResolvedBackend => ({
    backend,
    source,
    sessionFile: '/tmp/x',
    ppid: 1,
    ...(source === 'default' && backend === 'lease' ? { defaultReason: 'no provisioned AVD in /x' } : {}),
  });

  it('lease without a PAT is fatal LEASE_NOT_CONFIGURED (never falls through to local)', () => {
    const p = preflightMobileBackend({ resolved: resolved('lease'), leaseConfigured: false });
    expect(p.fatal?.code).toBe('LEASE_NOT_CONFIGURED');
    expect(p.fatal?.message).toContain('no provisioned AVD');
    expect(p.fatal?.remediation).toContain('/ace:mobile-bootstrap');
  });

  it('a pinned lease names the pin, not the default', () => {
    const p = preflightMobileBackend({ resolved: resolved('lease', 'env'), leaseConfigured: false });
    expect(p.fatal?.message).toContain('pinned to lease (env)');
  });

  it('lease with a PAT proceeds silently', () => {
    const p = preflightMobileBackend({ resolved: resolved('lease'), leaseConfigured: true });
    expect(p.fatal).toBeUndefined();
  });

  it('local proceeds silently whether or not a lease is configured', () => {
    expect(preflightMobileBackend({ resolved: resolved('local', 'default'), leaseConfigured: true }).fatal).toBeUndefined();
    expect(preflightMobileBackend({ resolved: resolved('local', 'session-file') }).fatal).toBeUndefined();
  });
});
