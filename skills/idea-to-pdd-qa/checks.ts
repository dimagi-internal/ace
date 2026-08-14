/**
 * Static QA checks for `idea-to-pdd-qa`.
 *
 * Each check takes the PDD text (utf-8 markdown) and returns a `QACheckResult`.
 * Checks are pure functions, no LLM, fast (<1ms per check on a typical PDD).
 *
 * Imported by:
 * - The skill body via `scripts/qa-run.ts` at runtime (orchestrator dispatch)
 * - Per-skill tests under `test/skills/idea-to-pdd-qa/` (vitest)
 *
 * The `CHECKS` array is the canonical ordering — both runtime and tests
 * iterate it. Add a check by appending to the array; surface in the SKILL.md
 * `## Checks` table simultaneously.
 */

import type { QACheck, QACheckContext, QACheckResult } from '../../lib/qa-types';

const REQUIRED_SECTIONS = [
  'Archetype',
  'Problem Statement',
  'Intervention Design',
  'Learn App Specification',
  'Deliver App Specification',
  'Target Population',
  'FLW Requirements',
  'LLO Preference',
  'Success Metrics',
  'Evidence Model',
  'Timeline',
] as const;

/**
 * Per-section purpose strings, mirrored from `skills/idea-to-pdd/SKILL.md § Process step 4`.
 *
 * Used in the auto_fix_hint when a section is missing — so a producer
 * regenerating the PDD knows what content the section should contain,
 * not just what heading text to add. Without this, the static check
 * could be satisfied by a stub paragraph under the right heading.
 *
 * Keep in sync with `skills/idea-to-pdd/SKILL.md`. Out-of-sync rows are
 * a doc-drift class detectable by future audits — see
 * `docs/learnings/2026-04-28-mcp-vs-skill-doc-drift.md` for the broader
 * pattern.
 */
const SECTION_PURPOSES: Record<(typeof REQUIRED_SECTIONS)[number], string> = {
  'Archetype': 'declared in frontmatter, repeated as the first heading; one of {atomic-visit, focus-group, multi-stage}',
  'Problem Statement': 'what problem this opportunity solves',
  'Intervention Design': 'how the intervention works end-to-end',
  'Learn App Specification': 'what FLWs need to learn (data collection, facilitation, etc., depending on archetype)',
  'Deliver App Specification': 'what FLWs deliver (forms, sessions, etc., depending on archetype)',
  'Target Population': 'beneficiary criteria, geographic scope, expected reach',
  'FLW Requirements': 'number of FLWs, skills needed, geographic distribution',
  'LLO Preference': 'preferred or known LLOs to execute, from the LLO Directory',
  'Success Metrics': 'how to measure if the intervention worked — populated table with Metric / Target / Method / Layer columns',
  'Evidence Model': 'Layer A (delivery proof), Layer B (content proof), Layer C (cross-delivery quality) verification plan',
  'Timeline': 'expected duration of the opportunity, key milestones',
};

