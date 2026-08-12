/**
 * Tests for `lib/path-containment.ts` — the allowed-roots decision that
 * dimagi-internal/ace#1110 deferred.
 *
 * Structured around the two things that must both hold, because the issue's
 * stated risk was breaking real flows:
 *   1. every attack in #1110's own table is refused, and
 *   2. every path ACE flows actually use is still allowed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertPathAllowed,
  resolveAllowedRoots,
  resolveRealPath,
  defaultAllowedRoots,
  PathContainmentError,
  __resetKillSwitchWarningForTests,
} from '../../lib/path-containment.js';

const OPTS = { mode: 'write' as const, atom: 'test_atom', arg: 'testPath' };

let tmpDir: string;
let fakeHome: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-containment-'));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-fakehome-'));
  __resetKillSwitchWarningForTests();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe('allowed paths — the flows #1110 warned we could break', () => {
  it('allows a file staged in the OS temp dir', () => {
    const p = path.join(tmpDir, 'staged.pdf');
    expect(assertPathAllowed(p, OPTS)).toBe(resolveRealPath(p));
  });

  it('allows a not-yet-existing write target (the normal write case)', () => {
    const p = path.join(tmpDir, 'nested', 'deeper', 'out.bin');
    expect(() => assertPathAllowed(p, OPTS)).not.toThrow();
  });

  it('allows /tmp/ace-* paths, which skills use pervasively', () => {
    expect(() => assertPathAllowed('/tmp/ace-hq-learn.json', OPTS)).not.toThrow();
    expect(() => assertPathAllowed('/tmp/ace-bednet-recipes/screenshots/J2/a.png', OPTS)).not.toThrow();
  });

  it('allows the mobile video spool — a real drive_upload_binary source', () => {
    // skills/app-screenshot-capture § 5.7 uploads from ~/.ace/mobile-videos/<ppid>/
    const spool = path.join(fakeHome, '.ace', 'mobile-videos', '12345');
    fs.mkdirSync(spool, { recursive: true });
    const mp4 = path.join(spool, '1786385206088-connect-claim-opp.mp4');
    expect(() => assertPathAllowed(mp4, { ...OPTS, mode: 'read', home: fakeHome })).not.toThrow();
  });

  it('allows ~/.ace/logs', () => {
    fs.mkdirSync(path.join(fakeHome, '.ace', 'logs'), { recursive: true });
    expect(() =>
      assertPathAllowed(path.join(fakeHome, '.ace', 'logs', 'run.log'), { ...OPTS, home: fakeHome }),
    ).not.toThrow();
  });

  // `~/.ace` as a WHOLE is deliberately not a root — it holds the Playwright
  // cookie jars (`ocs-session-<team>.json`, `connect-session.json`). Asserted
  // against resolveAllowedRoots rather than by probing a path, because a real
  // $HOME is not inside tmpdir but this suite's fakeHome is, so a path probe
  // would pass for the wrong reason.
  it('does NOT make all of ~/.ace a root — only the two subdirectories', () => {
    const roots = resolveAllowedRoots({} as NodeJS.ProcessEnv, fakeHome);
    expect(roots).not.toContain(path.join(fakeHome, '.ace'));
    expect(roots).toContain(resolveRealPath(path.join(fakeHome, '.ace', 'mobile-videos')));
    expect(roots).toContain(resolveRealPath(path.join(fakeHome, '.ace', 'logs')));
  });

  it('refuses the session cookie jars by name wherever they sit', () => {
    for (const jar of ['ocs-session-dimagi.json', 'connect-session.json', 'labs-session.json']) {
      expect(() =>
        assertPathAllowed(path.join(fakeHome, '.ace', jar), { ...OPTS, mode: 'read', home: fakeHome }),
      ).toThrow(/path_denied/);
    }
  });

  it('returns the RESOLVED path so callers cannot reintroduce the symlink hole', () => {
    const real = path.join(tmpDir, 'real.txt');
    fs.writeFileSync(real, 'x');
    const link = path.join(tmpDir, 'link.txt');
    fs.symlinkSync(real, link);
    expect(assertPathAllowed(link, OPTS)).toBe(fs.realpathSync(real));
  });
});

describe('refused paths — #1110\'s attack table', () => {
  it('refuses a path outside every allowed root', () => {
    expect(() => assertPathAllowed('/etc/passwd', { ...OPTS, mode: 'read' })).toThrow(
      /path_outside_allowed_roots/,
    );
  });

  it('refuses a relative path', () => {
    expect(() => assertPathAllowed('out.bin', OPTS)).toThrow(/path_not_absolute/);
  });

  it('refuses ../ traversal out of an allowed root', () => {
    const escape = path.join(tmpDir, '..', '..', '..', 'etc', 'passwd');
    expect(() => assertPathAllowed(escape, { ...OPTS, mode: 'read' })).toThrow(
      /path_outside_allowed_roots/,
    );
  });

  it('refuses a symlink that points out of an allowed root', () => {
    // The bypass a naive path.startsWith() check misses entirely.
    const link = path.join(tmpDir, 'innocent.json');
    fs.symlinkSync('/etc/hosts', link);
    expect(() => assertPathAllowed(link, { ...OPTS, mode: 'read' })).toThrow(
      /path_outside_allowed_roots/,
    );
  });

  it('resolves a write THROUGH a symlinked parent before deciding', () => {
    // Target does not exist yet, so containment must realpath the PARENT.
    // Here the link's target is still inside tmpdir, so this is allowed — what
    // it proves is that resolution happened at all, rather than the check
    // string-matching the pre-resolution path.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-outside-'));
    try {
      const linkDir = path.join(tmpDir, 'sneaky');
      fs.symlinkSync(outside, linkDir);
      expect(assertPathAllowed(path.join(linkDir, 'new.txt'), OPTS)).toBe(
        path.join(fs.realpathSync(outside), 'new.txt'),
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a write through a symlinked parent pointing OUT of every root', () => {
    // The bypass that matters: /tmp/<x>/etc/hosts looks contained, but the
    // parent is a symlink to /etc, so the write would land at /etc/hosts.
    const linkDir = path.join(tmpDir, 'etc-link');
    fs.symlinkSync('/etc', linkDir);
    expect(() => assertPathAllowed(path.join(linkDir, 'hosts'), OPTS)).toThrow(
      /path_outside_allowed_roots/,
    );
  });

  const denied: Array<[string, RegExp]> = [
    ['.env', /dotenv secrets/],
    ['.env.local', /dotenv secrets/],
    ['gws-sa-key.json', /service-account/],
    ['credentials-ace.json', /OAuth client credentials/],
    ['ocs-session-dimagi.json', /session cookies/],
    ['connect-session.json', /session cookies/],
    ['.zshrc', /code execution/],
    ['.npmrc', /shell\/registry/],
    ['id_ed25519', /SSH private key/],
    ['server.pem', /private key/],
  ];

  for (const [name, why] of denied) {
    it(`refuses "${name}" even inside an allowed root`, () => {
      const p = path.join(tmpDir, name);
      expect(() => assertPathAllowed(p, { ...OPTS, mode: 'read' })).toThrow(/path_denied/);
      expect(() => assertPathAllowed(p, { ...OPTS, mode: 'read' })).toThrow(why);
    });
  }

  const deniedDirs: Array<[string[], RegExp]> = [
    [['.ssh', 'known_hosts'], /SSH keys/],
    [['.aws', 'config'], /AWS credentials/],
    [['.gnupg', 'pubring.kbx'], /GPG keys/],
    [['.config', 'gh', 'hosts.yml'], /GitHub CLI token/],
    [['.git', 'hooks', 'pre-commit'], /code execution on next commit/],
    [['.claude', 'plugins', 'data', 'ace-ace', 'notes.txt'], /plugin data/],
    [['.claude', 'projects', 'p', 'session.jsonl'], /transcripts/],
  ];

  for (const [segs, why] of deniedDirs) {
    it(`refuses a path inside ${segs.slice(0, -1).join('/')}/`, () => {
      const p = path.join(tmpDir, ...segs);
      expect(() => assertPathAllowed(p, { ...OPTS, mode: 'read' })).toThrow(/path_denied/);
      expect(() => assertPathAllowed(p, { ...OPTS, mode: 'read' })).toThrow(why);
    });
  }

  // The two headline scenarios from the issue, spelled out.
  it('refuses the "read $CLAUDE_PLUGIN_DATA/.env and publish it" hop', () => {
    const env = path.join(fakeHome, '.claude', 'plugins', 'data', 'ace-ace', '.env');
    expect(() =>
      assertPathAllowed(env, { ...OPTS, mode: 'read', atom: 'drive_upload_binary', arg: 'localFilePath', home: fakeHome }),
    ).toThrow(/path_denied/);
  });

  it('refuses the "clobber ~/.zshrc via a download" hop', () => {
    const rc = path.join(fakeHome, '.zshrc');
    expect(() =>
      assertPathAllowed(rc, { ...OPTS, atom: 'commcare_download_ccz', arg: 'write_to_path', home: fakeHome }),
    ).toThrow(/path_denied/);
  });
});

describe('error messages are actionable', () => {
  it('names the atom, the arg, the roots, and how to extend them', () => {
    const err = (() => {
      try {
        assertPathAllowed('/etc/passwd', { mode: 'read', atom: 'ocs_upload_collection_files', arg: 'file_path' });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(PathContainmentError);
    const m = err!.message;
    expect(m).toMatch(/ocs_upload_collection_files/);
    expect(m).toMatch(/file_path/);
    expect(m).toMatch(/Allowed roots:/);
    expect(m).toMatch(/ACE_ALLOWED_FILE_ROOTS/);
    expect(m).toMatch(/ace#1110/);
  });
});

describe('operator controls', () => {
  it('ACE_ALLOWED_FILE_ROOTS extends rather than replaces the defaults', () => {
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-extra-'));
    try {
      const env = { ACE_ALLOWED_FILE_ROOTS: extra } as NodeJS.ProcessEnv;
      const roots = resolveAllowedRoots(env, fakeHome);
      expect(roots).toContain(fs.realpathSync(extra));
      // Defaults survive — the whole point of extend-not-replace.
      for (const d of defaultAllowedRoots(env, fakeHome)) {
        expect(roots).toContain(resolveRealPath(d));
      }
      expect(() => assertPathAllowed(path.join(extra, 'x.txt'), { ...OPTS, env, home: fakeHome })).not.toThrow();
    } finally {
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });

  it('accepts multiple colon-separated extra roots', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-b-'));
    try {
      const env = { ACE_ALLOWED_FILE_ROOTS: `${a}:${b}` } as NodeJS.ProcessEnv;
      const roots = resolveAllowedRoots(env, fakeHome);
      expect(roots).toContain(fs.realpathSync(a));
      expect(roots).toContain(fs.realpathSync(b));
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it('an extra root does NOT override the denied-basename list', () => {
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-extra2-'));
    try {
      const env = { ACE_ALLOWED_FILE_ROOTS: extra } as NodeJS.ProcessEnv;
      expect(() =>
        assertPathAllowed(path.join(extra, '.env'), { ...OPTS, mode: 'read', env, home: fakeHome }),
      ).toThrow(/path_denied/);
    } finally {
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });

  it('ACE_PATH_CONTAINMENT=off bypasses the check and warns loudly once', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const env = { ACE_PATH_CONTAINMENT: 'off' } as NodeJS.ProcessEnv;
      expect(() => assertPathAllowed('/etc/passwd', { ...OPTS, mode: 'read', env })).not.toThrow();
      expect(() => assertPathAllowed('/etc/hosts', { ...OPTS, mode: 'read', env })).not.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatch(/ACE_PATH_CONTAINMENT=off/);
    } finally {
      spy.mockRestore();
    }
  });
});
