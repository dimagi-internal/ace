/**
 * dimagi-internal/ace#1997 — the version gate that killed every Phase 6 walk.
 *
 * A released CCZ declares the MINIMUM CommCare it will run on, in
 * `profile.ccpr`'s root element:
 *
 * ```xml
 * <profile version="10" requiredMajor="2" requiredMinor="64"
 *          requiredMinimal="0" uniqueid="cb980f9c…" name="… Learn app"/>
 * ```
 *
 * `requiredMinimal` is the PATCH component — the triple above is `2.64.0`, not
 * a four-part version. HQ/Nova stamps HQ's own current release into it at
 * build time, so it moves whenever HQ ships, with nothing in ACE choosing it.
 *
 * ACE's mobile stack, meanwhile, PINS the CommCare APK
 * (`ACE_CONNECT_APK_VERSION`, `DEFAULT_APK_VERSION` in `mcp/mobile/client.ts`)
 * because every APK version needs a calibrated selector map under
 * `mcp/mobile/selectors/connect-<version>.yaml`. When the CCZ's minimum
 * exceeds the pinned APK, CommCare refuses to launch the app and renders a
 * version-gate screen instead:
 *
 * ```
 * org.commcare.dalvik:id/prompt_title
 *   "The application requires CommCare version 2.64.0. You are currently
 *    running 2.63.2."
 * org.commcare.dalvik:id/action_button    "UPDATE COMMCARE VIA THE PLAY STORE"
 * ```
 *
 * Phase 6 then dies at the Connect→CommCare app-launch handoff — after an AVD
 * boot, a PersonalID login and an opportunity claim — and surfaces under the
 * misleading `claim-START-HANDOFF-WEDGED-issue629` label (#629 is the INERT
 * handoff class; this is not that).
 *
 * ## Why Phase 3 never caught it, and why the check belongs there
 *
 * `app-release-qa` Step 4.5 runs `commcare-cli validate` + `play`. Those are a
 * JVM runtime with **no minimum-version gate** — a CCZ that no ACE-provisioned
 * device can open passes every Phase 3 gate cleanly. Phase 3 is also the last
 * point at which the app can still be rebuilt against a lower target; by
 * Phase 6 the only remedy is a new APK.
 *
 * ## Severity is conditional, deliberately
 *
 * The underlying condition is true on EVERY run today, so a flat `[BLOCKER]`
 * would convert one Phase-6 failure into a Phase-3 failure on every
 * `/ace:run` — earlier and cheaper, but blocking every run behind a remedy no
 * operator can apply mid-run, which is how a gate gets switched off. A flat
 * `[WARN]` on a condition that is always true is a line everyone learns to
 * scroll past. So severity keys on whether a remedy is actually REACHABLE:
 *
 * | State                                            | Severity   | Why |
 * |--------------------------------------------------|------------|-----|
 * | required <= pinned                                | `ok`       | nothing to say |
 * | required > pinned, a selector map covers required | `blocker`  | in-run remedy: repin `ACE_CONNECT_APK_VERSION` |
 * | required > pinned, no such map                    | `warn`     | remedy is a new APK + a calibrated map — human-owned, out of reach mid-run |
 * | required > pinned, device phase not planned       | `info`     | no device walk to break |
 * | profile / APK version unreadable                  | `warn`     | never a silent pass, never a crash |
 *
 * ## Evidence class
 *
 * STATIC PARSING + VERSION COMPARISON. Nothing here is sent to, or matched
 * against, a device — no selector, no coordinate, no recipe step order. Both
 * inputs are text ACE already holds in Phase 3 (a zip member and an env var).
 * Unit tests are complete evidence; see `test/lib/ccz-min-version.test.ts`.
 */

import { type CheckOutcome, checked, unable } from './check-outcome.js';

export interface VersionTriple {
  major: number;
  minor: number;
  patch: number;
}

