/**
 * Validate a CommCare CCZ by invoking upstream `commcare-cli.jar validate`.
 *
 * Why this exists: every Phase 3 static gate (Nova `validate_app`, CCHQ
 * `make_build`, CCHQ release, `app-release-smoke`'s `projected_connect_state`
 * projection) is structural — none of them exercise CommCare's runtime
 * install path. The `commcare-cli.jar validate` subcommand (from
 * `dimagi/commcare-core` — built via `./gradlew cliJar`) runs the same
 * `ResourceTable.initializeResources` install path the Android device runs,
 * including the `XFormAndroidInstaller` / `SuiteAndroidInstaller` /
 * `ProfileAndroidInstaller` chain whose `InvalidResourceException` maps to
 * CommCare's "A part of your application is invalid" device install error.
 *
 * Phase 3 wires this in via `app-release-smoke`: if the validator exits
 * non-zero, halt loud before the run reaches Phase 6. Reproducer for the
 * class this catches: `bednet-spot-check/20260525-1405` Phase 6 install
 * rejection — `docs/learnings/2026-05-25-bednet-smoke-phase6-install-rejection.md`.
 *
 * Pure-side parsing is exposed separately as `parseValidatorOutput` so unit
 * tests can validate stderr-shape handling without spawning Java.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

export interface CommCareCliValidateOptions {
  /** Path to the CCZ file to validate. Must exist and be non-empty. */
  cczPath: string;
  /** Path to commcare-cli.jar (built via `./gradlew cliJar` in dimagi/commcare-core). */
  jarPath: string;
  /** Optional Java executable (default `java` — must resolve to JDK 17+ on PATH). */
  javaPath?: string;
  /** Spawn timeout in ms. Default 60000. Bednet-scale CCZs validate in <2s; long timeouts surface a stuck JVM. */
  timeoutMs?: number;
}

export type CommCareCliValidateVerdict = 'pass' | 'fail';

export interface CommCareCliValidateResult {
  verdict: CommCareCliValidateVerdict;
  exit_code: number;
  /** Failing resource descriptor extracted from stderr/stdout (e.g. `jr://resource/modules-0/forms-0.xml`). */
  failed_resource?: string;
  /** Parser/installer error message (e.g. `XFormParseException: <msg>`). */
  parser_message?: string;
  /** Raw stdout (trimmed; truncated to MAX_LOG_CHARS). */
  stdout: string;
  /** Raw stderr (trimmed; truncated to MAX_LOG_CHARS). */
  stderr: string;
  /** Spawn timeout applied (ms). */
  timeout_ms: number;
  /** True when the spawn timed out before clean exit. */
  timed_out: boolean;
}

export type CommCareCliInputErrorKind =
  | 'ccz_not_found'
  | 'ccz_empty'
  | 'jar_not_found';

export class CommCareCliInputError extends Error {
  constructor(public readonly kind: CommCareCliInputErrorKind, public readonly path: string) {
    super(`commcare-cli input error: ${kind} (${path})`);
    this.name = 'CommCareCliInputError';
  }
}

/**
 * Spawn `java -jar <jar> validate <ccz>` and resolve to a typed verdict.
 *
 * Throws `CommCareCliInputError` for missing inputs (operator must fix —
 * not transient). Network / spawn errors propagate as native Node errors.
 */
export async function commcareCliValidateCcz(
  opts: CommCareCliValidateOptions,
): Promise<CommCareCliValidateResult> {
  const javaPath = opts.javaPath ?? 'java';
  const timeoutMs = opts.timeoutMs ?? 60_000;

  // Pre-flight: explicit existence + non-empty checks so the operator
  // sees a typed error before Java spews its own (noisier) stack trace.
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(opts.cczPath);
  } catch (e: any) {
    if (e?.code === 'ENOENT') throw new CommCareCliInputError('ccz_not_found', opts.cczPath);
    throw e;
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new CommCareCliInputError('ccz_empty', opts.cczPath);
  }
  try {
    await fs.promises.access(opts.jarPath, fs.constants.R_OK);
  } catch {
    throw new CommCareCliInputError('jar_not_found', opts.jarPath);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(javaPath, ['-jar', opts.jarPath, 'validate', opts.cczPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code === null ? -1 : code;
      resolve(parseValidatorOutput({ exitCode, stdout, stderr, timedOut, timeoutMs }));
    });
  });
}

export interface ParseValidatorOutputInput {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs: number;
}

const MAX_LOG_CHARS = 4000;

/**
 * Pure parser — extracted so unit tests can exercise stderr-shape handling
 * without spawning the JVM.
 *
 * Verdict rule:
 *   - Timed out → fail (validator should complete bednet-scale CCZs in <2s).
 *   - Non-zero exit → fail.
 *   - Zero exit but stderr/stdout names a known exception class → fail
 *     (commcare-cli's CliValidateCommand sometimes logs UnresolvedResourceException
 *     to stderr while still exiting 0; treat as fail.)
 *   - Otherwise → pass.
 */
export function parseValidatorOutput(input: ParseValidatorOutputInput): CommCareCliValidateResult {
  const stdout = trimLog(input.stdout);
  const stderr = trimLog(input.stderr);

  const passed =
    !input.timedOut &&
    input.exitCode === 0 &&
    !streamIndicatesFailure(stderr) &&
    !streamIndicatesFailure(stdout);

  return {
    verdict: passed ? 'pass' : 'fail',
    exit_code: input.exitCode,
    failed_resource: extractFailedResource(stderr, stdout),
    parser_message: extractParserMessage(stderr, stdout),
    stdout,
    stderr,
    timeout_ms: input.timeoutMs,
    timed_out: input.timedOut,
  };
}

function trimLog(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= MAX_LOG_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_LOG_CHARS)}\n... [truncated; original ${trimmed.length} chars]`;
}

/**
 * Any of the install-time exception class names → fail signal.
 * Aligned with `commcare-core` install-path exception types.
 */
function streamIndicatesFailure(s: string): boolean {
  if (!s) return false;
  return /(?:XFormParseException|InvalidStructureException|InvalidResourceException|UnresolvedResourceException|XPathException|Failed to install resource|^\s*(?:FAILURE|ERROR:))/im.test(
    s,
  );
}

function extractFailedResource(stderr: string, stdout: string): string | undefined {
  const patterns: RegExp[] = [
    /Failed to install resource:\s*([^\n]+)/i,
    /Invalid resource:?\s*([^\n]+)/i,
    /Resource\s+([^:\n]+):\s/i,
  ];
  for (const src of [stderr, stdout]) {
    for (const pat of patterns) {
      const m = src.match(pat);
      if (m && m[1]) return m[1].trim();
    }
  }
  return undefined;
}

function extractParserMessage(stderr: string, stdout: string): string | undefined {
  const pat =
    /(XFormParseException|InvalidStructureException|InvalidResourceException|UnresolvedResourceException|XPathException):\s*([^\n]+)/i;
  for (const src of [stderr, stdout]) {
    const m = src.match(pat);
    if (m && m[2]) return `${m[1]}: ${m[2].trim()}`;
  }
  return undefined;
}
