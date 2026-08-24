/**
 * Per-run demo test user — the ACE-side end of dimagi-internal/ace#1289.
 *
 * ## The class this closes
 *
 * Phase 6's tile-finding scroll is O(the test user's invite list), and that
 * list grows by one card per `/ace:run` forever. Claiming an opportunity flips
 * the invite to `status=accepted`, and `connect_delete_unaccepted_flw_invites`
 * skips accepted invites server-side (`lib/invite-pruning.ts` excludes them),
 * so the ~20-card In Progress section is structurally unprunable. Every fixed
 * scroll budget therefore expires again on a long enough timeline; #1475 and
 * #1532 bought headroom (240s, an O(section) second pass) without closing the
 * class.
 *
 * A **fresh demo user per run** dissolves it by construction: a user minted
 * this morning has no accepted rows, so tile depth is O(1) rather than
 * O(list-that-grows-forever).
 *
 * ## Why this is mintable at all
 *
 * `+7426` is a **PREFIX**, not a provisioned account. Upstream in
 * `dimagi/connect-id`, `users/const.py` defines `TEST_NUMBER_PREFIX = "+7426"`
 * and every demo behaviour is a `startswith` on it — OTP skip (`_send_otp`
 * returns early), `is_phone_validated` at device configuration, and the Play
 * Integrity bypass that lets an emulator register at all. There is no allowlist
 * table and no per-account flag, so ACE can mint arbitrarily many demo users.
 * The one hard constraint is E.164 shape: connect-id runs
 * `PhoneNumber.from_string` and a parse failure 503s.
 *
 * ## THE SWITCH IS OFF BY DEFAULT AND MUST STAY OFF UNTIL THE PRECONDITION HOLDS
 *
 * See {@link PER_RUN_TEST_USER_FLIP_PRECONDITION}. Nothing in this module reads
 * or mutates device state; it is arithmetic plus two classifiers. Everything it
 * feeds is guarded by {@link perRunTestUserEnabled}, which is `false` for an
 * unset env var — so with the flag off, no ACE code path calls any of this.
 */

/** The single documented switch. Default OFF. */
export const ACE_PER_RUN_TEST_USER_FLAG = 'ACE_PER_RUN_TEST_USER';

/**
 * The EXACT precondition that must hold before {@link ACE_PER_RUN_TEST_USER_FLAG}
 * may be flipped on. Deliberately one greppable string, duplicated verbatim into
 * `.env.tpl` and the two guarded skills, and pinned by
 * `test/skills/per-run-test-user-switch.test.ts` so it cannot drift.
 *
 * Why this gate exists: `mcp/mobile/selectors/connect-2.63.2.yaml` records that
 * the static recipes are migrated off raw ids EXCEPT
 * `connect-register-from-otp.yaml`'s 7 camera ids on the photo-capture surface,
 * "deliberately raw pending live calibration". Those ids sit inside a
 * `runFlow.when visible:` guard, so a drifted id makes the whole block silently
 * SKIP and the failure surfaces ~60s later at a terminal assertion. Today the
 * fresh-signup branch is exercised rarely (the phone is fixed, so steady state
 * is the recovery path); turning per-run phones on routes EVERY run through
 * that uncalibrated surface. Flipping this flag before calibration would trade
 * a bounded, well-understood scroll cost for an unbounded silent-skip risk.
 */
export const PER_RUN_TEST_USER_FLIP_PRECONDITION =
  'the 7 camera ids in connect-register-from-otp.yaml are calibrated against a live ' +
  '2.63.2 mobile_capture_ui_dump, and one fresh-signup registration has completed on 2.63.2';

/**
 * connect-id's `TEST_NUMBER_PREFIX`. Every demo behaviour upstream is a
 * `startswith` on this constant, so it is load-bearing: a minted number that
 * loses the prefix registers as a REAL user, waits for an SMS OTP that never
 * arrives, and fails Play Integrity on an emulator.
 */
export const TEST_NUMBER_PREFIX = '+7426';

/** Digits appended after {@link TEST_NUMBER_PREFIX} to form the full number. */
export const PER_RUN_SUFFIX_DIGITS = 7;

/**
 * Anchor for the day component of the encoding (UTC midnight, 2026-01-01).
 * Run ids before this anchor are still encoded — the modulo below is
 * sign-corrected — they just consume the far end of the cycle.
 */
export const PER_RUN_ANCHOR_UTC_MS = Date.UTC(2026, 0, 1);

const MINUTES_PER_DAY = 1440;

