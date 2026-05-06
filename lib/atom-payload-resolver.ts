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
import { readFileSync } from 'node:fs';

export class AtomArgUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AtomArgUsageError';
  }
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
  if (file_bytes_path) return readFileSync(file_bytes_path);
  return Buffer.from(file_bytes_base64!, 'base64');
}
