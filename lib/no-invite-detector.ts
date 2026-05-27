/**
 * Detect the canonical pre-invite gating failure signature in
 * registerTestUser's Maestro output.
 *
 * Background — `playbook/integrations/mobile-integration.md`
 * § Pre-invite gating:
 *
 *   Connect-id's `/users/start_configuration` endpoint runs an
 *   `@app_integrity` decorator that synchronously calls
 *   `check_number_for_existing_invites(phone)`. For phones with no
 *   existing invite, this lookup hangs past the gunicorn worker
 *   timeout, the worker dies with SystemExit, CommCare receives an
 *   empty body and force-stops.
 *
 * From Maestro's vantage point: phone-entry succeeded, Continue tap
 * succeeded, then the next assertion finds CommCare no longer in the
 * foreground. We require BOTH signals (Continue tap + downstream
 * foreground loss) so we don't false-positive on crashes that happen
 * BEFORE the registration attempt actually called start_configuration.
 *
 * When this signature is detected, `MobileClient.registerTestUser`
 * surfaces a `NoInviteSuspectedError` with a precise remediation hint
 * (`connect_send_flw_invite`) instead of a generic stderr blob — so
 * the operator immediately knows the fix is "invite the phone," not
 * "debug Maestro / AVD / driver."
 */

export interface DetectInput {
  stderr: string;
  stdout: string;
}

// Tap on the Continue button after entering the phone number — this
// is the step that triggers /users/start_configuration server-side.
const CONTINUE_TAP_PATTERNS: RegExp[] = [
  /tapOn[^\n]*btn_continue/i,
  /tapOn[^\n]*continue/i,
];

// Foreground-loss signals — CommCare app force-stopped or fell into
// background. Maestro reports any of these when the app under test
// is no longer the focused activity.
const FOREGROUND_LOSS_PATTERNS: RegExp[] = [
  /Application[^\n]*not in foreground/i,
  /expected app[^\n]*foreground but was background/i,
  /force-stopped/i,
  /CONNECT-ID-3F/i,
];

export function detectNoInviteSignature(input: DetectInput): boolean {
  const haystack = `${input.stderr}\n${input.stdout}`;
  if (haystack.trim().length === 0) return false;

  // Find the position of the first Continue-tap signal.
  let continueIdx = -1;
  for (const p of CONTINUE_TAP_PATTERNS) {
    const m = p.exec(haystack);
    if (m && (continueIdx === -1 || m.index < continueIdx)) continueIdx = m.index;
  }
  if (continueIdx === -1) return false;

  // Find the position of the first foreground-loss signal.
  let lossIdx = -1;
  for (const p of FOREGROUND_LOSS_PATTERNS) {
    const m = p.exec(haystack);
    if (m && (lossIdx === -1 || m.index < lossIdx)) lossIdx = m.index;
  }
  if (lossIdx === -1) return false;

  // CONNECT-ID-3F is confirmatory regardless of ordering.
  if (/CONNECT-ID-3F/i.test(haystack)) return true;

  // The loss must happen AFTER the Continue tap. Loss-before-tap means
  // the app crashed/backgrounded for unrelated reasons (driver wedge,
  // GMS dialog, etc.).
  return lossIdx > continueIdx;
}
