/**
 * dimagi-internal/ace#3223 — the OCS upload paths never screened RAG uploads
 * against the opp's LLO-facing deny list. `scripts/screen-kb-deny-list.ts` is
 * the screen, and its contract is an EXIT CODE (the skills say "on exit 1 do
 * NOT upload"), so these cases spawn the real script and read `status`.
 *
 * NON-INERTNESS: the hit and clean fixtures differ only in one sentence naming
 * the funder, and must produce different exit codes. Repro shape:
 * `connect-fi/20261018-1440` — confidentiality.yaml lists GiveDirectly /
 * Give Directly / GD, and the PDD opened "This document is INTERNAL. The
 * funder is GiveDirectly ...".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/screen-kb-deny-list.ts');

let tmp: string;
let yamlPath: string;

function run(...args: string[]) {
  return spawnSync('npx', ['tsx', SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf-8' });
}

function kbDir(name: string, files: Record<string, string | Buffer>): string {
  const dir = join(tmp, name);
  mkdirSync(dir);
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  return dir;
}

const CLEAN_PDD = '# Program design\n\nThe funder supports cash transfers to 400 households.\nBudget and GDP figures are in section 4.\n';
const HIT_PDD = '# Program design\n\nThis document is INTERNAL. The funder is GiveDirectly.\n';

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screen-kb-deny-list-'));
  yamlPath = join(tmp, 'confidentiality.yaml');
  writeFileSync(yamlPath, 'llo_facing_deny_list: [GiveDirectly, Give Directly, GD]\n');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('scripts/screen-kb-deny-list.ts (ace#3223)', () => {
  it('exits 1 and names the file and term when a file names a deny-listed party', () => {
    const dir = kbDir('hit', { 'idea-to-pdd.md': HIT_PDD, 'faq.md': CLEAN_PDD });
    const res = run(yamlPath, dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('idea-to-pdd.md');
    expect(res.stderr).toContain('"GiveDirectly"');
    const out = JSON.parse(res.stdout.trim());
    const hit = out.files.find((f: { path: string }) => f.path.endsWith('idea-to-pdd.md'));
    expect(hit.pass).toBe(false);
    expect(hit.hits).toContain('GiveDirectly');
    expect(out.files.find((f: { path: string }) => f.path.endsWith('faq.md')).pass).toBe(true);
  });

  it('exits 0 on a clean dir (whole-word matching: "budget" and "GDP" are not "GD")', () => {
    const dir = kbDir('clean', { 'idea-to-pdd.md': CLEAN_PDD });
    const res = run(yamlPath, dir);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim()).files[0].pass).toBe(true);
  });

  it('exits 1 on a non-text file it cannot screen', () => {
    const dir = kbDir('binary', { 'sop.pdf': Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]) });
    const res = run(yamlPath, dir);
    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout.trim()).unscreened[0]).toMatch(/sop\.pdf$/);
  });

  it('exits 0 with a note when the opp has no confidentiality.yaml (`none`) or an empty list', () => {
    const dir = kbDir('nolist', { 'idea-to-pdd.md': HIT_PDD });
    const none = run('none', dir);
    expect(none.status).toBe(0);
    expect(JSON.parse(none.stdout.trim()).note).toMatch(/no inputs\/confidentiality\.yaml/);

    const empty = join(tmp, 'empty.yaml');
    writeFileSync(empty, 'llo_facing_deny_list: []\n');
    const res = run(empty, dir);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim()).note).toMatch(/no llo_facing_deny_list entries/);
  });

  it('exits 2 on a missing confidentiality yaml, a missing dir, or bad usage', () => {
    const dir = kbDir('harness', { 'a.md': CLEAN_PDD });
    expect(run(join(tmp, 'does-not-exist.yaml'), dir).status).toBe(2);
    expect(run(yamlPath, join(tmp, 'no-such-dir')).status).toBe(2);
    expect(run(yamlPath).status).toBe(2);
  });

  it('exits 2 on a malformed deny list', () => {
    const bad = join(tmp, 'bad.yaml');
    writeFileSync(bad, 'llo_facing_deny_list: GiveDirectly\n');
    expect(run(bad, kbDir('malformed', { 'a.md': CLEAN_PDD })).status).toBe(2);
  });
});

describe('both OCS upload skills run the deny-list screen before uploading (ace#3223)', () => {
  for (const skill of ['ocs-agent-setup', 'ocs-knowledge-refresh']) {
    const text = readFileSync(join(REPO_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');

    it(`${skill} invokes scripts/screen-kb-deny-list.ts and cites ace#3223`, () => {
      expect(text).toMatch(/node "\$ACE_ROOT\/node_modules\/tsx\/dist\/cli\.mjs" "\$ACE_ROOT\/scripts\/screen-kb-deny-list\.ts"/);
      expect(text).toMatch(/ace#3223/);
      expect(text).toMatch(/confidentiality\.yaml/);
    });
  }

  it('ocs-agent-setup forbids indexing inputs/ wholesale when confidentiality.yaml exists', () => {
    const text = readFileSync(join(REPO_ROOT, 'skills/ocs-agent-setup/SKILL.md'), 'utf8');
    expect(text).toMatch(/\[LLO-facing source\]/);
    expect(text).toMatch(/do not index `inputs\/`\s+wholesale/i);
  });
});
