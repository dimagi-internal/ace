// lib/scratch-file.ts
//
// Safe scratch files for ACE helper scripts (dimagi-internal/ace#1046).
//
// The class: a script documented as `--out /tmp/ace-<thing>-<app>.json`
// writes to a path that is PREDICTABLE and SHARED across macOS users and
// sessions. On the real ACE workstation (two macOS accounts, several
// sessions) two failures compose:
//
//   1. The write fails `EACCES` because another user owns the existing file.
//   2. The follow-up read SUCCEEDS anyway — returning the OTHER session's
//      stale file.
//
// The caller gets a well-formed, plausible, completely wrong payload with
// no error anywhere. Live near-miss: bednet-spot-check/20260729-0002 Phase 3
// Step 2.65 (`app-hq-settings`) read a stale `/tmp/ace-hq-<app>.json`
// describing DIFFERENT apps (2 and 5 modules) than the run's own (1 module
// each). Had those module ids reached `commcare_set_menu_display` the run
// would have mutated modules on two unrelated apps in live prod HQ with a
// 200 and no error. It was caught only because the agent chose to
// cross-check the returned app ids against the ones it passed in — a check
// written down nowhere.
//
// Two independent halves, both implemented here:
//
//   * `scratchPath()` — an UNPREDICTABLE, per-user, per-process path via
//     `fs.mkdtempSync(os.tmpdir())`. `os.tmpdir()` honours `TMPDIR`, which
//     is already per-user on macOS; mkdtemp adds per-process randomness and
//     mode 0700 so a sibling session cannot pre-create or read it.
//
//   * `writeVerifiedJson()` / `readVerifiedJson()` — fail-CLOSED reads. The
//     payload carries the identifiers it is keyed to (app_id, domain, …) and
//     the read asserts they round-trip, throwing `StaleArtifactError` on
//     mismatch instead of returning someone else's data. This is the durable
//     half: it is exactly the check that caught the near-miss, encoded so it
//     no longer depends on an agent choosing to do it.
//
// Sibling of the "prove every write against a fresh authoritative read"
// discipline ACE already applies to HQ role grants — applied to local files.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Thrown when a file's stamped identity does not match what the caller
 * asked for — i.e. we are about to hand back another session's data.
 *
 * Deliberately a hard throw, never a warning: the whole defect class is
 * "wrong payload, no error to notice".
 */
export class StaleArtifactError extends Error {
  readonly code = 'STALE_ARTIFACT' as const;
  readonly filePath: string;
  readonly mismatches: Array<{ key: string; expected: unknown; actual: unknown }>;

  constructor(
    filePath: string,
    mismatches: Array<{ key: string; expected: unknown; actual: unknown }>,
  ) {
    const detail = mismatches
      .map((m) => `${m.key}: expected ${JSON.stringify(m.expected)}, file has ${JSON.stringify(m.actual)}`)
      .join('; ');
    super(
      `STALE_ARTIFACT: ${filePath} does not describe what was requested (${detail}). ` +
        `Refusing to return it. This is the ace#1046 class: a predictable shared ` +
        `/tmp path whose write failed (EACCES from another macOS user) while the read ` +
        `silently succeeded against a DIFFERENT session's file. Do NOT feed this ` +
        `payload to any write-side atom. Re-run with a scratch path (see ` +
        `lib/scratch-file.ts::scratchPath, or shell: mktemp "\${TMPDIR:-/tmp}/ace-XXXXXX.json").`,
    );
    this.name = 'StaleArtifactError';
    this.filePath = filePath;
    this.mismatches = mismatches;
  }
}

/** Memoized per-process scratch directory. */
let cachedDir: string | null = null;

/**
 * Every scratch dir THIS process created via `mkdtempSync`. Membership is an
 * exact answer to "is this path ours?", which beats guessing at randomness —
 * see `isSafeScratchTarget`.
 */
const createdScratchDirs = new Set<string>();

/**
 * The per-process scratch directory: `<os.tmpdir()>/ace-scratch-<random>/`,
 * created 0700 via `mkdtempSync`.
 *
 * Unpredictable BY CONSTRUCTION — the random suffix means no sibling
 * session (or sibling macOS user) can name, pre-create, or collide with it,
 * which is the half of #1046 that a fixed `/tmp/ace-*` literal cannot have.
 * Memoized so every call in one MCP/script process shares one directory.
 */
