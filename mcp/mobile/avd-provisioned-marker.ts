/**
 * "This AVD has completed an ACE bootstrap" — recorded as evidence, never inferred.
 *
 * ace#1047 fix 2 needs to answer "is it safe to run this session on a DIFFERENT
 * AVD than the one that was asked for?". Disk images are not the answer.
 * `ACE_Pixel_API_34_PS` has a complete image set and boots fine, and #1047's own
 * closing note records why it is still not a viable fallback: nothing is
 * installed on it, so tier-2 auto-bootstrap failed at `register_test_user part
 * B` and the post-failure probe read `commcare-not-installed`. Falling back onto
 * it would trade a precise `AvdContendedError` for a confusing failure three
 * steps later — strictly worse than today.
 *
 * So the marker is written only at a point where the device has PROVEN itself:
 * a successful `registerTestUser`, which means CommCare is installed and a test
 * user exists. Nothing infers it from a name, a directory, or a config file.
 *
 * Fails closed by design. An unmarked AVD is never chosen as a fallback, so on
 * a machine that has never completed a bootstrap the behaviour is exactly
 * today's. The marker populates itself the first time Phase 6 succeeds.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const MARKER_FILENAME = '.ace-provisioned.json';

export interface ProvisionedMarker {
  /** ISO timestamp of the bootstrap that proved this AVD. */
  marked_at: string;
  /** Selector map in force at the time — a 2.62.0 device under a 2.63.2 map is the #591/#593 trap. */
  selector_map?: string;
  /** CommCare package version observed on the device, when known. */
  commcare_version?: string;
}

export function markerPath(avdHome: string, avdName: string): string {
  return path.join(avdHome, `${avdName}.avd`, MARKER_FILENAME);
}

/** Returns null when absent or unreadable — both mean "not proven". */
export function readProvisionedMarker(
  avdHome: string,
  avdName: string,
): ProvisionedMarker | null {
  try {
    const raw = readFileSync(markerPath(avdHome, avdName), 'utf8');
    const parsed = JSON.parse(raw) as ProvisionedMarker;
    return typeof parsed?.marked_at === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort. A failure to record the marker must never fail the bootstrap
 * that just succeeded — the cost is only that this AVD stays unavailable as a
 * fallback, which is the safe direction.
 */
export function writeProvisionedMarker(
  avdHome: string,
  avdName: string,
  marker: ProvisionedMarker,
): boolean {
  try {
    writeFileSync(markerPath(avdHome, avdName), JSON.stringify(marker, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * A marker recorded under a DIFFERENT selector map is not proof for this run:
 * that is exactly the version-drift trap of #591/#593, where a 2.62.0 device
 * was driven by a 2.63.2 map. Unknown (an older marker with no map recorded) is
 * treated as not-proven rather than assumed-good.
 */
export function markerProvesFor(
  marker: ProvisionedMarker | null,
  selectorMap: string | undefined,
): boolean {
  if (!marker) return false;
  if (!selectorMap) return true;
  return marker.selector_map === selectorMap;
}
