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
  /**
   * Selector map in force at the time — a 2.62.0 device under a 2.63.2 map is
   * the #591/#593 trap. Written as `connect-<apkVersion>@<sha12>` by
   * `resolveActiveSelectorMapId()`; the SHA is what makes an EDIT to a map
   * (the common case) count as drift, not just an APK bump. Optional only
   * because markers written before ace#1993 do not carry it — and those are
   * treated as not-proven, per `markerProvesFor`.
   */
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
 * was driven by a 2.63.2 map.
 *
 * **Every branch fails closed, and that is a correction, not a preference
 * (ace#1993).** This function used to return `true` whenever the caller passed
 * no map — while both call sites read `process.env.ACE_SELECTOR_MAP`, a
 * variable set nowhere in the repo, in `.env.tpl`, or in any installed `.env`.
 * So the guard the header above describes never once executed its comparison,
 * and the header's own promise ("unknown is treated as not-proven") was
 * inverted in code: every marker on every host is unknown-map, and every one
 * was assumed good. Callers now pass `resolveActiveSelectorMapId()`
 * (`recipe-resolver.ts`), which reads the map ACE actually loads.
 *
 * The three ways to fail, all of them closed:
 *   - no marker            → never provisioned. Not proven.
 *   - no active map known  → we cannot say what this run will drive the device
 *                            with, so we cannot say the marker matches it.
 *   - marker has no map    → written before this field carried a value, or by a
 *                            build that could not resolve one. Not proof.
 *
 * The cost of failing closed is bounded and self-healing: an unproven AVD is
 * only ineligible as a FALLBACK (`AvdPoolEntry.proven` — the requested AVD
 * never needs a marker), and the next successful `registerTestUser` on it
 * writes a marker carrying the current map. The cost of failing OPEN is a run
 * silently driven by the wrong selectors, which is the defect this whole module
 * exists to prevent.
 */
export function markerProvesFor(
  marker: ProvisionedMarker | null,
  selectorMap: string | undefined,
): boolean {
  if (!marker) return false;
  if (!selectorMap) return false;
  if (!marker.selector_map) return false;
  return marker.selector_map === selectorMap;
}
