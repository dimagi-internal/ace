/**
 * Maestro failure taxonomy — parse stderr + exit code into a small
 * enum so eval/retry logic can act on the signal rather than looking
 * at strings and guessing.
 *
 * Precedence (highest → lowest): driver > app-crash > network >
 * selector-not-found > test-logic > timeout > unknown. Rationale:
 * higher-precedence classes describe root-cause failures that make
 * any lower-precedence string in the same stderr unreliable. If the
 * driver was UNAVAILABLE, the recipe never executed; subsequent
 * "element not found" lines are noise.
 *
 * 'pass' is returned when exitCode is 0; callers can ignore it but
 * the shape stays uniform so downstream code can switch on
 * `failureClass` without checking exitCode separately.
 *
 * Patterns come from real production stderr captured in the mobile
 * learnings docs and Maestro's source-of-truth exception names.
 * New patterns should land alongside a test fixture in
 * `test/lib/maestro-failure-class.test.ts` so the corpus grows over
 * time.
 */

export type FailureClass =
  | 'pass'
  | 'driver'
  | 'app-crash'
  | 'network'
  | 'selector-not-found'
  | 'test-logic'
  | 'timeout'
  | 'unknown';

export interface MaestroFailureClassification {
  failureClass: FailureClass;
  /** First ~240 chars of stderr (or stdout if stderr empty) for display. */
  stderrExcerpt: string;
  /**
   * Recipe/flow name from a `Running flow: <name>` breadcrumb in
   * stderr, when Maestro emits one. Undefined when no breadcrumb.
   */
  stageReached?: string;
}

export interface ClassifyInput {
  stderr: string;
  stdout: string;
  exitCode: number;
}

const EXCERPT_LIMIT = 240;

// Driver / gRPC patterns. These mean the recipe never actually ran;
// the Maestro driver app on the device couldn't be talked to.
const DRIVER_PATTERNS: RegExp[] = [
  /\bUNAVAILABLE\b.*io exception/i,
  /\bUNAVAILABLE\b/,
  /\bRESOURCE_EXHAUSTED\b/,
  /probe\d?:\s*shell timeout/i,
  /maestro hierarchy exit/i,
  /\bgRPC\b.*timeout/i,
  /Broken pipe/i,
  /dadb.*UNAVAILABLE/i,
];

// App-crash patterns (the app under test crashed). Higher precedence
// than selector-not-found because a crashed app produces downstream
// "element not visible" noise.
const APP_CRASH_PATTERNS: RegExp[] = [
  /\bappCrashed\b/i,
  /Application has stopped/i,
  /\bANR\b/i,
  /Process crashed/i,
];

// Network patterns (host-side network failures, NOT gRPC-on-device).
const NETWORK_PATTERNS: RegExp[] = [
  /ConnectException.*Connection refused/i,
  /UnknownHostException/i,
  /SocketTimeoutException/i,
  /\bENOTFOUND\b/,
  /\bECONNREFUSED\b/,
];

// Selector-not-found patterns. These mean Maestro reached the surface
// but couldn't find the expected element.
const SELECTOR_PATTERNS: RegExp[] = [
  /assertVisible.*failed/i,
  /Assertion failed.*not visible/i,
  /Element not found/i,
  /No element found with/i,
  /Could not find element/i,
  /extendedWaitUntil timed out.*element/i,
];

// Test-logic patterns: the recipe itself is broken (YAML parse, bad
// step key, form-advance-without-answer symptoms).
const TEST_LOGIC_PATTERNS: RegExp[] = [
  /expected\s+<block end>/i,
  /Failed to parse recipe/i,
  /RecipeValidationError/i,
  /unknown step key/i,
  /Sorry, this response is required/i,
];

// Timeout patterns: command-level timeout with no other signal.
const TIMEOUT_PATTERNS: RegExp[] = [
  /Timed out after/i,
  /command timed out/i,
  /\btimeout exceeded\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export function classifyMaestroFailure(
  input: ClassifyInput,
): MaestroFailureClassification {
  const stageReached = extractStage(input.stderr);
  const excerptSource = input.stderr.trim().length > 0 ? input.stderr : input.stdout;
  const stderrExcerpt = excerptSource.slice(0, EXCERPT_LIMIT);

  if (input.exitCode === 0) {
    const result: MaestroFailureClassification = {
      failureClass: 'pass',
      stderrExcerpt,
    };
    if (stageReached !== undefined) result.stageReached = stageReached;
    return result;
  }

  const haystack = `${input.stderr}\n${input.stdout}`;

  // Precedence ladder. Earlier wins.
  let failureClass: FailureClass = 'unknown';
  if (matchesAny(haystack, DRIVER_PATTERNS)) failureClass = 'driver';
  else if (matchesAny(haystack, APP_CRASH_PATTERNS)) failureClass = 'app-crash';
  else if (matchesAny(haystack, NETWORK_PATTERNS)) failureClass = 'network';
  else if (matchesAny(haystack, SELECTOR_PATTERNS)) failureClass = 'selector-not-found';
  else if (matchesAny(haystack, TEST_LOGIC_PATTERNS)) failureClass = 'test-logic';
  else if (matchesAny(haystack, TIMEOUT_PATTERNS) || input.exitCode === 124)
    failureClass = 'timeout';

  const result: MaestroFailureClassification = { failureClass, stderrExcerpt };
  if (stageReached !== undefined) result.stageReached = stageReached;
  return result;
}

function extractStage(stderr: string): string | undefined {
  // Match `Running flow: <name>` — Maestro emits this breadcrumb at
  // the start of every flow (including chained runFlow files).
  const m = stderr.match(/Running flow:\s+(\S+)/i);
  return m ? m[1] : undefined;
}
