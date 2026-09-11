/**
 * bin/ace-email + bin/ace-mark-read shim preventer suite.
 *
 * Both are thin shims over the shared canopy email engine (jjackson/canopy#266/#281,
 * ace#826): identity pinned to THIS repo via --repo, all behavior (HTML wrapper,
 * reply-all, keychain-free mark-read, timeouts) engine-side so fixes propagate
 * fleet-wide. These tests run the real shims against a fake `canopy` on PATH and pin
 * the exec shape, so a refactor back toward a local implementation (or an argument
 * drift) fails loudly offline. The missing-CLI path must exit with a remediation, not
 * a bare traceback.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function withFakeCanopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-canopy-'));
  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'canopy');
  fs.writeFileSync(bin, `#!/bin/bash\necho "$@" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  return { dir, log };
}

function runShim(tool: string, args: string[], pathPrefix: string) {
  return spawnSync('python3', [path.join(REPO_ROOT, 'bin', tool), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${pathPrefix}:${process.env.PATH}` },
  });
}

describe('email shims over the canopy engine', () => {
  it('ace-email execs `canopy email send --repo <this repo>` with args passed through', () => {
    const { dir, log } = withFakeCanopy();
    const r = runShim('ace-email', ['--to', 'x@y.z', '--subject', 's', '--body-file', 'b.txt', '--dry-run'], dir);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(log, 'utf8').trim()).toBe(
      `email send --repo ${REPO_ROOT} --to x@y.z --subject s --body-file b.txt --dry-run`,
    );
  });

  it('ace-mark-read execs `canopy email mark-read --repo <this repo>` with thread ids', () => {
    const { dir, log } = withFakeCanopy();
    const r = runShim('ace-mark-read', ['t1', 't2'], dir);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(log, 'utf8').trim()).toBe(
      `email mark-read --repo ${REPO_ROOT} t1 t2`,
    );
  });

  /**
   * ace-web is the human surface for a run; Drive is ACE's storage (ace#2378).
   * Since 2026-09-02 ACE's replies on thread 19f86579142e6ba5 linked Google
   * Docs and HQ pages and never the run's ace-web page, which existed the whole
   * time. The shim now refuses a Drive-linked body that names no ace-web page,
   * before canopy is ever called — and a dry-run gets the same verdict, so the
   * draft is caught before it reaches the approval step.
   */
  describe('run-page check (ace#2378)', () => {
    const RUN_PAGE =
      'https://labs.connect.dimagi.com/ace/opps/dimagi-team/poverty-graduation/runs/20260908-0510/summary';
    const DOC = 'https://docs.google.com/document/d/1AbCdEf/edit';

    function bodyFile(text: string) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-email-body-'));
      const p = path.join(dir, 'body.txt');
      fs.writeFileSync(p, text);
      return p;
    }
    const called = (log: string) => fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim() !== '';

    it('refuses a body that links Drive/Docs and no ace-web page — canopy is never called', () => {
      const { dir, log } = withFakeCanopy();
      const body = bodyFile(`Hi Sophie,\n\nThe build memo is here: ${DOC}\n\nAlso https://drive.google.com/drive/folders/xyz\n`);
      const r = runShim('ace-email', ['--to', 'x@y.z', '--subject', 's', '--body-file', body], dir);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('REFUSED');
      expect(r.stderr).toContain('ace_web_summary_url');
      expect(r.stderr).toContain('--no-run-page');
      expect(r.stderr).toContain('ace#2378');
      expect(r.stderr).toContain(DOC);
      expect(r.stderr).not.toContain('Traceback');
      expect(called(log)).toBe(false);
    });

    it('a dry-run gets the same verdict, so the draft is caught before approval', () => {
      const { dir, log } = withFakeCanopy();
      const body = bodyFile(`See ${DOC}\n`);
      const r = runShim('ace-email', ['--to', 'x@y.z', '--subject', 's', '--body-file', body, '--dry-run'], dir);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('REFUSED (dry-run');
      expect(called(log)).toBe(false);
    });

    it('also reads the --body-file=PATH form', () => {
      const { dir, log } = withFakeCanopy();
      const body = bodyFile(`See ${DOC}\n`);
      const r = runShim('ace-email', ['--to', 'x@y.z', '--subject', 's', `--body-file=${body}`], dir);
      expect(r.status).toBe(3);
      expect(called(log)).toBe(false);
    });

    it('passes a body that leads with the run page and keeps Drive links behind it', () => {
      const { dir, log } = withFakeCanopy();
      const body = bodyFile(`The run: ${RUN_PAGE}\n\nThe memo Doc, to comment on: ${DOC}\n`);
      const r = runShim('ace-email', ['--to', 'x@y.z', '--subject', 's', '--body-file', body], dir);
      expect(r.status).toBe(0);
      expect(fs.readFileSync(log, 'utf8').trim()).toBe(
        `email send --repo ${REPO_ROOT} --to x@y.z --subject s --body-file ${body}`,
      );
    });

    it('passes the authenticated workbench URL form too', () => {
      const { dir } = withFakeCanopy();
      const body = bodyFile(
        `https://labs.connect.dimagi.com/ace/w/dimagi-team/opps/poverty-graduation/runs/20260908-0510\n\n${DOC}\n`,
      );
      const r = runShim('ace-email', ['--to', 'x@y.z', '--subject', 's', '--body-file', body], dir);
      expect(r.status).toBe(0);
    });

    it('passes a body with no links at all', () => {
      const { dir, log } = withFakeCanopy();
      const body = bodyFile('Thanks — noted. Nothing further from ACE on this one.\n');
      const r = runShim('ace-email', ['--to', 'x@y.z', '--subject', 's', '--body-file', body], dir);
      expect(r.status).toBe(0);
      expect(called(log)).toBe(true);
    });

    it('the override passes with a reason, is stripped before canopy, and is echoed', () => {
      const { dir, log } = withFakeCanopy();
      const body = bodyFile(`Proposal draft: ${DOC}\n`);
      const r = runShim(
        'ace-email',
        ['--to', 'x@y.z', '--subject', 's', '--body-file', body, '--no-run-page', 'sales thread, no run yet'],
        dir,
      );
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('run-page check overridden — sales thread, no run yet');
      const sent = fs.readFileSync(log, 'utf8').trim();
      expect(sent).toBe(`email send --repo ${REPO_ROOT} --to x@y.z --subject s --body-file ${body}`);
      expect(sent).not.toContain('no-run-page');
    });

    it('the override refuses an empty reason', () => {
      const { dir, log } = withFakeCanopy();
      const body = bodyFile(`${DOC}\n`);
      for (const flag of [['--no-run-page', ''], ['--no-run-page=  ']]) {
        const r = runShim('ace-email', ['--to', 'x@y.z', '--subject', 's', '--body-file', body, ...flag], dir);
        expect(r.status, flag.join(' ')).toBe(1);
        expect(r.stderr).toContain('needs a reason');
      }
      expect(called(log)).toBe(false);
    });

    it('refuses a stdin body, which it could not check without consuming', () => {
      const { dir, log } = withFakeCanopy();
      const r = runShim('ace-email', ['--to', 'x@y.z', '--subject', 's', '--body-file', '-'], dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('needs a real file');
      expect(called(log)).toBe(false);
    });
  });

  it('both shims exit with a remediation (not a traceback) when canopy is missing', () => {
    // an empty dir shadows nothing; strip the rest of PATH down to essentials so the
    // real canopy (if installed) is not found
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-canopy-'));
    for (const tool of ['ace-email', 'ace-mark-read']) {
      const r = spawnSync('python3', [path.join(REPO_ROOT, 'bin', tool), '--help'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${empty}:/usr/bin:/bin` },
      });
      expect(r.status, tool).toBe(1);
      expect(r.stderr, tool).toContain('canopy CLI not on PATH');
      expect(r.stderr, tool).not.toContain('Traceback');
    }
  });
});
