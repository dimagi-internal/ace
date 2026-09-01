#!/usr/bin/env npx tsx
/**
 * Strip embedded `data:` payloads out of files that are about to be uploaded
 * into an OCS RAG collection, in place.
 *
 * WHY THIS IS A SCRIPT AND NOT A LINE OF PROSE: both OCS upload paths download
 * their documents with `drive_read_file({writeToPath})` precisely so the bytes
 * never enter the agent's context, then hand the PATH to
 * `ocs_upload_collection_files`. There is therefore no point at which a skill
 * could strip the payload in-context even if it remembered to — the fix has to
 * operate on the files on disk, in one call over the whole download directory.
 * See dimagi-internal/ace#1827.
 *
 * Usage:
 *   npx tsx scripts/strip-inline-data-uris.ts <file|dir> [...]
 *
 * A directory argument is walked one level deep for text files
 * (`.md`, `.txt`, `.markdown`); anything else is read as a file.
 *
 * Output (stdout): one JSON line —
 *   { files: [{path, bytes_before, bytes_after, payloads_stripped}],
 *     total_bytes_before, total_bytes_after, residual: [] }
 *
 * Exit codes: 0 clean, 1 usage/IO error, 2 a `base64,` payload SURVIVED the
 * strip in some file — do not upload, the shape is one this script does not
 * know about (report it on ace#1827 with the file).
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { hasResidualDataUri, stripInlineDataUris } from '../lib/inline-data-uri.js';

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

function die(msg: string, code = 1): never {
  process.stderr.write(`strip-inline-data-uris: ${msg}\n`);
  process.exit(code);
}

function expand(arg: string): string[] {
  const abs = resolve(arg);
  let st;
  try {
    st = statSync(abs);
  } catch {
    die(`no such path: ${arg}`);
  }
  if (!st.isDirectory()) return [abs];
  return readdirSync(abs)
    .map((name) => join(abs, name))
    .filter((p) => statSync(p).isFile() && TEXT_EXTENSIONS.has(extname(p).toLowerCase()))
    .sort();
}

function main(argv: string[]): void {
  if (argv.length === 0) die('usage: strip-inline-data-uris.ts <file|dir> [...]');

  const files: Array<{
    path: string;
    bytes_before: number;
    bytes_after: number;
    payloads_stripped: number;
  }> = [];
  const residual: string[] = [];

  for (const target of argv.flatMap(expand)) {
    const before = readFileSync(target, 'utf8');
    const result = stripInlineDataUris(before);
    if (result.stripped.length > 0) writeFileSync(target, result.text, 'utf8');
    if (hasResidualDataUri(result.text)) residual.push(target);
    files.push({
      path: target,
      bytes_before: result.bytesBefore,
      bytes_after: result.bytesAfter,
      payloads_stripped: result.stripped.length,
    });
  }

  process.stdout.write(
    JSON.stringify({
      files,
      total_bytes_before: files.reduce((n, f) => n + f.bytes_before, 0),
      total_bytes_after: files.reduce((n, f) => n + f.bytes_after, 0),
      residual,
    }) + '\n'
  );

  if (residual.length > 0) {
    die(`base64 payload survived in ${residual.length} file(s) — do NOT upload`, 2);
  }
}

main(process.argv.slice(2));