/** `2.63.2` / `2.64` → a triple. Anything else → `null` (never throws). */
export function parseVersionTriple(s: unknown): VersionTriple | null {
  if (typeof s !== 'string') return null;
  const m = /^\s*(\d+)\.(\d+)(?:\.(\d+))?\s*$/.exec(s);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
  };
}

export function formatVersionTriple(v: VersionTriple): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * NUMERIC component-wise comparison. `-1` if `a < b`, `0` if equal, `1` if
 * `a > b`.
 *
 * Never compare these as strings: `'2.64.0' < '2.9.0'` and
 * `'2.63.10' < '2.63.9'` lexicographically, both of which are wrong. A string
 * compare happens to get the ace#1997 case itself right ('2.64.0' > '2.63.2')
 * — which is exactly how such a bug ships green.
 */
export function compareVersionTriples(a: VersionTriple, b: VersionTriple): -1 | 0 | 1 {
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (a[k] < b[k]) return -1;
    if (a[k] > b[k]) return 1;
  }
  return 0;
}

export type ProfileParseStatus = 'parsed' | 'absent' | 'malformed';

export interface ProfileVersionRead {
  status: ProfileParseStatus;
  version: VersionTriple | null;
  /** Human-readable reason, present on `absent` / `malformed`. */
  reason?: string;
}

/**
 * Pull the required CommCare triple out of a `profile.ccpr` document.
 *
 * - `parsed`    — `requiredMajor` + `requiredMinor` found and numeric.
 *                 `requiredMinimal` is the patch component; absent → 0.
 * - `absent`    — a well-formed profile element that declares no minimum.
 * - `malformed` — not a profile element at all, or attributes present but
 *                 non-numeric. Never throws.
 */
export function parseCczRequiredVersion(xml: unknown): ProfileVersionRead {
  if (typeof xml !== 'string' || xml.trim() === '') {
    return { status: 'malformed', version: null, reason: 'profile.ccpr is empty or not a string' };
  }

  // Isolate the <profile …> start tag so attributes from elsewhere in the
  // document cannot be mistaken for the profile's own.
  const tag = /<profile\b[^>]*>/i.exec(xml);
  if (!tag) {
    return { status: 'malformed', version: null, reason: 'no <profile> element found in profile.ccpr' };
  }
  const attrs = tag[0];

  const raw = (name: string): string | null => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs);
    return m ? m[1] : null;
  };

  const majorRaw = raw('requiredMajor');
  const minorRaw = raw('requiredMinor');
  const minimalRaw = raw('requiredMinimal');

  if (majorRaw === null && minorRaw === null && minimalRaw === null) {
    return {
      status: 'absent',
      version: null,
      reason: '<profile> declares no requiredMajor/requiredMinor — no minimum CommCare version',
    };
  }
  if (majorRaw === null || minorRaw === null) {
    return {
      status: 'malformed',
      version: null,
      reason: '<profile> declares a partial minimum (requiredMajor and requiredMinor are both required)',
    };
  }

  const numeric = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : null);
  const major = numeric(majorRaw);
  const minor = numeric(minorRaw);
  const patch = minimalRaw === null ? 0 : numeric(minimalRaw);
  if (major === null || minor === null || patch === null) {
    return {
      status: 'malformed',
      version: null,
      reason:
        `<profile> minimum is non-numeric (requiredMajor=${JSON.stringify(majorRaw)}, ` +
        `requiredMinor=${JSON.stringify(minorRaw)}, requiredMinimal=${JSON.stringify(minimalRaw)})`,
    };
  }

  return { status: 'parsed', version: { major, minor, patch } };
}

export type CczMinVersionSeverity = 'ok' | 'info' | 'warn' | 'blocker';

export interface CczMinVersionFinding {
  kind: 'ccz-min-version-gate';
  /** Which released app this profile came from — `learn` / `deliver`. */
  app: string;
  requiredVersion: string;
  apkVersion: string;
  /** Newest selector map on disk that is >= the required version, if any. */
  satisfyingSelectorMap: string | null;
  message: string;
  remedy: string;
}

