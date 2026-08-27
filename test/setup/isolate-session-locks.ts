/**
 * Global test isolation for the mobile session-lock directory.
 *
 * `~/.ace/sessions/` is SHARED across every ACE session on the machine.
 * Tests that exercise the lock/reap protocol used to operate on it
 * directly, and one case (`reapStaleSessions({ all: true })`) deletes
 * every lock in it — including locks belonging to other live sessions.
 * `npm test` was therefore destructive to concurrent work, silently.
 * Others merely leaked stray lock files into it. See ace#1704.
 *
 * This runs as a vitest `setupFiles` entry, so it executes in every
 * worker BEFORE any test module is imported. It redirects the lock dir
 * to a per-worker tempdir, which makes touching the real one
 * structurally impossible rather than a rule each test file has to
 * remember. Individual tests may still re-point
 * `ACE_SESSION_LOCK_DIR` within their own tempdirs.
 *
 * Class-level preventer, not an instance fix: a new mobile test that
 * acquires a lock is isolated by default, with nothing to opt into.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';

const workerTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-test-session-locks-'));
process.env.ACE_SESSION_LOCK_DIR = workerTmpDir;

afterAll(() => {
  try {
    fs.rmSync(workerTmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
