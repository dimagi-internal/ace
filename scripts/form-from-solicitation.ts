#!/usr/bin/env npx tsx
/**
 * CLI over lib/form-from-solicitation.ts for `skills/solicitation-google-form`.
 * Reads JSON from a file, writes JSON to stdout. No network.
 *
 *   spec          --input <FormSpecInput.json>
 *                 → the forms_create_from_spec arguments ({name, title, description, items})
 *   question-map  --spec <FormSpec.json> --created <forms_create_from_spec result.json>
 *                 → {form_question_id: solicitation_question_id}
 *   import-plan   --input <{solicitation_id, questions, question_map, responses, already_imported}.json>
 *                 → {to_create, skipped, problems}
 *
 * Exit 0 on success. Exit 2 with {status: "fail", errors|message} on a refusal
 * (e.g. a deny-listed party in respondent-facing text). Exit 1 on usage errors.
 */

import { readFileSync } from 'node:fs';
import {
  FormSpecValidationError,
  buildFormSpec,
  buildQuestionMap,
  planImport,
} from '../lib/form-from-solicitation.js';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) {
    process.stderr.write(`missing --${name}\n`);
    process.exit(1);
  }
  return v;
}

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);

try {
  switch (process.argv[2]) {
    case 'spec':
      out(buildFormSpec(readJson(arg('input'))));
      break;
    case 'question-map': {
      const created = readJson(arg('created'));
      out(buildQuestionMap(readJson(arg('spec')), created.items ?? created));
      break;
    }
    case 'import-plan':
      out(planImport(readJson(arg('input'))));
      break;
    default:
      process.stderr.write('usage: form-from-solicitation.ts spec|question-map|import-plan …\n');
      process.exit(1);
  }
} catch (e) {
  if (e instanceof FormSpecValidationError) {
    out({ status: 'fail', errors: e.errors });
  } else {
    out({ status: 'fail', message: (e as Error).message });
  }
  process.exit(2);
}
