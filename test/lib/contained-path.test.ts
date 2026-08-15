/**
 * ace#1110 — LLM-supplied paths reaching read/write/exec sinks.
 *
 * The threat is not hypothetical plumbing: MCP arguments come from an agent
 * that ingests inbound email, Drive docs and OCS source material, while the
 * MCP subprocesses hold production credentials.
 *
 * The two halves are tested differently on purpose. The credential denylist
 * must REFUSE secrets and must NOT refuse the paths real ACE flows use — that
 * second half is what keeps this from becoming the #1026 class, a blocker that
 * always fires and trains agents to route around it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertNotCredentialPath,
  assertContainedPath,
  isSafeArtifactName,
  PathContainmentError,
} from '../../lib/contained-path';

const opts = { atom: 'drive_upload_binary', resolveSymlinks: false } as const;
const refuses = (p: string) => () => assertNotCredentialPath(p, opts);

describe('the credential denylist refuses secrets wherever they live', () => {
  it.each([
    '/Users/x/.claude/plugins/data/ace-ace/.env',
    '/Users/x/project/.env.local',
    '/Users/x/.ace/ocs-session-dimagi.json',
    '/Users/x/.ace/connect-session.json',
    '/Users/x/.claude/plugins/data/ace-ace/gws-sa-key.json',
    '/Users/x/.ssh/id_rsa',
    '/Users/x/.ssh/id_ed25519',
    '/Users/x/certs/server.pem',
    '/Users/x/credentials.json',
    '/Users/x/.netrc',
    '/Users/x/.git-credentials',
  ])('refuses %s', (p) => {
    expect(refuses(p)).toThrow(PathContainmentError);
  });

  it('refuses anything under .ssh / .aws / .gnupg wholesale', () => {
    expect(refuses('/Users/x/.ssh/config')).toThrow(/traverses \.ssh/);
    expect(refuses('/Users/x/.aws/credentials')).toThrow(PathContainmentError);
    expect(refuses('/Users/x/.gnupg/secring.gpg')).toThrow(PathContainmentError);
  });

  it('is case-insensitive', () => {
    expect(refuses('/Users/x/.ENV')).toThrow(PathContainmentError);
    expect(refuses('/Users/x/GWS-SA-KEY.JSON')).toThrow(PathContainmentError);
  });

  it('sees through .. before matching', () => {
    expect(refuses('/Users/x/screenshots/../.ssh/id_rsa')).toThrow(PathContainmentError);
  });

  it('names the atom, so the operator knows which call refused', () => {
    expect(() => assertNotCredentialPath('/Users/x/.env', { atom: 'ocs_upload_collection_files', resolveSymlinks: false }))
      .toThrow(/^ocs_upload_collection_files:/);
  });
});

describe('legitimate ACE paths still pass — the half that keeps this usable', () => {
  it.each([
    '/tmp/ace-screenshots/run-1/learn-01.png',
    '/var/folders/xx/T/ace-mobile-reg-abc/part-a/step.png',
    '/Users/x/.claude/plugins/data/ace-ace/commcare-cli.jar',
    '/tmp/ace/app.ccz',
    '/tmp/ace/multimedia/jingle.mp3',
    '/tmp/ace/form.xml',
    '/tmp/opp/inputs/design-notes.docx',
    '/tmp/ace/session-notes.md',        // "session" but not a .json credential
    '/tmp/ace/env-summary.txt',         // "env" but not a dotfile
    '/tmp/ace/my-key.json.png',         // not a -key.json basename
  ])('allows %s', (p) => {
    expect(() => assertNotCredentialPath(p, opts)).not.toThrow();
  });

  it('allows a public key — only the private half is credential material', () => {
    expect(() => assertNotCredentialPath('/Users/x/keys/id_rsa.pub', opts)).not.toThrow();
  });
});

describe('a symlink cannot disguise the target', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'ace-cp-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves a benign-looking name to the real credential', () => {
    const secret = path.join(dir, '.env');
    writeFileSync(secret, 'OCS_TOKEN=hunter2');
    const decoy = path.join(dir, 'holiday-photo.png');
    symlinkSync(secret, decoy);

    expect(() => assertNotCredentialPath(decoy, { atom: 'drive_upload_binary' }))
      .toThrow(/resolves to/);
  });

  it('still allows a symlink to something innocuous', () => {
    const real = path.join(dir, 'shot.png');
    writeFileSync(real, 'x');
    const link = path.join(dir, 'latest.png');
    symlinkSync(real, link);
    expect(() => assertNotCredentialPath(link, { atom: 'drive_upload_binary' })).not.toThrow();
  });

  it('handles a WRITE target that does not exist yet', () => {
    // commcare_download_ccz's write_to_path names a file to be created.
    expect(() => assertNotCredentialPath(path.join(dir, 'new.ccz'), { atom: 'commcare_download_ccz' }))
      .not.toThrow();
  });

  it('refuses a not-yet-existing write target that IS a credential name', () => {
    expect(() => assertNotCredentialPath(path.join(dir, '.env'), { atom: 'commcare_download_ccz' }))
      .toThrow(PathContainmentError);
  });

  it('refuses a write through a symlinked parent directory', () => {
    const hidden = path.join(dir, 'real-ssh');
    mkdirSync(hidden);
    const link = path.join(dir, '.ssh');
    symlinkSync(hidden, link);
    expect(() => assertNotCredentialPath(path.join(link, 'authorized_keys'), { atom: 'commcare_download_ccz' }))
      .toThrow(PathContainmentError);
  });
});

describe('isSafeArtifactName — a remote-supplied filename', () => {
  it.each(['learn-01.png', 'a.b.c.png', 'UPPER.PNG', '2026-08-14_shot.mp4'])(
    'accepts %s', (n) => expect(isSafeArtifactName(n)).toBe(true));

  it.each([
    '../../../etc/passwd',
    '../evil.png',
    'sub/dir.png',
    'sub\\dir.png',
    '/abs/path.png',
    '',
    '.',
    '..',
    'bad\0name.png',
  ])('rejects %j', (n) => expect(isSafeArtifactName(n)).toBe(false));
});

describe('assertContainedPath — implemented, wired only where roots are settled', () => {
  it('allows a path under an allowed root', () => {
    expect(() => assertContainedPath('/tmp/ace/x/y.png', ['/tmp/ace'], { atom: 't', resolveSymlinks: false }))
      .not.toThrow();
  });

  it('allows the root itself', () => {
    expect(() => assertContainedPath('/tmp/ace', ['/tmp/ace'], { atom: 't', resolveSymlinks: false }))
      .not.toThrow();
  });

  it('does not let a sibling prefix pass as containment', () => {
    // /tmp/ace-evil must NOT count as being under /tmp/ace.
    expect(() => assertContainedPath('/tmp/ace-evil/x', ['/tmp/ace'], { atom: 't', resolveSymlinks: false }))
      .toThrow(PathContainmentError);
  });

  it('rejects a .. escape', () => {
    expect(() => assertContainedPath('/tmp/ace/../etc/passwd', ['/tmp/ace'], { atom: 't', resolveSymlinks: false }))
      .toThrow(PathContainmentError);
  });

  it('refuses everything when no roots are configured, rather than allowing all', () => {
    expect(() => assertContainedPath('/tmp/x', [], { atom: 't', resolveSymlinks: false }))
      .toThrow(/no allowed roots/);
  });

  it('accepts any of several roots', () => {
    expect(() => assertContainedPath('/var/data/x', ['/tmp/ace', '/var/data'], { atom: 't', resolveSymlinks: false }))
      .not.toThrow();
  });
});
