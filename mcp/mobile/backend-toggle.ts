/**
 * Per-session mobile backend toggle.
 *
 * Two backends:
 *   - `local` — this machine's AVD (AvdBackend + MaestroBackend).
 *   - `lease` — ACE's own ephemeral `android-emulator` machine, leased from
 *     canopy-web's capability broker (backends/lease.ts). The default
 *     wherever no AVD has been provisioned — notably the KVM-less cloud runner.
 *
 * `cloud` is a DEPRECATED ALIAS for `lease`. It used to name ace-web's one
 * shared `/api/mobile` instance; that backend and ace-web's `apps/mobile`
 * were retired 2026-10-14 once canopy-web capability leases were proven live.
 * An `ACE_MOBILE_BACKEND=cloud` env or a `cloud` session file still resolves
 * (to `lease`), with a one-line deprecation log, so an old toggle keeps
 * working instead of silently dropping to the default.
 *
 * Resolution order (highest priority first):
 *   1. `process.env.ACE_MOBILE_BACKEND` — set when launching Claude Code
 *      (e.g. `ACE_MOBILE_BACKEND=lease claude`). Wins everything else.
 *   2. Per-session state file at `~/.ace/mobile-backend.<ppid>`. Keyed
 *      by the Claude Code parent process ID so two emdash workspaces
 *      (or two terminals) pick the same backend independently. Written
 *      by the `/ace:mobile-backend` slash command.
 *   3. Default: `local` when a provisioned AVD exists on this machine (an
 *      `.ace-provisioned.json` marker — avd-provisioned-marker.ts, written
 *      only after a real bootstrap succeeded), else `lease`.
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
import { MARKER_FILENAME, readProvisionedMarker } from './avd-provisioned-marker.js';

export type MobileBackend = 'local' | 'lease';
export type BackendSource = 'env' | 'session-file' | 'default';

export const MOBILE_BACKENDS: readonly MobileBackend[] = ['local', 'lease'];

/**
 * Deprecated backend names and what they now resolve to. `cloud` was
 * ace-web's retired `/api/mobile` emulator; its successor is the lease.
 */
export const DEPRECATED_BACKEND_ALIASES: Readonly<Record<string, MobileBackend>> = { cloud: 'lease' };

let warnedAliases = new Set<string>();

/** Test seam: forget which deprecation lines were already logged. */
export function resetDeprecationWarnings(): void {
  warnedAliases = new Set<string>();
}

function asBackend(raw: string, where?: string): MobileBackend | null {
  const v = raw.trim().toLowerCase();
  if ((MOBILE_BACKENDS as readonly string[]).includes(v)) return v as MobileBackend;
  const aliased = DEPRECATED_BACKEND_ALIASES[v];
  if (aliased) {
    // Once per (name, source) per process — resolveBackend() runs on every routing decision.
    const key = `${v}:${where ?? ''}`;
    if (where && !warnedAliases.has(key)) {
      warnedAliases.add(key);
      console.warn(
        `[ace-mobile] mobile backend '${v}' (${where}) is deprecated — the ace-web cloud emulator was retired; using '${aliased}'. Use /ace:mobile-backend ${aliased}.`,
      );
    }
    return aliased;
  }
  return null;
}

export interface ResolvedBackend {
  backend: MobileBackend;
  source: BackendSource;
  /** Only on `source: 'default'`: why the default landed where it did. */
  defaultReason?: string;
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
 * The AVD home the default-selection probe scans: `ANDROID_AVD_HOME`, else
 * `~/.android/avd` — the same resolution AvdBackend uses.
 * `ACE_MOBILE_SELECTION_AVD_HOME` overrides it for the probe alone; it is the
 * test seam (test/setup/isolate-ace-home-state.ts points it at a fixture so a
 * suite's default never depends on the developer's real AVDs).
 */
export function selectionAvdHome(): string {
  const seam = process.env.ACE_MOBILE_SELECTION_AVD_HOME;
  if (seam && seam.trim()) return seam;
  return process.env.ANDROID_AVD_HOME ?? path.join(os.homedir(), '.android', 'avd');
}

/**
 * The provisioned AVDs on this machine: every `<name>.avd/` carrying a
 * readable provisioned marker. Evidence, not inference — the marker is
 * written only after a real `registerTestUser` succeeded on that AVD, so an
 * AVD that merely has disk images (or was created and never bootstrapped)
 * does not count. Selector-map currency is deliberately NOT required here:
 * the local backend re-bootstraps every dispatch, so an old map is a reason
 * to re-run the bootstrap, not a reason to send the run to a cloud machine.
 */
export function provisionedAvds(avdHome: string = selectionAvdHome()): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(avdHome);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.endsWith('.avd')) continue;
    const name = e.slice(0, -'.avd'.length);
    if (!fs.existsSync(path.join(avdHome, e, MARKER_FILENAME))) continue;
    if (readProvisionedMarker(avdHome, name)) out.push(name);
  }
  return out.sort();
}

