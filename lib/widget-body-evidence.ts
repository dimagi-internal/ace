//
// The OCS widget's real grading evidence is in the RESPONSE BODY, not in the
// structured fields the docs point at.
//
// Two rubric dimensions — Source usage (20%) and Tagging (15%), 35% of the
// `--deep` verdict between them — were each told to read a structured field
// that does not carry what the doc says it carries. Filed separately as
// dimagi-internal/ace#1952 and #1953; they are ONE defect with one fix,
// because they share a root cause AND a mechanism:
//
//   THE DOC NAMES A FIELD, THE FIELD EXISTS, THE FIELD CONTAINS SOMETHING
//   ELSE, AND READING IT PRODUCES A RESULT INDISTINGUISHABLE FROM A REAL
//   OBSERVATION.
//
// That last clause is why neither was caught by running the harness. An empty
// `cited_files` reads as "this bot cited nothing"; `tags: ["v3"]` on every
// entry reads as "uniformly tagged". Both are well-formed answers to the
// wrong question. This is the third door of the same class as ace#1298.
//
// Measured on `hh-poverty-targeting/20260828-0702` (64-prompt deep suite,
// chatbot 13029 published v3, collection 570, transcript revisionVersion 8):
//
//   * `message.metadata.cited_files` — empty on all 64. TRUE, and documented.
//   * INLINE citation markup in the body — present on **8 of 64** entries
//     (cg-3, opp-9, opp-17, opp-25, opp-27, opp-30, opp-46, opp-49), 59
//     markers, **13 distinct file ids**. Twelve resolve against
//     `ocs_list_collection_files(570)`; 48998 is a shared-collection file.
//     The rubric said this markup does not exist at all.
//   * `message.tags` — `["v3"]` on all 64. That is the CHATBOT VERSION tag
//     (`ocs-agent-setup.md` records `version_number: 3`), not a semantic tag.
//     The `[training-gap]` / `[product-feedback]` / `[no tag]` markers are
//     emitted inline in the body.
//
// WHY THIS IS ONE SHARED PARSER AND NOT TWO REGEXES AT THE CALL SITES.
//
// Format variance is the whole problem, and it is worse than either issue
// recorded. #1952 published a repro regex of `<CIT file-id>(\d+)</CIT>` and
// `<sup>(\d+)</sup>` and reported 8 entries. Re-running exactly that pattern
// over the same transcript returns **2** — the other six use spellings the
// pattern does not cover. Six grammars are live in one suite from one bot:
//
//     12x  <CIT file-id>N</CIT>          16x  <CIT file-id=N />
//     12x  <CIT file-id="N" />            4x  <CIT file-id="N"/>
//      7x  <sup>N</sup>                   8x  <sup>[N]</sup>
//
// and three for tags, which #1953 did record:
//
//     [product-feedback]   `[product-feedback]`   [`product-feedback`]
//
// A hand-rolled regex at a call site is therefore not a shortcut, it is the
// bug: it silently under-reports and the under-report is invisible. qa and
// eval must not be able to disagree about the grammar, so there is one
// parser and both read it.
//
// SCOPE. This module observes what the bot emitted. It does not predict what
// OCS will do, and it must not grow a rule that does — see CLAUDE.md
// § "A guard that PREDICTS another system's rejection must cite a reproducer".
// The producer-side question (the bot should not be emitting raw markup to a
// user at all) is deliberately NOT handled here; it needs a live chatbot
// rebuild and re-capture to validate, and is tracked separately.
//

import type { JudgedEntry } from './fabrication-clamp.js';

/** Marker emitted when raw citation markup reached the user. */
export const LEAKED_CITATION_MARKUP_MARKER = '[LEAKED-CITATION-MARKUP]';

/**
 * Every inline citation grammar observed on 20260828-0702, in one alternation.
 *
 * Deliberately permissive about the attribute (`file-id>N</CIT>`,
 * `file-id=N`, `file-id="N"`) and about `<sup>` with or without brackets,
 * because six spellings appeared in a SINGLE suite from a SINGLE bot and
 * there is no reason to think that set is closed. Deliberately strict about
 * the digits (3–7) so an ordinary superscript footnote marker (`<sup>1</sup>`)
 * is not mistaken for a collection file id.
 */
const INLINE_CITATION =
  /<CIT\b[^>]*>\s*(\d{3,7})\s*<\/CIT>|<CIT\b[^>]*?file-id\s*=\s*"?(\d{3,7})"?[^>]*?\/?>|<sup>\s*\[?\s*(\d{3,7})\s*\]?\s*<\/sup>/g;

/** The three semantic-tag spellings observed, plus the bare form. */
const INLINE_TAG = /`?\[\s*`?\s*(training-gap|product-feedback|no tag)\s*`?\s*\]`?/gi;

