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
export async function runRecipeWithDriverHeal(
  opts: DriverHealRetryOpts,
): Promise<RecipeRunResult> {
  const maxRetries = opts.maxRetries ?? 1;
  const isTransientThrow = opts.isTransientThrow ?? isTransientNetworkError;

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
        await opts.heal();
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
      await opts.heal();
      continue;
    }

    return result;
  }
}