/**
 * Distinct days representable before the encoding wraps.
 *
 * `6944 * 1440 = 9_999_360 <= 9_999_999`, the largest 7-digit value — so this
 * is the widest day-span that still fits {@link PER_RUN_SUFFIX_DIGITS}. It is
 * ~19 years, and it is exactly the collision period: two run ids collide iff
 * their calendar days differ by a nonzero multiple of {@link PER_RUN_DAY_SPAN}
 * AND they share a minute-of-day. That is a STRUCTURAL guarantee, not a hash's
 * probabilistic one — which is why the encoding is positional rather than a
 * digest mod 10^7 (a digest collides by pigeonhole at ~4k run ids, and ACE
 * already has thousands).
 */
export const PER_RUN_DAY_SPAN = 6944;

/** Canonical run-id shape: `YYYYMMDD-HHMM`. */
const RUN_ID_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/;

/** The credential set a per-run demo user needs. Mirrors `LocalBootstrapConfig.testUser`. */
export interface PerRunTestUser {
  /** Full E.164 number, e.g. `+74263120415`. */
  phone: string;
  /** National number without the `+7` country code, e.g. `4263120415`. */
  phoneLocal: string;
  /** Always `+7` — the country code that owns the `+7426` demo range. */
  countryCode: string;
  /** Display name written during registration. */
  name: string;
}

/**
 * Is the per-run test-user path enabled?
 *
 * Accepts only the explicit affirmatives `true` / `1` / `yes` / `on`
 * (case-insensitive, trimmed). Everything else — unset, empty, `false`, `0`,
 * `off`, a typo — is OFF. Fail-closed on purpose: a typo'd value must not
 * silently route every run through the uncalibrated camera surface.
 */
export function perRunTestUserEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ACE_PER_RUN_TEST_USER_FLAG];
  if (typeof raw !== 'string') return false;
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** FNV-1a over a string. Only used for run ids that do not match `YYYYMMDD-HHMM`. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Map a run id onto the 7-digit suffix.
 *
 * Canonical `YYYYMMDD-HHMM` ids use the POSITIONAL encoding
 * `(daysSinceAnchor mod PER_RUN_DAY_SPAN) * 1440 + minuteOfDay`, which is
 * injective over any {@link PER_RUN_DAY_SPAN}-day window (see that constant).
 *
 * Anything else falls back to FNV-1a mod 10^7 — deterministic and correctly
 * shaped, but only probabilistically distinct. ACE's own run ids always match
 * the canonical shape (`resolve_current_run_id` mints them), so the fallback
 * exists for hand-typed / forked ids rather than for the production path.
 */
export function perRunSuffix(runId: string): string {
  const m = RUN_ID_RE.exec(runId.trim());
  let n: number;
  if (m) {
    const [, y, mo, d, hh, mm] = m;
    const dayMs = Date.UTC(Number(y), Number(mo) - 1, Number(d));
    const days = Math.floor((dayMs - PER_RUN_ANCHOR_UTC_MS) / 86_400_000);
    const wrapped = ((days % PER_RUN_DAY_SPAN) + PER_RUN_DAY_SPAN) % PER_RUN_DAY_SPAN;
    const minuteOfDay = Number(hh) * 60 + Number(mm);
    n = wrapped * MINUTES_PER_DAY + minuteOfDay;
  } else {
    n = fnv1a(runId) % 10 ** PER_RUN_SUFFIX_DIGITS;
  }
  return String(n).padStart(PER_RUN_SUFFIX_DIGITS, '0');
}

/**
 * Derive this run's demo credentials from its run id.
 *
 * Deterministic: the same run id always yields the same number, so a re-entered
 * or resumed run registers the SAME user rather than orphaning the first one.
 * The result always starts with {@link TEST_NUMBER_PREFIX} and is always valid
 * E.164 (11 digits — `+7` + a 10-digit national number, the same shape as the
 * fixed `ACE_E2E_PHONE`).
 *
 * `pin` / `backupCode` are deliberately NOT derived here: they are not
 * per-user secrets in the demo range, so the run reuses `ACE_E2E_PIN` /
 * `ACE_E2E_BACKUP_CODE` and this helper stays free of credential material.
 */
export function derivePerRunTestUser(runId: string, opts: { name?: string } = {}): PerRunTestUser {
  if (!runId || !runId.trim()) {
    throw new Error('derivePerRunTestUser: runId is required (read run_state.yaml.run_id verbatim)');
  }
  const phone = `${TEST_NUMBER_PREFIX}${perRunSuffix(runId)}`;
  assertDemoE164(phone);
  return {
    phone,
    phoneLocal: phone.slice('+7'.length),
    countryCode: '+7',
    name: opts.name ?? `ACE Test ${runId}`,
  };
}

/**
 * Throw unless `phone` is a well-formed demo number.
 *
 * Both halves matter and neither is cosmetic: connect-id's
 * `utils/connect.py` runs `PhoneNumber.from_string` and 503s on a parse
 * failure, and losing {@link TEST_NUMBER_PREFIX} silently converts a demo
 * registration into a real one (SMS OTP that never arrives + Play Integrity
 * rejection on an emulator).
 */
