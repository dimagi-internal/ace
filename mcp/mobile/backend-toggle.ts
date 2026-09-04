/**
 * Per-session mobile backend toggle.
 *
 * Resolution order (highest priority first):
 *   1. `process.env.ACE_MOBILE_BACKEND` — set when launching Claude Code
 *      (e.g. `ACE_MOBILE_BACKEND=cloud claude`). Wins everything else.
 *   2. Per-session state file at `~/.ace/mobile-backend.<ppid>`. Keyed
 *      by the Claude Code parent process ID so two emdash workspaces
 *      (or two terminals) pick the same backend independently. Written
 *      by the `/ace:mobile-backend` slash command.
 *   3. Default: `local`.
 *
 * Why ppid keying: each Claude Code session is its own process; each
 * spawned MCP server inherits a unique parent pid. The slash command
 * runs in the same Claude process (same pid lineage from the MCP
 * server's perspective), so writes and reads agree on the key without
 * the user having to pass anything explicit.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type MobileBackend = 'cloud' | 'local';
export type BackendSource = 'env' | 'session-file' | 'default';

export interface ResolvedBackend {
  backend: MobileBackend;
  source: BackendSource;
  /** Path of the per-session state file (whether it currently exists or not). */
  sessionFile: string;
  /** Parent pid the session file is keyed by. */
  ppid: number;
}

/**
 * Directory holding the per-session backend state file.
 *
 * Resolved at CALL time, not import time, and behind an env seam — the
 * same shape as `sessionLockDir()` in ./session-lock.ts, and for the
 * same reason (ace#1704). A module-level `const` froze the path at
 * first import, so there was no way for a test worker to be given its
 * own directory.
 *
 * Why that mattered: `resolveBackend()` keys the state file on
 * `process.ppid`, which inside a vitest worker is the vitest MAIN
 * process — identical in every worker. So `~/.ace/mobile-backend.<pid>`
 * was ONE REAL FILE in the developer's home directory that every worker
 * read, wrote and deleted concurrently. Observed directly: worker pid
 * 19783 running backend-toggle.test.ts wrote `cloud` into it while
 * worker pid 19255 running client.test.ts read `cloud` back out of it
 * 12 times, and client.test.ts's own `clearSessionBackend()` deleted
 * the file mid-assertion from the other side. That is the single source
 * behind both ace#1883 and ace#1797.
 *
 * `ACE_MOBILE_STATE_DIR` is the isolation seam tests use; it is set to
 * a per-worker tempdir by test/setup/isolate-ace-home-state.ts.
 */
export function mobileStateDir(): string {
  const override = process.env.ACE_MOBILE_STATE_DIR;
  if (override && override.trim()) return override;
  return path.join(os.homedir(), '.ace');
}

/**
 * Resolve the active backend for *this* MCP-server process. Reads the
 * per-session file fresh on every call so a slash-command toggle takes
 * effect immediately without restarting the MCP server.
 */
export function resolveBackend(): ResolvedBackend {
  const ppid = process.ppid;
  const sessionFile = path.join(mobileStateDir(), `mobile-backend.${ppid}`);

  const envRaw = (process.env.ACE_MOBILE_BACKEND || '').trim().toLowerCase();
  if (envRaw === 'cloud' || envRaw === 'local') {
    return { backend: envRaw, source: 'env', sessionFile, ppid };
  }

  try {
    const fromFile = fs.readFileSync(sessionFile, 'utf8').trim().toLowerCase();
    if (fromFile === 'cloud' || fromFile === 'local') {
      return { backend: fromFile, source: 'session-file', sessionFile, ppid };
    }
  } catch {
    // file missing or unreadable — fall through
  }

  return { backend: 'local', source: 'default', sessionFile, ppid };
}

/**
 * Set the backend for an arbitrary session pid (defaults to current
 * process's parent pid). Used by the slash command, which is itself
 * spawned by Claude Code, so `process.ppid` matches the MCP server's.
 */