/**
 * Resolve the active backend for *this* MCP-server process. Reads the
 * per-session file fresh on every call so a slash-command toggle takes
 * effect immediately without restarting the MCP server.
 */
export function resolveBackend(): ResolvedBackend {
  const ppid = process.ppid;
  const sessionFile = path.join(mobileStateDir(), `mobile-backend.${ppid}`);

  const fromEnv = asBackend(process.env.ACE_MOBILE_BACKEND || '', 'ACE_MOBILE_BACKEND');
  if (fromEnv) {
    return { backend: fromEnv, source: 'env', sessionFile, ppid };
  }

  try {
    const fromFile = asBackend(fs.readFileSync(sessionFile, 'utf8'), `session file ${sessionFile}`);
    if (fromFile) {
      return { backend: fromFile, source: 'session-file', sessionFile, ppid };
    }
  } catch {
    // file missing or unreadable — fall through
  }

  const avdHome = selectionAvdHome();
  const provisioned = provisionedAvds(avdHome);
  if (provisioned.length > 0) {
    return {
      backend: 'local',
      source: 'default',
      defaultReason: `provisioned AVD on this machine (${provisioned.join(', ')} in ${avdHome})`,
      sessionFile,
      ppid,
    };
  }
  return {
    backend: 'lease',
    source: 'default',
    defaultReason: `no provisioned AVD in ${avdHome} — leasing ACE's android-emulator from canopy-web`,
    sessionFile,
    ppid,
  };
}

/**
 * Set the backend for an arbitrary session pid (defaults to current
 * process's parent pid). Used by the slash command, which is itself
 * spawned by Claude Code, so `process.ppid` matches the MCP server's.
 */
export function setSessionBackend(backend: MobileBackend | 'cloud', ppid: number = process.ppid): string {
  // A deprecated alias is written as what it resolves to, so the file never
  // carries a retired name.
  const resolved = asBackend(backend);
  if (!resolved) {
    throw new Error(`invalid backend: ${backend} (expected one of ${MOBILE_BACKENDS.join(', ')})`);
  }
  const dir = mobileStateDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `mobile-backend.${ppid}`);
  fs.writeFileSync(file, `${resolved}\n`, 'utf8');
  return file;
}

/**
 * Result of the pre-boot backend preflight. `fatal` means the caller MUST
 * throw before doing any work (booting an AVD / acquiring a lease).
 */
export interface BackendPreflight {
  backend: MobileBackend;
  source: BackendSource;
  leaseConfigured: boolean;
  /** When set, the ensure-running path must throw instead of booting. */
  fatal?: { code: string; message: string; remediation: string };
}

/**
 * Pure pre-boot check that turns a silent backend-config gap
 * (jjackson/ace#839) into a loud, actionable signal BEFORE any boot: the
 * resolved backend is `lease` but ACE's canopy-web PAT is missing — fail
 * immediately with LEASE_NOT_CONFIGURED instead of falling through to a
 * local AVD boot. Every other combination proceeds silently.
 */
export function preflightMobileBackend(args: {
  resolved: ResolvedBackend;
  /** Omitted = not configured. */
  leaseConfigured?: boolean;
}): BackendPreflight {
  const { resolved } = args;
  const leaseConfigured = args.leaseConfigured ?? false;
  const base = { backend: resolved.backend, source: resolved.source, leaseConfigured };

  if (resolved.backend === 'lease' && !leaseConfigured) {
    const why =
      resolved.source === 'default'
        ? `the default resolved to lease (${resolved.defaultReason ?? 'no provisioned AVD'})`
        : `the mobile backend is pinned to lease (${resolved.source})`;
    return {
      ...base,
      fatal: {
        code: 'LEASE_NOT_CONFIGURED',
        message:
          `${why}, but ACE's canopy-web PAT (CANOPY_WEB_PAT in ACE's .env) is missing — ` +
          'refusing to fall through to a local AVD boot',
        remediation:
          'Run /ace:setup --force-env to inject CANOPY_WEB_PAT, or provision a local AVD with /ace:mobile-bootstrap, ' +
          'or pin the local backend with /ace:mobile-backend local.',
      },
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