export function scratchDir(): string {
  if (cachedDir && fs.existsSync(cachedDir)) return cachedDir;
  cachedDir = fs.mkdtempSync(path.join(os.tmpdir(), SCRATCH_PREFIX));
  createdScratchDirs.add(cachedDir);
  return cachedDir;
}

/**
 * A path inside this process's scratch directory.
 *
 * `basename` is sanitized to a single path segment — a caller passing an
 * app id straight through must not be able to escape the scratch dir with
 * `../` or land back on a shared absolute path.
 */
export function scratchPath(basename: string): string {
  const safe = path.basename(basename).replace(/[^A-Za-z0-9._-]/g, '_');
  if (!safe || safe === '.' || safe === '..') {
    throw new Error(`scratchPath: '${basename}' does not reduce to a usable filename`);
  }
  return path.join(scratchDir(), safe);
}

/** Prefix `scratchDir()` hands to `mkdtempSync`. */
const SCRATCH_PREFIX = 'ace-scratch-';

/**
 * SYNTACTIC lint predicate: does this path *as written in source* reintroduce
 * the #1046 shape — a fixed, cross-user-shared `/tmp` location with a name a
 * sibling session can predict?
 *
 * Used by `test/scripts/tmp-path-predictability.test.ts`, which scans static
 * command-line strings in `scripts/`, `skills/`, `commands/` etc. Those are
 * literals no process created, so the answer has to come from the text:
 * an `XXXXXX` template or `$(id -u)` scoping is unpredictable, a fixed name
 * is not.
 *
 * Do NOT use this on a runtime path — see `isSafeScratchTarget`. Keeping the
 * two apart is deliberate: conflating them shipped a bug where `scratchPath()`
 * output was flagged as predictable on Linux (where `os.tmpdir()` IS `/tmp`,
 * so the mkdtemp randomness sits in a parent segment this text-level check
 * cannot see).
 */
