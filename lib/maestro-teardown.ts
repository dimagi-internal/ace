/**
 * Did a Maestro invocation fail DURING the walk, or only while tearing the
 * session down after the walk was over?
 *
 * dimagi-internal/ace#1822 — `bednet-check-2-visit/20260828-0629`. A Learn
 * leg completed (Connect flipped `learn_complete: true`, 35 non-zero PNGs
 * landed, zero `*-FAILURE.*` forensics were written) and the dispatch was
 * reported as a failure, because the JVM printed this on the way out:
 *
 *   Exception in thread "Thread-5" java.net.SocketException: Broken pipe
 *     at dadb.AdbWriter.writeClose(AdbWriter.kt:60)
 *     at dadb.AdbStreamImpl.close(AdbStream.kt:130)
 *     at maestro.drivers.AndroidDriver.close(AndroidDriver.kt:184)
 *     at maestro.Maestro.close(Maestro.kt:500)
 *     at maestro.cli.session.MaestroSessionManager$MaestroSession.close(...)
 *     at maestro.cli.session.MaestroSessionManager.newSession$lambda$2(...)
 *
 * Every frame in that stack is teardown. None of it is step execution. But
 * `Broken pipe` is a `driver` pattern in `maestro-failure-class.ts`, so the
 * run was classified as a driver death — and that is the one class the
 * heal-and-retry envelope acts on.
 *
 * **Why the verdict matters more here than anywhere else in ACE.** Learn
 * completion is one-way per `(test user, opportunity)` (#568/#570). A walk
 * that genuinely completed and is then reported as failed cannot be re-run;
 * the only restore is a fresh opportunity, and #573 documents why a mid-run
 * re-mint is broken. So a false failure on this path costs a whole fresh
 * `/ace:run`.
 *
 * **Deliberately conservative.** A genuine mid-walk failure must keep
 * failing, so this returns `true` only when the evidence is teardown AND
 * there is no evidence of anything else going wrong. Every disqualifier is
 * spelled out in `reason` so a `false` verdict is readable rather than
 * mysterious.
 */

/** Frames that only appear while a Maestro session is being closed. */
const TEARDOWN_FRAME_PATTERNS: RegExp[] = [
  /MaestroSessionManager/,
  /MaestroSession\$?\w*\.close/,
  /\bMaestro\.close\b/,
  /AndroidDriver\.close/,
  /IOSDriver\.close/,
  /AdbWriter\.writeClose/,
  /AdbStreamImpl\.close/,
  /Dadb\w*\.close/,
];

/**
 * A JVM thread-death banner. Session teardown runs on a shutdown thread
 * (`MaestroSessionManager.newSession$lambda$2` via `kotlin.concurrent.thread`),
 * so a teardown-only fault surfaces as an exception in a NON-main thread.
 * Requiring the banner is what keeps a driver crash on the main execution
 * path from being read as teardown.
 */
const NON_MAIN_THREAD_BANNER = /Exception in thread "(?!main")[^"]+"/;

/**
 * Evidence that something went wrong while steps were RUNNING. Any hit
 * disqualifies the teardown reading outright — these are the strings a real
 * failure leaves behind, and none of them can be produced by a session close.
 *
 * `Not able to reach the gRPC server` and `UNAVAILABLE` are in here on
 * purpose: they are what a driver that died MID-WALK looks like, and that is
 * the case this classifier must never absorb.
 */
const IN_WALK_FAILURE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /Not able to reach the gRPC server/i, label: 'gRPC unreachable during the walk' },
  { pattern: /\bUNAVAILABLE\b/, label: 'gRPC UNAVAILABLE' },
  { pattern: /\bRESOURCE_EXHAUSTED\b/, label: 'gRPC RESOURCE_EXHAUSTED' },
  { pattern: /Element not found/i, label: 'element not found' },
  { pattern: /No element found with/i, label: 'element not found' },
  { pattern: /Could not find element/i, label: 'element not found' },
  { pattern: /Assertion (is false|failed)/i, label: 'assertion failed' },
  { pattern: /assertVisible.*failed/i, label: 'assertVisible failed' },
  { pattern: /\[Failed\]/, label: 'Maestro step reported [Failed]' },
  { pattern: /^\s*FAILED\b/m, label: 'Maestro step reported FAILED' },
  { pattern: /\bappCrashed\b/i, label: 'app crashed' },
  { pattern: /Application has stopped/i, label: 'app crashed' },
  { pattern: /\bANR\b/, label: 'app not responding' },
  { pattern: /Timed out after/i, label: 'step timed out' },
  { pattern: /extendedWaitUntil timed out/i, label: 'extendedWaitUntil timed out' },
  { pattern: /expected\s+<block end>/i, label: 'recipe parse error' },
  { pattern: /Failed to parse recipe/i, label: 'recipe parse error' },
  { pattern: /Flow file does not exist/i, label: 'missing flow file' },
  { pattern: /Sorry, this response is required/i, label: 'form advanced without an answer' },
];

export interface TeardownClassifyInput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface TeardownClassification {
  /**
   * True only when the non-zero exit is attributable to session teardown and
   * nothing else. Callers may treat the WALK as having completed; they must
   * still surface the teardown fault as a warning.
   */
  teardownOnly: boolean;
  /** Why not, when `teardownOnly` is false. Always populated in that case. */
  reason?: string;
  /**
   * The teardown banner + its first frames, for a `warnings[]` entry. Never
   * swallowed — a teardown fault that keeps happening is a real signal about
   * the host, it just is not a verdict about the walk.
   */
  excerpt?: string;
}

const EXCERPT_LIMIT = 400;

export function classifyTeardownFailure(input: TeardownClassifyInput): TeardownClassification {
  if (input.exitCode === 0) {
    return { teardownOnly: false, reason: 'exit 0 — the run already passed' };
  }
  const haystack = `${input.stderr}\n${input.stdout}`;

  if (!NON_MAIN_THREAD_BANNER.test(haystack)) {
    return {
      teardownOnly: false,
      reason: 'no non-main-thread exception banner — a teardown fault is raised on the session shutdown thread',
    };
  }
  if (!TEARDOWN_FRAME_PATTERNS.some((p) => p.test(haystack))) {
    return {
      teardownOnly: false,
      reason: 'no session-teardown frames (MaestroSession.close / AndroidDriver.close / AdbWriter.writeClose) in the stack',
    };
  }
  const disqualifier = IN_WALK_FAILURE_PATTERNS.find((d) => d.pattern.test(haystack));
  if (disqualifier) {
    return {
      teardownOnly: false,
      reason: `in-walk failure evidence present (${disqualifier.label}) — a teardown stack does not excuse it`,
    };
  }

  return { teardownOnly: true, excerpt: extractTeardownExcerpt(haystack) };
}

/** The banner line plus the frames that follow it, capped for display. */
function extractTeardownExcerpt(haystack: string): string {
  const m = haystack.match(NON_MAIN_THREAD_BANNER);
  const start = m?.index ?? 0;
  return haystack.slice(start, start + EXCERPT_LIMIT).trim();
}

/** The `warnings[]` line a teardown-only failure contributes. */
export function teardownWarning(excerpt: string | undefined): string {
  return (
    'maestro session teardown threw AFTER the last step completed; the walk itself ran clean ' +
    'and its artifacts are the real result (ace#1822). Teardown fault: ' +
    (excerpt ? excerpt.split('\n').slice(0, 3).join(' | ') : 'no excerpt captured')
  );
}
