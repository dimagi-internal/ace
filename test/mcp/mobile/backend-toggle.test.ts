import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveBackend,
  setSessionBackend,
  clearSessionBackend,
} from '../../../mcp/mobile/backend-toggle.js';

const STATE_DIR = path.join(os.homedir(), '.ace');
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
