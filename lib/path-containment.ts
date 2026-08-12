/**
 * Containment for MCP atom arguments that name a LOCAL FILE PATH.
 *
 * Closes dimagi-internal/ace#1110 (2026-07-31 security audit, MCP findings
 * F2/F4/F6/F7/F9/F10). That issue deliberately deferred the fix because it
 * "needs an allowed-roots decision plus live-flow validation" — the decision
 * is encoded here, and the roots are derived from the paths ACE flows actually
 * use rather than guessed.
 *
 * ## Threat model
 *
 * MCP tool arguments come from the ACE agent, which routinely ingests
 * untrusted content (inbound email in `/ace:turn`, Drive docs, OCS material).
 * A prompt-injected agent can therefore choose these paths, and the MCP
 * subprocesses hold real production credentials. Two sinks:
 *
 *   - **read** (`drive_upload_binary.localFilePath`,
 *     `ocs_upload_collection_files.files[].file_path`,
 *     `commcare_upload_multimedia.file_bytes_path`,
 *     `commcare_patch_xform.new_xform_xml_path`) — arbitrary read becomes
 *     exfiltration, and `drive_upload_binary` can attach
 *     `shareAnyoneWithLink: true` in the same call, so one hop gets a PUBLIC
 *     link to `$CLAUDE_PLUGIN_DATA/.env`. The OCS variant is worse: the secret
 *     lands in a vector store and is retrievable later by a normal chat turn,
 *     never appearing in the stealing call's transcript.
 *   - **write** (`commcare_download_ccz.write_to_path`,
 *     `drive_read_file.writeToPath`, `drive_download_binary.writeToPath`,
 *     `ocs_download_file.writeToPath`) — arbitrary overwrite of `~/.zshrc`, a
 *     git hook, or `.env`, i.e. code execution on the next shell or commit.
 *
 * Both directions get the SAME containment. A read-only allowlist would leave
 * the overwrite-to-execute path open, and vice versa.
 *
 * ## The rule
 *
 * A path is allowed iff it resolves inside an allowed root AND does not match
 * a denied pattern. Deny beats allow, because the highest-value targets
 * (`.env`, `gws-sa-key.json`, `*session*.json`) sit inside directories that
 * otherwise have to be reachable.
 *
 * Resolution is symlink-aware: we realpath the nearest EXISTING ancestor and
 * re-join the remainder, so neither `../../` or a symlinked parent directory
 * can smuggle a path out of a root. Doing it on the nearest existing ancestor
 * (rather than the full path) is what makes this work for a WRITE to a file
 * that does not exist yet.
 *
 * ## Operator controls
 *
 * `ACE_ALLOWED_FILE_ROOTS` — colon-separated extra roots. **Extends** the
 * defaults rather than replacing them, so adding a root for a new flow cannot
 * silently drop the safe ones.
 *
 * `ACE_PATH_CONTAINMENT=off` — kill switch, logs loudly to stderr. Env is
 * fixed when the MCP subprocess spawns, so this is reachable by an operator
 * and NOT by a prompt-injected agent mid-session. It exists because #1110's
 * stated risk was breaking Phase 3/6/7, and an outage with no escape hatch is
 * a worse failure than the one we're preventing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class PathContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathContainmentError';
  }
}

export interface AssertPathOptions {
  /** Which direction the path is used in — appears in the error message. */
  mode: 'read' | 'write';
  /** Atom name, e.g. `drive_upload_binary`. For an actionable error. */
  atom: string;
  /** Argument name, e.g. `localFilePath`. For an actionable error. */
  arg: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Path segments and basenames that are refused even inside an allowed root.
 *
 * Each entry earned its place from #1110's own table or from the credentials
 * `/ace:doctor` and CLAUDE.md § Auth model name as live: `.env`,
 * `gws-sa-key.json`, `~/.ace/*-session.json`.
 */
