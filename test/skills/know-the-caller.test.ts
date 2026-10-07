/**
 * skills/know-the-caller + bin/ace-person (Jon, 2026-10-07; ace#2766).
 *
 * ACE answered Lilianna Bagnoli's KC coaching question for its own generic Coach,
 * as if Connect had one coach. The fix is a per-person memory in Drive that names
 * each person's projects and instances, plus a rule to resolve "the coach" to a
 * specific one. These tests pin the storage contract (where the doc lives, that it
 * is never shared, that a second write replaces in place) by running the real
 * script against fake `gog` and `canopy`, and pin that every person-facing entry
 * point loads the skill.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');

function fakes(hasDoc: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-person-'));
  const log = path.join(dir, 'calls.log');
  const doc = hasDoc ? '[{"id":"doc1","name":"Lilianna Bagnoli lbagnoli@dimagi.com"}]' : '[]';
  fs.writeFileSync(
    path.join(dir, 'gog'),
    `#!/bin/bash
echo "gog $*" >> "${log}"
if [ "$1 $2" = "docs cat" ]; then echo "DOC BODY"; exit 0; fi
parent=""; query=""
while [ $# -gt 0 ]; do case "$1" in --parent) parent="$2"; shift;; --query) query="$2"; shift;; esac; shift; done
case "$parent" in
  root) case "$query" in *"Process State"*) echo '[{"id":"ps","name":"Process State"}]';; *) echo '[]';; esac;;
  ps) echo '[{"id":"pp","name":"People"}]';;
  pp) echo '${doc}';;
  *) echo '[]';;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, 'canopy'), `#!/bin/bash\necho "canopy $*" >> "${log}"\n`, { mode: 0o755 });
  return { dir, log };
}

function run(args: string[], hasDoc: boolean) {
  const { dir, log } = fakes(hasDoc);
  const r = spawnSync(path.join(REPO_ROOT, 'bin', 'ace-person'), args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      GDRIVE_ROOT_FOLDER: 'root',
      ACE_GOG_CLIENT: 'canopy',
      ACE_ENV_FILE: path.join(dir, 'no.env'),
    },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  return { ...r, calls };
}

describe('bin/ace-person', () => {
  it('finds the doc under Process State/People by email', () => {
    const r = run(['find', 'LBagnoli@dimagi.com'], true);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('doc1\tLilianna Bagnoli lbagnoli@dimagi.com\thttps://docs.google.com/document/d/doc1/edit');
    expect(r.calls).toContain("name contains 'lbagnoli@dimagi.com'");
  });

  it('reads the doc, and exits 1 on first contact', () => {
    expect(run(['read', 'lbagnoli@dimagi.com'], true).stdout).toContain('DOC BODY');
    expect(run(['read', 'lbagnoli@dimagi.com'], false).status).toBe(1);
  });

  it('creates a new doc in Process State/People, never shared', () => {
    const md = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ace-person-md-')), 'p.md');
    fs.writeFileSync(md, '# Lilianna\n');
    const r = run(['write', 'lbagnoli@dimagi.com', '--name', 'Lilianna Bagnoli', '--md', md], false);
    expect(r.status).toBe(0);
    expect(r.calls).toContain(
      `canopy gdoc publish --repo ${REPO_ROOT} --md ${md} --name Lilianna Bagnoli lbagnoli@dimagi.com --area Process State --project People --share none`,
    );
  });

  it('replaces an existing doc in place, never shared', () => {
    const md = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ace-person-md-')), 'p.md');
    fs.writeFileSync(md, '# Lilianna\n');
    const r = run(['write', 'lbagnoli@dimagi.com', '--md', md], true);
    expect(r.status).toBe(0);
    expect(r.calls).toContain(`canopy gdoc publish --repo ${REPO_ROOT} --md ${md} --replace doc1 --share none`);
  });

  it('refuses an address that could rewrite the Drive query', () => {
    const r = run(['find', "x@y.com' or name contains '"], true);
    expect(r.status).toBe(2);
    expect(r.calls).toBe('');
  });
});

describe('know-the-caller is wired into every person-facing entry point', () => {
  it.each(['CLAUDE.md', 'persona.md', 'skills/inbox-triage/SKILL.md', 'skills/partner-on-connect-program/SKILL.md'])(
    '%s loads the skill',
    (file) => {
      expect(read(file)).toContain('know-the-caller');
    },
  );

  it('the program context doc lists its coaches and bots', () => {
    expect(read('skills/partner-on-connect-program/SKILL.md')).toContain('| AI coaches and bots |');
  });

  it('the skill states the instance rule', () => {
    expect(read('skills/know-the-caller/SKILL.md')).toContain('There is no "the" in Connect');
  });
});
