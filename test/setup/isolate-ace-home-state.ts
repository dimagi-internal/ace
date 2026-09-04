/**
 * Global test isolation for ACE's real `~/.ace` state directory.
 *
 * `~/.ace/` is SHARED across every ACE session on the machine, and two
 * different pieces of live session state live directly in it:
 *
 *   1. `~/.ace/sessions/`            — mobile session locks
 *   2. `~/.ace/mobile-backend.<pid>` — the /ace:mobile-backend toggle
 *
 * Tests that exercise either used to operate on the real thing.
 * `reapStaleSessions({ all: true })` deletes every lock in (1),
 * including locks belonging to other live sessions, so `npm test` was
 * destructive to concurrent work, silently (ace#1704).
 *
 * (2) is worse, because it is a SINGLE FILE rather than a directory of
 * per-session ones. `resolveBackend()` keys it on `process.ppid`, which
 * inside a vitest worker is the vitest MAIN process — the same value in
 * every worker. So every worker read, wrote and deleted one shared file
 * concurrently: `backend-toggle.test.ts` left it at `cloud` while an
 * unrelated mobile test in another worker resolved `cloud` out of it and
 * threw CLOUD_NOT_CONFIGURED, and `client.test.ts`'s
 * `clearSessionBackend()` deleted it mid-assertion from the other side.
 * That is the single source behind both ace#1883 and ace#1797 — the
 * former is the shared file, the latter is a test dropping the env pin
 * that had been accidentally masking it.
 *
 * This runs as a vitest `setupFiles` entry, so it executes in every
 * worker BEFORE any test module is imported. It redirects both pieces of
 * state to a per-worker tempdir, which makes touching the real ones
 * structurally impossible rather than a rule each test file has to
 * remember. Individual tests may still re-point `ACE_SESSION_LOCK_DIR`
 * or `ACE_MOBILE_STATE_DIR` within their own tempdirs.
 *
 * Class-level preventer, not an instance fix: a new mobile test that
 * acquires a lock or flips the backend toggle is isolated by default,
 * with nothing to opt into. If a third piece of `~/.ace` state appears,
 * it belongs here too — that is what this file is for.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';

const workerTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-test-home-state-'));

// (1) mobile session locks — ace#1704. Mirrors the real layout
// (`~/.ace/sessions/`), and is created up front because the previous
// value was the tempdir root, which mkdtemp had already created.
const lockDir = path.join(workerTmpDir, 'sessions');
fs.mkdirSync(lockDir, { recursive: true });
process.env.ACE_SESSION_LOCK_DIR = lockDir;

// (2) the mobile backend toggle file — ace#1883 / ace#1797
process.env.ACE_MOBILE_STATE_DIR = workerTmpDir;

afterAll(() => {
  try {
    fs.rmSync(workerTmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