const DENIED_BASENAME_TESTS: Array<{ re: RegExp; why: string }> = [
  { re: /^\.env(\..+)?$/i, why: 'dotenv secrets (every ACE_/OCS_/CONNECT_ credential)' },
  { re: /^gws-sa-key\.json$/i, why: 'Google service-account private key' },
  { re: /^credentials.*\.json$/i, why: 'OAuth client credentials' },
  { re: /session.*\.json$/i, why: 'Playwright session cookies (OCS / Connect / labs)' },
  { re: /^\.(npmrc|netrc|zshrc|bashrc|bash_profile|zprofile|profile)$/i, why: 'shell/registry config — overwrite is code execution' },
  { re: /^id_(rsa|dsa|ecdsa|ed25519)/i, why: 'SSH private key' },
  { re: /\.(pem|p12|pfx)$/i, why: 'private key / certificate bundle' },
];

/**
 * Directory segments that are refused anywhere in a resolved path. Matched
 * segment-wise (not substring) so a legitimately-named file cannot trip them.
 */
const DENIED_SEGMENTS: Array<{ segs: string[]; why: string }> = [
  { segs: ['.ssh'], why: 'SSH keys' },
  { segs: ['.gnupg'], why: 'GPG keys' },
  { segs: ['.aws'], why: 'AWS credentials' },
  { segs: ['.config', 'gh'], why: 'GitHub CLI token' },
  { segs: ['Library', 'Keychains'], why: 'macOS keychain' },
  { segs: ['.git', 'hooks'], why: 'git hooks — overwrite is code execution on next commit' },
  // Covers $CLAUDE_PLUGIN_DATA (~/.claude/plugins/data/ace-ace/: .env +
  // gws-sa-key.json), the plugin cache, settings, and — importantly — session
  // transcripts under ~/.claude/projects/, which contain whatever secrets
  // passed through a conversation.
  { segs: ['.claude'], why: 'Claude Code state: plugin data (.env, SA key), settings, and session transcripts' },
];

/** True iff `child` is `parent` or lives underneath it. */
function isInside(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolve a path to its real location, tolerating a target that does not
 * exist yet (the normal case for a write).
 *
 * Walks up to the nearest existing ancestor, realpaths THAT, then re-joins the
 * non-existent tail. Without the walk, `realpathSync` throws ENOENT on every
 * write to a new file; without the realpath, a symlinked parent directory
 * escapes containment.
 */
export function resolveRealPath(p: string): string {
  const abs = path.resolve(p);
  let existing = abs;
  const tail: string[] = [];

  for (;;) {
    if (fs.existsSync(existing)) break;
    const parent = path.dirname(existing);
    if (parent === existing) return abs; // hit the filesystem root, nothing exists
    tail.unshift(path.basename(existing));
    existing = parent;
  }

  let real: string;
  try {
    real = fs.realpathSync(existing);
  } catch {
    return abs;
  }
  return tail.length ? path.join(real, ...tail) : real;
}

/**
 * The roots ACE flows legitimately touch, derived from observed usage rather
 * than invented:
 *
 *   - the OS temp dir, `/tmp`, `/private/tmp` — where every skill and test
 *     stages files (`/tmp/ace-*`, mobile failure forensics in
 *     `/var/folders/.../failshot-*`, the session scratchpad under
 *     `/private/tmp/claude-*`).
 *   - `~/.ace/mobile-videos` — the recipe-recording spool that
 *     `app-screenshot-capture` § 5.7 uploads via
 *     `drive_upload_binary(localFilePath)`. A real read source, so it must be
 *     reachable; the rest of `~/.ace` (which holds the session cookie jars)
 *     is NOT.
 *   - `~/.ace/logs` — same reasoning, diagnostics get attached to runs.
 *
 * Deliberately absent: the ACE checkout / plugin cache. In production that is
 * inside `~/.claude`, which is denied outright, so including it would mean
 * "works in dev, refused in prod" — the worst kind of difference.
 */
export function defaultAllowedRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  const roots = [os.tmpdir(), '/tmp', '/private/tmp'];
  if (env.TMPDIR) roots.push(env.TMPDIR);
  roots.push(path.join(home, '.ace', 'mobile-videos'));
  roots.push(path.join(home, '.ace', 'logs'));
  return roots;
}

