// Bounded driver-death heal-and-retry envelope for `mobile_run_recipe`
// (closes jjackson/ace#592 item 5).
//
// A Maestro driver / gRPC transport crash — "Broken pipe", `UNAVAILABLE`,
// a thrown EPIPE/ECONNRESET at the Node/adb layer — can take the AVD down
// mid-run. Observed live (bednet-spot-check 20260530-2015 Phase 6): the
// driver died, the recipe came back `failureClass: 'driver'`, and every
// subsequent `mobile_capture_ui_dump` returned "AVD not currently running".
// Before this envelope that aborted the whole phase.
//
// Why retrying is SAFE here (and only here):
//   - Per the failure taxonomy (`lib/maestro-failure-class.ts`), a
//     `'driver'` classification means the driver couldn't be talked to —
//     "element not found" noise in the same stderr is unreliable. The heal
//     is a full cold-boot (`MobileClient.ensureAvdRunning`) which
//     DETERMINISTICALLY restores the phase precondition (fresh demo user at
//     Connect home), wiping any partial on-device progress from the crashed
//     run. ACE's journey recipes are cold-runnable and branch on server-side
//     state (already-claimed / already-Learn-complete, #570), so re-running
//     from the top after a cold-boot is correct — NOT double-execution.
//   - Every OTHER failure class (`selector-not-found`, `app-crash`,
//     `test-logic`, `timeout`) is a REAL result of a recipe that actually
//     ran. Retrying those would mask genuine failures and waste a cold-boot,
//     so they are returned as-is, untouched.
//
// This mirrors the "preconditions are restored, not adapted" rule in
// CLAUDE.md: on driver death we restore to the precondition and retry once,
// rather than trying to resume mid-recipe.

import { isTransientNetworkError } from '../../lib/transient-retry.js';
import type { RecipeRunResult } from './types.js';

