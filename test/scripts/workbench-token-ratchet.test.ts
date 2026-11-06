// ace#2805: ~/.claude/canopy/workbench-token belongs to whoever set up the machine — on the
// owner's laptop, Jonathan. An ACE path that falls back to it acts on canopy-web AS A HUMAN:
// that is how the chlorine narrative was posted as Jonathan into the wrong workspace. Writes
// were pinned by bin/ace-canopy-web (PR #2807); this closes the reads (browser-sessions.ts,
// output-preview-capture) and ratchets the class: no ACE file may name the workbench token
// unless it is on the allowlist below, with the reason it is allowed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

const ALLOWED: Record<string, string> = {
  'bin/ace-canopy-web': 'the write wrapper — documents the hazard; asks canopy, never the workbench token',
  'lib/ace-canopy-pat.ts': 'the one reader — doc comment says canopy never issues the workbench token',
  'playbook/integrations/canopy-web.md': 'the rule doc explaining why the workbench token is never used',
  'scripts/browser-sessions.ts': 'doc comment stating canopy auth never uses the workbench token',
  'skills/partnership-publish/SKILL.md': 'says “never ~/.claude/canopy/workbench-token”',
  'test/scripts/ace-canopy-web.test.ts': 'plants a hostile workbench token to prove the wrapper ignores it',
  'test/scripts/workbench-token-ratchet.test.ts': 'this ratchet',
};

// History and quoted third-party text are not code paths.
const EXEMPT_PREFIXES = ['docs/', 'test/fixtures/', 'CHANGELOG'];

describe('workbench-token ratchet (ace#2805)', () => {
  const hits = execFileSync('git', ['grep', '-l', 'workbench-token'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !EXEMPT_PREFIXES.some((p) => f.startsWith(p)));

  it('no ACE file names the workbench token outside the allowlist', () => {
    const unexpected = hits.filter((f) => !(f in ALLOWED));
    expect(unexpected, `name it ACE's own PAT instead (bin/ace-canopy-web / browser-sessions.ts canopyToken), or allowlist it here with a reason`).toEqual([]);
  });

  it('no executable ACE code builds the workbench-token path', () => {
    for (const f of hits) {
      if (f.startsWith('test/')) continue; // tests plant a hostile token on purpose
      if (!/\.(ts|js|mjs|py|sh)$/.test(f) && !f.startsWith('bin/')) continue;
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(src, f).not.toMatch(/['"]workbench-token['"]/);
    }
  });

  it('allowlist entries still exist (prune stale ones)', () => {
    for (const f of Object.keys(ALLOWED)) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
  });
});

// Phase 2 of canopy-web's turn-scoped agent token retires the stored PAT. A script that reads
// CANOPY_WEB_PAT itself breaks then, and inside a person's local turn it acts as the wrong
// identity. Only the reader (and its Python twin) may touch it — as the marked phase-1 fallback.
const PAT_READERS: Record<string, string> = {
  'lib/ace-canopy-pat.ts': 'the one reader: canopy agent token, then the phase-1 stored-PAT fallback',
  'bin/ace-canopy-web': 'the Python twin of the reader; also hands the token to the wrapped command',
};

describe('canopy-web token ratchet: every token comes from canopy via the reader', () => {
  const files = execFileSync('git', ['grep', '-l', '-E', 'CANOPY_WEB_PAT|workbench-token'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !EXEMPT_PREFIXES.some((p) => f.startsWith(p)) && !f.startsWith('test/'))
    .filter((f) => /\.(ts|js|mjs|py|sh)$/.test(f) || f.startsWith('bin/'));

  it('no executable ACE code reads CANOPY_WEB_PAT outside the reader', () => {
    // A read: process.env.CANOPY_WEB_PAT, aceEnvValue('CANOPY_WEB_PAT'), a "CANOPY_WEB_PAT=" line parse.
    const READ = /process\.env\.CANOPY_WEB_PAT|process\.env\[['"]CANOPY_WEB_PAT['"]\]|aceEnvValue\(\s*['"]CANOPY_WEB_PAT['"]|['"]CANOPY_WEB_PAT=|environ(?:\.get)?\(?\[?['"]CANOPY_WEB_PAT/;
    const offenders = files.filter((f) => !(f in PAT_READERS) && READ.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(offenders, 'get the token from lib/ace-canopy-pat.ts (canopy agent token --slug ace), never CANOPY_WEB_PAT').toEqual([]);
  });

  it('the reader asks canopy first and keeps the stored PAT as the marked phase-1 fallback', () => {
    for (const f of Object.keys(PAT_READERS)) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(src, f).toMatch(/['"]agent['"],\s*['"]token['"],\s*['"]--slug['"]/);
      expect(src, f).toMatch(/No such command/);
      expect(src, f).toMatch(/PHASE-1 FALLBACK/);
    }
  });
});

describe('browser-sessions canopyToken reads ACE’s own PAT only', () => {
  let home = '';
  const saved = { HOME: process.env.HOME, ACE_ENV_FILE: process.env.ACE_ENV_FILE, CANOPY_WEB_PAT: process.env.CANOPY_WEB_PAT };
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtok-'));
    fs.mkdirSync(path.join(home, '.claude', 'canopy'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'canopy', 'workbench-token'), 'human-pat');
    process.env.HOME = home;
    process.env.CANOPY_WEB_PAT = 'inherited-human-pat';
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('ignores an inherited CANOPY_WEB_PAT and the workbench token, returning ACE’s .env PAT', async () => {
    const env = path.join(home, 'ace.env');
    fs.writeFileSync(env, 'FOO=1\nCANOPY_WEB_PAT="ace-pat"\n');
    process.env.ACE_ENV_FILE = env;
    const { canopyToken } = await import('../../scripts/browser-sessions.js');
    expect(canopyToken()).toBe('ace-pat');
  });

  it('returns null (caller fails loudly) when ACE’s .env has no PAT', async () => {
    const env = path.join(home, 'empty.env');
    fs.writeFileSync(env, 'FOO=1\n');
    process.env.ACE_ENV_FILE = env;
    const { canopyToken } = await import('../../scripts/browser-sessions.js');
    expect(canopyToken()).toBeNull();
  });
});
