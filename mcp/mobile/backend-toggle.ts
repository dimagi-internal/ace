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

const STATE_DIR = path.join(os.homedir(), '.ace');

/**
 * Resolve the active backend for *this* MCP-server process. Reads the
 * per-session file fresh on every call so a slash-command toggle takes
 * effect immediately without restarting the MCP server.
 */
export function resolveBackend(): ResolvedBackend {
  const ppid = process.ppid;
  const sessionFile = path.join(STATE_DIR, `mobile-backend.${ppid}`);

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
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = path.join(STATE_DIR, `mobile-backend.${ppid}`);
  fs.writeFileSync(file, `${backend}\n`, 'utf8');
  return file;
}

/** Remove the per-session toggle (resets to default). */
export function clearSessionBackend(ppid: number = process.ppid): void {
  const file = path.join(STATE_DIR, `mobile-backend.${ppid}`);
  try {
    fs.unlinkSync(file);
  } catch {
    // missing is fine
  }
}
