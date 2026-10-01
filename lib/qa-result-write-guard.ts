//
// The ONE place every QA result passes through: the Drive write.
//
// Every `-qa` skill writes `<phase>/<producer>-qa_result.yaml` with
// `drive_create_file` or `drive_upload_binary`. Two skills hand-rolled their
// own shapes — `demo-data-setup-qa` on bednet-check-2-visit/20260908-1544
// (`checks_total` / `checks[]`), `semantic-registry-author-qa` on
// spark-facilitator/20260926-1800 (`findings[]`, no `stats`) — and ace-web,
// which reads `stats.checks_run`, displayed both as "Passed (0/0 checks)".
// Writing a convention into thirteen skill bodies is how that happened; a
// refusal at the write is what makes it hold. `qaResultWriteRefusal` runs the
// canonical validator (`validateQAResult` — counts that add up, and no pass
// with 0 checks run) over the bytes about to be written, keyed on the file
// NAME, and the two atoms refuse the write when it says no.
//
// Build the file with `scripts/qa-result.ts` (`aggregateQAResult`) and it
// always passes.

import { parse as parseYaml } from 'yaml';
import { validateQAResult } from './qa-types.js';

export const QA_RESULT_NAME = /-qa_result\.ya?ml$/i;

/** null ⇒ write allowed; else the refusal message (INVALID_QA_RESULT …). */
export function qaResultWriteRefusal(name: string, text: string): string | null {
  if (!QA_RESULT_NAME.test(name ?? '')) return null;
  let data: unknown;
  try {
    data = parseYaml(String(text ?? '').replace(/\r\n/g, '\n'));
  } catch (e) {
    return refusal(name, [`does not parse as YAML: ${(e as Error).message}`]);
  }
  try {
    validateQAResult(data);
    return null;
  } catch (e) {
    const issues = (e as { issues?: Array<{ path: (string | number)[]; message: string }> }).issues;
    return refusal(
      name,
      issues?.length ? issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) : [(e as Error).message],
    );
  }
}

function refusal(name: string, problems: string[]): string {
  return (
    `INVALID_QA_RESULT: ${name} is not a lib/qa-types.ts QA result — ${problems.join('; ')}. ` +
    'Nothing was written. Build it with scripts/qa-result.ts (aggregateQAResult): it derives ' +
    'stats from the check outcomes and fails a result that evaluated nothing. A hand-written ' +
    'shape reads as "Passed (0/0 checks)" on ace-web.'
  );
}
