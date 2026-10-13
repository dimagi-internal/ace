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

import { parse as parseYaml, parseAllDocuments } from 'yaml';
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

// ---------------------------------------------------------------------------
// Eval verdicts — the same seam, a narrower rule
// ---------------------------------------------------------------------------

export const VERDICT_NAME = /_verdict(?:-[a-z0-9]+)?\.ya?ml$/i;

/**
 * A verdict file must at least BE YAML a strict reader accepts, as a mapping
 * with a `verdict`. spark-facilitator/20260926-1800's
 * `pdd-to-learn-app-eval_verdict.yaml` repeats a key (line 105): ace-web's
 * Python reader silently keeps the last value, the plugin's reader rejects the
 * file, and the two disagree about what was graded. Shape beyond that stays
 * with `lib/verdict-schema.ts`'s own validators — this is the write-time floor.
 */
export function verdictWriteRefusal(name: string, text: string): string | null {
  if (!VERDICT_NAME.test(name ?? '')) return null;
  let data: unknown;
  try {
    data = parseYaml(String(text ?? '').replace(/\r\n/g, '\n'));
  } catch (e) {
    return `INVALID_VERDICT: ${name} is not valid YAML — ${(e as Error).message.split('\n')[0]}. Nothing was written. Serialize the verdict (yaml.stringify / scripts) rather than typing it; a duplicated key is read differently by different readers.`;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('verdict' in (data as object))) {
    return `INVALID_VERDICT: ${name} is not a verdict mapping with a \`verdict\` field (lib/verdict-schema.ts). Nothing was written.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The floor under both of the above: a .yaml file must BE YAML
// ---------------------------------------------------------------------------

export const YAML_NAME = /\.ya?ml$/i;

/**
 * Any file ACE writes with a `.yaml` / `.yml` name must parse.
 *
 * The two guards above cover `-qa_result.yaml` and `*_verdict.yaml` because
 * those have a SHAPE worth checking. Every other YAML artifact had nothing at
 * all — and the ones with no shape check are the load-bearing ones:
 * `opp.yaml`, `run_state.yaml`, `decisions.yaml`. `update_yaml_file` is
 * read-parse-merge-write, so an unparseable file is not merely wrong, it is
 * UNWRITABLE by the documented path.
 *
 * Observed on turmeric-market-study-ghana (dimagi-internal/ace#2866). A
 * hand-authored `opp.yaml` carried a `notes:` item whose prose first line
 * ended in a colon:
 *
 *     notes:
 *       - No connect.program is recorded here on purpose. Phase 4 must CREATE one:
 *         country, currency and delivery_type are create-time-only on a Connect
 *
 * The trailing `:` makes the parser read the line as an implicit mapping key
 * and the continuation line then fails. Nothing checked it at write time and
 * nothing checks it at read time, so it stayed invisible until Phase 4 tried
 * to record `connect.program` — the opp's only durable cross-run Connect
 * reference — and got `Implicit keys need to be on a single line at line 19`.
 * A later run would have re-read the file, found no `connect.program`, and
 * created a SECOND programme.
 *
 * This is the same hazard class `update_yaml_file` already defends against on
 * its own writes (YAML-1.1-safe serialization, ace#2296) — that protection
 * covers the SERIALIZER, and these artifacts are authored as raw text through
 * `drive_create_file` / `drive_update_file` / `drive_upload_binary`, which
 * bypass it entirely. A detector at the read boundary would only name the
 * damage; this makes emitting it impossible.
 *
 * Deliberately only a PARSE check. Top-level shape is not asserted here — a
 * `.yaml` artifact is legitimately a mapping in some places and a sequence in
 * others, and over-reaching would refuse writes that are fine. Multi-document
 * YAML is accepted (`parseAllDocuments`), so a `---`-separated file is not a
 * false refusal.
 */
export function yamlParseWriteRefusal(name: string, text: string): string | null {
  if (!YAML_NAME.test(name ?? '')) return null;
  const body = String(text ?? '').replace(/\r\n/g, '\n');
  let problem: string | undefined;
  try {
    const docs = parseAllDocuments(body);
    const firstError = docs.flatMap((d) => d.errors ?? [])[0];
    if (firstError) problem = firstError.message;
  } catch (e) {
    problem = (e as Error).message;
  }
  if (!problem) return null;

  const firstLine = problem.split('\n')[0];
  // Grounded hint for the one shape that has actually been observed. Any other
  // syntax error gets the generic remedy, which is correct for all of them.
  const hint = /implicit key/i.test(problem)
    ? ' This is usually a PROSE line ending in a colon (`- ... must CREATE one:`), which YAML reads ' +
      'as an implicit mapping key — quote the whole scalar, or drop the trailing colon.'
    : '';
  return (
    `INVALID_YAML: ${name} does not parse as YAML — ${firstLine}. Nothing was written.${hint} ` +
    'Serialize the document (`yaml.stringify`, or `update_yaml_file`, which serializes 1.1-safely) ' +
    'rather than hand-authoring the text; an unparseable state file is unreadable AND unwritable, ' +
    'because update_yaml_file is read-parse-merge-write (ace#2866).'
  );
}