export function isPredictableSharedPath(p: string): boolean {
  if (!p) return false;
  // Normalize macOS's /private/tmp alias for /tmp.
  const norm = p.replace(/^\/private\/tmp\//, '/tmp/');
  if (!norm.startsWith('/tmp/')) return false;
  // `mktemp`/`mkdtemp` templates and their expansions are unpredictable
  // even under /tmp: an XXXXXX template, or a `$(id -u)` user scoping.
  if (/XXXXXX/.test(norm)) return false;
  if (/\$\(id -u\)|\$UID|\$\{UID\}/.test(norm)) return false;
  // A path inside an `ace-scratch-<random>/` or `tmp.<random>/` directory is
  // mkdtemp/mktemp output, not a predictable literal.
  if (mkdtempSegment(norm)) return false;
  return true;
}

/** True if any segment looks like `mkdtemp`/`mktemp -d` output. */
function mkdtempSegment(p: string): boolean {
  return p
    .split('/')
    .some((seg) => new RegExp(`^(?:${SCRATCH_PREFIX}|tmp\\.)[A-Za-z0-9]{6,}$`).test(seg));
}

/**
 * RUNTIME check: is this concrete path a safe place for us to write — i.e.
 * ours, rather than a cross-user-shared name another account could own?
 *
 * Answers exactly rather than by guessing at entropy, in priority order:
 *   1. Not under `/tmp` at all (e.g. macOS's per-user `/var/folders/...`
 *      `TMPDIR`, or `~/.ace/`) — safe.
 *   2. Inside a scratch dir THIS process created via `mkdtempSync` — safe by
 *      construction. This is the case that `isPredictableSharedPath` got
 *      wrong on Linux, where `os.tmpdir()` is `/tmp`.
 *   3. Inside an `ace-scratch-<random>/` or `tmp.<random>/` dir — mkdtemp
 *      output, possibly from a sibling ACE process or a shell `mktemp -d`.
 *   4. An existing file owned by us with mode 0600 — `mktemp`'s signature,
 *      so a shell-provided `--out "$(mktemp ...)"` doesn't get a bogus warning.
 * Anything else under `/tmp` is the defect shape.
 */
export function isSafeScratchTarget(p: string): boolean {
  if (!p) return false;
  const resolved = path.resolve(p).replace(/^\/private\/tmp\//, '/tmp/');
  if (!resolved.startsWith('/tmp/')) return true;
  for (const dir of createdScratchDirs) {
    if (resolved === dir || resolved.startsWith(dir + path.sep)) return true;
  }
  if (mkdtempSegment(resolved)) return true;
  try {
    const st = fs.statSync(resolved);
    if (st.isFile() && (st.mode & 0o777) === 0o600 && st.uid === process.getuid?.()) return true;
  } catch {
    /* does not exist yet — fall through to "not proven safe" */
  }
  return false;
}

/** Identity keys a payload must round-trip, e.g. `{ domain, app_id }`. */
export type Identity = Record<string, string | number | null>;

/**
 * Compare a parsed payload's top-level identity stamp against what the
 * caller asked for. Returns the mismatching keys (empty = clean).
 *
 * A key the payload does NOT carry at all counts as a mismatch: an
 * unstamped payload cannot prove it is ours, and "can't prove it" must
 * fail closed rather than pass.
 */
export function identityMismatches(
  payload: unknown,
  identity: Identity,
): Array<{ key: string; expected: unknown; actual: unknown }> {
  const out: Array<{ key: string; expected: unknown; actual: unknown }> = [];
  const obj = (payload ?? {}) as Record<string, unknown>;
  const isObj = typeof payload === 'object' && payload !== null && !Array.isArray(payload);
  for (const [key, expected] of Object.entries(identity)) {
    const actual = isObj ? obj[key] : undefined;
    if (actual !== expected) out.push({ key, expected, actual });
  }
  return out;
}

/**
 * Write a JSON payload, then PROVE the file on disk is the one we just
 * wrote by reading it back and asserting the identity stamp round-trips.
 *
 * Why read-back rather than trusting the write: the #1046 failure is a
 * write that throws while a stale file with the same name survives. A
 * caller that only checks the exit code of its own `writeFileSync` cannot
 * distinguish "my bytes are on disk" from "someone else's bytes are still
 * on disk" — only a read-back can.
 *
 * `identity` keys must already be present in `payload`; a caller that
 * forgets to stamp them gets a loud `StaleArtifactError` against its own
 * output rather than a silent hole in the guard.
 */
export function writeVerifiedJson(args: {
  filePath: string;
  payload: unknown;
  identity: Identity;
  /**
   * Writer seam. Production leaves it undefined and gets `fs.writeFileSync`.
   * Tests inject a no-op to reproduce the swallowed-write shape — an ESM
   * namespace export cannot be spied, and the whole point of the read-back
   * is to catch a write that reported success without landing.
   */
  writeImpl?: (filePath: string, data: string) => void;
}): void {
  const { filePath, payload, identity } = args;
  const write = args.writeImpl ?? ((p: string, data: string) => fs.writeFileSync(p, data));
  const preWrite = identityMismatches(payload, identity);
  if (preWrite.length > 0) {
    throw new StaleArtifactError(filePath, preWrite);
  }
  if (!isSafeScratchTarget(filePath)) {
    // Not fatal — an operator may explicitly want a shared path — but say
    // so loudly, because this is the exact shape that produced the
    // near-miss. The read-back below still fails closed either way.
    process.stderr.write(
      `[scratch-file] WARNING: '${filePath}' is a predictable path shared across ` +
        `macOS users (ace#1046). Prefer a scratch path: ` +
        `mktemp "\${TMPDIR:-/tmp}/ace-XXXXXX.json".\n`,
    );
  }
  write(filePath, JSON.stringify(payload, null, 2));
  // Fail-closed read-back. If the write silently lost (EACCES swallowed by
  // a wrapper, a symlink pointing elsewhere, a racing sibling session)
  // this is where it surfaces.
  readVerifiedJson({ filePath, identity });
}

/**
 * Read a JSON file and assert its identity stamp matches what the caller
 * asked for, throwing `StaleArtifactError` on mismatch.
 *
 * A script must never silently consume a file it did not just write.
 */
export function readVerifiedJson(args: { filePath: string; identity: Identity }): unknown {
  const { filePath, identity } = args;
  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new StaleArtifactError(filePath, [
      { key: '<parse>', expected: 'valid JSON', actual: (e as Error).message },
    ]);
  }
  const mismatches = identityMismatches(parsed, identity);
  if (mismatches.length > 0) throw new StaleArtifactError(filePath, mismatches);
  return parsed;
}
