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
  '.env.tpl': 'documents that ACE’s own CANOPY_WEB_PAT exists so the workbench token is never needed',
  'bin/ace-canopy-web': 'the write wrapper — documents the hazard; reads ACE’s .env only',
  'playbook/integrations/canopy-web.md': 'the rule doc explaining why the workbench token is never used',
  'scripts/browser-sessions.ts': 'doc comment on canopyToken stating it never reads the workbench token',
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
