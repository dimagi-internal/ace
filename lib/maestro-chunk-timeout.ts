/**
 * Per-chunk wall-clock ceiling for a `maestro test` invocation.
 *
 * ## Why this is not a constant
 *
 * ace#1164 fixed "no watchdog at all" — a `mobile_run_recipe` dispatch hung
 * silently for ~3.1h before Claude Code's generic MCP idle timeout killed it.
 * Its suggested fix asked for a ceiling *"derived from the recipe (e.g.
 * sum(step timeouts) * k + floor), overridable via env."* What shipped was a
 * flat `10 * 60 * 1000`, and the flat form caused the failure it was meant to
 * make diagnosable (ace#1570):
 *
 * On hh-poverty-targeting/20260819-1435 a 97-step Learn journey was killed at
 * exactly 600s while still advancing at a steady ~11s per question — 59 good
 * screenshots on disk, `connect_get_learn_progress` reporting 5 of 6 modules
 * banked. Learn completion is ONE-WAY per (test user, opportunity), so the
 * kill permanently consumed the precondition: the remaining modules could not
 * be re-walked, and the only restore is a fresh `/ace:run`.
 *
 * The reason the walk was one chunk is the second half of that bug and is NOT
 * fixed here: `splitRecipeAtScreenshots` splits only on TOP-LEVEL
 * `takeScreenshot:` steps, while ACE's own Phase-3 recipes emit most captures
 * inside `runFlow: form-advance.yaml {SCREENSHOT_NAME}`. journey-learn had
 * exactly one top-level screenshot and ran as `chunk 1/1`; journey-deliver
 * split into 11 and was structurally safe. Scaling the budget makes the long
 * single chunk survivable regardless of how it got that way.
 *
 * ## Contract
 *
 * - **Floor** — never shorter than the historical 10 min, so no recipe that
 *   passes today can start failing because of this change.
 * - **Scale** — `PER_STEP_MS` per step, which covers ACE's measured device
 *   cadence (~11s/question on a guarded-scroll + tap + advance chunk) with
 *   headroom for a slow emulator.
 * - **Ceiling** — capped, because ace#1164's whole point is that an unbounded
 *   wait is worse than a loud failure. A budget this large means something is
 *   genuinely wrong, not merely slow.
 * - **Override** — `ACE_MOBILE_CHUNK_TIMEOUT_MS` wins outright when it parses
 *   to a positive finite integer, for an operator debugging a pathological
 *   device. A malformed value is IGNORED rather than treated as zero: a typo
 *   must not silently disarm the watchdog.
 */

/** Historical flat budget. Retained as the floor so nothing regresses. */
export const FLOOR_MS = 10 * 60 * 1000;

/** Per-step allowance. ACE's measured worst case is ~11s/step on-device. */
export const PER_STEP_MS = 20_000;

/** Upper bound. Beyond this, failing loudly beats waiting (ace#1164). */
export const CEILING_MS = 45 * 60 * 1000;

export const ENV_OVERRIDE = 'ACE_MOBILE_CHUNK_TIMEOUT_MS';

export interface ChunkTimeoutInput {
  /**
   * Number of top-level steps in the chunk being invoked. Omit (or pass a
   * non-positive / non-finite value) when the count is unknown — the result
   * is then the floor, i.e. exactly the pre-ace#1570 behaviour.
   */
  stepCount?: number;
  /** Defaults to `process.env`. Injected in tests. */
  env?: Record<string, string | undefined>;
}

export interface ChunkTimeoutResult {
  timeoutMs: number;
  /** How the number was arrived at — surfaced in the stall error for triage. */
  basis: 'env-override' | 'floor' | 'scaled' | 'ceiling';
  stepCount: number | null;
}

export function resolveChunkTimeout(input: ChunkTimeoutInput = {}): ChunkTimeoutResult {
  const env = input.env ?? process.env;

  const raw = env[ENV_OVERRIDE];
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) {
      return { timeoutMs: parsed, basis: 'env-override', stepCount: null };
    }
    // Deliberately fall through on a malformed value.
  }

  const n = input.stepCount;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    return { timeoutMs: FLOOR_MS, basis: 'floor', stepCount: null };
  }

  const scaled = Math.ceil(n) * PER_STEP_MS;
  if (scaled <= FLOOR_MS) return { timeoutMs: FLOOR_MS, basis: 'floor', stepCount: Math.ceil(n) };
  if (scaled >= CEILING_MS) return { timeoutMs: CEILING_MS, basis: 'ceiling', stepCount: Math.ceil(n) };
  return { timeoutMs: scaled, basis: 'scaled', stepCount: Math.ceil(n) };
}

/**
 * Count top-level flow steps in an ACE recipe body.
 *
 * Deliberately a cheap line scan rather than a YAML parse: this runs on the
 * hot path before every Maestro invocation, the answer only sizes a timeout,
 * and a wrong count degrades to the floor rather than breaking a run. Counts
 * list items at the flow's base indentation after the `---` separator.
 */
export function countRecipeSteps(body: string): number {
  const parts = body.split(/^---\s*$/m);
  const flow = parts.length >= 2 ? parts.slice(1).join('\n') : body;
  let count = 0;
  for (const line of flow.split('\n')) {
    if (/^-\s+\S/.test(line) || /^-$/.test(line.trimEnd())) count++;
  }
  return count;
}
