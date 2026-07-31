import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  StaleArtifactError,
  identityMismatches,
  isPredictableSharedPath,
  isSafeScratchTarget,
  readVerifiedJson,
  scratchDir,
  scratchPath,
  writeVerifiedJson,
} from '../../lib/scratch-file.js';

// dimagi-internal/ace#1046 — a helper documented as
// `--out /tmp/ace-hq-<app>.json` writes to a path shared across macOS
// users. The write fails EACCES because another account owns the file; the
// follow-up read SUCCEEDS and returns that account's stale payload. Live
// near-miss: bednet-spot-check/20260729-0002 Phase 3 Step 2.65 read a walk
// of DIFFERENT apps (2 and 5 modules vs this run's 1 each) and would have
// gridded modules on two unrelated apps in prod HQ with a 200 and no error.
//
// Two halves are pinned here: the path must not be predictable-shared, and
// the read must FAIL CLOSED on an identity mismatch rather than hand back
// the wrong payload.

const cleanup: string[] = [];
afterEach(() => {
  for (const p of cleanup.splice(0)) fs.rmSync(p, { force: true, recursive: true });
});

describe('scratchPath is not the predictable shared /tmp form (#1046)', () => {
  it('roots under the per-user tmpdir with mkdtemp randomness', () => {
    const p = scratchPath('run-form-walk-73cc7a4046f34a33b46a337310ff0a39.json');
    cleanup.push(scratchDir());

    // The whole defect: a fixed literal a sibling session can name.
    // NOTE this must hold on BOTH platforms. On macOS `os.tmpdir()` is the
    // per-user `/var/folders/...` TMPDIR; on Linux CI it IS `/tmp`, so the
    // only thing making the path unpredictable there is the mkdtemp'd parent
    // segment. An earlier cut of this checked the path TEXT and passed
    // locally while failing on CI for exactly that reason.
    expect(isSafeScratchTarget(p)).toBe(true);
    expect(p).not.toBe('/tmp/ace-hq-learn.json');
    expect(p.startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);

    // mkdtemp randomness: the containing dir carries a suffix, so the path
    // is unguessable rather than merely per-user.
    const dir = path.basename(path.dirname(p));
    expect(dir).toMatch(/^ace-scratch-.+/);
    expect(dir.length).toBeGreaterThan('ace-scratch-'.length);
  });

  it('two processes would not collide on the same directory name', () => {
    // Same process here, but a fresh mkdtemp proves the name is random
    // rather than derived from anything a sibling shares (uid, app id).
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-scratch-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-scratch-'));
    cleanup.push(a, b);
    expect(a).not.toBe(b);
  });

  it('creates the scratch dir 0700 so a sibling user cannot read it', () => {
    const dir = scratchDir();
    cleanup.push(dir);
    const mode = fs.statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('cannot be escaped by a hostile basename', () => {
    const p = scratchPath('../../etc/passwd');
    cleanup.push(scratchDir());
    expect(path.dirname(p)).toBe(scratchDir());
    expect(p).not.toContain('/etc/');
  });

  it('classifies the exact near-miss path as predictable-shared', () => {
    // Syntactic lint predicate — operates on literals as written in source.
    expect(isPredictableSharedPath('/tmp/ace-hq-learn.json')).toBe(true);
    expect(isPredictableSharedPath('/private/tmp/ace-hq-learn.json')).toBe(true);
    // mktemp templates and uid-scoped paths are NOT the defect shape.
    expect(isPredictableSharedPath('/tmp/ace-hq-XXXXXX.json')).toBe(false);
    expect(isPredictableSharedPath('/tmp/ace-labs-walkthrough-$(id -u)')).toBe(false);
    expect(isPredictableSharedPath('/var/folders/xy/T/ace-scratch-abc/x.json')).toBe(false);
    // mkdtemp output under a plain /tmp (the Linux/CI shape).
    expect(isPredictableSharedPath('/tmp/ace-scratch-Ab3xY9/walk.json')).toBe(false);
    expect(isPredictableSharedPath('/tmp/tmp.9Kd2pQaz/walk.json')).toBe(false);
  });

  it('the runtime check accepts our own scratch dir but rejects a shared literal', () => {
    // The two predicates answer different questions and must not be swapped.
    expect(isSafeScratchTarget(scratchPath('x.json'))).toBe(true);
    cleanup.push(scratchDir());
    expect(isSafeScratchTarget('/tmp/ace-hq-learn.json')).toBe(false);
    // Anything outside /tmp is somebody's own space, not the shared class.
    expect(isSafeScratchTarget(path.join(os.homedir(), '.ace', 'x.json'))).toBe(true);
  });

  it('the runtime check accepts a shell mktemp file (0600, ours)', () => {
    // A caller doing `--out "$(mktemp ...)"` must not get a bogus warning.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mkt-'));
    cleanup.push(dir);
    const p = path.join(dir, 'from-mktemp.json');
    fs.writeFileSync(p, '{}', { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    expect(isSafeScratchTarget(p)).toBe(true);
  });
});

describe('reads fail closed on an identity mismatch (#1046)', () => {
  it('throws StaleArtifactError instead of returning another session stale payload', () => {
    // Simulate the near-miss exactly: our write never landed, and a file
    // from a DIFFERENT session sits at the path we are about to read.
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ace-stale-')), 'ace-hq-learn.json');
    cleanup.push(path.dirname(p));
    fs.writeFileSync(
      p,
      JSON.stringify({
        domain: 'connect-ace-prod',
        app_id: '3c2f7a0000000000000000000000000a', // the OTHER session's app
        forms: [{ module: 0, form: 0 }, { module: 1, form: 0 }],
      }),
    );

    let thrown: unknown;
    try {
      readVerifiedJson({
        filePath: p,
        identity: { domain: 'connect-ace-prod', app_id: '73cc7a4046f34a33b46a337310ff0a39' },
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown, 'a mismatched app_id MUST throw, not return the payload').toBeInstanceOf(
      StaleArtifactError,
    );
    const err = thrown as StaleArtifactError;
    expect(err.code).toBe('STALE_ARTIFACT');
    expect(err.mismatches.map((m) => m.key)).toEqual(['app_id']);
    expect(err.mismatches[0].actual).toBe('3c2f7a0000000000000000000000000a');
    // The message must name the mismatch so an operator can see WHICH id lied.
    expect(err.message).toContain('73cc7a4046f34a33b46a337310ff0a39');
    expect(err.message).toContain('3c2f7a0000000000000000000000000a');
  });

  it('an UNSTAMPED payload cannot prove it is ours, so it also fails closed', () => {
    const p = scratchPath('unstamped.json');
    cleanup.push(scratchDir());
    fs.writeFileSync(p, JSON.stringify({ forms: [] }));
    expect(() =>
      readVerifiedJson({ filePath: p, identity: { app_id: 'abc' } }),
    ).toThrow(StaleArtifactError);
  });

  it('accepts a payload whose stamp matches', () => {
    const p = scratchPath('match.json');
    cleanup.push(scratchDir());
    const payload = { domain: 'd', app_id: 'abc', forms: [] };
    fs.writeFileSync(p, JSON.stringify(payload));
    expect(readVerifiedJson({ filePath: p, identity: { domain: 'd', app_id: 'abc' } })).toEqual(
      payload,
    );
  });

  it('malformed JSON fails closed rather than surfacing a raw parse error', () => {
    const p = scratchPath('garbage.json');
    cleanup.push(scratchDir());
    fs.writeFileSync(p, 'not json at all');
    expect(() => readVerifiedJson({ filePath: p, identity: { app_id: 'abc' } })).toThrow(
      StaleArtifactError,
    );
  });

  it('identityMismatches treats a non-object payload as a mismatch', () => {
    expect(identityMismatches('a string', { app_id: 'abc' })).toHaveLength(1);
    expect(identityMismatches([{ app_id: 'abc' }], { app_id: 'abc' })).toHaveLength(1);
  });
});

describe('writeVerifiedJson proves the file on disk is the one we wrote (#1046)', () => {
  it('round-trips a stamped payload', () => {
    const p = scratchPath('written.json');
    cleanup.push(scratchDir());
    writeVerifiedJson({
      filePath: p,
      payload: { domain: 'd', app_id: 'abc', forms: [] },
      identity: { domain: 'd', app_id: 'abc' },
    });
    expect(JSON.parse(fs.readFileSync(p, 'utf-8')).app_id).toBe('abc');
  });

  it('refuses to write a payload that does not carry its own identity stamp', () => {
    // A caller who forgets to stamp gets a loud failure rather than a
    // silent hole in the guard.
    const p = scratchPath('unstamped-write.json');
    cleanup.push(scratchDir());
    expect(() =>
      writeVerifiedJson({ filePath: p, payload: { forms: [] }, identity: { app_id: 'abc' } }),
    ).toThrow(StaleArtifactError);
    expect(fs.existsSync(p)).toBe(false);
  });

  it('detects a lost write: a stale file left where ours should have landed', () => {
    // The composed failure: a stale file from "another session" sits at the
    // target, and our write reports success without landing (the shape of a
    // wrapper that swallowed the EACCES). The read-back is the only thing
    // that can notice — which is the whole point of the guard.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-lost-'));
    cleanup.push(dir);
    const p = path.join(dir, 'out.json');
    fs.writeFileSync(p, JSON.stringify({ domain: 'd', app_id: 'SOMEONE_ELSE' }));

    expect(() =>
      writeVerifiedJson({
        filePath: p,
        payload: { domain: 'd', app_id: 'OURS' },
        identity: { domain: 'd', app_id: 'OURS' },
        writeImpl: () => {
          /* swallowed failure — what an EACCES-eating wrapper looks like */
        },
      }),
    ).toThrow(StaleArtifactError);

    // And the stale file is still exactly what it was — we never returned it.
    expect(JSON.parse(fs.readFileSync(p, 'utf-8')).app_id).toBe('SOMEONE_ELSE');
  });

  it('a genuinely unwritable target throws instead of reporting success', () => {
    // No stubbing: a real EACCES from a read-only file. This is the closest a
    // test can get to "another macOS user owns the file" without a second uid.
    if (process.getuid?.() === 0) return; // root ignores mode bits
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-eacces-'));
    cleanup.push(dir);
    const p = path.join(dir, 'out.json');
    fs.writeFileSync(p, JSON.stringify({ domain: 'd', app_id: 'SOMEONE_ELSE' }));
    fs.chmodSync(p, 0o444);

    expect(() =>
      writeVerifiedJson({
        filePath: p,
        payload: { domain: 'd', app_id: 'OURS' },
        identity: { domain: 'd', app_id: 'OURS' },
      }),
    ).toThrow(/EACCES|permission denied|STALE_ARTIFACT/i);

    // The stale payload survived the failed write — and reading it now fails
    // closed rather than handing back the other session's app_id. That two-step
    // is the exact bednet-spot-check/20260729-0002 near-miss.
    fs.chmodSync(p, 0o644);
    expect(() =>
      readVerifiedJson({ filePath: p, identity: { domain: 'd', app_id: 'OURS' } }),
    ).toThrow(StaleArtifactError);
  });
});
