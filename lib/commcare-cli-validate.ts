/**
 * Validate / play a CommCare CCZ via upstream `commcare-cli.jar`.
 *
 * Two modes, with different coverage:
 *
 *   - **`validate`** — `java -jar commcare-cli.jar validate <ccz>`. Runs
 *     CCZ unzip + suite/profile/XForm parse + static reference integrity.
 *     Fast (<2s). Catches parser-class defects (malformed XML, missing
 *     namespaces, structurally broken CCZs).
 *
 *   - **`play`** — `java -jar commcare-cli.jar play <ccz> -r <restore.xml>`.
 *     Boots the CommCare app in CLI mode, navigates to a target form
 *     (default: first menu → first module → first form), and triggers
 *     form-init. **This is where runtime XPath binding errors surface**
 *     (`XPathTypeMismatchException` from `FormDef.initAllTriggerables` →
 *     `Recalculate.eval` chain) — including the canonical bednet bug class
 *     where `connect.deliver_unit.entity_id` references a session datum
 *     that resolves to nothing at form-init time. Slower (~5-10s).
 *
 * Reproducer for the play-mode class: `bednet-spot-check/20260525-1405`
 * Phase 6 — Deliver app's `entity_id: #case/case_name` substitution passed
 * every static gate (Nova `validate_app`, CCHQ `make_build`, CCHQ release,
 * `commcare-cli validate`) then failed at form-init via `play` (and on the
 * Android device with "A part of your application is invalid"). See
 * `docs/learnings/2026-05-25-bednet-smoke-phase6-install-rejection.md`.
 *
 * Pure-side parsers (`parseValidatorOutput`, `parsePlayOutput`) are exposed
 * separately so unit tests can exercise log shapes without spawning Java.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

// ============================================================================
// play mode — run the CCZ in CliPlayCommand, navigate to a form, see if
// FormDef.initAllTriggerables blows up.
// ============================================================================

export interface CommCareCliPlayOptions {
  /** Path to the CCZ file. Must exist + non-empty. */
  cczPath: string;
  /** Path to commcare-cli.jar. */
  jarPath: string;
  /**
   * Path to a synthetic restore.xml (OpenRosa Registration block + empty
   * sandbox). When omitted, the helper writes a built-in minimal restore
   * to a temp file. Override for tests + when you want fixture cases.
   */
  restorePath?: string;
  /**
   * Menu-index sequence to navigate to a form. Default `[0, 0]` walks
   * "first module → first form" — the common case. For multi-module apps
   * the caller invokes play once per module (`[0,0]`, `[1,0]`, ...) to
   * cover every form-init.
   */
  entryPath?: number[];
  javaPath?: string;
  /** Default 30000. CCZ load + form-init is ~3-8s; 30s budget covers JVM cold-start. */
  timeoutMs?: number;
}

export interface CommCareCliPlayResult {
  verdict: CommCareCliValidateVerdict;
  exit_code: number;
  /** Form path navigated to (echo of entryPath). */
  entry_path: number[];
  /**
   * The form's data binding that raised — extracted from
   * `Error in calculation for /data/<form>/<binding>` when present.
   */
  failing_binding?: string;
  /**
   * The XPath the runtime couldn't resolve — extracted from
   * `Logic references <xpath> which is not a valid question or value.`
   */
  unresolved_xpath?: string;
  /** Exception class + message (e.g. `XPathTypeMismatchException: ...`). */
  parser_message?: string;
  stdout: string;
  stderr: string;
  timeout_ms: number;
  timed_out: boolean;
}

/** Minimal OpenRosa restore — empty sandbox + one demo user. Embedded so
 *  callers don't need to ship a fixture file. */
export const DEFAULT_PLAY_RESTORE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OpenRosaResponse xmlns="http://openrosa.org/http/response">
  <message nature="ota_restore_success">Successful</message>
  <Registration xmlns="http://openrosa.org/user/registration">
    <username>demo</username>
    <password>demo</password>
    <uuid>demo-user-uuid</uuid>
    <date>2026-05-25T00:00:00.000-00:00</date>
    <user_data>
      <data key="commcare_first_name">Demo</data>
      <data key="commcare_last_name">User</data>
    </user_data>
  </Registration>
