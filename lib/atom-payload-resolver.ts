/**
 * Tiny pure helpers for resolving "inline OR file-path" args on MCP atoms.
 *
 * Background: a few CCHQ atoms (`commcare_patch_xform`,
 * `commcare_upload_multimedia`) take big payloads — 12K+ XForm XML or
 * ~1.6 MB base64 PNGs — that blow past practical tool-call arg-size
 * limits in some harnesses. We added an alternative file-path arg next
 * to each inline arg: callers pass *exactly one*. These helpers
 * encapsulate the "exactly one" rule plus the on-disk read so the
 * server.tool() handlers in `mcp/connect-server.ts` are tiny one-liners
 * and the contract is unit-testable without spinning up MCP plumbing.
 *
 * Shipped 0.13.29 alongside the atom signatures.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { assertNotCredentialPath } from './contained-path.js';
import { dirname, isAbsolute } from 'node:path';

export class AtomArgUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AtomArgUsageError';
  }
}

/**
 * Inline-content ceiling for `drive_update_file` (characters). Mirrors
 * `drive_read_file`'s inline refusal so the read and write halves of a
 * read-modify-write have symmetric context costs: above this, callers must
 * use `localFilePath`, which costs ~zero context regardless of file size
 * (dimagi-internal/ace#1218).
 */
export const UPDATE_FILE_INLINE_CEILING = 40_000;

/**
 * Resolve the text payload for `drive_update_file` — either the inline
 * `content` string or the file at `localFilePath` (utf-8), never both,
 * never neither. Inline content above {@link UPDATE_FILE_INLINE_CEILING}
 * is refused with a typed error pointing at `localFilePath`, so the
 * expensive path is loud rather than the silent default.
 *
 * @throws AtomArgUsageError when the caller violates the contract.
 */
export function resolveUpdateFileContent(args: {
  content?: string;
  localFilePath?: string;
}): string {
  return resolveInlineOrLocalFile({
    atom: 'drive_update_file',
    inlineParam: 'content',
    inline: args.content,
    localFilePath: args.localFilePath,
    inlineCeiling: UPDATE_FILE_INLINE_CEILING,
  });
}

/**
 * The general form of "exactly one of an inline payload or a local file
 * path", shared by every text-payload write atom in the plugin.
 *
 * Extracted from `resolveUpdateFileContent` (dimagi-internal/ace#1780) so the
 * gdrive CREATE atoms can offer the same handle their sibling
 * `drive_update_file` and `drive_upload_binary` already do, under the SAME
 * param name. `localFilePath` is the established write-side name family; a
 * third name for the same idea (`fromPath`, `sourcePath`, …) makes the
 * pairing unguessable, which is its own defect.
 *
 * `inlineCeiling` is OPTIONAL and deliberately unset for the create atoms.
 * The handle is purely additive — no existing caller changes behaviour — but
 * a refusal changes the contract for every existing caller, and a threshold
 * chosen wrong breaks skills that work today. Adding one is tracked
 * separately so the number can be picked against measured payload sizes
 * rather than guessed.
 *
 * @throws AtomArgUsageError when the caller violates the contract.
 */
export function resolveInlineOrLocalFile(args: {
  /** Atom name, used in every error message. */
  atom: string;
  /** The name of this atom's inline param (`content`, `markdown`, …). */
  inlineParam: string;
  inline?: string;
  localFilePath?: string;
  /** When set, an inline payload longer than this is refused. */
  inlineCeiling?: number;
}): string {
  const { atom, inlineParam, inline, localFilePath, inlineCeiling } = args;
  if (inline !== undefined && localFilePath !== undefined) {
    throw new AtomArgUsageError(
      `${atom}: pass exactly one of ${inlineParam} or localFilePath, not both`,
    );
  }
  if (inline === undefined && localFilePath === undefined) {
    throw new AtomArgUsageError(
      `${atom}: must supply one of ${inlineParam} or localFilePath`,
    );
  }
  if (localFilePath !== undefined) {
    // ace#1110 F2: an arbitrary local read reaching a Drive file.
    assertNotCredentialPath(localFilePath, { atom });
    return readFileSync(localFilePath, 'utf-8');
  }
  if (inlineCeiling !== undefined && inline!.length > inlineCeiling) {
    throw new AtomArgUsageError(
      `oversized_inline_content: ${inlineParam} is ${inline!.length} chars (ceiling ${inlineCeiling}). ` +
        `Write it to a local file and pass localFilePath instead — the server reads the bytes off disk, ` +
        `so the update costs ~zero context regardless of file size.`,
    );
  }
  return inline!;
}