/** `["v3"]`, `["v12"]` — the chatbot version tag, never a semantic tag. */
const VERSION_TAG = /^v\d+$/i;

export interface InlineCitation {
  /** The collection file id as written. */
  id: string;
  /** The full marker verbatim, for the leak report. */
  marker: string;
}

/**
 * Harvest inline citation ids from a response body.
 *
 * Returns ids in first-appearance order, deduplicated, alongside every raw
 * marker (NOT deduplicated — the leak detector counts occurrences).
 */
export function extractInlineCitations(body: string): { ids: string[]; markers: string[] } {
  const ids: string[] = [];
  const markers: string[] = [];
  for (const m of body.matchAll(INLINE_CITATION)) {
    const id = m[1] ?? m[2] ?? m[3];
    if (!id) continue;
    markers.push(m[0]);
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, markers };
}

/**
 * Parse the semantic tags a response emitted inline.
 *
 * `[no tag]` is a real, deliberate emission — the bot saying it considered
 * tagging and declined — so it is returned rather than dropped. A caller
 * matching against `expected_tags: none` should treat `[no tag]` and an empty
 * result as equivalent; `noSemanticTags` below says which is which.
 */
export function extractInlineTags(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(INLINE_TAG)) {
    const tag = `[${m[1].toLowerCase()}]`;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/** True when the response emitted no semantic marker at all (not even `[no tag]`). */
export function noSemanticTags(body: string): boolean {
  return extractInlineTags(body).length === 0;
}

/**
 * True when a structured `tags` value is nothing but chatbot version labels.
 *
 * The guard against ace#1953 recurring: a harness that reads `message.tags`
 * and finds `["v3"]` must be able to tell that apart from a real tag set.
 */
export function isVersionTagOnly(tags: readonly string[] | null | undefined): boolean {
  if (!tags || tags.length === 0) return false;
  return tags.every((t) => VERSION_TAG.test(String(t).trim()));
}

export interface CitationLeak {
  ref: string;
  /** Raw markers that reached the user, verbatim. */
  markers: string[];
  /** Distinct file ids named. */
  ids: string[];
}

/**
 * Find entries where raw machine markup reached the reader.
 *
 * `<CIT file-id>63004</CIT>` renders as literal garbage in the widget: a field
 * supervisor reading `cg-3` on 20260828-0702 saw the file id inline. This is
 * REPORT-ONLY on purpose — it emits a marker and does not clamp. The defect is
 * on the producer side (the composed system prompt), the fix has to be
 * validated against a live rebuilt chatbot, and clamping the grade here would
 * punish the bot for a formatting behaviour the harness has not yet asked it
 * to stop. Grade it once the producer fix has shipped and been re-captured.
 */
export function detectLeakedCitationMarkup(
  entries: readonly JudgedEntry[],
): { entries: JudgedEntry[]; leaks: CitationLeak[] } {
  const leaks: CitationLeak[] = [];

  const out = entries.map((entry) => {
    const body = typeof entry.response_content === 'string' ? entry.response_content : '';
    const { ids, markers } = extractInlineCitations(body);
    if (markers.length === 0) return { ...entry };

    leaks.push({ ref: entry.ref, markers, ids });

    const existing = entry.auto_surfaced;
    const lines = existing === undefined ? [] : Array.isArray(existing) ? [...existing] : [existing];
    const marker =
      `${LEAKED_CITATION_MARKUP_MARKER} ${markers.length} raw marker` +
      `${markers.length === 1 ? '' : 's'} reached the reader (${markers[0]})`;
    if (!lines.some((l) => String(l).startsWith(LEAKED_CITATION_MARKUP_MARKER))) lines.push(marker);

    return { ...entry, auto_surfaced: lines };
  });

  return { entries: out, leaks };
}

/** Auditable report of the harvested citation evidence and the leak. */
export function formatInlineCitationReport(leaks: readonly CitationLeak[], suiteSize: number): string {
  if (leaks.length === 0) {
    return 'Inline citations: none harvested — grade Source usage on body text alone.';
  }
  const allIds = [...new Set(leaks.flatMap((l) => l.ids))].sort();
  const markerCount = leaks.reduce((a, l) => a + l.markers.length, 0);
  const lines = [
    `Inline citations: ${leaks.length}/${suiteSize} entries carried file-id markup ` +
      `(${markerCount} markers, ${allIds.length} distinct ids)`,
    `  ids: ${allIds.join(', ')}`,
    `  refs: ${leaks.map((l) => l.ref).join(', ')}`,
    `  ${LEAKED_CITATION_MARKUP_MARKER} the same markup renders as literal text to the reader — ` +
      'report-only here; the producer-side fix is tracked separately.',
  ];
  return lines.join('\n');
}