export function assertDemoE164(phone: string): void {
  if (!phone.startsWith(TEST_NUMBER_PREFIX)) {
    throw new Error(
      `per-run test user: '${phone}' does not carry the demo prefix ${TEST_NUMBER_PREFIX}. ` +
        `Upstream demo behaviour (OTP skip, Play Integrity bypass) is a startswith on that prefix.`,
    );
  }
  if (!/^\+\d{8,15}$/.test(phone)) {
    throw new Error(
      `per-run test user: '${phone}' is not valid E.164 (expected '+' followed by 8-15 digits). ` +
        `connect-id parses it with PhoneNumber.from_string and 503s on failure.`,
    );
  }
}

/** The subset of a `connect_list_flw_invites` row these gates read. */
export interface InviteGateRow {
  connect_user_id: string | null;
  status?: string;
}

export interface InviteGateVerdict {
  /** True when the walk may proceed. */
  ok: boolean;
  /** True when the caller must HALT with a `[BLOCKER]` rather than proceed. */
  halt: boolean;
  /** Operator-facing explanation, safe to paste into a gate brief verbatim. */
  reason: string;
}

/**
 * Phase 4 / Phase-6-preflight gate under per-run phones — BEFORE registration.
 *
 * **This is the gate that inverts.** With the fixed phone, a missing invite row
 * is the ace#824 silent failure and Phase 6 HALTs on it
 * (`agents/qa-and-training.md`). With a per-run phone the ConnectID user does
 * not exist yet, and connect-id creates the invite -> `OpportunityAccess` link
 * only at invite time and only if the user already exists
 * (`opportunity/tasks.py`) — so an absent or unlinked row here is the EXPECTED
 * state, not a defect. The self-heal that used to paper over it
 * (`resend_connect_invite`) is dead code with zero callers.
 *
 * The invite still has to be SENT first, though: registration itself requires a
 * pre-existing invite (connect-id `decorators.py`), which is why the verified
 * sequence is **invite -> register -> re-invite** (ace#855, live-verified on
 * `hh-poverty-targeting/20260702-1456`). Never proceeds on the basis of this
 * gate alone — {@link classifyPerRunPostRegistrationGate} is the real one.
 */
export function classifyPerRunPreRegistrationGate(match: InviteGateRow | null): InviteGateVerdict {
  if (match === null) {
    return {
      ok: true,
      halt: false,
      reason:
        'per-run test user: no invite row yet — EXPECTED before registration. The ConnectID user ' +
        'does not exist, so Connect creates no OpportunityAccess link at invite time. Proceed to ' +
        'registration; the post-registration re-invite is what must produce a linked row.',
    };
  }
  if (match.connect_user_id === null) {
    return {
      ok: true,
      halt: false,
      reason:
        'per-run test user: invite row present with connect_user_id=null — EXPECTED before ' +
        'registration (this is the ace#824 signature ONLY for an already-registered phone). ' +
        'Proceed to registration, then re-invite.',
    };
  }
  return {
    ok: true,
    halt: false,
    reason:
      'per-run test user: invite row already linked to a ConnectID user — this run id was ' +
      'registered before (re-entered / resumed run). Registration is idempotent; proceed.',
  };
}

/**
 * The REAL gate: after registration + re-invite, before the device walk.
 *
 * Requires a row that is LINKED (`connect_user_id !== null`). Connect's mobile
 * opp-list endpoint filters `opportunityaccess__user`, so an access with a null
 * user matches nothing and the opportunity is invisible to the device forever —
 * and per connect-id `2bd03c4` it does not self-heal. Proceeding past this
 * would burn a full AVD dispatch discovering zero tiles.
 */
export function classifyPerRunPostRegistrationGate(match: InviteGateRow | null): InviteGateVerdict {
  if (match === null) {
    return {
      ok: false,
      halt: true,
      reason:
        'per-run test user: NO invite row after registration + re-invite. The re-invite did not ' +
        'land, so no recipe can ever claim a tile. Re-send connect_send_flw_invite for the ' +
        "run's minted phone and re-run this check; do NOT boot the AVD.",
    };
  }
  if (match.connect_user_id === null) {
    return {
      ok: false,
      halt: true,
      reason:
        'per-run test user: invite row present but connect_user_id is null after registration + ' +
        're-invite. Connect filters the mobile opp list on opportunityaccess__user, so this opp ' +
        'is invisible on device forever and does not self-heal (connect-id 2bd03c4). Confirm the ' +
        'registration actually completed, then re-invite; do NOT boot the AVD.',
    };
  }
  return {
    ok: true,
    halt: false,
    reason: `per-run test user: invite row linked to ConnectID user ${match.connect_user_id} — walk may proceed.`,
  };
}
