/**
 * Plan an AVD POOL — the missing half of ace#1821.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * ACE already allocates an AVD *name* per session (`mcp/mobile/avd-allocator.ts`
 * `selectAvd`, called from `mcp/mobile/backends/avd.ts`), detects cross-session
 * contention (`lib/mobile-contention.ts`), and records a provisioning marker on
 * a successful `mobile_register_test_user` (`mcp/mobile/client.ts`, in the
 * `finally`). Every piece of the fan-out is in place.
 *
 * It has never fired, because THE POOL HAS ONE MEMBER. `selectAvd`'s fallback
 * branch needs another entry that is `free && proven`; on every ACE workstation
 * `emulator -list-avds` prints exactly `ACE_Pixel_API_34`, so the fallback list
 * is empty and `AvdPoolExhaustedError` is the only reachable outcome once a
 * sibling session holds it. `commands/mobile-bootstrap.md` confirms the AVD
 * "exists" — singular — and nothing in ACE has ever created a second one.
 *
 * So this module is the planner behind `/ace:mobile-bootstrap --pool N`: given
 * the base name, the desired pool size, and what `emulator -list-avds` actually
 * prints, it says which members are missing, and — given a PROVEN member's
 * `config.ini` — which tuned keys a freshly `avdmanager create`d clone is
 * missing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE TUNED VALUES ARE READ, NOT HARDCODED
 *
 * The tuned profile is the operator's, not ACE's: RAM, data-partition size, GPU
 * mode and heap have all been retuned on the reference AVD more than once. A
 * hardcoded table would freeze one snapshot of it and silently diverge — a new
 * pool member would boot on a profile nobody chose. So the KEYS are declared
 * here (that set is stable and reviewable) and the VALUES are lifted live from
 * whichever member is already proven. Retune the reference AVD and the next
 * `--pool` run propagates it.
 *
 * `avdmanager create avd` writes a stock Pixel-7 profile, so the delta is real:
 * on the reference host it differs on RAM, data-partition size, GPU, heap and
 * the camera keys.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY *NOT* HERE
 *
 * 1. **No marker writing.** `registerTestUser`'s `finally` already writes
 *    `.ace-provisioned.json` (`mcp/mobile/avd-provisioned-marker.ts`), so
 *    provisioning is self-certifying: run the registration, the marker appears.
 *    A second writer here would be a duplicate source of truth for "has this
 *    AVD proven itself", and the two could disagree.
 *
 * 2. **No `hw.camera.front` special-casing.** It is in the copied key set for
 *    completeness, but `AvdBackend.ensureFrontCameraEmulated`
 *    (`mcp/mobile/backends/avd.ts`) already rewrites it to `emulated` before
 *    every boot. This module does not predict what happens without it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CLASSIFICATION: unit-testable logic, not device truth.
 *
 * Per CLAUDE.md — "does this change alter what is SENT TO, or MATCHED AGAINST,
 * the device?" Nothing here is. The inputs are a name, an integer, a list of
 * strings from `emulator -list-avds`, and INI text; the outputs are names and
 * key/value pairs. The device-truth half of `--pool` is the imperative sequence
 * the command prose runs (create → boot → install → register), and that is
 * validated by the registration itself succeeding.
 */

/**
 * Suffixes appended to the base name for members 2..N: `_b`, `_c`, … `_z`.
 *
 * The base name is member 1 and takes no suffix — every existing workstation
 * already has it under that exact name, and renaming it would strand its
 * provisioning marker, its snapshot, and every `ACE_AVD_NAME` in a `.env`.
 */
export const POOL_SUFFIX_ALPHABET = 'bcdefghijklmnopqrstuvwxyz';

/** Largest pool this scheme can name (base + 25 suffixes). */
export const MAX_POOL_SIZE = POOL_SUFFIX_ALPHABET.length + 1;

/**
 * The names a pool of `size` members has, in order. `poolMemberNames(b, 1)`
 * is `[b]` — the default, and byte-identical to today's single-AVD world.
 */
export function poolMemberNames(base: string, size: number): string[] {
  if (!base.trim()) throw new Error('poolMemberNames: base AVD name is required');
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`poolMemberNames: size must be an integer >= 1 (got ${String(size)})`);
  }
  if (size > MAX_POOL_SIZE) {
    throw new Error(
      `poolMemberNames: size ${size} exceeds the ${MAX_POOL_SIZE}-member naming scheme ` +
        `(${base}, ${base}_b … ${base}_${POOL_SUFFIX_ALPHABET.at(-1)})`,
    );
  }
  const names = [base];
  for (let i = 1; i < size; i++) names.push(`${base}_${POOL_SUFFIX_ALPHABET[i - 1]}`);
  return names;
}

/**
 * The tuned `config.ini` keys a new pool member inherits from a proven one.
 *
 * Exact keys plus prefix families (`hw.gpu.`, `hw.lcd.`, `hw.camera.`,
 * `hw.keyboard`). Everything outside this set is deliberately left at
 * `avdmanager`'s default — in particular `AvdId`, `avd.ini.displayname`,
 * `image.sysdir.*` and `path*` are per-AVD identity and copying them would
 * point the clone at the reference AVD's own directory.
 */
