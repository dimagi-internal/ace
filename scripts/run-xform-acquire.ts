// scripts/run-xform-acquire.ts
//
// CLI wrapper around lib/xform-acquire.ts::addAcquireAppearance so
// `app-hq-settings` § Step 3 (a prompt) can perform the camera-only edit
// ON DISK, via Bash, without the XForm ever entering the model context.
//
// The point of the pairing (ace#1795):
//
//   commcare_get_form_source({ ..., write_to_path: "$D/f.xml" })   # zero context
//   npx tsx scripts/run-xform-acquire.ts "$D/f.xml" -o "$D/f.patched.xml"
//   commcare_patch_xform({ ..., new_xform_xml_path: "$D/f.patched.xml", sha1 })
//
// Sibling of scripts/run-xform-patch.ts (the multimedia-itext patcher), and
// deliberately the same shape: XML on stdout unless -o, JSON summary on stderr.
//
// Usage:
//   npx tsx scripts/run-xform-acquire.ts <form.xml> [-o <out.xml>]
//
// Exit codes:
//   0  clean — patched, or already fully `acquire` (idempotent no-op)
//   1  argument / usage error
//   2  could not read the input form
//   3  at least one image <upload> carries a CONFLICTING appearance hint.
//      Nothing is written; the caller halts that form and surfaces the value
//      rather than clobbering a deliberate appearance.

import { readFileSync, writeFileSync } from 'node:fs';
import { addAcquireAppearance } from '../lib/xform-acquire.js';

function main(): number {
  const args = process.argv.slice(2);
  let formPath: string | undefined;
  let outPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o') {
      outPath = args[++i];
    } else if (!formPath) {
      formPath = a;
    } else {
      console.error(`Unrecognized argument: ${a}`);
      return 1;
    }
  }

  if (!formPath) {
    console.error('Usage: npx tsx scripts/run-xform-acquire.ts <form.xml> [-o <out.xml>]');
    return 1;
  }

  let xml: string;
  try {
    xml = readFileSync(formPath, 'utf-8');
  } catch (e) {
    console.error(`Failed to read form XML at ${formPath}: ${(e as Error).message}`);
    return 2;
  }

  const res = addAcquireAppearance(xml);

  if (res.conflicts.length > 0) {
    console.error(
      JSON.stringify({
        patched: false,
        applied: res.applied,
        alreadyAcquire: res.alreadyAcquire,
        conflicts: res.conflicts,
        nonImageUploads: res.nonImageUploads,
        error:
          'conflicting_appearance: at least one image <upload> already declares a non-acquire ' +
          'appearance hint. Refusing to clobber a deliberate appearance — halt this form and ' +
          'surface the observed value (app-hq-settings § Step 3).',
      }),
    );
    return 3;
  }

  if (outPath) {
    writeFileSync(outPath, res.xml, 'utf-8');
  } else {
    process.stdout.write(res.xml);
  }

  console.error(
    JSON.stringify({
      patched: res.patched,
      applied: res.applied,
      alreadyAcquire: res.alreadyAcquire,
      conflicts: res.conflicts,
      nonImageUploads: res.nonImageUploads,
      wrote: outPath ?? '<stdout>',
    }),
  );
  return 0;
}

process.exit(main());
