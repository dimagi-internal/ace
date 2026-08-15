/**
 * dimagi-internal/ace#1114 — 2026-07-31 security audit, operator-surface
 * cluster. Each item is small and independent; what they share is that they
 * expose something to a LOCAL observer or to a shell.
 *
 * C1 — credentials in `curl` argv. `curl -H "Authorization: Bearer $TOKEN"`
 *      publishes the live secret to `ps` for the duration of the call. Five
 *      probes in bin/ace-doctor did this (labs PAT x2, HQ ApiKey, Nova key,
 *      ace-web PAT), plus the upload PAT in skills/upload-transcript.
 *      curl reads a header from stdin with `-H @-`, which keeps it out of argv
 *      entirely — verified live against httpbin: the server still receives it.
 *
 * A4 — untrusted inbound subject reaching a Bash command line. bin/ace-email
 *      is itself clean (os.execvp, no shell), but email-communicator has the
 *      MODEL compose the invocation as a Bash command, and inbox-triage
 *      derives --subject from inbound mail as `Re: <their subject>`. The body
 *      was already file-passed for exactly this reason; the subject was not.
 *
 * C2 — `npx --yes tsx` fetches an unpinned package at runtime.
 * C3 — the Connect login probe logged cookie material and 4KB of page HTML
 *      into the session transcript.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
/** Strip comment lines so a doc-comment quoting the old form doesn't match. */
const code = (s: string) =>
  s.split('\n').filter((l) => !/^\s*(#|\/\/|\*|<!--)/.test(l)).join('\n');

describe('C1 — no credentials on a curl command line (#1114)', () => {
  it('bin/ace-doctor passes every auth header on stdin', () => {
    const src = code(read('bin/ace-doctor'));
    expect(src).not.toMatch(/curl[^|\n]*-H "Authorization:/);
    expect(src, 'the stdin helper must exist').toMatch(/curl_auth\(\)/);
    expect(src).toMatch(/curl -H @-/);
  });

  it('every secret-bearing probe goes through curl_auth', () => {
    const src = code(read('bin/ace-doctor'));
    for (const tok of ['$LABS_TOKEN', '$NOVA_KEY_VAL', '$PAT_TOKEN', '$HQ_KEY_VAL']) {
      const line = src.split('\n').find((l) => l.includes(tok) && l.includes('Authorization'));
      expect(line, `no auth line found for ${tok}`).toBeTruthy();
      expect(line, `${tok} must be passed via curl_auth`).toMatch(/curl_auth/);
    }
  });

  it('upload-transcript sends its PAT on stdin too', () => {
    const src = code(read('skills/upload-transcript/SKILL.md'));
    expect(src).not.toMatch(/curl[^|\n]*-H "Authorization: Bearer \$ACE_WEB_PAT_TOKEN"/);
    expect(src).toMatch(/-H @-/);
  });
});

describe('A4 — an inbound subject never reaches a shell (#1114)', () => {
  it('bin/ace-email accepts --subject-file', () => {
    expect(read('bin/ace-email')).toMatch(/--subject-file/);
  });

  it('reads the file, takes only the first line, and rejects an empty one', () => {
    const src = read('bin/ace-email');
    // A newline in a subject would let an attacker inject extra headers.
    expect(src).toMatch(/splitlines\(\)\[0\]/);
    expect(src).toMatch(/is empty/);
  });

  it('still hands the value to canopy through execvp argv, not a shell', () => {
    const src = read('bin/ace-email');
    expect(src).toMatch(/os\.execvp\("canopy"/);
    expect(src).not.toMatch(/shell=True/);
  });
});

describe('C2 — no unpinned runtime package fetch (#1114)', () => {
  it('bin/ace-mobile-reap uses the repo-pinned tsx', () => {
    const src = code(read('bin/ace-mobile-reap'));
    // Match the EXECUTING form. The hint text below deliberately names
    // `npx --yes` to say what we are not doing, so a bare substring check
    // would fail forever.
    expect(src).not.toMatch(/(^|[;&|]\s*|\bexec\s+)npx\s+--yes/m);
    expect(src).toMatch(/node_modules\/\.bin\/tsx/);
    expect(src).toMatch(/exec "\$TSX_BIN"/);
  });

  it('fails with an install hint rather than falling back to the network', () => {
    expect(read('bin/ace-mobile-reap')).toMatch(/npm ci/);
  });
});

describe('C3 — the login probe logs no secret material (#1114)', () => {
  it('logs cookie NAMES, never values', () => {
    const src = code(read('scripts/probe-connect-login.ts'));
    expect(src).not.toMatch(/c\.value\.slice/);
    expect(src).toMatch(/c\.value\.length/);
  });

  it('does not dump raw page HTML into the transcript', () => {
    const src = code(read('scripts/probe-connect-login.ts'));
    expect(src).not.toMatch(/console\.log\(snippet\)/);
  });
});