export const TUNED_CONFIG_KEYS: readonly string[] = [
  'hw.ramSize',
  'disk.dataPartition.size',
  'vm.heapSize',
];

/** Prefix families copied wholesale. See {@link TUNED_CONFIG_KEYS}. */
export const TUNED_CONFIG_KEY_PREFIXES: readonly string[] = [
  'hw.gpu.',
  'hw.lcd.',
  'hw.camera.',
  'hw.keyboard',
];

/** Keys that must never be copied — they are the clone's own identity. */
export const NEVER_COPIED_KEY_PREFIXES: readonly string[] = [
  'AvdId',
  'avd.ini.',
  'image.sysdir.',
  'path',
];

export function isTunedConfigKey(key: string): boolean {
  if (NEVER_COPIED_KEY_PREFIXES.some((p) => key.startsWith(p))) return false;
  if (TUNED_CONFIG_KEYS.includes(key)) return true;
  return TUNED_CONFIG_KEY_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Parse an AVD `config.ini`. Flat `key=value`, last write wins, `#` comments
 * and blank lines dropped. Values keep their inner spacing (`512 MB` is a real
 * value avdmanager writes); only the key and the outer edges are trimmed.
 */
export function parseConfigIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export interface TunedKeyDelta {
  key: string;
  /** The clone's current value, or null when the key is absent entirely. */
  from: string | null;
  /** The proven AVD's value — what the clone should carry. */
  to: string;
}

/**
 * Which tuned keys a freshly-created clone is missing or has wrong, relative to
 * a proven member. Sorted by key so the output is stable and reviewable.
 *
 * Returns `[]` when the clone already matches — which is what makes `--pool`
 * idempotent: re-running it on a healthy pool writes nothing.
 */
export function tunedConfigDelta(provenIni: string, cloneIni: string): TunedKeyDelta[] {
  const proven = parseConfigIni(provenIni);
  const clone = parseConfigIni(cloneIni);
  const deltas: TunedKeyDelta[] = [];
  for (const key of Object.keys(proven).sort()) {
    if (!isTunedConfigKey(key)) continue;
    const to = proven[key];
    const from = key in clone ? clone[key] : null;
    if (from === to) continue;
    deltas.push({ key, from, to });
  }
  return deltas;
}

/**
 * Apply a delta to `config.ini` text: rewrite in place where the key exists,
 * append otherwise. Preserves every untouched line — including comments and
 * key order — because the file is the operator's, not ours.
 */
export function applyTunedConfigDelta(cloneIni: string, deltas: readonly TunedKeyDelta[]): string {
  if (deltas.length === 0) return cloneIni;
  const pending = new Map(deltas.map((d) => [d.key, d.to]));
  const lines = cloneIni.split('\n');
  const rewritten = lines.map((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) return raw;
    const eq = line.indexOf('=');
    if (eq < 1) return raw;
    const key = line.slice(0, eq).trim();
    if (!pending.has(key)) return raw;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${value}`;
  });
  let out = rewritten.join('\n');
  if (pending.size > 0) {
    if (!out.endsWith('\n')) out += '\n';
    for (const [key, value] of pending) out += `${key}=${value}\n`;
  }
  return out;
}

export interface AvdPoolPlan {
  /** Every member the requested pool size names, in order. */
  members: string[];
  /** Members `emulator -list-avds` already prints. */
  present: string[];
  /** Members that must be created. Empty ⇒ nothing to do. */
  missing: string[];
}

/**
 * What a `--pool N` run has to do. `existing` is whatever
 * `emulator -list-avds` printed — names are compared exactly, and unrelated
 * AVDs on the host (`Pixel_6_API_33`, another team's device) are ignored
 * rather than adopted into the pool.
 */
export function planAvdPool(
  base: string,
  size: number,
  existing: readonly string[],
): AvdPoolPlan {
  const members = poolMemberNames(base, size);
  const have = new Set(existing.map((n) => n.trim()).filter(Boolean));
  return {
    members,
    present: members.filter((m) => have.has(m)),
    missing: members.filter((m) => !have.has(m)),
  };
}

/**
 * The `avdmanager create avd` invocation for one member. `systemImage` is the
 * package path the reference AVD was built from — read it from that AVD's
 * `image.sysdir.1` rather than assuming, since `google_apis` vs
 * `google_apis_playstore` and the ABI both vary by host.
 */
export function createAvdCommand(name: string, systemImage: string, device = 'pixel_7'): string {
  return `avdmanager create avd -n ${name} -k "${systemImage}" -d ${device}`;
}

/**
 * Turn a proven AVD's `image.sysdir.1` (e.g.
 * `system-images/android-34/google_apis_playstore/arm64-v8a/`) into the
 * `sdkmanager` package path `avdmanager -k` wants
 * (`system-images;android-34;google_apis_playstore;arm64-v8a`).
 *
 * Returns null when the value is not a recognisable system-image dir, so the
 * caller asks the operator instead of passing a malformed `-k` through.
 */
export function systemImagePackageFromSysdir(sysdir: string): string | null {
  const parts = sysdir.trim().replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (parts.length !== 4) return null;
  if (parts[0] !== 'system-images') return null;
  return parts.join(';');
}