/** Payload attached to the `checked` branch only — unreachable without narrowing. */
export interface CczMinVersionReport {
  /**
   * `ok` when the CCZ requires at or below the pinned APK. Otherwise the
   * severity the remedy's reachability earns — see the table in the module
   * header. `ok: false` with `severity: 'info'` is a real state: the mismatch
   * exists but this run walks no device.
   */
  severity: CczMinVersionSeverity;
  requiredVersion: string;
  apkVersion: string;
  satisfyingSelectorMap: string | null;
}

export type CczMinVersionOutcome = CheckOutcome<CczMinVersionFinding, CczMinVersionReport>;

export interface CczMinVersionInput {
  /** `learn` | `deliver` — named in the finding so the operator knows which CCZ. */
  app: string;
  /** Raw text of the CCZ's `profile.ccpr`. */
  profileXml: string;
  /** The APK version Phase 6 will actually run (`ACE_CONNECT_APK_VERSION`). */
  apkVersion: string;
  /**
   * Versions with a calibrated selector map on disk
   * (`mcp/mobile/selectors/connect-<v>.yaml`). Presence of one at or above the
   * required version is what makes the remedy reachable inside the run.
   */
  selectorMapVersions?: string[];
  /**
   * Whether this run will actually walk a device. Default `true`. Pass `false`
   * only when the run demonstrably skips Phase 6's device leg (a headless box
   * — `runtime.yaml` marks every mobile var optional for exactly that case).
   */
  devicePhasePlanned?: boolean;
}

/**
 * Compare a released CCZ's minimum CommCare version against the APK Phase 6
 * will run. Pure; never throws on any input shape.
 *
 * Returns a `CheckOutcome` (`lib/check-outcome.ts`), so a caller cannot read a
 * verdict off a check that never ran: an unreadable `profile.ccpr` or an
 * unparseable APK pin is `status: 'unable'`, which is NOT a pass and which
 * `app-release-qa` Step 4.6 renders as a `[WARN]`.
 */
