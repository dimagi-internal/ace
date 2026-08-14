/**
 * Connect's `FormJsonValidationRules.question_path` is a **JSONPath into the
 * HQ form-JSON document**, not an XForm XPath.
 *
 * commcare-connect evaluates it in
 * `commcare_connect/form_receiver/processor.py::clean_form_submission` as:
 *
 * ```python
 * json_path = parse(f"$.{form_json_rule.question_path}")   # jsonpath_ng.ext
 * matches  = [m.value for m in json_path.find(user_visit.form_json) ...]
 * ```
 *
 * `user_visit.form_json` is the WHOLE forwarded doc (`{app_id, domain, form:
 * {...}, metadata, ...}`), so a question inside XForm group `meeting_basics`
 * lives at `form.meeting_basics.meeting_conducted`.
 *
 * ## Why this is a rail and not a style preference
 *
 * An XForm XPath makes that `parse()` raise `JsonPathParserError`. Nothing on
 * the deliver path catches it — `process_deliver_form` has no
 * `except JSONPathError` (only `process_learn_form` does), and
 * `FormReceiver.post` catches only `IntegrityError` — so HQ's data forwarder
 * gets an unhandled Django **500** and the visit never reaches Connect. The
 * device is unaffected: CommCare says "1 form sent to server!" because the
 * submission DID land in HQ. Connect just silently has no visit, so the
 * opportunity cannot pay.
 *
 * OBSERVED, not predicted — dimagi-internal/ace#1301, run
 * `spark-facilitator/20260813-2126`:
 *
 *   - HQ motech log (`/a/connect-ace-prod/motech/logs/437770057/`):
 *     `POST https://connect.dimagi.com/api/receiver/?app_id=06f0764c8416... -> 500`
 *     for xform `46356d2c-f93f-4345-be95-a841945b4391`, while every
 *     registration form on the SAME app returned 200 (no `deliver` block, so
 *     `clean_form_submission` is never reached).
 *   - The opportunity's two live rules were
 *     `/data/meeting_basics/meeting_conducted` and
 *     `/data/meeting_basics/meeting_type`.
 *   - Reproducer on the pinned jsonpath-ng 1.8.0 (commcare-connect uv.lock):
 *     `parse("$./data/meeting_basics/meeting_conducted")` ->
 *     `JsonPathParserError: Parse error at 1:2 near token / (SORT_DIRECTION)`.
 *     `parse("$.form.meeting_basics.meeting_conducted").find(<the real payload>)`
 *     -> `['yes']`.
 *   - Rewriting the two rows to `form.meeting_basics.*` and requeueing the
 *     SAME forwarded payload took the opportunity from
 *     `delivered: 0 / approved: 0` to `delivered: 1 / approved: 1`.
 *
 * The mapping is mechanical, which is why it is safe to apply automatically:
 * HQ nests the submitted instance under the `form` key whatever the XForm
 * instance root is called, so the first XPath segment always becomes `form`.
 */

/**
 * Normalise a `question_path` for Connect's `form_json` formset.
 *
 * - `/data/<group>/<question>` -> `form.<group>.<question>`
 * - already-JSONPath values (`form.x.y`, `$.form.x.y`) pass through untouched
 * - blank / whitespace-only passes through so the caller's own validation owns it
 */
export function toConnectQuestionPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('/')) return trimmed;
  const segments = trimmed.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return trimmed;
  // HQ's form JSON nests the instance under `form`, whatever the XForm
  // instance root node is named (`data` for every Nova-built app).
  segments[0] = 'form';
  return segments.join('.');
}

/** True when `path` is an XForm XPath that Connect's JSONPath parser cannot read. */
export function isXFormXPath(path: string): boolean {
  return path.trim().startsWith('/');
}
