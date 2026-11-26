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
import { parseDecisionOverridesYaml } from './decision-overrides.js';
import { parseOperatorRulingsYaml } from './operator-rulings.js';
import { kebabFeedbackRef } from './feedback-ledger.js';

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

// ---------------------------------------------------------------------------
// The two opp-level ruling stores — a SHAPE the parse floor cannot see
// ---------------------------------------------------------------------------

/**
 * `<opp>/inputs/decision-overrides.yaml` — saved reviewer rulings.
 * `<opp>/inputs/operator-rulings.yaml` — per-opp operator rulings.
 *
 * Matched on the BASENAME so a path-qualified name (`inputs/…`) is caught too.
 */
export const DECISION_OVERRIDES_WRITE_NAME = /(?:^|\/)decision-overrides\.ya?ml$/i;
export const OPERATOR_RULINGS_WRITE_NAME = /(?:^|\/)operator-rulings\.ya?ml$/i;

/**
 * null ⇒ write allowed; else the refusal (INVALID_DECISION_OVERRIDES … /
 * INVALID_OPERATOR_RULINGS …).
 *
 * ## Why these two files need a guard the parse floor cannot give them
 *
 * Live incident, `accra-vendor-survey` / `20261125-1637`, Phase 1 blocked
 * 2026-11-26. The opp was stood up fresh carrying eleven operator rulings
 * forwarded from the prior run. One row bound its ruling to a key of that
 * run's `run_state.yaml` and kept the YAML key's underscores:
 *
 *     feedback_ref: 20261013-2314-run_state/blockers_for_operator
 *
 * `DecisionOverrideRowSchema.feedback_ref` is kebab-case on both sides of the
 * slash. The file still PARSES, so `yamlParseWriteRefusal` waved it through,
 * and the only reader that checks the shape — `parseDecisionOverridesYaml`,
 * at the decisions write boundary — does not run until a phase writes a
 * decision. By design that reader is ALL-OR-NOTHING (`lib/decision-overrides.ts`:
 * a malformed file means a reviewer's saved intent would otherwise be silently
 * dropped, so ACE halts rather than ship a run that ignores an expert review).
 * One bad ref therefore discarded all eleven rulings and blocked the phase,
 * a day and a run away from the write that caused it.
 *
 * **There is no synthesizer to fix instead.** Nothing in this repo, and
 * nothing in ace-web, ever emits a `feedback_ref` into
 * `decision-overrides.yaml`: ace-web's `make_override_row`
 * (`apps/opps/decision_overrides.py`) writes a fixed field list that does not
 * include it. Both ruling stores are hand-authored through
 * `drive_create_file` / `drive_update_file` / `drive_upload_binary` /
 * `update_yaml_file` — which is exactly the authoring path this module
 * already polices for `*-qa_result.yaml`, `*_verdict.yaml` and unparseable
 * YAML (ace#2866), and these two were the hole left in it.
 *
 * **It refuses; it never repairs.** `feedback_ref` is a BINDING KEY naming
 * one reviewer comment or one operator ruling, so kebab-casing it silently
 * would bind a saved ruling to whatever the corrected spelling happens to
 * name — the data-integrity property the all-or-nothing reader exists to
 * protect. The refusal offers the kebab spelling (`kebabFeedbackRef`) and
 * leaves the choice with the author.
 *
 * `operator-rulings.yaml` is here for the same class one file over: a ruling
 * `id` becomes the second half of `feedback_ref: operator-rulings/<id>`
 * (`rulingDecisionRow`, `lib/operator-rulings.ts`), so an id this file
 * accepted but the decisions schema would not is the same defect.
 */
export function rulingStoreWriteRefusal(name: string, text: string): string | null {
  const fname = String(name ?? '');
  const body = String(text ?? '').replace(/\r\n/g, '\n');

  if (DECISION_OVERRIDES_WRITE_NAME.test(fname)) {
    return rulingStoreRefusal(
      'INVALID_DECISION_OVERRIDES',
      fname,
      body,
      () => parseDecisionOverridesYaml(body),
      'lib/decision-overrides.ts (schema v1)',
      'ONE malformed row discards EVERY ruling in the file and halts the decisions write ' +
        '(the file is validated all-or-nothing on purpose), so this has to be right before it lands.',
    );
  }

  if (OPERATOR_RULINGS_WRITE_NAME.test(fname)) {
    return rulingStoreRefusal(
      'INVALID_OPERATOR_RULINGS',
      fname,
      body,
      () => parseOperatorRulingsYaml(body),
      'lib/operator-rulings.ts (schema v1)',
      'A ruling id becomes the second half of `feedback_ref: operator-rulings/<id>` on every ' +
        'decision row it stamps, so an id this file accepts but the decisions schema rejects ' +
        'fails later, in a phase, with the whole file as collateral.',
    );
  }

  return null;
}

function rulingStoreRefusal(
  code: string,
  name: string,
  body: string,
  parse: () => unknown,
  contract: string,
  why: string,
): string | null {
  try {
    parse();
    return null;
  } catch (e) {
    const detail = (e as Error).message;
    return (
      `${code}: ${name} does not match ${contract} — ${detail}. ` +
      `Nothing was written. ${why}${kebabHints(body)}`
    );
  }
}

/**
 * Name the offending ids and the kebab spelling that would be legal.
 *
 * The schema message states the RULE; with eleven rows in a file the author
 * still has to find which value broke it. Underscores carried over from a
 * YAML key are the observed cause, so every non-kebab id-ish scalar in the
 * bytes about to be written is quoted back with its suggested spelling.
 */
function kebabHints(body: string): string {
  const seen = new Map<string, string>();
  const scalar = /(?:^|[\s:>|"'[{,-])([A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)?)(?=["'\s,\]}]|$)/gm;
  for (const m of body.matchAll(scalar)) {
    const value = m[1];
    if (!value.includes('_')) continue; // only the observed failure shape
    const suggestion = value.includes('/')
      ? kebabFeedbackRef(value)
      : value.toLowerCase().replace(/_+/g, '-');
    if (suggestion && suggestion !== value && !seen.has(value)) seen.set(value, suggestion);
  }
  if (seen.size === 0) return '';
  const list = [...seen].map(([bad, good]) => `\`${bad}\` -> \`${good}\``).join(', ');
  return (
    ` Underscores are illegal on either side of the slash; these look like the cause: ${list}. ` +
    'Re-point the ref deliberately rather than pasting the suggestion — it is a BINDING key ' +
    'naming one reviewer comment or one operator ruling, and the corrected spelling must name ' +
    'the record you actually mean.'
  );
}