/**
 * Validate + prepare a caller-supplied write path: require an absolute path
 * (the MCP server's CWD is the plugin cache, not the caller's project, so a
 * relative path writes somewhere unexpected) and create missing parent
 * directories. Returns the path unchanged so call sites can inline it:
 * `writeFileSync(prepareWritePath(p), buf)`.
 *
 * Exists so every write-path param in the plugin behaves like
 * `drive_read_file`'s `writeToPath` (which documents "missing parent
 * directories are created") — `commcare_download_ccz`'s `write_to_path`
 * threw a bare ENOENT instead, on the exact chain `app-release-qa`
 * prescribes into a fresh scratch dir (dimagi-internal/ace#1247, absorbed
 * into #1218).
 *
 * @throws AtomArgUsageError on a relative path.
 */
export function prepareWritePath(p: string): string {
  // ace#1110 F4: an arbitrary OVERWRITE — clobber .zshrc, a git hook, or .env.
  assertNotCredentialPath(p, { atom: 'commcare_download_ccz' });
  if (!isAbsolute(p)) {
    throw new AtomArgUsageError(
      `write_path_not_absolute: expected an absolute path (got "${p}"). ` +
        `This server's working directory is the plugin cache, not your project, ` +
        `so a relative path would write somewhere unexpected.`,
    );
  }
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

/**
 * Resolve the XForm XML payload for `commcare_patch_xform` — either the
 * inline `new_xform_xml` string or the file at `new_xform_xml_path`,
 * never both, never neither.
 *
 * @throws AtomArgUsageError when the caller violates the contract.
 */
export function resolvePatchXformXml(args: {
  new_xform_xml?: string;
  new_xform_xml_path?: string;
}): string {
  const { new_xform_xml, new_xform_xml_path } = args;
  if (new_xform_xml && new_xform_xml_path) {
    throw new AtomArgUsageError(
      'commcare_patch_xform: pass exactly one of new_xform_xml or new_xform_xml_path, not both',
    );
  }
  if (!new_xform_xml && !new_xform_xml_path) {
    throw new AtomArgUsageError(
      'commcare_patch_xform: must supply one of new_xform_xml or new_xform_xml_path',
    );
  }
  if (new_xform_xml) return new_xform_xml;
  // ace#1110 F7: an arbitrary read landing in an app's XForm source on prod HQ.
  assertNotCredentialPath(new_xform_xml_path!, { atom: 'commcare_patch_xform' });
  return readFileSync(new_xform_xml_path!, 'utf-8');
}

/**
 * Resolve the binary payload for `commcare_upload_multimedia` — either
 * the inline `file_bytes_base64` string or the file at `file_bytes_path`,
 * never both, never neither.
 *
 * @throws AtomArgUsageError when the caller violates the contract.
 */
export function resolveUploadMultimediaBytes(args: {
  file_bytes_base64?: string;
  file_bytes_path?: string;
}): Buffer {
  const { file_bytes_base64, file_bytes_path } = args;
  if (file_bytes_base64 && file_bytes_path) {
    throw new AtomArgUsageError(
      'commcare_upload_multimedia: pass exactly one of file_bytes_base64 or file_bytes_path, not both',
    );
  }
  if (!file_bytes_base64 && !file_bytes_path) {
    throw new AtomArgUsageError(
      'commcare_upload_multimedia: must supply one of file_bytes_base64 or file_bytes_path',
    );
  }
  if (file_bytes_path) {
    // ace#1110 F6: an arbitrary read landing in HQ multimedia, which
    // `download_ccz include_multimedia` can pull back out.
    assertNotCredentialPath(file_bytes_path, { atom: 'commcare_upload_multimedia' });
    return readFileSync(file_bytes_path);
  }
  return Buffer.from(file_bytes_base64!, 'base64');
}

/**
 * Substitute `${VAR}` patterns with values from `env` (defaults to
 * `process.env`). Returns the resolved string. Used by atoms that take
 * secrets as args — e.g. `connect_create_opportunity.learn_app.api_key`
 * — so callers can pass `${ACE_HQ_API_KEY}` literally instead of having
 * to expand env vars in their own composition layer.
 *
 * Behavior:
 *   - `${VAR}` → `env.VAR` if defined, else `${VAR}` is left intact and
 *     the function throws `AtomArgUsageError` (so an unset env var is a
 *     loud failure, not a silent empty string).
 *   - `\${VAR}` → literal `${VAR}` (escape hatch when callers actually
 *     mean the literal sequence).
 *   - non-`${VAR}` strings pass through unchanged.
 *
 * Issue tracking: jjackson/ace#106 finding 6 — atoms used to send
 * `${ACE_HQ_API_KEY}` verbatim to Connect, which surfaced as the
 * unhelpful "Failed to fetch apps from CommCare HQ" error.
 *
 * SECURITY — `allow` allowlist (security audit 2026-07-31): the MCP server
 * process holds the WHOLE `.env` (`ACE_HQ_PASSWORD`, `LABS_MCP_TOKEN`,
 * `OCS_API_TOKEN*`, `ACE_WEB_PAT_TOKEN`, the SA key path, …). Without a
 * restriction, a tool argument reaching this helper can name ANY of those
 * — e.g. a prompt-injected agent passing `${LABS_MCP_TOKEN}` as an
 * `api_key` or a `phone_number` — and the resolved SECRET is shipped
 * outbound to whatever endpoint the atom talks to. The model never has to
 * *see* the secret (it only names the variable), so no transcript scan
 * catches it. `allow` narrows substitution to the small set of vars a given
 * field legitimately references; a `${VAR}` naming anything else is a loud
 * `AtomArgUsageError`, not a silent secret expansion. When `allow` is
 * omitted the legacy behavior (any UPPER_SNAKE var) is kept for back-compat,
 * so EVERY call site that forwards its result outbound MUST pass an `allow`.
 */
export function resolveEnvSubstitution(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  allow?: RegExp | readonly string[],
): string {
  if (typeof value !== 'string' || !value.includes('$')) return value;
  const isAllowed = (name: string): boolean =>
    allow == null ? true : allow instanceof RegExp ? allow.test(name) : allow.includes(name);
  // Replace escape sequences first with a sentinel so the next regex
  // doesn't see them.
  const ESCAPE_SENTINEL = '\u0001\u0002';
  const escaped = value.replace(/\\\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, name) => `${ESCAPE_SENTINEL}${name}}`);
  const missing: string[] = [];
  const denied: string[] = [];
  const resolved = escaped.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, name) => {
    if (!isAllowed(name)) {
      denied.push(name);
      return _m;
    }
    const v = env[name];
    if (v == null || v === '') {
      missing.push(name);
      return _m;
    }
    return v;
  });
  if (denied.length > 0) {
    // Only the rejected variable NAMES are echoed — never the resolved value.
    throw new AtomArgUsageError(
      `env var substitution rejected for this argument: ${denied.join(', ')}. ` +
        `Only a specific allowlist of variables may be expanded into this field ` +
        `(the HQ API key / username, or a test phone number). Expanding an ` +
        `arbitrary \${VAR} here would transmit a secret the field is not meant to carry.`,
    );
  }
  if (missing.length > 0) {
    throw new AtomArgUsageError(
      `env var(s) not set in MCP server process: ${missing.join(', ')}. ` +
        `Either set them in $CLAUDE_PLUGIN_DATA/.env (visible to the server) ` +
        `or expand the value in the calling skill before invoking the atom.`,
    );
  }
  return resolved.replace(new RegExp(`${ESCAPE_SENTINEL}([A-Z_][A-Z0-9_]*)\\}`, 'g'), '${$1}');
}

/**
 * Allowlists for the fields that call {@link resolveEnvSubstitution} on
 * outbound-bound tool arguments. Each permits ONLY the variable family the
 * field legitimately references — the `_[A-Z0-9]+_` optional segment covers
 * the multi-cluster forms (`ACE_HQ_US_API_KEY`, `ACE_HQ_EU_USERNAME`, …).
 * Anything else (passwords, tokens, SA creds) is rejected.
 */
export const ENV_ALLOW = {
  /** CCHQ REST API key fields. */
  hqApiKey: /^ACE_HQ(?:_[A-Z0-9]+)?_API_KEY$/,
  /** CCHQ username fields. */
  hqUsername: /^ACE_HQ(?:_[A-Z0-9]+)?_USERNAME$/,
  /** Test-worker phone-number fields. */
  e2ePhone: /^ACE_E2E_PHONE(?:_LOCAL)?$/,
} as const;
