/**
 * ACE's own canopy-web identity: the PAT and the API base URL.
 *
 * One reader, shared by `scripts/browser-sessions.ts` (preview capture) and
 * `mcp/mobile/backends/lease.ts` (capability leases), so the two cannot drift
 * into different answers to "who is ACE on canopy-web?". `bin/ace-canopy-web`
 * is the Python twin and reads the same files in the same order.
 *
 * The PAT comes from ACE's .env ONLY. An inherited `CANOPY_WEB_PAT` and the
 * machine owner's personal canopy token can both belong to a human, and an
 * agent acting as a human is the identity substitution behind ace#2805.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** canopy-web's API origin. `CANOPY_WEB_API_URL` overrides it (tests, staging). */
export const DEFAULT_CANOPY_WEB_API_URL = 'https://canopy.dimagi.com';

/** ACE's .env files, in the order bin/ace-canopy-web reads them. */
export function aceEnvFiles(): string[] {
  if (process.env.ACE_ENV_FILE) return [process.env.ACE_ENV_FILE];
  return [
    path.join(os.homedir(), '.claude', 'plugins', 'data', 'ace-ace', '.env'),
    path.join(os.homedir(), '.ace', '.env'),
  ];
}

/**
 * A key's value from ACE's .env files (first file that sets it), or null.
 * An unresolved 1Password reference (`op://…`) counts as unset.
 */
export function aceEnvValue(key: string): string | null {
  const prefix = `${key}=`;
  for (const f of aceEnvFiles()) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const t = line.trim();
        if (t.startsWith(prefix)) {
          const v = t.slice(prefix.length).trim().replace(/^["']|["']$/g, '');
          if (v && !v.startsWith('op://')) return v;
        }
      }
    } catch {
      /* next file */
    }
  }
  return null;
}

/** ACE's own canopy-web PAT from ACE's .env, or null when none is set. */
export function canopyToken(): string | null {
  return aceEnvValue('CANOPY_WEB_PAT');
}

/** canopy-web API base URL, without a trailing slash. */
export function canopyApiBase(): string {
  return (process.env.CANOPY_WEB_API_URL || DEFAULT_CANOPY_WEB_API_URL).replace(/\/+$/, '');
}
