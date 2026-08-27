#!/usr/bin/env npx tsx
/**
 * Classify an opp's `inputs/media/` folder listing into attachable assets,
 * guidance documents, and everything we could not use.
 *
 * The skill obtains the listing with `drive_list_folder` and writes it to a
 * file; this wrapper turns it into the classification `app-media-coverage`
 * acts on. Keeping it out-of-band means the folder listing never has to be
 * reasoned about inline, and the classification rules stay unit-tested
 * (`lib/media-guidance.test.ts`) rather than re-derived per run.
 *
 * Usage:
 *   npx tsx scripts/run-media-classify.ts <listing.json> [--out <path>]
 *   cat listing.json | npx tsx scripts/run-media-classify.ts -
 *
 * Input: either a bare JSON array of Drive entries, or the object
 * `drive_list_folder` returns (`{files: [...]}` / `{entries: [...]}`).
 * Each entry needs `name` plus one of `id`/`file_id`, and a mime type under
 * `mimeType`/`mime_type`.
 *
 * Output (stdout, or `--out`): the MediaFolderClassification as JSON.
 * Exit codes: 0 classified, 1 usage/parse error.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { classifyMediaFolder, type DriveEntry } from '../lib/media-guidance.js';

function die(msg: string): never {
  process.stderr.write(`run-media-classify: ${msg}\n`);
  process.exit(1);
}

function readInput(path: string): string {
  if (path === '-') return readFileSync(0, 'utf-8');
  try {
    return readFileSync(path, 'utf-8');
  } catch (e) {
    die(`cannot read ${path}: ${(e as Error).message}`);
  }
}

/** Accepts the several shapes a Drive listing arrives in. */
function toEntries(raw: unknown): DriveEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown>)?.files ??
       (raw as Record<string, unknown>)?.entries ??
       (raw as Record<string, unknown>)?.children);
  if (!Array.isArray(list)) {
    die('expected a JSON array of Drive entries, or an object with files/entries/children');
  }
  return list.map((r: Record<string, unknown>, i) => {
    const name = r.name ?? r.title;
    const id = r.file_id ?? r.id ?? r.fileId;
    if (typeof name !== 'string' || typeof id !== 'string') {
      die(`entry ${i} needs a string name and id (saw ${JSON.stringify(r).slice(0, 120)})`);
    }
    const shortcut = (r.shortcutDetails ?? {}) as Record<string, unknown>;
    return {
      file_id: id,
      name,
      mime_type: String(r.mime_type ?? r.mimeType ?? 'application/octet-stream'),
      resolved_target_id: (r.resolved_target_id ?? shortcut.targetId) as string | undefined,
      resolved_target_mime_type: (r.resolved_target_mime_type ?? shortcut.targetMimeType) as
        | string
        | undefined,
    };
  });
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  process.stderr.write(
    'usage: run-media-classify.ts <listing.json|-> [--out <path>]\n',
  );
  process.exit(argv.length === 0 ? 1 : 0);
}

const outIdx = argv.indexOf('--out');
const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;
if (outIdx >= 0 && !outPath) die('--out needs a path');

let parsed: unknown;
try {
  parsed = JSON.parse(readInput(argv[0]));
} catch (e) {
  die(`input is not valid JSON: ${(e as Error).message}`);
}

const classification = classifyMediaFolder(toEntries(parsed));
const json = JSON.stringify(classification, null, 2);

if (outPath) {
  writeFileSync(outPath, `${json}\n`);
  process.stderr.write(
    `classified ${classification.assets.length} asset(s), ` +
      `${classification.guidance.length} guidance doc(s), ` +
      `${classification.unsupported.length} unsupported, ` +
      `${classification.ignored.length} ignored → ${outPath}\n`,
  );
} else {
  process.stdout.write(`${json}\n`);
}
