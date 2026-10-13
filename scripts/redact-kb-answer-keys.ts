#!/usr/bin/env npx tsx
/**
 * Redact assessment answer keys out of files that are about to be uploaded
 * into a worker-facing OCS RAG collection, in place.
 *
 * WHY THIS IS A SCRIPT: the OCS upload paths download with
 * `drive_read_file({writeToPath})` so the bytes never enter the agent's
 * context, then hand the PATH to `ocs_upload_collection_files`. There is no
 * in-context text for the agent to redact, so the redaction runs over the
 * download directory. Sibling of `scripts/strip-inline-data-uris.ts`
 * (ace#1827). See dimagi-internal/ace#2869; pure helper
 * `lib/kb-answer-key-redaction.ts`.
 *
 * Usage:
 *   npx tsx scripts/redact-kb-answer-keys.ts <file|dir> [...]
 *
 * A directory argument is walked one level deep for text files
 * (`.md`, `.txt`, `.markdown`); anything else is read as a file.
 *
 * Output (stdout): one JSON line —
 *   { files: [{path, redactions, sections_dropped}], residual: [] }
 *
 * Exit codes: 0 clean, 1 usage/IO error, 2 an answer key SURVIVED in some
 * file — do not upload (report it on ace#2869 with the file).
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { hasResidualAnswerKey, redactAnswerKeys } from '../lib/kb-answer-key-redaction.js';

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

function die(msg: string, code = 1): never {
  process.stderr.write(`redact-kb-answer-keys: ${msg}\n`);
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
  if (argv.length === 0) die('usage: redact-kb-answer-keys.ts <file|dir> [...]');

  const files: Array<{ path: string; redactions: number; sections_dropped: string[] }> = [];
  const residual: string[] = [];

  for (const target of argv.flatMap(expand)) {
    const before = readFileSync(target, 'utf8');
    const result = redactAnswerKeys(before);
    if (result.text !== before) writeFileSync(target, result.text, 'utf8');
    if (hasResidualAnswerKey(result.text)) residual.push(target);
    files.push({
      path: target,
      redactions: result.redactions.length,
      sections_dropped: result.redactions.filter((r) => r.kind === 'section').map((r) => r.detail),
    });
  }

  process.stdout.write(JSON.stringify({ files, residual }) + '\n');

  if (residual.length > 0) {
    die(`answer key survived in ${residual.length} file(s) — do NOT upload`, 2);
  }
}

main(process.argv.slice(2));