const VALID_ARCHETYPES = ['atomic-visit', 'focus-group', 'multi-stage'] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Optional leading ordinal on an H2 — `1. `, `4.2 `, `13.`.
 *
 * Numbered headings are the NORMAL output here, not an anomaly: source PDDs
 * carry numbered sections (Neal's `[FIXED]`/`[ACE]` doc is §1–§13 + annexes),
 * so a producer synthesising from one mirrors that structure. Before this was
 * tolerated, a structurally-complete PDD failed 5 of 6 checks from this single
 * cause — and reported "missing required section(s)" for sections plainly
 * present, sending the auto-fixer looking in the wrong place
 * (dimagi-internal/ace#991, hh-poverty-targeting/20260727-1406 Phase 1).
 *
 * Shared by `checkAllRequiredSectionsPresent` and `extractSection` because
 * they anchor the same way; fixing only one leaves the secondary failures.
 */
const ORDINAL_PREFIX = '(?:\\d+(?:\\.\\d+)*\\.?\\s+)?';

/**
 * Optional leading appendix label on an H2 — `Appendix C — `, `Appendix B: `.
 *
 * An appendix IS the canonical placement for some required content (SKILL.md
 * § Process step 6 puts the stress test in an appendix), so the checker must
 * not reject the placement its own producer doc prescribes
 * (dimagi-internal/ace#1227, hh-poverty-targeting/20260813-1612 Phase 1).
 */
const APPENDIX_PREFIX = '(?:Appendix\\s+[A-Z0-9]+\\s*(?:[—–:-])\\s*)?';

/**
 * The full heading-prefix tolerance every heading matcher shares: an optional
 * appendix label, then an optional ordinal. #991 fixed the ordinal at 3 of 5
 * call sites and the other two drifted (#1227) — every heading regex in this
 * file MUST anchor through this constant rather than re-deriving its own.
 */
const HEADING_PREFIX = `${APPENDIX_PREFIX}${ORDINAL_PREFIX}`;

/**
 * Check 1: All 11 required PDD sections are present (as `## Section Name` headings).
 *
 * Heading-match tolerance (intentional — real PDDs vary):
 *   ✓ canonical:        `## Target Population`
 *   ✓ case variants:    `## target population`, `## TARGET POPULATION`  (i flag)
 *   ✓ bold-wrapped:     `## **Target Population**`                      (`(?:\\*\\*)?`)
 *   ✓ trailing notes:   `## Target Population (TBD)`                    (`\\b` ends after the section name)
 *   ✓ trailing context: `## Target Population — addressing comment [a]`
 *   ✓ numbered:         `## 4. Target Population`, `## 4.2 Target Population`  (ORDINAL_PREFIX)
 *   ✗ truncated:        `## Target Pop`                                 (no word boundary at the right place)
 *   ✗ synonyms:         `## Target Audience`                            (different word entirely)
 *
 * Skips matching inside YAML frontmatter so "title:" lines etc. don't false-positive.
 * Tolerance is documented in the auto_fix_hint so producers know what counts.
 */
export function checkAllRequiredSectionsPresent(pdd: string): QACheckResult {
  const body = stripFrontmatter(pdd);
  const missing: (typeof REQUIRED_SECTIONS)[number][] = [];
  for (const section of REQUIRED_SECTIONS) {
    // Match `##\s+(optional ordinal)(optional **)<section>` at line start, case-insensitive.
    const re = new RegExp(
      `^##\\s+${HEADING_PREFIX}(?:\\*\\*)?${escapeRegExp(section)}\\b`,
      'mi',
    );
    if (!re.test(body)) {
      missing.push(section);
    }
  }
  if (missing.length === 0) return { pass: true };
  const purposeLines = missing
    .map((s) => `  • § ${s} — ${SECTION_PURPOSES[s]}`)
    .join('\n');
  return {
    pass: false,
    detail: `missing required section(s): ${missing.map((s) => `§ ${s}`).join(', ')}`,
    auto_fix_hint:
      `regenerate the PDD with explicit instructions to include each missing section. ` +
      `For each section, write substantive content matching its purpose — a stub paragraph ` +
      `under the correct heading would satisfy this static check but fail the eval's quality grade. ` +
      `Missing sections + their required content:\n${purposeLines}\n` +
      `Heading match tolerates case variation, bold wrapping (\`## **X**\`), and trailing parentheticals (\`## X (notes)\`); ` +
      `the section name itself must appear intact (no truncation, no synonyms). ` +
      `The full required-section list is in skills/idea-to-pdd/SKILL.md § Process step 4.`,
  };
}

/**
 * Check 2: Archetype is declared (frontmatter or body) and value is in the valid enum.
 */
export function checkArchetypeDeclared(pdd: string): QACheckResult {
  let archetype: string | undefined;

  // Frontmatter form: `archetype: <value>`
  const frontmatter = pdd.match(/^---\s*\n([\s\S]*?)\n---/);
  if (frontmatter) {
    const m = frontmatter[1].match(/^archetype:\s*(\S+)/m);
    if (m) archetype = m[1];
  }

  // Body form: `**Archetype:** <value>` or `Archetype: <value>` near the top.
  if (!archetype) {
    const m = pdd.match(/Archetype[:\s]*\*{0,2}\s*(atomic-visit|focus-group|multi-stage)\b/im);
    if (m) archetype = m[1];
  }

  if (!archetype) {
    return {
      pass: false,
      detail: 'no archetype declared in frontmatter or body',
      auto_fix_hint:
        'add `archetype: <atomic-visit|focus-group|multi-stage>` to the PDD frontmatter and a matching `**Archetype:**` line in the body',
    };
  }
  if (!(VALID_ARCHETYPES as readonly string[]).includes(archetype)) {
    return {
      pass: false,
      detail: `archetype '${archetype}' is not one of: ${VALID_ARCHETYPES.join(', ')}`,
      auto_fix_hint: `change archetype to one of: ${VALID_ARCHETYPES.join(', ')}`,
    };
  }
  return { pass: true, detail: archetype };
}

/**
 * Check 3: PDD has a `## Stress Test Results` appendix at the bottom.
 *
 * Required by skills/idea-to-pdd/SKILL.md § Process step 6. Downstream review
 * tooling expects to find it.
 */
export function checkStressTestAppendixPresent(pdd: string): QACheckResult {
  if (new RegExp(`^##\\s+${HEADING_PREFIX}(?:\\*\\*)?Stress[\\s-]?Test\\s+Results\\b`, 'im').test(pdd)) {
    return { pass: true };
  }
  return {
    pass: false,
    detail: 'missing § Stress Test Results appendix',
    auto_fix_hint:
      'add a `## Stress Test Results` section at the bottom of the PDD with the 5-question rubric grades (per skills/idea-to-pdd/SKILL.md § Process step 6)',
  };
}

/**
 * Check 4: `## Success Metrics` section contains a populated markdown table
 * (header row + at least one data row).
 */
export function checkSuccessMetricsTablePopulated(pdd: string): QACheckResult {
  const body = extractSection(pdd, 'Success Metrics');
  if (body === null) {
    return {
      pass: false,
      detail: 'missing § Success Metrics section',
      auto_fix_hint:
        'add a `## Success Metrics` section with a table whose columns are at least: Metric, Target, Measurement Method, Layer',
    };
  }
  const dataRowCount = countTableDataRows(body);
  if (dataRowCount < 1) {
    return {
      pass: false,
      detail: 'Success Metrics section has no populated data rows',
      auto_fix_hint:
        'fill the Success Metrics section with a markdown table containing at least one metric row (Metric | Target | Measurement Method | Layer)',
    };
  }
  return { pass: true, detail: `${dataRowCount} metric row(s) found` };
}

/**
 * Check 5: `## Evidence Model` section references all three layers (A, B, C).
 *
 * Tolerates both heading styles seen in production PDDs:
 *   - `Layer A`, `Layer B`, `Layer C` (turmeric-style explicit)
 *   - `**A — Delivery proof**`, `**B — Content proof**`, `**C — Cross-delivery**`
 *     (leep-style table-row prefix)
 */
export function checkEvidenceModelLayered(pdd: string): QACheckResult {
  const body = extractSection(pdd, 'Evidence Model');
  if (body === null) {
    return {
      pass: false,
      detail: 'missing § Evidence Model section',
      auto_fix_hint:
        'add a `## Evidence Model` section with rows for Layer A (delivery proof), Layer B (content proof), Layer C (cross-delivery quality)',
    };
  }
  const missing: string[] = [];
  if (!hasLayerRef(body, 'A')) missing.push('Layer A');
  if (!hasLayerRef(body, 'B')) missing.push('Layer B');
  if (!hasLayerRef(body, 'C')) missing.push('Layer C');
  if (missing.length > 0) {
    return {
      pass: false,
      detail: `Evidence Model missing layer(s): ${missing.join(', ')}`,
      auto_fix_hint: `populate the Evidence Model section with rows for each layer: ${missing.join(', ')}`,
    };
  }
  return { pass: true };
}

/** Match `Layer X` OR `**X —` / `**X –` / `**X -` / `**X:` table-row prefix styles. */
function hasLayerRef(body: string, letter: string): boolean {
  const explicit = new RegExp(`Layer\\s+${letter}\\b`, 'i');
  const tableRow = new RegExp(`\\*\\*\\s*${letter}\\s*(?:[—–\\-]|:)`, 'i');
  return explicit.test(body) || tableRow.test(body);
}

/**
 * Check 6: If reviewer comments are referenced (markers like [a], [b], [c], or a
 * `## Reviewer Comments` section), the disposition table must exist with rows.
 *
 * No-op when the source pack is clean (no markers, no section). The eval grades
 * whether dispositions are *concrete* (semantic); QA only checks they exist.
 */
export function checkReviewerCommentTableIfReferenced(pdd: string): QACheckResult {
  const body = stripFrontmatter(pdd);
  const hasMarkers = /\[(?:[a-z])\]/i.test(body);
  const hasSection = new RegExp(`^##\\s+${HEADING_PREFIX}(?:\\*\\*)?Reviewer\\s+Comments?\\b`, 'im').test(body);

  if (!hasMarkers && !hasSection) {
    return { pass: true, detail: 'no reviewer comments referenced (clean source pack)' };
  }
  if (hasMarkers && !hasSection) {
    return {
      pass: false,
      detail: 'PDD references reviewer comment markers but has no Reviewer Comments — Disposition section',
      auto_fix_hint:
        'add a `## Reviewer Comments — Disposition` section with a row per reviewer comment marker [a], [b], etc., each with a concrete disposition citing where in the PDD it was addressed',
    };
  }
  // Section exists. Verify it has data rows.
  const sectionBody = extractSection(body, 'Reviewer Comments?(?:\\s+[—–-]\\s+Disposition)?');
  if (sectionBody === null) {
    // The header parsed via the lighter regex above but our extractor missed it.
    // Defensive — fall back to "section present, content unknown".
    return { pass: true, detail: 'Reviewer Comments section present (table parse skipped)' };
  }
  const dataRowCount = countTableDataRows(sectionBody);
  if (dataRowCount < 1) {
    return {
      pass: false,
      detail: 'Reviewer Comments — Disposition section has no populated table rows',
      auto_fix_hint:
        'fill the Reviewer Comments — Disposition section with one row per source-idea reviewer comment, each row citing the PDD section that addressed it',
    };
  }
  return { pass: true, detail: `${dataRowCount} disposition row(s)` };
}

// ── Helpers ────────────────────────────────────────────────────────

function stripFrontmatter(pdd: string): string {
  const m = pdd.match(/^---\s*\n[\s\S]*?\n---\s*\n/);
  return m ? pdd.slice(m[0].length) : pdd;
}

/**
 * Extract the body of a `## <heading>` section (everything until the next `## `
 * heading or end-of-file). Returns null if the section isn't present.
 *
 * `headingPattern` is a regex source string (un-anchored); used inside a
 * case-insensitive multi-line regex.
 *
 * Implemented as a two-step match (find heading, find next heading or EOF)
 * because JS regex has no `\Z` end-of-string anchor and lookahead-to-EOF is
 * fiddly across engines.
 */
function extractSection(pdd: string, headingPattern: string): string | null {
  const headingRe = new RegExp(
    `^##\\s+${HEADING_PREFIX}${headingPattern}[^\\n]*$`,
    'im',
  );
  const headingMatch = pdd.match(headingRe);
  if (!headingMatch || headingMatch.index === undefined) return null;
  const bodyStart = headingMatch.index + headingMatch[0].length;
  const tail = pdd.slice(bodyStart);
  const nextHeadingMatch = tail.match(/^##\s/m);
  const bodyEnd =
    nextHeadingMatch && nextHeadingMatch.index !== undefined
      ? bodyStart + nextHeadingMatch.index
      : pdd.length;
  return pdd.slice(bodyStart, bodyEnd);
}

/**
 * Count "data" rows in a markdown table inside a section body.
 *
 * A data row is `| col | col |` style and NOT the header separator (`|---|---|`).
 * We exclude the header row itself from the count, so the result is the number
 * of populated rows under the header. Returns 0 if no table is present.
 */
function countTableDataRows(sectionBody: string): number {
  const lines = sectionBody.split('\n');
  let separatorSeen = false;
  let dataRows = 0;
  for (const line of lines) {
    const isTableLine = /^\s*\|.*\|/.test(line);
    if (!isTableLine) continue;
    const isSeparator = /^\s*\|[\s|:-]+\|\s*$/.test(line);
    if (isSeparator) {
      separatorSeen = true;
      continue;
    }
    if (separatorSeen) {
      // Lines after the separator and before any non-table line are data rows.
      // (Tolerates blank lines mid-table by relying on continuous `|...|` pattern.)
      dataRows++;
    }
  }
  return dataRows;
}

/** The mimeType a native Google Doc carries in Drive. */
const GOOGLE_DOC_MIMETYPE = 'application/vnd.google-apps.document';

/**
 * Check 7: the PDD artifact is a NATIVE Google Doc, not a text/* upload
 * (dimagi-internal/ace#1061).
 *
 * The PDD is the only artifact in the pipeline whose purpose is to be argued
 * with by a human — the whole feedback → ledger → next-run loop starts with a
 * domain expert leaving ANCHORED comments on it. A `text/markdown` upload
 * renders in Drive's plain-text previewer: no comment gutter, no suggesting
 * mode, no way to anchor to a section. It regressed exactly that way between
 * two runs of the same opp six days apart (9 anchored comments → none), and
 * nothing caught it because every CONTENT check still passed.
 *
 * Format is checked from Drive metadata, not from the bytes: an exported Doc
 * and a markdown upload are indistinguishable as text, so the caller must
 * supply the artifact's mimeType (`qa-run.ts --artifact-mime-type`).
 *
 * A MISSING mimeType fails rather than passes. "Nobody verified the format" is
 * precisely how this shipped; a silent pass would rebuild the hole. The hint
 * for that case points at the QA invocation, not at the PDD's content, so the
 * orchestrator does not spend an auto-fix attempt rewriting a healthy document.
 */
export function checkPddIsNativeGoogleDoc(ctx?: QACheckContext): QACheckResult {
  const mime = ctx?.artifactMimeType;
  if (typeof mime !== 'string' || mime.trim() === '') {
    return {
      pass: false,
      detail:
        'artifact mimeType was not supplied, so the PDD format could not be verified',
      auto_fix_hint:
        'do NOT regenerate the PDD for this failure — it is a QA-invocation gap, not a content defect. ' +
        'Re-run the QA passing the artifact\'s Drive mimeType: ' +
        '`npx tsx scripts/qa-run.ts --skill idea-to-pdd-qa --artifact <local.md> --artifact-mime-type <mimeType from drive_read_file/drive_list_folder> ...`.',
    };
  }
  if (mime === GOOGLE_DOC_MIMETYPE) {
    return { pass: true, detail: mime };
  }
  return {
    pass: false,
    detail: `PDD artifact is '${mime}', not a native Google Doc (${GOOGLE_DOC_MIMETYPE}) — reviewers get no comment gutter, so it cannot be commented on`,
    auto_fix_hint:
      'rewrite the PDD as a NATIVE Google Doc with `drive_create_doc_from_markdown` ' +
      '(NOT `drive_create_file` with a text/* mimeType), then update ' +
      '`run_state.yaml` `phases.design.products.pdd.file_id` to the new fileId. ' +
      'The PDD is the artifact a domain expert comments on; a text/* upload has no ' +
      'comment gutter, no suggesting mode, and no way to anchor a comment to a section ' +
      '(dimagi-internal/ace#1061).',
  };
}

// ── Canonical CHECKS array ────────────────────────────────

/**
 * Ordered list of static checks idea-to-pdd-qa runs against a PDD artifact.
 * The `id` of each check matches the row in skills/idea-to-pdd-qa/SKILL.md
 * `## Checks` table.
 */
export const CHECKS: QACheck[] = [
  {
    id: 'pdd_is_native_google_doc',
    type: 'static',
    description: 'PDD artifact is a native Google Doc (reviewers can comment on it)',
    run: (_pdd: string, ctx?: QACheckContext) => checkPddIsNativeGoogleDoc(ctx),
  },
  {
    id: 'all_required_sections_present',
    type: 'static',
    description: '11 required PDD sections all present',
    run: checkAllRequiredSectionsPresent,
  },
  {
    id: 'archetype_declared_and_valid',
    type: 'static',
    description: 'Archetype declared in frontmatter or body; value in valid enum',
    run: checkArchetypeDeclared,
  },
  {
    id: 'stress_test_appendix_present',
    type: 'static',
    description: 'PDD has a § Stress Test Results appendix',
    run: checkStressTestAppendixPresent,
  },
  {
    id: 'success_metrics_table_populated',
    type: 'static',
    description: 'Success Metrics section contains a populated markdown table',
    run: checkSuccessMetricsTablePopulated,
  },
  {
    id: 'evidence_model_layered',
    type: 'static',
    description: 'Evidence Model section references all three layers (A, B, C)',
    run: checkEvidenceModelLayered,
  },
  {
    id: 'reviewer_comment_table_if_referenced',
    type: 'static',
    description:
      'If reviewer comments are referenced (markers or section header), the disposition table is populated',
    run: checkReviewerCommentTableIfReferenced,
  },
];
