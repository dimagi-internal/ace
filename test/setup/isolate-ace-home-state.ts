/**
 * Global test isolation for ACE's real `~/.ace` state directory.
 *
 * `~/.ace/` is SHARED across every ACE session on the machine, and two
 * different pieces of live session state live directly in it:
 *
 *   1. `~/.ace/sessions/`            — mobile session locks
 *   2. `~/.ace/mobile-backend.<pid>` — the /ace:mobile-backend toggle
 *   3. `~/.android/avd/*.avd/.ace-provisioned.json` — read (never written)
 *      to choose the DEFAULT mobile backend; see (3) below
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

// (3) the DEFAULT mobile backend. With no env pin and no session file,
// `resolveBackend()` picks `local` iff a provisioned AVD exists on this
// machine, else `lease` — so an unpinned suite would route to `local` on a
// developer laptop and `lease` in CI. Point the selection probe (and only the
// probe — `ANDROID_AVD_HOME` is untouched) at a fixture holding one
// provisioned AVD, so the suite-wide default is `local` everywhere, as it was
// before the lease backend existed. Tests of the selection matrix re-point
// `ACE_MOBILE_SELECTION_AVD_HOME` at their own tempdirs.
const selectionAvdHome = path.join(workerTmpDir, 'selection-avd-home');
fs.mkdirSync(path.join(selectionAvdHome, 'ACE_Test_Provisioned.avd'), { recursive: true });
fs.writeFileSync(
  path.join(selectionAvdHome, 'ACE_Test_Provisioned.avd', '.ace-provisioned.json'),
  JSON.stringify({ marked_at: '2026-01-01T00:00:00.000Z', selector_map: 'connect-test@000000000000' }),
);
process.env.ACE_MOBILE_SELECTION_AVD_HOME = selectionAvdHome;

// (4) the test-worker lease ledger (`~/.ace/test-worker-leases.jsonl`,
// ace#3033) — the file an operator greps to name who held a lease, so a
// test's fake leases must never land in the real one.
process.env.ACE_TEST_WORKER_LEDGER = path.join(workerTmpDir, 'test-worker-leases.jsonl');

// (5) ACE's REAL canopy-web PAT — ace#3033. Any `new MobileClient({...})`
// that passes neither `workers` nor `bootstrapConfig` builds a real
// TestWorkerCheckout, which read the machine's PAT from ACE's .env and took
// REAL test-worker leases on canopy-web: one acquire per test, never called
// again (the worker is killed, not exited), each pinning a pool slot for
// idle_release_s (900 s). Seen live 2026-10-16: one `npx vitest run
// test/mcp/mobile/` filled all 10 slots and queued three more. Point the PAT
// reader at a file that does not exist; a test that needs a PAT writes its
// own ACE_ENV_FILE (client-lease-routing.test.ts does).
process.env.ACE_ENV_FILE = path.join(workerTmpDir, 'no-ace.env');

afterAll(() => {
  try {
    fs.rmSync(workerTmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