export function setSessionBackend(backend: MobileBackend, ppid: number = process.ppid): string {
  if (backend !== 'cloud' && backend !== 'local') {
    throw new Error(`invalid backend: ${backend} (expected 'cloud' or 'local')`);
  }
  const dir = mobileStateDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `mobile-backend.${ppid}`);
  fs.writeFileSync(file, `${backend}\n`, 'utf8');
  return file;
}

/**
 * Result of the pre-boot backend preflight. `fatal` means the caller MUST
 * throw before doing any work (booting an AVD / hitting the cloud); `note`
 * is a non-fatal one-liner the caller should surface so a backend mismatch
 * is visible before a boot attempt rather than only after one fails.
 */
export interface BackendPreflight {
  backend: MobileBackend;
  source: BackendSource;
  cloudConfigured: boolean;
  /** Non-fatal advisory to log before proceeding. */
  note?: string;
  /** When set, the ensure-running path must throw instead of booting. */
  fatal?: { code: string; message: string; remediation: string };
}

/**
 * Pure pre-boot check that turns two silent backend-config gaps
 * (jjackson/ace#839) into a loud, actionable signal BEFORE any AVD boot:
 *
 *   (a) resolved backend is `cloud` but the cloud env is missing
 *       (`ACE_WEB_BASE_URL` / `ACE_WEB_PAT_TOKEN`) — fail immediately with
 *       CLOUD_NOT_CONFIGURED instead of doing anything. (The client never
 *       falls through to local on a cloud toggle, but this makes the check
 *       explicit + early, ahead of any per-call work.)
 *   (b) resolved backend is `local` *by default* (no toggle) while the
 *       cloud backend IS configured — a likely dispatch/session mismatch.
 *       Surface a note naming `/ace:mobile-backend cloud` so the operator
 *       sees it before a local AVD boots (which on a shared host can squat
 *       a busy emulator port and waste a full boot attempt).
 *
 * Every other combination proceeds silently — notably `local` default with
 * cloud NOT configured (the ordinary single-machine dev case) must NOT nag.
 */
export function preflightMobileBackend(args: {
  resolved: ResolvedBackend;
  cloudConfigured: boolean;
}): BackendPreflight {
  const { resolved, cloudConfigured } = args;
  const base = { backend: resolved.backend, source: resolved.source, cloudConfigured };

  if (resolved.backend === 'cloud' && !cloudConfigured) {
    return {
      ...base,
      fatal: {
        code: 'CLOUD_NOT_CONFIGURED',
        message:
          'mobile backend resolved to cloud but the cloud emulator is not configured ' +
          '(ACE_WEB_BASE_URL / ACE_WEB_PAT_TOKEN missing) — refusing to fall through to a local AVD boot',
        remediation:
          'Set ACE_WEB_BASE_URL (e.g. https://labs.connect.dimagi.com/ace) via /ace:setup --force-env and mint ' +
          'ACE_WEB_PAT_TOKEN via /ace:ace-web-pat-mint, or switch to the local AVD with /ace:mobile-backend local.',
      },
    };
  }

  if (resolved.backend === 'local' && resolved.source === 'default' && cloudConfigured) {
    return {
      ...base,
      note:
        'mobile backend defaulted to LOCAL (no /ace:mobile-backend toggle set) while the cloud emulator IS ' +
        'configured — booting a local AVD. If you intended the cloud emulator, run /ace:mobile-backend cloud ' +
        'before dispatching (a wrong local boot can squat a busy emulator port on a shared host).',
    };
  }

  return base;
}

/** Remove the per-session toggle (resets to default). */
export function clearSessionBackend(ppid: number = process.ppid): void {
  const file = path.join(mobileStateDir(), `mobile-backend.${ppid}`);
  try {
    fs.unlinkSync(file);
  } catch {
    // missing is fine
  }
}