/**
 * Allowed roots = defaults + `ACE_ALLOWED_FILE_ROOTS`, each realpath-resolved
 * and de-duplicated. Roots that do not exist are kept (a root can be created
 * later in the session), but realpathing what DOES exist is what makes
 * `/tmp` → `/private/tmp` comparisons work on macOS.
 */
export function resolveAllowedRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  const extra = (env.ACE_ALLOWED_FILE_ROOTS ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
  const all = [...defaultAllowedRoots(env, home), ...extra];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of all) {
    const resolved = resolveRealPath(r);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

let killSwitchWarned = false;

/**
 * Assert that `candidate` is a path ACE may read or write, and return its
 * resolved real path (callers should use the RETURN VALUE for the actual
 * filesystem operation — using the original string would reopen the symlink
 * hole this closes).
 *
 * @throws PathContainmentError with a message naming the atom, the arg, the
 * resolved path, the allowed roots, and how to extend them.
 */
export function assertPathAllowed(candidate: string, opts: AssertPathOptions): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const { atom, arg, mode } = opts;

  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new PathContainmentError(`${atom}: ${arg} must be a non-empty path string.`);
  }

  if (!path.isAbsolute(candidate)) {
    throw new PathContainmentError(
      `path_not_absolute: ${atom}'s ${arg} must be an absolute path (got "${candidate}"). ` +
        `This server's working directory is the plugin cache, not your project, so a relative ` +
        `path would resolve somewhere unexpected.`,
    );
  }

  const resolved = resolveRealPath(candidate);

  if ((env.ACE_PATH_CONTAINMENT ?? '').toLowerCase() === 'off') {
    if (!killSwitchWarned) {
      killSwitchWarned = true;
      console.error(
        '[ace-path-containment] DISABLED via ACE_PATH_CONTAINMENT=off — local file paths ' +
          'passed to MCP atoms are UNCHECKED. Unset it as soon as the blocking flow is fixed ' +
          '(dimagi-internal/ace#1110).',
      );
    }
    return resolved;
  }

  // Deny beats allow: the crown jewels live inside directories that otherwise
  // have to be reachable.
  const base = path.basename(resolved);
  for (const { re, why } of DENIED_BASENAME_TESTS) {
    if (re.test(base)) {
      throw new PathContainmentError(
        `path_denied: ${atom}'s ${arg} refuses "${resolved}" — its filename matches a protected ` +
          `class (${why}). This is refused even inside an allowed root, and ACE_ALLOWED_FILE_ROOTS ` +
          `does not override it. If a legitimate flow needs this exact file, that is a design ` +
          `question for dimagi-internal/ace#1110, not a path to widen.`,
      );
    }
  }

  const segments = resolved.split(path.sep).filter(Boolean);
  for (const { segs, why } of DENIED_SEGMENTS) {
    for (let i = 0; i + segs.length <= segments.length; i++) {
      if (segs.every((s, j) => segments[i + j] === s)) {
        throw new PathContainmentError(
          `path_denied: ${atom}'s ${arg} refuses "${resolved}" — it is inside a protected ` +
            `directory (${segs.join('/')}: ${why}). Refused even inside an allowed root; ` +
            `ACE_ALLOWED_FILE_ROOTS does not override it.`,
        );
      }
    }
  }

  const roots = resolveAllowedRoots(env, home);
  if (roots.some((r) => isInside(r, resolved))) return resolved;

  throw new PathContainmentError(
    `path_outside_allowed_roots: ${atom}'s ${arg} may only ${mode} inside ACE's working roots. ` +
      `"${candidate}"${resolved === candidate ? '' : ` (resolves to "${resolved}")`} is outside them.\n` +
      `Allowed roots:\n${roots.map((r) => `  - ${r}`).join('\n')}\n` +
      `Stage the file in a temp directory instead (e.g. ${path.join(os.tmpdir(), 'ace-<purpose>', base)}). ` +
      `An operator can add a root with ACE_ALLOWED_FILE_ROOTS=/path/one:/path/two (extends, ` +
      `never replaces, the defaults). Rationale: dimagi-internal/ace#1110.`,
  );
}

/** Test seam — resets the once-per-process kill-switch warning. */
export function __resetKillSwitchWarningForTests(): void {
  killSwitchWarned = false;
}
