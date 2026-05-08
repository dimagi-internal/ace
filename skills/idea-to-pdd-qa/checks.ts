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

import type { QACheck, QACheckResult } from '../../lib/qa-types';

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

const VALID_ARCHETYPES = ['atomic-visit', 'focus-group', 'multi-stage'] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check 1: All 11 required PDD sections are present (as `## Section Name` headings).
 *
 * Tolerates `## Section`, `## **Section**`, `## Section Name (notes)`. Skips matching
 * inside frontmatter. Section name match is case-insensitive on the first letter to
 * tolerate "Llo Preference" / "LLO Preference" variation.
 */
export function checkAllRequiredSectionsPresent(pdd: string): QACheckResult {
  const body = stripFrontmatter(pdd);
  const missing: string[] = [];
  for (const section of REQUIRED_SECTIONS) {
    // Match `##\s+(optional **)<section>` at start of a line, case-insensitive.
    const re = new RegExp(`^##\\s+(?:\\*\\*)?${escapeRegExp(section)}\\b`, 'mi');
    if (!re.test(body)) {
      missing.push(section);
    }
  }
  if (missing.length === 0) return { pass: true };
  return {
    pass: false,
    detail: `missing required section(s): ${missing.map((s) => `§ ${s}`).join(', ')}`,
    auto_fix_hint: `regenerate the PDD with explicit instructions to include each missing section: ${missing.join(', ')}. The full required list is in skills/idea-to-pdd/SKILL.md § Process step 4.`,
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
  if (/^##\s+Stress[\s-]?Test\s+Results\b/im.test(pdd)) {
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
  const hasSection = /^##\s+Reviewer\s+Comments?\b/im.test(body);

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
  const headingRe = new RegExp(`^##\\s+${headingPattern}[^\\n]*$`, 'im');
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

// ── Canonical CHECKS array ────────────────────────────────────────

/**
 * Ordered list of static checks idea-to-pdd-qa runs against a PDD artifact.
 * The `id` of each check matches the row in skills/idea-to-pdd-qa/SKILL.md
 * `## Checks` table.
 */
export const CHECKS: QACheck[] = [
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