</OpenRosaResponse>
`;

/**
 * Run `commcare-cli.jar play` against a CCZ, navigating to a form, and
 * resolve to a typed verdict capturing whether form-init blew up.
 *
 * Mechanics: spawns Java with stdin piped, writes the navigation sequence
 * (one `0\n` per menu level by default) followed by `:quit\n`. The CLI
 * prints menu screens to stdout and exceptions to stdout (it does NOT use
 * stderr for app errors — confirmed live 2026-05-25 against
 * `commcare-cli-commcare_2.63.0.jar`). When form-init triggers a
 * `XPathTypeMismatchException` or similar, the line `Unhandled Fatal Error
 * executing CommCare app` appears on stdout immediately followed by the
 * exception class + message.
 *
 * Throws `CommCareCliInputError` on missing inputs.
 */
export async function commcareCliPlayCcz(
  opts: CommCareCliPlayOptions,
): Promise<CommCareCliPlayResult> {
  const javaPath = opts.javaPath ?? 'java';
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const entryPath = opts.entryPath ?? [0, 0];

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

  // Resolve restore: caller path > built-in temp.
  let restorePath = opts.restorePath;
  let restoreTempDir: string | undefined;
  if (!restorePath) {
    restoreTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ace-ccz-play-restore-'));
    restorePath = path.join(restoreTempDir, 'restore.xml');
    await fs.promises.writeFile(restorePath, DEFAULT_PLAY_RESTORE_XML);
  }

  // Two-level menu walk = first form. Final `0\n` lands inside form entry;
  // some forms display label screens that need an additional Enter to
  // advance — we fire one extra `0\n` for safety. `:quit\n` exits.
  const navInput = entryPath.map(String).join('\n') + '\n0\n:quit\n';

  try {
    return await new Promise<CommCareCliPlayResult>((resolve, reject) => {
      const proc = spawn(
        javaPath,
        ['-jar', opts.jarPath, 'play', opts.cczPath, '-r', restorePath!],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
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
      proc.stdin.write(navInput);
      proc.stdin.end();
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
        resolve(
          parsePlayOutput({
            exitCode,
            stdout,
            stderr,
            timedOut,
            timeoutMs,
            entryPath,
          }),
        );
      });
    });
  } finally {
    if (restoreTempDir) {
      await fs.promises.rm(restoreTempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export interface ParsePlayOutputInput {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs: number;
  entryPath: number[];
}

/**
 * Pure parser for `commcare-cli play` output.
 *
 * Verdict rules:
 *   - Timed out → fail.
 *   - Stdout/stderr contains `Unhandled Fatal Error executing CommCare app`
 *     AND a real exception class (XPath*, XForm*, Calculation Error,
 *     InvalidStructureException, etc.) → fail.
 *   - Stdout/stderr contains ONLY the benign EOF NPE
 *     (`Cannot invoke "String.startsWith(String)" because "input" is null`
 *     at `ApplicationHost.loopSession`), which fires when stdin closes
 *     mid-menu-prompt → pass. This is an artifact of piping `:quit` after
 *     a single form open; the form-init already completed cleanly.
 *   - Otherwise → pass.
 */
export function parsePlayOutput(input: ParsePlayOutputInput): CommCareCliPlayResult {
  const stdout = trimLog(input.stdout);
  const stderr = trimLog(input.stderr);
  const combined = `${stdout}\n${stderr}`;

  const failingBinding = extractFailingBinding(combined);
  const unresolvedXpath = extractUnresolvedXpath(combined);
  const parserMessage = extractPlayParserMessage(combined);

  const realError = playStreamIndicatesRealFailure(combined);
  const passed = !input.timedOut && !realError;

  return {
    verdict: passed ? 'pass' : 'fail',
    exit_code: input.exitCode,
    entry_path: input.entryPath,
    failing_binding: failingBinding,
    unresolved_xpath: unresolvedXpath,
    parser_message: parserMessage,
    stdout,
    stderr,
    timeout_ms: input.timeoutMs,
    timed_out: input.timedOut,
  };
}

/** Distinguish real form-init failures from the benign EOF NPE. */
function playStreamIndicatesRealFailure(s: string): boolean {
  if (!s) return false;
  // Real form-init defects we care about. XPathTypeMismatchException is
  // the bednet class; XPathException is any other XPath-eval failure;
  // XFormParseException is a structural defect we'd catch in `validate`
  // too but is also visible here; "Calculation Error" / "Logic references"
  // are XPathTypeMismatchException's user-facing message.
  if (
    /(XPathTypeMismatchException|XPathException|XFormParseException|InvalidStructureException|InvalidResourceException|UnresolvedResourceException|Calculation Error|Logic references)/i.test(
      s,
    )
  ) {
    return true;
  }
  // `Unhandled Fatal Error executing CommCare app` followed by ANY other
  // exception class (not the benign `String.startsWith` NPE). The CLI
  // closes the input stream when stdin EOFs at a menu prompt, and the
  // loopSession reader returns null, throwing NPE on
  // `input.startsWith(":")` at ApplicationHost.java:267. That's benign —
  // form-init already completed.
  const fatalLine = /Unhandled Fatal Error executing CommCare app\s*(.+)/.exec(s);
  if (fatalLine && fatalLine[1]) {
    const afterFatal = fatalLine[1];
    const benignEof =
      /String\.startsWith\(String\).*because "input" is null/.test(afterFatal) ||
      /ApplicationHost\.loopSession\(ApplicationHost\.java:\d+\)/.test(afterFatal);
    if (!benignEof) return true;
  }
  return false;
}

function extractFailingBinding(s: string): string | undefined {
  const m = s.match(/Error in calculation for (\S+)/);
  return m ? m[1] : undefined;
}

function extractUnresolvedXpath(s: string): string | undefined {
  const m = s.match(/Logic references\s+(\S+)\s+which is not a valid question or value/);
  return m ? m[1] : undefined;
}

function extractPlayParserMessage(s: string): string | undefined {
  // Try real exception classes first.
  const exc = s.match(
    /(XPathTypeMismatchException|XPathException|XFormParseException|InvalidStructureException|InvalidResourceException|UnresolvedResourceException):\s*([^\n]+)/,
  );
  if (exc) return `${exc[1]}: ${exc[2].trim()}`;
  // Fall back to "Calculation Error" form ("XPathTypeMismatchException"
  // sometimes wraps with this prefix on the same line).
  const calc = s.match(/Calculation Error:\s*([^\n]+)/);
  if (calc) return `Calculation Error: ${calc[1].trim()}`;
  return undefined;
}
