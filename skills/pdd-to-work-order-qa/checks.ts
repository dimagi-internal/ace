/**
 * Static QA checks for `pdd-to-work-order-qa`.
 *
 * Operates on the work-order markdown body. Some checks take additional
 * inputs (the decisions.yaml string, the declared archetype) — they're
 * separate exported functions, all of them pure.
 *
 * Imported by:
 *   - The skill body at runtime via the QA runner
 *   - Per-skill tests under `test/skills/pdd-to-work-order-qa/`
 *
 * The `CHECKS` array is the canonical ordering. Static checks that need
 * supplementary context (decisions.yaml, archetype) receive it via
 * `QACheckContext` — see qa-types.ts for the shape.
 */
import type { QACheck, QACheckContext, QACheckResult } from '../../lib/qa-types';

/**
 * The 11 required headings in a complete work order. Matched against
 * `##` and `###` lines, tolerant of leading numeric prefixes (`## 1.`,
 * `### 4.1`) and bold-wrapping (`## **Background**`).
 */
const REQUIRED_SECTIONS: string[] = [
  'Background',
  'Scope of Work',
  'Geographic Coverage',
  'Deliverables and Verification',
  'Timeline and Milestones',
  'Payment Terms',
  'Roles and Responsibilities',
  'Permissions, Ethics, and Compliance',
  'Data Handling',
  'Signatures',
  'Annexures',
];

const REQUIRED_WO_DECISION_IDS = [
  'wo-number',
  'wo-period-of-performance',
  'wo-total-not-to-exceed-usd',
  'wo-payment-schedule-split',
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check 1: All 11 required work-order sections are present.
 *
 * Heading-match tolerance (intentional — real work orders vary):
 *   ✓ numbered prefix:  `## 1. Background`, `### 4.1 Primary Deliverable`
 *   ✓ bold-wrapped:     `## **Background**`
 *   ✓ trailing context: `## Background — context`
 *   ✓ case variation:   `## background`
 *   ✗ truncated:        `## Backgrd`
 */
export function checkAllRequiredSectionsPresent(wo: string): QACheckResult {
  const missing: string[] = [];
  for (const section of REQUIRED_SECTIONS) {
    // Match `## ` or `### ` followed by optional `<digits>.<sub>?\.?\s+`, optional **,
    // then the section name, then a word boundary.
    const re = new RegExp(
      `^#{2,3}\\s+(?:\\d+(?:\\.\\d+)?\\.?\\s+)?(?:\\*\\*)?${escapeRegExp(section)}\\b`,
      'mi',
    );
    if (!re.test(wo)) {
      missing.push(section);
    }
  }
  if (missing.length === 0) return { pass: true };
  return {
    pass: false,
    detail: `missing required section(s): ${missing.map((s) => `§ ${s}`).join(', ')}`,
    auto_fix_hint:
      `regenerate the work order with explicit instructions to include each missing section. ` +
      `Missing: ${missing.join(', ')}. ` +
      `Heading match tolerates numbered prefixes (\`## 1.\`, \`### 4.1\`), bold wrapping (\`## **X**\`), ` +
      `and trailing context after the section name. The full required-section list is in ` +
      `templates/work-order-template.md.`,
  };
}

/**
 * Check 2: All four required `wo-*` decision rows are present in decisions.yaml.
 *
 * Parses the YAML structure looking for `id: <name>` entries — robust to row order.
 * Doesn't fully validate the schema (that's decisions-schema.ts's job); just confirms
 * the four IDs exist somewhere in the document.
 */
export function checkRequiredWoDecisionsPresent(decisionsYaml: string): QACheckResult {
  const missing: string[] = [];
  for (const id of REQUIRED_WO_DECISION_IDS) {
    // Match `id: <name>` (with optional quoting) on its own line in the YAML.
    const re = new RegExp(`^\\s*-?\\s*id:\\s*['"]?${escapeRegExp(id)}['"]?\\s*$`, 'm');
    if (!re.test(decisionsYaml)) {
      missing.push(id);
    }
  }
  if (missing.length === 0) return { pass: true };
  return {
    pass: false,
    detail: `decisions.yaml missing required wo-* row(s): ${missing.join(', ')}`,
    auto_fix_hint:
      `add the following decision rows to decisions.yaml under \`decisions:\`, each with phase=1-design, ` +
      `skill=pdd-to-work-order, status=applied, and an appropriate question/default/source/options_considered: ` +
      missing.join(', '),
  };
}

/**
 * Check 3: Period of Performance has both start + end dates (`YYYY-MM-DD to YYYY-MM-DD`)
 * OR an explicit `[...]` placeholder. Scaffolding `{{...}}` markers fail.
 */
export function checkPeriodOfPerformanceComplete(wo: string): QACheckResult {
  // Find the Period of Performance cell in the header table.
  const m = wo.match(/\|\s*Period of Performance\s*\|\s*([^|\n]+?)\s*\|/i);
  if (!m) {
    return {
      pass: false,
      detail: 'no Period of Performance row found in the header table',
      auto_fix_hint:
        'add a `| Period of Performance | YYYY-MM-DD to YYYY-MM-DD |` row to the header table (or `[TBD]` if dates are still being finalized)',
    };
  }
  const value = m[1].trim();
  const explicitRange = /\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2}/.test(value);
  const explicitPlaceholder = /^\[[^\]]+\]$/.test(value);
  if (explicitRange || explicitPlaceholder) return { pass: true, detail: value };
  return {
    pass: false,
    detail: `Period of Performance value '${value}' is incomplete (need YYYY-MM-DD to YYYY-MM-DD or [TBD])`,
    auto_fix_hint:
      'fill the Period of Performance cell with both start and end dates in `YYYY-MM-DD to YYYY-MM-DD` form, ' +
      'or use an explicit `[TBD]` placeholder. Scaffolding `{{...}}` markers must not leak through.',
  };
}

