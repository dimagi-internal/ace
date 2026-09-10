// The gog identity has exactly one source of truth: `config/agent.json`.
//
// It used to have two. `.env.tpl` injected ACE_GMAIL_ACCOUNT / ACE_GMAIL_CLIENT
// from the 1Password Agent-Ace item, duplicating `email` / `gog_client` that
// agent.json already states — and the copies drifted. The vault held
// `gmail_client=ace` against agent.json's `canopy`; no `credentials-ace.json`
// is ever provisioned, so anything reading the env var failed with "OAuth
// client credentials missing" and a remedy (`gog login --client ace`) that is
// an interactive browser OAuth a headless turn cannot run. Two doctor probes
// printed different clients in the SAME run, both PASS (ace#1147, #1338).
//
// Neither value is a secret — a mailbox address and an OAuth CLIENT NAME are
// not credentials; the real client_id/secret live in gog's own credentials
// file that `--client canopy` selects — so they belong in version control.
//
// Two things must hold together, and the second is the one that bites:
//   1. `.env.tpl` must not declare an identity key.
//   2. `bin/ace-setup` must list retired keys in RETIRED_KEYS.
// Without (2), removing a key from the template makes bin/ace-setup treat the
// leftover in an installed `.env` as an operator-added local-only secret and
// re-append it on every inject — immortalising the exact residual the removal
// was meant to delete, silently.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const IDENTITY_KEYS = ['ACE_GMAIL_ACCOUNT', 'ACE_GMAIL_CLIENT'];

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('gog identity has one source of truth (ace#1147)', () => {
  it('config/agent.json declares both fields', () => {
    const cfg = JSON.parse(read('config/agent.json'));
    expect(cfg.email).toBeTruthy();
    expect(cfg.gog_client).toBeTruthy();
    // The shared fleet client, not a per-agent one. A per-agent client name
    // here is the #1147 defect re-entering by another door.
    expect(cfg.gog_client).toBe('canopy');
  });

  it('.env.tpl declares neither identity key', () => {
    const tpl = read('.env.tpl');
    for (const key of IDENTITY_KEYS) {
      const declared = new RegExp(`^\\s*${key}\\s*=`, 'm').test(tpl);
      expect(declared, `${key} is declared in .env.tpl — agent.json owns it`).toBe(false);
    }
  });

  it('bin/ace-setup lists every retired key so a re-inject drops it', () => {
    const setup = read('bin/ace-setup');
    const m = /RETIRED_KEYS="([^"]*)"/.exec(setup);
    expect(m, 'bin/ace-setup must define RETIRED_KEYS').not.toBeNull();
    const retired = (m![1] || '').split(/\s+/).filter(Boolean);
    for (const key of IDENTITY_KEYS) {
      expect(retired, `${key} must be in RETIRED_KEYS or ace-setup will preserve it forever`).toContain(key);
    }
  });

  it('lib/gog-identity.ts reads agent.json with no env fallback', () => {
    const src = read('lib/gog-identity.ts');
    // The assignments must not consult the env at all.
    expect(src).toMatch(/const account = agentConfig\.email;/);
    expect(src).toMatch(/const client = agentConfig\.gog_client;/);
    expect(src).not.toMatch(/agentConfig\.email\s*\|\|\s*env\./);
    expect(src).not.toMatch(/agentConfig\.gog_client\s*\|\|\s*env\./);
  });

  it('no shell command in any skill, command or agent doc passes the retired vars to gog', () => {
    // Same failure as the CLAUDE.md case below, one door over: `skills/turn` and
    // `skills/email-communicator` still carried `--account $ACE_GMAIL_ACCOUNT
    // --client $ACE_GMAIL_CLIENT` as THE documented inbox pull two weeks after
    // the vars were retired, and the CLAUDE.md-only guard could not see them.
    // Match every spelling gog accepts for the two flags.
    const docs: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(rel);
        else if (ent.name.endsWith('.md')) docs.push(rel);
      }
    };
    for (const dir of ['skills', 'commands', 'agents']) walk(dir);
    expect(docs.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const rel of docs) {
      const md = read(rel);
      for (const key of IDENTITY_KEYS) {
        const re = new RegExp(`(?:-a|--account|--client)\\s+\\$\\{?${key}`, 'g');
        for (const m of md.matchAll(re)) {
          const line = md.slice(0, m.index).split('\n').length;
          offenders.push(`${rel}:${line}: ${m[0]}`);
        }
      }
    }
    expect(offenders, `retired identity vars passed to gog in a documented command (they expand to empty):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no shell command in CLAUDE.md passes the retired vars to gog', () => {
    // These expand to EMPTY in a shell (.env is loaded into MCP subprocesses,
    // not the parent shell), so a documented `-a $ACE_GMAIL_ACCOUNT` ran as
    // `-a ` and failed — while reading as though it were the canonical form.
    const md = read('CLAUDE.md');
    for (const key of IDENTITY_KEYS) {
      expect(md, `CLAUDE.md still uses $${key} in a command; it expands to empty`).not.toMatch(
        new RegExp(`-a \\$\\{?${key}`),
      );
      expect(md).not.toMatch(new RegExp(`--client \\$\\{?${key}`));
    }
  });
});