export function checkCczMinVersion(input: CczMinVersionInput): CczMinVersionOutcome {
  const app = typeof input?.app === 'string' && input.app ? input.app : 'app';
  const apkRaw = typeof input?.apkVersion === 'string' ? input.apkVersion : '';
  const devicePhasePlanned = input?.devicePhasePlanned !== false;
  const mapVersions = Array.isArray(input?.selectorMapVersions) ? input.selectorMapVersions : [];

  const profile = parseCczRequiredVersion(input?.profileXml);
  if (profile.status !== 'parsed' || !profile.version) {
    return unable(
      `Could not read a minimum CommCare version from the released ${app} CCZ's profile.ccpr ` +
        `(${profile.status}: ${profile.reason ?? 'no detail'}). The version-gate comparison did NOT ` +
        `run, so a CCZ requiring a CommCare newer than the pinned APK would not be caught here — ` +
        `Phase 6's device walk would die at the app-launch handoff instead. Remedy: confirm the CCZ ` +
        `downloaded intact (profile.ccpr present at the zip root) and re-run app-release-qa; if the ` +
        `profile is genuinely minimum-free, record that and proceed. (dimagi-internal/ace#1997)`,
    );
  }

  const required = profile.version;
  const requiredStr = formatVersionTriple(required);

  const apk = parseVersionTriple(apkRaw);
  if (!apk) {
    return unable(
      `The released ${app} CCZ requires CommCare ${requiredStr}, but the pinned APK version ` +
        `${JSON.stringify(apkRaw)} is not a parseable version triple, so the comparison could not be ` +
        `made. If the real APK is older than ${requiredStr}, Phase 6's device walk WILL die at the ` +
        `Connect-to-CommCare app-launch handoff on a version-gate screen. Remedy: set ` +
        `ACE_CONNECT_APK_VERSION to a MAJOR.MINOR.PATCH value (or unset it to fall back to ` +
        `DEFAULT_APK_VERSION in mcp/mobile/client.ts) and re-run app-release-qa. ` +
        `(dimagi-internal/ace#1997)`,
    );
  }

  const apkStr = formatVersionTriple(apk);

  // A remedy is reachable inside the run only if a calibrated selector map
  // already exists for a version at or above what the CCZ requires. Sorted
  // NUMERICALLY — a lexicographic "newest map" would accept 2.9.0 for a
  // 2.64.0 requirement.
  const satisfying =
    mapVersions
      .map((v) => ({ raw: v, t: parseVersionTriple(v) }))
      .filter((e): e is { raw: string; t: VersionTriple } => e.t !== null)
      .filter((e) => compareVersionTriples(e.t, required) >= 0)
      .sort((a, b) => compareVersionTriples(a.t, b.t))[0]?.raw ?? null;

  const report = (severity: CczMinVersionSeverity): CczMinVersionReport => ({
    severity,
    requiredVersion: requiredStr,
    apkVersion: apkStr,
    satisfyingSelectorMap: satisfying,
  });

  if (compareVersionTriples(required, apk) <= 0) {
    return { ...checked<CczMinVersionFinding>(true, []), ...report('ok') };
  }

  const consequence =
    `The released ${app} CCZ requires CommCare ${requiredStr}, but ACE pins APK ${apkStr}. ` +
    `CommCare will show a version-gate screen ("The application requires CommCare version ` +
    `${requiredStr}. You are currently running ${apkStr}.") instead of launching the app, so ` +
    `Phase 6's device walk WILL die at the Connect-to-CommCare app-launch handoff`;

  let severity: CczMinVersionSeverity;
  let message: string;
  let remedy: string;

  if (!devicePhasePlanned) {
    severity = 'info';
    message =
      `${consequence} — but this run has no device walk planned, so nothing breaks here. ` +
      `Recorded so the mismatch is legible rather than invisible.`;
    remedy =
      `Before any run that DOES walk a device, the APK must reach ${requiredStr} ` +
      `(ACE_CONNECT_APK_VERSION / DEFAULT_APK_VERSION), or the app must be rebuilt against a ` +
      `lower target CommCare version.`;
  } else if (satisfying) {
    severity = 'blocker';
    message =
      `${consequence}. A calibrated selector map for ${satisfying} is already on disk, so this is ` +
      `fixable now, in Phase 3, before an AVD boot is spent on it.`;
    remedy =
      `Set ACE_CONNECT_APK_VERSION=${satisfying} (and bump DEFAULT_APK_VERSION in ` +
      `mcp/mobile/client.ts if this should be the new floor), then re-run app-release-qa. ` +
      `Alternatively rebuild the app against a target CommCare version <= ${apkStr}.`;
  } else {
    severity = 'warn';
    message =
      `${consequence}. No calibrated selector map covers ${requiredStr} ` +
      `(on disk: ${mapVersions.length ? mapVersions.join(', ') : 'none'}), so there is no remedy ` +
      `reachable inside this run — this is a WARN rather than a halt so the rest of the run still ` +
      `produces its artifacts, but treat every Phase 6 device result from this run as unobtained, ` +
      `not as a pass.`;
    remedy =
      `Human-owned: pin a CommCare APK >= ${requiredStr} and calibrate a selector map for it ` +
      `(mcp/mobile/selectors/connect-${requiredStr}.yaml) against a live device, or set the HQ ` +
      `app's target CommCare version explicitly at build time instead of inheriting HQ's latest ` +
      `release. Tracked in dimagi-internal/ace#1997.`;
  }

  return {
    ...checked<CczMinVersionFinding>(false, [
      {
        kind: 'ccz-min-version-gate',
        app,
        requiredVersion: requiredStr,
        apkVersion: apkStr,
        satisfyingSelectorMap: satisfying,
        message,
        remedy,
      },
    ]),
    ...report(severity),
  };
}
