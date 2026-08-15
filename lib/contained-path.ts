/**
 * Containment checks for LLM-supplied file paths and artifact names.
 *
 * ace#1110 (2026-07-31 audit, F2/F4/F6/F7/F9/F10). MCP tool arguments come from
 * the ACE agent, which routinely ingests untrusted content — inbound email in
 * `/ace:turn`, Drive docs, OCS source material — while the MCP subprocesses
 * hold real production credentials. A prompt-injected agent therefore drives
 * these arguments directly.
 *
 * The headline sink is `drive_upload_binary`: an arbitrary local read, with an
 * optional `shareAnyoneWithLink: true` in the SAME call. One call reads
 * `.env` / `~/.ssh/id_*` / `gws-sa-key.json` and publishes it.
 * `assertParentOnSharedDrive` guards the DESTINATION; nothing guarded the
 * source. `ocs_upload_collection_files` is worse in one way — the secret lands
 * in a vector store and is retrievable later through an ordinary chat turn, so
 * it never appears in the stealing call's transcript at all.
 *
 * ## Why this ships the denylist and not the allowlist
 *
 * #1110 proposes root containment (`os.tmpdir()`, the opp working dir,
 * `$CLAUDE_PLUGIN_DATA`, `ACE_ARTIFACT_ROOT`) and says plainly that it needs
 * each caller's legitimate target dirs enumerated and a real Phase 3/6/7 run
 * before merge. That judgement is correct and is not something repo-only work
 * can settle: a blind allowlist that is one root short turns a security fix
 * into a Phase 3 outage, which is the #1026 lesson — a blocker that always
 * fires trains agents to route around it.
 *
 * The credential DENYLIST needs no such decision. No legitimate ACE flow uploads
 * a private key, a session jar, or a `.env` to Drive, OCS or HQ, so refusing
 * those cannot break a real flow no matter which roots turn out to be legitimate.
 * It also closes the specific exfil the audit is worried about. `assertContainedPath`
 * is implemented and tested here, ready to wire once the roots are enumerated
 * against a live run — deliberately not wired blindly.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';

export class PathContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathContainmentError';
  }
}

/**
 * Basenames that are credential material in every ACE deployment. Matched on
 * the FINAL path segment, case-insensitively, after symlink resolution — a
 * symlink named `photo.png` pointing at `id_rsa` is the obvious bypass.
 */
export const CREDENTIAL_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,              // .env, .env.local
  /(^|[.-])session.*\.json$/i,    // ocs-session-<team>.json, connect-session.json
  /-key\.json$/i,                 // gws-sa-key.json
  /^id_[a-z0-9]+$/i,              // id_rsa, id_ed25519 (public .pub is harmless but not needed)
  /\.pem$/i,
  /^credentials?(-.+)?\.json$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.git-credentials$/i,
];

/** Directories whose contents are credential material wholesale. */
export const CREDENTIAL_DIR_SEGMENTS: readonly string[] = ['.ssh', '.aws', '.gnupg'];

export interface CredentialCheckOpts {
  /** Named in the error so the operator knows which atom refused. */
  atom: string;
  /** Resolve symlinks before matching. Off only for unit tests over fake paths. */
  resolveSymlinks?: boolean;
}

/**
 * Refuse a path that is credential material, regardless of where it lives.
 *
 * Applies to BOTH reads and writes: reading exfiltrates, and writing clobbers
 * (`commcare_download_ccz`'s `write_to_path` can overwrite `.env` or a git hook).
 */
export function assertNotCredentialPath(p: string, opts: CredentialCheckOpts): void {
  const resolved = resolveForCheck(p, opts.resolveSymlinks !== false);

  // Check BOTH the literal path and the symlink-resolved one. Each catches
  // what the other misses: resolving unmasks a decoy name pointing at a secret,
  // while the literal form preserves a signal that resolving would erase — a
  // symlinked `.ssh` directory resolves to some innocuous-looking real path,
  // and the segment that told you what it was is gone.
  for (const candidate of new Set([path.resolve(p), resolved])) {
    const base = path.basename(candidate);
    for (const re of CREDENTIAL_BASENAME_PATTERNS) {
      if (re.test(base)) throw credentialRefusal(opts.atom, p, resolved, `basename matches ${re}`);
    }
    const segments = candidate.split(path.sep);
    for (const dir of CREDENTIAL_DIR_SEGMENTS) {
      if (segments.includes(dir)) {
        throw credentialRefusal(opts.atom, p, resolved, `path traverses ${dir}/`);
      }
    }
  }
}

function credentialRefusal(atom: string, given: string, resolved: string, why: string): PathContainmentError {
  const via = resolved !== given ? ` (resolves to ${resolved})` : '';
  return new PathContainmentError(
    `${atom}: refusing to touch "${given}"${via} — ${why}. ` +
      `Credential material is never a legitimate argument to this atom, and this ` +
      `atom's output is reachable by others (ace#1110). If you need this file's ` +
      `CONTENT for a legitimate reason, read it explicitly rather than routing it ` +
      `through an upload.`,
  );
}

/**
 * realpath when the file exists, so a symlink cannot disguise the target.
 * A path that does not exist yet — every write target — is normalised instead;
 * its parent is resolved when possible so `~/.ssh/../.ssh/x` still collapses.
 */
function resolveForCheck(p: string, resolveSymlinks: boolean): string {
  const abs = path.resolve(p);
  if (!resolveSymlinks) return abs;
  try {
    return realpathSync(abs);
  } catch {
    try {
      return path.join(realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

/**
 * Reject an artifact name that is anything other than a bare filename.
 *
 * `mcp/mobile/backends/cloud.ts` does `path.join(screenshotDir, art.name)` with
 * a name supplied by the REMOTE side, so a spoofed or MITM'd ace-web can write
 * outside the screenshot dir with `../`. No legitimate artifact name contains a
 * separator, which makes this one of the few sinks where the safe rule is
 * unambiguous and needs no roots decision.
 */
export function isSafeArtifactName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.includes('\0')) return false;
  if (path.isAbsolute(name)) return false;
  return path.basename(name) === name;
}

export interface ContainmentOpts {
  atom: string;
  resolveSymlinks?: boolean;
}

/**
 * Require `p` to sit under one of `roots`.
 *
 * Implemented and tested, wired only where the legitimate roots are already
 * unambiguous — see the module note. Comparison is on resolved paths with a
 * trailing separator, so `/tmp/ace-evil` does not pass as being under
 * `/tmp/ace`.
 */
export function assertContainedPath(p: string, roots: readonly string[], opts: ContainmentOpts): void {
  if (roots.length === 0) {
    throw new PathContainmentError(`${opts.atom}: no allowed roots configured — refusing "${p}".`);
  }
  const resolved = resolveForCheck(p, opts.resolveSymlinks !== false);
  const ok = roots.some((root) => {
    const r = resolveForCheck(root, opts.resolveSymlinks !== false);
    return resolved === r || resolved.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  });
  if (!ok) {
    throw new PathContainmentError(
      `${opts.atom}: "${p}" resolves to ${resolved}, which is outside every allowed root ` +
        `(${roots.join(', ')}). ace#1110.`,
    );
  }
}