/**
 * Check 4: Payment schedule percentages in § 6.2 sum to exactly 100.
 *
 * Extracts the section body between `## 6.2` (or `### 6.2`) and the next `##` /`###`
 * heading, finds all `\d+%` matches, sums them. Tolerates table cells, prose, or
 * mixed. Section 6.2 might be `### 6.2 Payment Schedule` (subsection of § 6) so
 * the extractor matches either heading level.
 */
export function checkPaymentScheduleSumsTo100(wo: string): QACheckResult {
  const body = extractNumberedSection(wo, '6.2');
  if (body === null) {
    return {
      pass: false,
      detail: 'missing § 6.2 Payment Schedule section',
      auto_fix_hint:
        'add a `### 6.2 Payment Schedule` section with a table of milestones, each row showing % of total; percentages must sum to 100',
    };
  }
  const matches = body.match(/(\d{1,3})\s*%/g) || [];
  if (matches.length === 0) {
    return {
      pass: false,
      detail: '§ 6.2 Payment Schedule has no `%` percentages',
      auto_fix_hint:
        'populate § 6.2 with a milestone table whose `% of Total` column contains percentages summing to 100',
    };
  }
  const total = matches.reduce((sum, m) => sum + parseInt(m, 10), 0);
  if (total === 100) return { pass: true, detail: `${matches.length} milestone(s) sum to 100%` };
  return {
    pass: false,
    detail: `§ 6.2 Payment Schedule milestones sum to ${total}% (need 100%)`,
    auto_fix_hint:
      `adjust the milestone percentages in § 6.2 so they sum to exactly 100. Current values: ${matches.join(', ')} = ${total}%.`,
  };
}

/**
 * Check 5: § 6.1 Total Not-to-Exceed has a USD amount or explicit placeholder.
 *
 * Accepts `USD 2500`, `USD 2,500`, `USD [TBD]`. Rejects bare `USD ` with nothing after.
 */