export interface DriverHealRetryOpts {
  /** Run the recipe once. Re-resolve any per-attempt device state (serial /
   *  adbPort can change across a cold-boot) INSIDE this closure. */
  runOnce: () => Promise<RecipeRunResult>;
  /** Recover from a driver death — typically a full cold-boot
   *  (`ensureAvdRunning`). Called between attempts, never after the last. */
  heal: () => Promise<void>;
  /** Max heal+retry attempts after the first run. Default 1. Pass 0 to
   *  disable (e.g. when no AVD name is available to heal). */
  maxRetries?: number;
  /** Override the thrown-error transient classifier (tests). Defaults to the
   *  shared `isTransientNetworkError` (covers EPIPE / ECONNRESET / hang-up). */
  isTransientThrow?: (e: unknown) => boolean;
  /** Optional progress logger. */
  log?: (msg: string) => void;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Run a recipe with a bounded driver-death heal-and-retry envelope.
 *
 * Retries ONLY when the run came back `failureClass: 'driver'` OR threw a
 * transient transport error. All other outcomes (pass, or any non-driver
 * failure class) are returned immediately, unchanged. Heal is invoked at
 * most `maxRetries` times, always between attempts.
 *
 * Pure w.r.t. the mobile client — `runOnce` / `heal` are injected, so this
 * is unit-testable without a device. See
 * `test/mcp/mobile/maestro-driver-retry.test.ts`.
 */
/**
 * A wall-clock stall is a REAL result of a recipe that actually ran — never
 * a transport crash (dimagi-internal/ace#1164). `isTransientNetworkError`'s
 * bare-substring `timeout` pattern matched the old untyped
 * `"shell timeout: …"` string, so a wedged 10-minute Maestro chunk was
 * classified as a transport blip and the envelope cold-booted + silently
 * REPLAYED the whole journey — ~1h of real device work — then wedged again:
 * two passes + two 10-minute burns ≈ the 3.1h the harness finally aborted
 * (spark-facilitator/20260731-0656). Keyed on `code`, which the typed
 * errors carry and no genuine transport throw does.
 */
function isWallClockStall(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return code === 'SHELL_TIMEOUT' || code === 'MAESTRO_STALL';
}

export async function runRecipeWithDriverHeal(
  opts: DriverHealRetryOpts,
): Promise<RecipeRunResult> {
  const maxRetries = opts.maxRetries ?? 1;
  const baseTransient = opts.isTransientThrow ?? isTransientNetworkError;
  const isTransientThrow = (e: unknown) => !isWallClockStall(e) && baseTransient(e);

  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < maxRetries;

    let result: RecipeRunResult;
    try {
      result = await opts.runOnce();
    } catch (e) {
      // A transport-layer crash can throw (EPIPE / socket hang up) rather
      // than returning a classified result. Same heal applies.
      if (canRetry && isTransientThrow(e)) {
        opts.log?.(
          `driver-heal: transport throw on attempt ${attempt + 1} (${errMsg(e)}) — cold-boot heal + retry`,
        );
        // A heal that throws must not REPLACE the fault we were healing
        // from (ace#1822). The original error is what the operator needs;
        // the heal failure is a second, separate fact. Pre-fix, the heal's
        // error propagated and the run's actual cause vanished — on
        // bednet-check-2-visit/20260828-0629 what reached the caller was
        // `register_test_user part A failed: ...`, an error from the COLD
        // BOOT, for a Learn walk that had already submitted.
        try {
          await opts.heal();
        } catch (healErr) {
          attachHealFailure(e, healErr);
          throw e;
        }
        continue;
      }
      throw e;
    }

    const isDriverFail =
      result.status === 'fail' && result.failure?.failureClass === 'driver';
    if (canRetry && isDriverFail) {
      opts.log?.(
        `driver-heal: failureClass=driver on attempt ${attempt + 1} ` +
          `(${result.failure?.stderrExcerpt ?? ''}) — cold-boot heal + retry`,
      );
      // A HEAL FAILURE MUST NEVER DISCARD THE ATTEMPT'S OWN RESULT (ace#1822).
      //
      // This `await` was unguarded, and that is the single most expensive
      // line on this path. `result` at this point carries the dispatch's
      // screenshots, videos, screenshotsDir and step log — the record of
      // work that, for a Learn leg, is ONE-WAY and cannot be redone
      // (#568/#570; #573 rules out a mid-run opportunity re-mint). A throw
      // from `heal()` replaced all of it with a cold-boot error, so a
      // dispatch that did real, unrepeatable work reported as if it had
      // done none.
      //
      // Returning the result is strictly more informative than throwing:
      // the caller still sees `status: 'fail'` and the driver
      // classification, AND can read what was captured.
      try {
        await opts.heal();
      } catch (healErr) {
        opts.log?.(
          `driver-heal: cold-boot heal FAILED after attempt ${attempt + 1} (${errMsg(healErr)}) — ` +
            `returning that attempt's own result rather than discarding its artifacts`,
        );
        result.warnings = [
          ...(result.warnings ?? []),
          `cold-boot heal failed after a driver-class failure, so no retry ran: ${errMsg(healErr)}. ` +
            `This result is attempt ${attempt + 1}'s own — its screenshots, videos and step log are real (ace#1822).`,
        ];
        return result;
      }
      continue;
    }

    return result;
  }
}

/**
 * Record a heal failure on the original error without replacing it.
 *
 * Two facts, and the original is the one that explains the run. Attaching
 * rather than throwing keeps `isTransientNetworkError` classification, typed
 * `code`s, and any `failureForensics` a caller already hung off `e`.
 */
function attachHealFailure(original: unknown, healErr: unknown): void {
  if (!(original instanceof Error)) return;
  (original as Error & { healFailure?: string }).healFailure = errMsg(healErr);
  original.message =
    `${original.message}\n[driver-heal] cold-boot heal also failed: ${errMsg(healErr)} ` +
    `(reported alongside, not instead of, the original fault — ace#1822)`;
}
