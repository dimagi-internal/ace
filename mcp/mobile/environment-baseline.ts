// The AVD environment baseline: the device settings every Phase 6 dispatch
// needs, whichever backend runs it. ONE definition, so the local funnel
// (`AvdBackend.applyEnvironmentBaseline`) and the lease (whose image applies
// the baseline at boot and reports a fingerprint in ready.json) can be
// compared rather than trusted.
//
// The fingerprint is sha1 over the sorted setting KEYS joined with `|`,
// first 12 hex chars. It attests to WHICH baseline was applied (its version),
// not that every write succeeded. The lease image computes the same function
// over the same keys (infra/capabilities/android-emulator/image/cli/
// ace_mobile.py) — `test/mcp/mobile/environment-baseline.test.ts` pins the
// value, so a key added on one side and not the other fails CI instead of
// shipping two baselines under one name.

import * as crypto from 'node:crypto';

/**
 * Setting keys the baseline applies. Add a key whenever a new
 * environment-class failure surfaces; the fingerprint changes with it, which
 * is what lets telemetry (and the lease parity check) see an older baseline.
 */
export const ENVIRONMENT_BASELINE_KEYS = [
  'heads_up_notifications_enabled',
  'notification_disallow_dnd_gms',
  'screen_off_timeout',
  'mock_location_fix',
  'location_providers_allowed',
] as const;

/**
 * Default mock GPS fix seeded by the baseline, so any CommCare `geopoint`
 * Capture widget always has a provider fix to read (otherwise the emulator's
 * GPS never acquires and the Capture button spins forever). Kano, Nigeria —
 * ACE's dominant malaria-opp field geography. Coordinates are functionally
 * irrelevant to the form (the malaria-rdt GPS question has no hard
 * accuracy/region constraint, verified live 2026-06-03); they only affect
 * screenshot realism. A recipe that wants opp-specific coords overrides this
 * per run via the `mobile_set_location` atom.
 *
 * `adb emu geo fix` takes LONGITUDE first, then latitude (a classic footgun).
 */
export const DEFAULT_MOCK_LOCATION = {
  longitude: 8.5167,
  latitude: 12.0022,
  altitude: 480,
  satellites: 12,
} as const;

/** sha1-12 of the sorted keys — the baseline's version stamp. */
export function environmentBaselineFingerprint(
  keys: readonly string[] = ENVIRONMENT_BASELINE_KEYS,
): string {
  const sorted = [...keys].sort();
  return crypto.createHash('sha1').update(sorted.join('|')).digest('hex').slice(0, 12);
}

/** The fingerprint this ACE version applies (and expects a lease image to report). */
export const ENVIRONMENT_BASELINE_FINGERPRINT = environmentBaselineFingerprint();