export function checkTotalNtePresent(wo: string): QACheckResult {
  const body = extractNumberedSection(wo, '6.1');
  if (body === null) {
    return {
      pass: false,
      detail: 'missing § 6.1 Total Not-to-Exceed section',
      auto_fix_hint:
        'add a `### 6.1 Total Not-to-Exceed` section stating `USD <amount>` or `USD [TBD]` if the cap is still being finalized',
    };
  }
  // Match `USD` followed by whitespace then either a digit or `[`.
  const m = body.match(/USD\s+([\d\[])/);
  if (!m) {
    return {
      pass: false,
      detail: '§ 6.1 has no `USD <amount>` (need a digit or `[TBD]` placeholder after `USD`)',
      auto_fix_hint:
        'in § 6.1, state Dimagi\'s commitment as `USD <amount>` (numeric, e.g. `USD 2500`) or `USD [TBD]` if pending',
    };
  }
  return { pass: true };
}

/**
 * Check 6: Both signature blocks present (`**Subcontractor**` + `**Dimagi, Inc.**`).
 *
 * The bold-marker pattern is the canonical template form. Flexible to allow
 * `## Subcontractor` style headings as well.
 */
export function checkSignatureBlocksPresent(wo: string): QACheckResult {
  const hasSub = /\*\*\s*Subcontractor\s*\*\*|^#{1,3}\s+Subcontractor\b/im.test(wo);
  const hasDimagi = /\*\*\s*Dimagi(?:,\s*Inc\.?)?\s*\*\*|^#{1,3}\s+Dimagi(?:,\s*Inc\.?)?\b/im.test(wo);
  const missing: string[] = [];
  if (!hasSub) missing.push('Subcontractor');
  if (!hasDimagi) missing.push('Dimagi, Inc.');
  if (missing.length === 0) return { pass: true };
  return {
    pass: false,
    detail: `missing signature block(s): ${missing.join(', ')}`,
    auto_fix_hint:
      `add a Signatures section with both blocks: \`**Subcontractor**\` (Partner side) and \`**Dimagi, Inc.**\` (Dimagi side), ` +
      `each with By/Name/Title/Date/Address lines. See templates/work-order-template.md.`,
  };
}

/**
 * Check 7: Scope of Work language matches the declared archetype.
 *
 * Branches on the `archetype` argument:
 *   - atomic-visit: requires /per[- ]visit/ AND /photo|gps/
 *   - focus-group:  requires /per[- ]session|attestation/ AND /gdoc|google doc/
 *   - multi-stage:  requires /stage\s*\d|per stage/
 *
 * Pass `null`/`undefined` to skip the check entirely (returns pass with a note).
 */
export function checkArchetypeAppropriateScope(
  wo: string,
  archetype?: string | null,
): QACheckResult {
  if (!archetype) {
    return { pass: true, detail: 'archetype not provided; skip' };
  }
  const scope = extractNumberedSection(wo, '2') ?? wo;
  const missing: string[] = [];
  if (archetype === 'atomic-visit') {
    if (!/per[- ]visit/i.test(scope)) missing.push('"per visit" phrasing');
    if (!/photo|gps/i.test(scope)) missing.push('photo or GPS evidence');
  } else if (archetype === 'focus-group') {
    if (!/per[- ]session|attestation/i.test(scope)) missing.push('"per session" or attestation phrasing');
    if (!/gdoc|google\s+doc/i.test(scope)) missing.push('gdoc reference');
  } else if (archetype === 'multi-stage') {
    if (!/stage\s*\d|per stage/i.test(scope)) missing.push('stage phrasing');
  } else {
    return {
      pass: false,
      detail: `unknown archetype '${archetype}' (expected atomic-visit | focus-group | multi-stage)`,
      auto_fix_hint:
        'archetype must be one of atomic-visit, focus-group, multi-stage; verify the PDD frontmatter',
    };
  }
  if (missing.length === 0) return { pass: true, detail: `scope matches ${archetype} archetype` };
  return {
    pass: false,
    detail: `scope of work does not match ${archetype} archetype: missing ${missing.join(', ')}`,
    auto_fix_hint:
      `rewrite § 2 Scope of Work to match the ${archetype} archetype's expected language. ` +
      `Missing markers: ${missing.join(', ')}. ` +
      `atomic-visit needs "per visit" + photo/GPS; focus-group needs "per session"/attestation + gdoc; ` +
      `multi-stage needs stage references.`,
  };
}

/**
 * Check 8: No `<<...>>` scaffolding markers leaked through from the template.
 *
 * The template uses `{{...}}` for fill-in tokens; `<<...>>` is reserved for
 * intermediate scaffolding the producer must strip. Any `<<...>>` in the
 * final artifact is a regen-blocking bug.
 */
export function checkNoScaffoldingMarkers(wo: string): QACheckResult {
  const matches = wo.match(/<<[^>]*>>/g) || [];
  if (matches.length === 0) return { pass: true };
  const dedup = Array.from(new Set(matches));
  return {
    pass: false,
    detail: `found ${matches.length} scaffolding marker(s): ${dedup.join(', ')}`,
    auto_fix_hint:
      `strip all \`<<...>>\` scaffolding markers from the work order — they're producer notes, not final content. ` +
      `Replace each with the concrete value it represents, or remove the surrounding phrase if no longer applicable. ` +
      `Markers found: ${dedup.join(', ')}.`,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Extract the body of a numbered section like `## 6.1 Total Not-to-Exceed` or
 * `### 6.2 Payment Schedule` (everything until the next heading of equal or
 * higher level, or EOF).
 *
 * For top-level numbers (e.g. `6`), matches `## 6.` style; for sub-sections
 * (e.g. `6.1`), matches `### 6.1` style. Returns null if not found.
 */
function extractNumberedSection(wo: string, number: string): string | null {
  // Determine heading depth from the number's dot-count.
  const depth = number.includes('.') ? 3 : 2;
  const hashes = '#'.repeat(depth);
  const headingRe = new RegExp(
    `^${hashes}\\s+${escapeRegExp(number)}(?:\\.|\\s)[^\\n]*$`,
    'mi',
  );
  const headingMatch = wo.match(headingRe);
  if (!headingMatch || headingMatch.index === undefined) return null;
  const bodyStart = headingMatch.index + headingMatch[0].length;
  const tail = wo.slice(bodyStart);
  // Stop at next heading of equal or higher level (= same or fewer #s).
  // Build a regex like `^#{1,depth}\s` to match equal-or-higher headings.
  const stopRe = new RegExp(`^#{1,${depth}}\\s`, 'm');
  const nextHeadingMatch = tail.match(stopRe);
  const bodyEnd =
    nextHeadingMatch && nextHeadingMatch.index !== undefined
      ? bodyStart + nextHeadingMatch.index
      : wo.length;
  return wo.slice(bodyStart, bodyEnd);
}

// ── Canonical CHECKS array ────────────────────────────────────────

/**
 * Ordered list of static checks pdd-to-work-order-qa runs against a work-order
 * artifact. The `id` of each check matches the row in
 * skills/pdd-to-work-order-qa/SKILL.md `## Checks` table.
 *
 * Context expected:
 *   - `decisionsYaml: string` — the decisions.yaml file contents (for check 2)
 *   - `archetype: string` — the PDD-declared archetype (for check 7)
 */
export const CHECKS: QACheck[] = [
  {
    id: 'all_required_sections_present',
    type: 'static',
    description: '11 required work-order sections all present',
    run: (wo: string) => checkAllRequiredSectionsPresent(wo),
  },
  {
    id: 'required_wo_decisions_present',
    type: 'static',
    description: 'All four required wo-* decision rows present in decisions.yaml',
    run: (_wo: string, ctx?: QACheckContext) =>
      checkRequiredWoDecisionsPresent(((ctx?.decisionsYaml as string) ?? '')),
  },
  {
    id: 'period_of_performance_complete',
    type: 'static',
    description: 'Period of Performance has both start + end dates (or [TBD])',
    run: (wo: string) => checkPeriodOfPerformanceComplete(wo),
  },
  {
    id: 'payment_schedule_sums_to_100',
    type: 'static',
    description: 'Milestone percentages in § 6.2 sum to exactly 100',
    run: (wo: string) => checkPaymentScheduleSumsTo100(wo),
  },
  {
    id: 'total_nte_present',
    type: 'static',
    description: '§ 6.1 has `USD <amount>` (numeric) or `USD [TBD]` placeholder',
    run: (wo: string) => checkTotalNtePresent(wo),
  },
  {
    id: 'signature_blocks_present',
    type: 'static',
    description: 'Both Subcontractor and Dimagi, Inc. signature blocks present',
    run: (wo: string) => checkSignatureBlocksPresent(wo),
  },
  {
    id: 'archetype_appropriate_scope',
    type: 'static',
    description: 'Scope of Work language matches the declared archetype',
    run: (wo: string, ctx?: QACheckContext) =>
      checkArchetypeAppropriateScope(wo, (ctx?.archetype as string | undefined) ?? null),
  },
  {
    id: 'no_scaffolding_markers',
    type: 'static',
    description: 'No `<<...>>` scaffolding markers leaked through from intermediate generation',
    run: (wo: string) => checkNoScaffoldingMarkers(wo),
  },
];
