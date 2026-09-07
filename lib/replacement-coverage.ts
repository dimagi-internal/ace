/**
 * A `replaceAllText` that matches nothing must not pass silently
 * (dimagi-internal/ace#2126).
 *
 * `docs_copy_template` turns each entry of its `replacements` map into one
 * `replaceAllText` request. If the template does not contain the placeholder,
 * the API returns 200 with `occurrencesChanged: 0` — no error, and no leftover
 * `{{token}}` in the rendered document for any downstream check to find. The
 * value the producer computed simply evaporates.
 *
 * Measured cost (ace#2126): `pdd-to-work-order` emitted
 * `{{partner_first_reference}}` against a live template that had no such slot.
 * `pdd-to-work-order-qa` returned 14/14 pass, the ace#819 token-coverage scan
 * passed (its failure mode is a SURVIVING marker, and there was none), and the
 * rendered Work Order used "the partner" ~30 times without ever defining who
 * that is. Two consecutive runs shipped a contractual document with an
 * undefined party and every checkpoint read green.
 *
 * The Docs and Slides batchUpdate responses already carry the answer, in
 * `replies[i].replaceAllText.occurrencesChanged`, positionally matched to the
 * requests we sent. Both atoms discarded it. This module turns those replies
 * into an explicit per-key coverage report that the caller surfaces in its
 * result, so an unmatched key is visible in the tool output rather than being
 * indistinguishable from success.
 *
 * Scope note: this REPORTS rather than throws. An over-broad replacements map
 * is legitimate for some callers (a template that omits an optional section
 * still gets the full map), so failing the copy would break working paths for
 * a condition that is usually benign; the loud, hard gate for the specific
 * mirror-vs-live class is `scripts/probe-work-order-template-drift.ts`.
 */

export interface ReplacementCoverage {
  /** Placeholder key -> number of occurrences replaced in the document. */
  occurrences: Record<string, number>;
  /** Keys whose placeholder appeared nowhere in the template (a silent no-op). */
  unmatchedReplacements: string[];
  /** Human-readable warning, or undefined when every key matched. */
  warning?: string;
}

interface ReplaceAllTextReply {
  replaceAllText?: { occurrencesChanged?: number | null } | null;
}

/**
 * Pair the replacement keys (in the order their requests were sent) with the
 * batchUpdate replies.
 *
 * Defensive about shape: a missing or short `replies` array, or a reply whose
 * `occurrencesChanged` is absent, yields `0` for that key — Google omits the
 * field when the count is zero, which is exactly the case this is here to
 * catch. Callers must pass the keys in the same order as the requests.
 */
export function summarizeReplacementCoverage(
  keys: string[],
  replies: ReplaceAllTextReply[] | null | undefined,
): ReplacementCoverage {
  const occurrences: Record<string, number> = {};
  const unmatchedReplacements: string[] = [];

  keys.forEach((key, i) => {
    const n = replies?.[i]?.replaceAllText?.occurrencesChanged ?? 0;
    occurrences[key] = n;
    if (n === 0) unmatchedReplacements.push(key);
  });

  if (unmatchedReplacements.length === 0) return { occurrences, unmatchedReplacements };

  return {
    occurrences,
    unmatchedReplacements,
    warning:
      `${unmatchedReplacements.length} of ${keys.length} replacement key(s) matched ZERO ` +
      `occurrences in the template and were silently dropped: ` +
      `${unmatchedReplacements.join(', ')}. ` +
      `The template does not carry these placeholders, so the values you computed for them ` +
      `are not in the rendered document and no {{token}} remains to reveal it (ace#2126). ` +
      `If the template is a repo-mirrored one, it has drifted from its mirror — see ` +
      `scripts/probe-work-order-template-drift.ts.`,
  };
}
