#!/usr/bin/env npx tsx
/**
 * Screen files that are about to be uploaded into an LLO- and FLW-facing OCS
 * RAG collection against the opp's LLO-facing deny list
 * (`inputs/confidentiality.yaml` → `llo_facing_deny_list`).
 *
 * WHY THIS IS A SCRIPT: the OCS upload paths download with
 * `drive_read_file({writeToPath})` so the bytes never enter the agent's
 * context, then hand the PATH to `ocs_upload_collection_files`. There is no
 * in-context text to grep, so the screen runs over the download directory, in
 * the same pass as `scripts/strip-inline-data-uris.ts` and
 * `scripts/redact-kb-answer-keys.ts`. See dimagi-internal/ace#3223 (repro:
 * `connect-fi/20261018-1440`, chatbot 14329 — every `inputs/` file and the
 * PDD named the confidential funder). Pure helpers:
 * `lib/llo-facing-deny-list.ts` (sibling of ace#3190).
 *
 * Usage:
 *   npx tsx scripts/screen-kb-deny-list.ts <confidentiality.yaml|none> <download-dir>
 *
 * Pass `none` as the first argument when the opp has no
 * `inputs/confidentiality.yaml`. Download the yaml OUTSIDE the download dir:
 * it names every deny-listed party, so inside the dir it would (correctly)
 * fail its own screen.
 *
 * Every regular file directly in the dir is screened as UTF-8 text. A file
 * that is not text (carries a NUL byte — a PDF, a docx) cannot be screened;
 * with a non-empty deny list it counts as a failure: upload a text extract
 * instead.
 *
 * Output (stdout): one JSON line —
 *   { deny_list_terms, note?, files: [{path, pass, hits, detail}], unscreened: [] }
 *
 * Exit codes: 0 clean (or no / empty deny list), 1 a deny-listed party is
 * named in some file (or a file could not be screened) — do NOT upload,
 * 2 harness error (bad args, missing/unreadable/malformed inputs).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkTextAgainstDenyList, parseConfidentialityYaml } from '../lib/llo-facing-deny-list.js';
import { findDenyListHits } from '../lib/synthetic-responses.js';

function die(msg: string, code: number): never {
  process.stderr.write(`screen-kb-deny-list: ${msg}\n`);
  process.exit(code);
}

function loadDenyList(arg: string): string[] | null {
  if (arg === 'none') return null;
  let text: string;
  try {
    text = readFileSync(resolve(arg), 'utf8');
  } catch (err) {
    die(`cannot read confidentiality yaml ${arg}: ${(err as Error).message}`, 2);
  }
  try {
    return parseConfidentialityYaml(text);
  } catch (err) {
    die(`malformed confidentiality yaml ${arg}: ${(err as Error).message}`, 2);
  }
}

function listFiles(dir: string): string[] {
  const abs = resolve(dir);
  let names: string[];
  try {
    if (!statSync(abs).isDirectory()) die(`not a directory: ${dir}`, 2);
    names = readdirSync(abs);
  } catch (err) {
    die(`cannot read download dir ${dir}: ${(err as Error).message}`, 2);
  }
  return names
    .map((name) => join(abs, name))
    .filter((p) => statSync(p).isFile())
    .sort();
}

function main(argv: string[]): void {
  if (argv.length !== 2) {
    die('usage: screen-kb-deny-list.ts <confidentiality.yaml|none> <download-dir>', 2);
  }
  const denyList = loadDenyList(argv[0]);
  const paths = listFiles(argv[1]);

  if (denyList === null || denyList.length === 0) {
    const note =
      denyList === null
        ? 'no inputs/confidentiality.yaml for this opp: nothing to screen'
        : 'confidentiality.yaml declares no llo_facing_deny_list entries: nothing to screen';
    process.stdout.write(
      JSON.stringify({ deny_list_terms: 0, note, files: paths.map((path) => ({ path, pass: true, hits: [] })), unscreened: [] }) + '\n',
    );
    return;
  }

  const files: Array<{ path: string; pass: boolean; hits: string[]; detail: string }> = [];
  const unscreened: string[] = [];
  for (const path of paths) {
    let buf: Buffer;
    try {
      buf = readFileSync(path);
    } catch (err) {
      die(`cannot read ${path}: ${(err as Error).message}`, 2);
    }
    if (buf.includes(0)) {
      unscreened.push(path);
      continue;
    }
    const text = buf.toString('utf8');
    const result = checkTextAgainstDenyList(text, denyList, path);
    files.push({ path, pass: result.pass, hits: findDenyListHits(text, denyList), detail: result.detail ?? "" });
  }

  process.stdout.write(JSON.stringify({ deny_list_terms: denyList.length, files, unscreened }) + '\n');

  const failed = files.filter((f) => !f.pass);
  for (const f of failed) {
    process.stderr.write(`screen-kb-deny-list: HIT ${f.path}: ${f.hits.map((h) => `"${h}"`).join(', ')}\n`);
  }
  for (const p of unscreened) {
    process.stderr.write(`screen-kb-deny-list: UNSCREENED (not text) ${p}: upload a text extract instead\n`);
  }
  if (failed.length > 0 || unscreened.length > 0) {
    die(
      `${failed.length} file(s) name a deny-listed party, ${unscreened.length} unscreenable — do NOT upload (ace#3223)`,
      1,
    );
  }
}

main(process.argv.slice(2));
