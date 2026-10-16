// lib/common-screenshot-pool.ts
//
// Is there a usable common screenshot pool for the PINNED Connect APK?
// (dimagi-internal/ace#3060)
//
// The pool lives in Drive at `ACE/_common/connect-screenshots/<apk>/`
// (`manifest.yaml` + PNGs, built by `skills/common-screenshot-capture`).
// `training-deck-generate` and `training-flw-guide` resolve it by the pinned APK
// version. When the default APK moved 2.63.x → 2.64.0 (ace#1997), nobody
// produced a 2.64.0 pool, and nothing failed: the `_common/platform-setup`
// slides had nothing to show and the FLW guide's common-navigation steps fell
// back to prose (tekzal/20261013-2314). Six weeks passed before a human noticed.
//
// The pool is not in git, so no repo test can see it. This classifier is the
// boundary check: it runs from `bin/ace-doctor` (`common_screenshot_pool`) and
// from the two training skills' preflight, via
// `scripts/doctor-common-screenshot-pool.ts`.
//
// What "usable" means
// -------------------
// Every alias in REQUIRED_LIVE_ALIASES is `source: live` (or `composited`, a
// real same-version capture with opp-specific strings replaced) with a Drive id, and no
// two of them share an id. Those seven aliases are the ones the live recipes can
// produce. They are not the full 16-alias roster:
//   - `sync-button` stays QUARANTINED: its recipe captures a byte-identical copy
//     of `connect-home` (ace#1832);
//   - the four PersonalID completion screens are committed template art
//     (ace#873);
//   - the three Play Store frames need a Google-signed-in device.
// None of those can be live, so counting them would make the gate unpassable.
//
// The id check is a cheap guard, not the distinctness proof. Byte-level
// distinctness is `lib/screenshot-pool-distinctness.ts`, which runs at capture
// time, before anything is published as live.

import { parse as parseYaml } from 'yaml';

/** The aliases the baseline recipes can capture live. ace#3060 lists them as the minimum to restore. */
export const REQUIRED_LIVE_ALIASES = [
  'commcare-welcome',
  'connect-home',
  'claim-opp',
  'learn-install',
  'personal-id-start',
  'personal-id-name',
  'personal-id-phone',
] as const;

export interface PoolManifestEntry {
  drive?: string;
  source?: string;
  placeholder?: boolean;
  note?: string;
}

export interface CommonPoolInput {
  /** The version decks resolve the pool by (`ACE_CONNECT_APK_VERSION`, else the code default). */
  pinnedVersion: string;
  /** Folder names found under `ACE/_common/connect-screenshots/`. */
  versionsPresent: string[];
  /** Raw text of `<pinned>/manifest.yaml`, or null if the folder has none. */
  manifestText: string | null;
}

export interface CommonPoolVerdict {
  status: 'pass' | 'fail';
  pinnedVersion: string;
  versionsPresent: string[];
  live: string[];
  missingLive: string[];
  duplicateIds: string[];
  summary: string;
  remediation?: string;
}

const CAPTURE_FIX =
  'run skills/common-screenshot-capture on a device that runs the pinned APK (it is required by skills/connect-apk-upgrade § Step 7b); ' +
  'until then decks show empty slots for these screens and FLW guides describe them in prose only';

/**
 * Parse a pool manifest. Drive stores it as a Google Doc, whose text export
 * uses CRLF line endings, so normalise those before parsing.
 */
export function parsePoolManifest(text: string): Record<string, PoolManifestEntry> {
  const doc = parseYaml(text.replace(/\r\n/g, '\n').replace(/^﻿/, '')) as
    | { screenshots?: Record<string, PoolManifestEntry | null> }
    | null;
  const shots = doc?.screenshots;
  if (!shots || typeof shots !== 'object') {
    throw new Error('manifest has no `screenshots:` map');
  }
  const out: Record<string, PoolManifestEntry> = {};
  for (const [alias, entry] of Object.entries(shots)) out[alias] = entry ?? {};
  return out;
}

/**
 * Usable on a deck: a real capture (`live`) or a composited illustration
 * (`composited`, lib/screenshot-composite.ts): a real same-version capture with
 * only opp-specific strings replaced. Both are this version's UI, and both are
 * fine for illustration. Composited frames are refused in evidence manifests
 * instead (`collectCaptureEntries`).
 */
function isLive(e: PoolManifestEntry | undefined): boolean {
  return (
    !!e &&
    (e.source === 'live' || e.source === 'composited') &&
    e.placeholder !== true &&
    typeof e.drive === 'string' &&
    e.drive.length > 0
  );
}

export function classifyCommonPool(input: CommonPoolInput): CommonPoolVerdict {
  const { pinnedVersion, versionsPresent, manifestText } = input;
  const base = { pinnedVersion, versionsPresent, live: [], missingLive: [...REQUIRED_LIVE_ALIASES], duplicateIds: [] };
  const others = versionsPresent.filter((v) => v !== pinnedVersion);
  const othersNote = others.length ? ` (present: ${others.join(', ')}; another version's screens are not this version's UI)` : '';

  if (!versionsPresent.includes(pinnedVersion)) {
    return {
      ...base,
      status: 'fail',
      summary: `no pool for the pinned APK ${pinnedVersion} at ACE/_common/connect-screenshots/${pinnedVersion}/${othersNote}`,
      remediation: CAPTURE_FIX,
    };
  }
  if (manifestText == null) {
    return {
      ...base,
      status: 'fail',
      summary: `ACE/_common/connect-screenshots/${pinnedVersion}/ has no manifest.yaml`,
      remediation: CAPTURE_FIX,
    };
  }

  let shots: Record<string, PoolManifestEntry>;
  try {
    shots = parsePoolManifest(manifestText);
  } catch (e) {
    return {
      ...base,
      status: 'fail',
      summary: `ACE/_common/connect-screenshots/${pinnedVersion}/manifest.yaml is unreadable (${(e as Error).message})`,
      remediation: CAPTURE_FIX,
    };
  }

  const live = REQUIRED_LIVE_ALIASES.filter((a) => isLive(shots[a]));
  const missingLive = REQUIRED_LIVE_ALIASES.filter((a) => !isLive(shots[a]));
  const byId = new Map<string, string[]>();
  for (const a of live) {
    const id = shots[a].drive as string;
    byId.set(id, [...(byId.get(id) ?? []), a]);
  }
  const duplicateIds = [...byId.values()].filter((g) => g.length > 1).map((g) => g.join('='));

  const n = REQUIRED_LIVE_ALIASES.length;
  if (missingLive.length === 0 && duplicateIds.length === 0) {
    return {
      pinnedVersion, versionsPresent, live, missingLive, duplicateIds,
      status: 'pass',
      summary: `pool for ${pinnedVersion}: ${n}/${n} capturable aliases live and distinct`,
    };
  }
  const parts: string[] = [];
  if (missingLive.length) parts.push(`not live: ${missingLive.join(', ')}`);
  if (duplicateIds.length) parts.push(`aliases sharing one Drive file: ${duplicateIds.join('; ')}`);
  return {
    pinnedVersion, versionsPresent, live, missingLive, duplicateIds,
    status: 'fail',
    summary: `pool for ${pinnedVersion}: ${live.length}/${n} capturable aliases live — ${parts.join('; ')}`,
    remediation: CAPTURE_FIX,
  };
}
