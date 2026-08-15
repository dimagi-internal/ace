/**
 * Allocate an AVD NAME per session, the way ports are already allocated.
 *
 * dimagi-internal/ace#1047 fix 2. `port-allocator.ts` gives every session a
 * distinct adb-server port and emulator console pair, and #1030 proved that
 * half works. The AVD name was never allocated: every local session resolves
 * `process.env.ACE_AVD_NAME ?? 'ACE_Pixel_API_34'`, so two concurrent sessions
 * get cleanly disjoint ports and still collide on the one shared AVD
 * directory, which the emulator refuses outright:
 *
 *     FATAL | Running multiple emulators with the same AVD is an experimental
 *             feature. Please use -read-only flag to enable this feature.
 *
 * Observed on spark-facilitator/20260728-1338: `/ace:iterate` cold-boots per
 * dispatch, so it re-grabs the AVD every cycle and the other session is
 * starved indefinitely, burning the full 60s adb-register budget each time.
 *
 * Fixes 1 and 3 landed first and made the failure legible — stderr is captured,
 * and a contended AVD now fails fast as `AvdContendedError` instead of spawning
 * a doomed emulator. This closes the loop: when the requested AVD is held by a
 * live session and another PROVISIONED one is free, use that instead of
 * failing. Failing was never the goal; it was just better than hanging.
 *
 * Pure. The caller evaluates the pool (it owns the filesystem probes in
 * `avd-provisioning.ts` + `avd-contention.ts`); this decides which entry to
 * take. That split is deliberate — the decision is set logic and unit-tests
 * without a device, while the probes are already covered by their own suites.
 */

export class AvdPoolExhaustedError extends Error {
  readonly requested: string;
  readonly pool: readonly AvdPoolEntry[];

  constructor(requested: string, pool: readonly AvdPoolEntry[]) {
    const describe = (e: AvdPoolEntry): string => {
      if (!e.free) return e.reason ?? 'unavailable';
      return e.proven
        ? 'free'
        : 'free, but never completed an ACE bootstrap — not used as a fallback ' +
          '(no provisioning marker; see ace#1047)';
    };
    const lines = pool.length
      ? pool.map((e) => `  - ${e.name}: ${describe(e)}`).join('\n')
      : '  (no AVDs found in `emulator -list-avds`)';
    super(
      `No free provisioned AVD. Requested '${requested}'.\n${lines}\n\n` +
        `Every AVD is either held by a live session or missing its system images. ` +
        `Add one to the pool so concurrent sessions stop starving each other:\n\n` +
        `  avdmanager create avd -n ${requested}_b \\\n` +
        `    -k "system-images;android-34;google_apis;arm64-v8a" -d pixel_7\n\n` +
        `then copy the tuned config.ini from ${requested}.avd (disk size, RAM, ` +
        `GPU mode) so the clone boots with the same profile.`,
    );
    this.name = 'AvdPoolExhaustedError';
    this.requested = requested;
    this.pool = pool;
  }
}

export interface AvdPoolEntry {
  name: string;
  /** Free = has disk images AND is not held by a live session. */
  free: boolean;
  /**
   * PROVEN usable — carries a provisioning marker from a completed ACE
   * bootstrap under the current selector map. Required to be chosen as a
   * FALLBACK; not required for the AVD that was explicitly asked for.
   *
   * The asymmetry is the whole point. `ACE_Pixel_API_34_PS` is free by disk
   * images and boots, and has nothing installed on it — silently switching a
   * run onto it turns a precise AvdContendedError into `commcare-not-installed`
   * three steps later. Meanwhile every existing machine has zero markers today,
   * so requiring one for the requested AVD would break every current setup.
   */
  proven?: boolean;
  /** Why it is not free. Shown verbatim when the pool is exhausted. */
  reason?: string;
}

export interface AvdSelection {
  name: string;
  /** True when we did not get the AVD that was asked for. */
  switched: boolean;
  from?: string;
  /** Operator-facing one-liner; null when nothing interesting happened. */
  note: string | null;
}

export interface SelectAvdOpts {
  /**
   * Used only to stagger which free entry two concurrent sessions try FIRST.
   * Both would otherwise pick pool[0] and one would lose the filesystem-lock
   * race for no reason. This is a collision-reducing heuristic, not a
   * guarantee — the authoritative interlock is still
   * `hardware-qemu.ini.lock`, and the loser of a genuine tie retries.
   */
  selfPid?: number;
}

/**
 * Pick an AVD. Prefers the requested one; falls back to any other free
 * provisioned entry; throws `AvdPoolExhaustedError` when there is none.
 */
export function selectAvd(
  requested: string,
  pool: readonly AvdPoolEntry[],
  opts: SelectAvdOpts = {},
): AvdSelection {
  const requestedEntry = pool.find((e) => e.name === requested);
  if (requestedEntry?.free) {
    return { name: requested, switched: false, note: null };
  }

  // A fallback must be PROVEN, not merely free — see AvdPoolEntry.proven.
  // Stable order so the choice is reproducible for a given pid + pool.
  const free = pool.filter((e) => e.free && e.proven && e.name !== requested)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  if (free.length === 0) throw new AvdPoolExhaustedError(requested, pool);

  const offset = opts.selfPid != null ? opts.selfPid % free.length : 0;
  const chosen = free[offset];
  const why = requestedEntry ? (requestedEntry.reason ?? 'unavailable') : 'not in the pool';

  return {
    name: chosen.name,
    switched: true,
    from: requested,
    note:
      `AVD '${requested}' is ${why}; using '${chosen.name}' instead ` +
      `(${free.length} free of ${pool.length}). Concurrent sessions each take ` +
      `their own AVD — see ace#1047.`,
  };
}
