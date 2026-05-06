// scripts/run-xform-patch.ts
//
// CLI wrapper around lib/multimedia-xform-patch.ts::addImageItext so
// the app-multimedia-coverage skill (a prompt) can invoke form-XML
// patching via Bash.
//
// Usage:
//   npx tsx scripts/run-xform-patch.ts <form.xml> <bindings.json> [--replace-existing] [-o <out.xml>]
//
// Where <bindings.json> is:
//   [{ "fieldId": "...", "cczFilename": "..." }, ...]
//
// Writes the patched XML to <out.xml> if -o is given, or to stdout
// otherwise. Writes a JSON summary line to stderr:
//   { patched, applied, skipped, notFound }
//
// Stdout is reserved for the patched XML so callers can pipe it
// straight into commcare_patch_xform.

import { readFileSync, writeFileSync } from 'node:fs';
import { addImageItext, type ImageBinding } from '../lib/multimedia-xform-patch.js';

function main(): number {
  const args = process.argv.slice(2);
  let formPath: string | undefined;
  let bindingsPath: string | undefined;
  let outPath: string | undefined;
  let replaceExisting = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--replace-existing') {
      replaceExisting = true;
    } else if (a === '-o') {
      outPath = args[++i];
    } else if (!formPath) {
      formPath = a;
    } else if (!bindingsPath) {
      bindingsPath = a;
    } else {
      console.error(`Unrecognized argument: ${a}`);
      return 1;
    }
  }

  if (!formPath || !bindingsPath) {
    console.error(
      'Usage: npx tsx scripts/run-xform-patch.ts <form.xml> <bindings.json> [--replace-existing] [-o <out.xml>]',
    );
    return 1;
  }

  let xml: string;
  try {
    xml = readFileSync(formPath, 'utf-8');
  } catch (e) {
    console.error(`Failed to read form XML at ${formPath}: ${(e as Error).message}`);
    return 2;
  }

  let bindings: ImageBinding[];
  try {
    const raw = JSON.parse(readFileSync(bindingsPath, 'utf-8'));
    if (!Array.isArray(raw)) throw new Error('bindings.json must be a JSON array');
    bindings = raw.map((b: unknown, i: number) => {
      const r = b as { fieldId?: unknown; cczFilename?: unknown };
      if (typeof r?.fieldId !== 'string' || typeof r?.cczFilename !== 'string') {
        throw new Error(`bindings[${i}] must have string fieldId and cczFilename`);
      }
      return { fieldId: r.fieldId, cczFilename: r.cczFilename };
    });
  } catch (e) {
    console.error(`Failed to read/parse ${bindingsPath}: ${(e as Error).message}`);
    return 2;
  }

  const result = addImageItext(xml, bindings, { replaceExisting });

  if (outPath) {
    writeFileSync(outPath, result.xml);
  } else {
    process.stdout.write(result.xml);
  }
  process.stderr.write(
    JSON.stringify({
      patched: result.patched,
      applied: result.applied,
      skipped: result.skipped,
      notFound: result.notFound,
    }) + '\n',
  );
  return 0;
}

process.exit(main());
