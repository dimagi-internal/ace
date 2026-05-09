/**
 * Static QA checks for `solicitation-review-qa`.
 *
 * Each check takes the recommendation artifact text and an optional context
 * containing the scoring-rubric text + the response file list, and returns a
 * `QACheckResult`. Checks are pure functions, no LLM, fast (<1ms per check on
 * a typical recommendation doc).
 *
 * Imported by:
 * - The skill body via `scripts/qa-run.ts` at runtime (orchestrator dispatch)
 * - Per-skill tests under `test/skills/solicitation-review-qa/` (vitest)
 *
 * The `CHECKS` array is the canonical ordering — both runtime and tests
 * iterate it. Add a check by appending to the array; surface in the SKILL.md
 * `## Checks` table simultaneously.
 *
 * Context shape (passed by the runner via `--context-*` CLI args, or by tests
 * directly):
 *
 *   {
 *     scoring?: string;            // scoring-rubric.md text (checks 4, 6, 7 use this)
 *     responseFiles?: string[];    // response filenames in solicitation-monitor_responses/
 *                                  // (check 4 uses this; absence -> INFO-skip)
 *   }
 */

import type { QACheck, QACheckContext, QACheckResult } from '../../lib/qa-types';

export interface SolicitationReviewQAContext extends QACheckContext {
  /** Text of the scoring-rubric.md artifact. */
  scoring?: string;
  /** Filenames in solicitation-monitor_responses/ (used to verify all responses are scored). */
  responseFiles?: string[];
}

// ── Check 1: recommendation section present ───────────────────────────

/**
 * Check 1: Recommendation doc has a `## Recommendation` heading.
 *
 * Tolerates case variation, bold-wrapping, and trailing parentheticals,
 * matching the `idea-to-pdd-qa` heading-tolerance contract.
 */
export function checkRecommendationSectionPresent(rec: string): QACheckResult {
  if (/^##\s+(?:\*\*)?Recommendation\b/im.test(rec)) {
    return { pass: true };
  }
  return {
    pass: false,
    detail: 'missing § Recommendation section',
    auto_fix_hint:
      'add a `## Recommendation` section to the recommendation doc with a named awardee and substantive reasoning',
  };
}

// ── Check 2: awardee named ────────────────────────────────────────────

/**
 * Check 2: Recommendation block names a specific response_id or org_slug.
 *
 * Looks for `response_id: <id>` or `awardee: <slug>` patterns inside
 * (or anywhere in) the recommendation block. Rejects generic placeholders
 * ("TBD", "the top response", "<awardee>").
 */
const PLACEHOLDER_AWARDEE = /^(?:tbd|tba|n\/a|none|unknown|placeholder|<.*>|\?+|the\s+top\s+response)$/i;

export function checkAwardeeNamed(rec: string): QACheckResult {
  const recBlock = extractSection(rec, 'Recommendation') ?? rec;

  // response_id: <something>  OR  awardee: <slug>  OR org_slug: <slug>
  const idMatch = recBlock.match(/response_id\s*[:=]\s*([^\s,;)\]]+)/i);
  const slugMatch =
    recBlock.match(/awardee\s*[:=]\s*([^\s,;)\]]+)/i) ??
    recBlock.match(/org_slug\s*[:=]\s*([^\s,;)\]]+)/i);

  const named = idMatch?.[1] ?? slugMatch?.[1];
  if (!named) {
    return {
      pass: false,
      detail: 'no specific response_id or org_slug named in Recommendation block',
      auto_fix_hint:
        'name the awardee explicitly with `response_id: <id>` or `org_slug: <slug>` inside the ## Recommendation section',
    };
  }
  if (PLACEHOLDER_AWARDEE.test(named.trim())) {
    return {
      pass: false,
      detail: `awardee value is a placeholder: '${named}'`,
      auto_fix_hint:
        'replace placeholder awardee with a real `response_id` from the scoring-rubric or `org_slug` from the response file',
    };
  }
  return { pass: true, detail: `awardee=${named}` };
}

// ── Check 3: awardee reasoning substantive ────────────────────────────

/**
 * Check 3: Reasoning paragraph in the Recommendation block has ≥ 3 sentences
 * AND references at least one named criterion (heading text seen elsewhere in
 * the doc, or a known criterion-style label like "criterion", "scoring", "weight").
 *
 * Heuristic — anchored against the doc's own headings rather than a hardcoded
 * list, because criteria are PDD-defined and vary per opp.
 */
export function checkAwardeeReasoningSubstantive(rec: string): QACheckResult {
  const recBlock = extractSection(rec, 'Recommendation');
  if (recBlock === null) {
    return {
      pass: false,
      detail: 'cannot evaluate reasoning — Recommendation section missing',
      auto_fix_hint: 'add a `## Recommendation` section with substantive reasoning',
    };
  }

  // Strip key-value lines (response_id:, awardee:, etc.) before counting sentences —
  // those aren't prose reasoning. Then count `.`/`!`/`?` sentence terminators.
  const prose = recBlock
    .split('\n')
    .filter((line) => !/^\s*[-*]?\s*\w[\w_]*\s*[:=]\s*\S/.test(line))
    .join(' ');
  const sentences = (prose.match(/[.!?](?:\s|$)/g) ?? []).length;

  // Reference at least one criterion: either a named heading from elsewhere in
  // the doc OR a generic criterion-label keyword.
  const otherHeadings = Array.from(rec.matchAll(/^##\s+(?:\*\*)?([^\n*#]+?)(?:\*\*)?\s*$/gim))
    .map((m) => m[1].trim().toLowerCase())
    .filter((h) => !/^recommendation\b/i.test(h));
  const referencesAHeading = otherHeadings.some((h) =>
    h.length >= 3 && new RegExp(`\\b${escapeRegExp(h)}\\b`, 'i').test(prose),
  );
  const referencesCriterionKeyword =
    /\b(criterion|criteria|scoring|score|weight|rubric|capacity|experience|coverage|capability|geographic|fit)\b/i.test(prose);
  const referencesACriterion = referencesAHeading || referencesCriterionKeyword;

  if (sentences < 3) {
    return {
      pass: false,
      detail: `reasoning has only ${sentences} sentence(s); need ≥ 3`,
      auto_fix_hint:
        'expand the Recommendation reasoning to ≥ 3 sentences and tie each claim to a named criterion from the scoring rubric',
    };
  }
  if (!referencesACriterion) {
    return {
      pass: false,
      detail: 'reasoning does not reference any named criterion or scoring-rubric heading',
      auto_fix_hint:
        'rewrite the reasoning to cite specific criteria (e.g., "Geographic Coverage: 9/10") rather than generic praise',
    };
  }
  return { pass: true, detail: `${sentences} sentence(s); criterion reference detected` };
}

// ── Check 4: all responses scored ─────────────────────────────────────

/**
 * Check 4: Every response file has a corresponding scoring entry in the
 * scoring-rubric doc. If the response-file list isn't supplied (e.g., grading
 * the doc in isolation), surface as INFO-skip via `pass: true` with a detail
 * note — this matches the contract documented in the SKILL.md table.
 */
export function checkAllResponsesScored(rec: string, ctx?: QACheckContext): QACheckResult {
  const c = ctx as SolicitationReviewQAContext | undefined;
  const responseFiles = c?.responseFiles;
  const scoring = c?.scoring;

  if (!responseFiles || responseFiles.length === 0) {
    return {
      pass: true,
      detail: 'response files not provided; coverage check skipped (INFO)',
    };
  }
  if (!scoring) {
    return {
      pass: false,
      detail: 'scoring-rubric text not provided to runner; cannot verify coverage',
      auto_fix_hint:
        'pass the scoring-rubric.md content as `--context-scoring` to the runner; check 4 needs it',
    };
  }

  // Each response filename should appear (as a token) in the scoring text, or
  // its derived response_id should. Treat the filename stem as the response_id.
  const missing: string[] = [];
  for (const fname of responseFiles) {
    const stem = fname.replace(/\.[^.]+$/, '');
    const re = new RegExp(`\\b${escapeRegExp(stem)}\\b`);
    if (!re.test(scoring)) missing.push(stem);
  }
  if (missing.length === 0) {
    return { pass: true, detail: `${responseFiles.length} response(s) all scored` };
  }
  return {
    pass: false,
    detail: `${missing.length} response(s) missing from scoring-rubric: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}`,
    auto_fix_hint:
      'add a row to the scoring-rubric for each missing response_id; re-score before recommending',
  };
}

// ── Check 5: criteria coverage table populated ────────────────────────

/**
 * Check 5: A `## Criteria Coverage` table exists with at least one populated
 * data row. Tolerates "Criteria Coverage", "Criterion Coverage", trailing punctuation.
 */
export function checkCriteriaCoverageTablePopulated(rec: string): QACheckResult {
  const body = extractSection(rec, 'Criteri(?:on|a)\\s+Coverage');
  if (body === null) {
    return {
      pass: false,
      detail: 'missing § Criteria Coverage section',
      auto_fix_hint:
        'add a `## Criteria Coverage` section with a row per PDD-declared criterion (Criterion | Weight | Coverage Notes)',
    };
  }
  const dataRows = countTableDataRows(body);
  if (dataRows < 1) {
    return {
      pass: false,
      detail: 'Criteria Coverage section has no populated data rows',
      auto_fix_hint:
        'fill the Criteria Coverage table with at least one row per criterion declared in the PDD or scoring-rubric',
    };
  }
  return { pass: true, detail: `${dataRows} criterion row(s) found` };
}

// ── Check 6: scoring table well formed ────────────────────────────────

/**
 * Check 6: The scoring-rubric doc contains a markdown table with columns
 * `response_id`, `score`, `rationale` (case-insensitive). Every data row must
 * populate each column (no empty cells in those three columns).
 */
const SCORING_REQUIRED_COLS = ['response_id', 'score', 'rationale'] as const;

export function checkScoringTableWellFormed(_rec: string, ctx?: QACheckContext): QACheckResult {
  const c = ctx as SolicitationReviewQAContext | undefined;
  const scoring = c?.scoring;
  if (!scoring) {
    return {
      pass: false,
      detail: 'scoring-rubric text not provided to runner',
      auto_fix_hint:
        'pass the scoring-rubric.md content as `--context-scoring` to the runner; check 6 needs it',
    };
  }

  const tables = extractAllTables(scoring);
  for (const table of tables) {
    const headerCols = parseTableRow(table.header).map((c) => c.toLowerCase());
    const allPresent = SCORING_REQUIRED_COLS.every((col) =>
      headerCols.some((h) => h.includes(col)),
    );
    if (!allPresent) continue;

    // Locate the column indices for response_id / score / rationale.
    const idxs = SCORING_REQUIRED_COLS.map((col) =>
      headerCols.findIndex((h) => h.includes(col)),
    );
    let blankCells = 0;
    for (const row of table.dataRows) {
      const cells = parseTableRow(row);
      for (const i of idxs) {
        if (i < 0) continue;
        const v = (cells[i] ?? '').trim();
        if (v === '' || v === '-' || v === '—') blankCells++;
      }
    }
    if (table.dataRows.length === 0) {
      return {
        pass: false,
        detail: 'scoring table has required columns but no data rows',
        auto_fix_hint:
          'add a row per response with response_id, score, and rationale populated',
      };
    }
    if (blankCells > 0) {
      return {
        pass: false,
        detail: `scoring table has ${blankCells} empty required-column cell(s)`,
        auto_fix_hint:
          'populate every response_id / score / rationale cell; an empty cell means the response was not actually scored',
      };
    }
    return {
      pass: true,
      detail: `scoring table found with ${table.dataRows.length} response row(s)`,
    };
  }
  return {
    pass: false,
    detail: `no markdown table found with required columns: ${SCORING_REQUIRED_COLS.join(', ')}`,
    auto_fix_hint:
      'emit the scoring rubric as a markdown table with columns: response_id | score | rationale (additional columns allowed)',
  };
}

// ── Check 7: tie-break resolved ───────────────────────────────────────

/**
 * Check 7: If the top two scores in the scoring table are within 0.5 points,
 * a `## Tie-Break` section must exist with a non-empty named rationale.
 *
 * Reads scores from the scoring-rubric context. If scoring isn't provided,
 * passes with INFO (consistent with check 4's graceful degrade).
 */
export function checkTieBreakResolved(rec: string, ctx?: QACheckContext): QACheckResult {
  const c = ctx as SolicitationReviewQAContext | undefined;
  const scoring = c?.scoring;
  if (!scoring) {
    return {
      pass: true,
      detail: 'scoring text not provided; tie-break check skipped (INFO)',
    };
  }

  // Extract scores from any scoring table column whose header contains "score".
  const scores: number[] = [];
  for (const table of extractAllTables(scoring)) {
    const headerCols = parseTableRow(table.header).map((c) => c.toLowerCase());
    const scoreIdx = headerCols.findIndex((h) => /\bscore\b/.test(h) && !/rationale/.test(h));
    if (scoreIdx < 0) continue;
    for (const row of table.dataRows) {
      const cells = parseTableRow(row);
      const cell = (cells[scoreIdx] ?? '').trim();
      const m = cell.match(/-?\d+(?:\.\d+)?/);
      if (m) scores.push(parseFloat(m[0]));
    }
    if (scores.length > 0) break; // first matching table wins
  }

  if (scores.length < 2) {
    return { pass: true, detail: 'fewer than 2 scored responses; tie-break N/A' };
  }
  scores.sort((a, b) => b - a);
  const gap = scores[0] - scores[1];
  if (gap >= 0.5) {
    return { pass: true, detail: `top-two gap=${gap.toFixed(2)}; tie-break not required` };
  }

  // Within 0.5 → tie-break section required.
  const tieBreakBody = extractSection(rec, 'Tie[\\s-]?Break');
  if (tieBreakBody === null) {
    return {
      pass: false,
      detail: `top-two scores within 0.5 (gap=${gap.toFixed(2)}) but no § Tie-Break section`,
      auto_fix_hint:
        'add a `## Tie-Break` section explaining which response was chosen and why, citing the PDD or LLO-preference rationale',
    };
  }
  if (tieBreakBody.replace(/\s+/g, '').length < 20) {
    return {
      pass: false,
      detail: 'Tie-Break section is empty or near-empty',
      auto_fix_hint:
        'expand the Tie-Break section with named rationale tying the decision to a specific criterion',
    };
  }
  return { pass: true, detail: `tie-break resolved (gap=${gap.toFixed(2)})` };
}

// ── Check 8: no award action yet ──────────────────────────────────────

/**
 * Check 8: Recommendation doc must NOT claim award_response was already
 * called. QA must run BEFORE the HITL human acts. Looks for affirmative
 * award-action language ("award_response called", "awarded_at:",
 * "status: awarded", etc.). Tolerates *recommendation* language ("recommend
 * awarding", "proposed awardee") which is the doc's whole point.
 */
const AWARD_ACTION_PATTERNS: RegExp[] = [
  /\baward_response\s*\(?\s*(?:called|invoked|completed|succeeded)\b/i,
  /\bawarded_at\s*[:=]/i,
  /\bstatus\s*[:=]\s*['"]?awarded\b/i,
  /\bawarded_org_slug\s*[:=]/i,
  /\baward(?:ed)?\s+confirmed\b/i,
];

export function checkNoAwardActionYet(rec: string): QACheckResult {
  for (const re of AWARD_ACTION_PATTERNS) {
    const m = rec.match(re);
    if (m) {
      return {
        pass: false,
        detail: `recommendation doc contains award-action language: '${m[0]}'`,
        auto_fix_hint:
          'remove award-action language from the recommendation doc; QA must run BEFORE the HITL gate, and award fields belong in the separate award-record.md',
      };
    }
  }
  return { pass: true, detail: 'no premature award-action language detected' };
}

// ── Helpers ───────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract the body of a `## <heading>` section. Mirror of the helper in
 * `idea-to-pdd-qa/checks.ts`; duplicated rather than shared because each QA
 * skill's checks file is intentionally self-contained.
 */
function extractSection(doc: string, headingPattern: string): string | null {
  const headingRe = new RegExp(`^##\\s+(?:\\*\\*)?${headingPattern}[^\\n]*$`, 'im');
  const headingMatch = doc.match(headingRe);
  if (!headingMatch || headingMatch.index === undefined) return null;
  const bodyStart = headingMatch.index + headingMatch[0].length;
  const tail = doc.slice(bodyStart);
  const nextHeadingMatch = tail.match(/^##\s/m);
  const bodyEnd =
    nextHeadingMatch && nextHeadingMatch.index !== undefined
      ? bodyStart + nextHeadingMatch.index
      : doc.length;
  return doc.slice(bodyStart, bodyEnd);
}

/** Count "data" rows in a markdown table (excluding the header separator). */
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
    if (separatorSeen) dataRows++;
  }
  return dataRows;
}

/**
 * Extract all markdown tables from a doc. Each result has the raw header
 * line and the raw data row lines (separator excluded).
 */
interface MarkdownTable {
  header: string;
  dataRows: string[];
}
function extractAllTables(doc: string): MarkdownTable[] {
  const lines = doc.split('\n');
  const tables: MarkdownTable[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|.*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s|:-]+\|\s*$/.test(lines[i + 1])) {
      const header = line;
      const dataRows: string[] = [];
      let j = i + 2;
      while (j < lines.length && /^\s*\|.*\|/.test(lines[j])) {
        if (!/^\s*\|[\s|:-]+\|\s*$/.test(lines[j])) {
          dataRows.push(lines[j]);
        }
        j++;
      }
      tables.push({ header, dataRows });
      i = j;
    } else {
      i++;
    }
  }
  return tables;
}

/** Parse a `| a | b | c |` table row into trimmed cell strings. */
function parseTableRow(row: string): string[] {
  // Strip leading/trailing pipe + whitespace, then split on `|`.
  const stripped = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return stripped.split('|').map((c) => c.trim());
}

// ── Canonical CHECKS array ────────────────────────────────────────────

export const CHECKS: QACheck[] = [
  {
    id: 'recommendation_section_present',
    type: 'static',
    description: 'Recommendation doc has a § Recommendation heading',
    run: checkRecommendationSectionPresent,
  },
  {
    id: 'awardee_named',
    type: 'static',
    description: 'Recommendation block names a specific response_id or org_slug',
    run: checkAwardeeNamed,
  },
  {
    id: 'awardee_reasoning_substantive',
    type: 'static',
    description: 'Recommendation reasoning has ≥ 3 sentences and references a named criterion',
    run: checkAwardeeReasoningSubstantive,
  },
  {
    id: 'all_responses_scored',
    type: 'static',
    description: 'Every response file has a corresponding scoring entry (graceful skip if list absent)',
    run: checkAllResponsesScored,
  },
  {
    id: 'criteria_coverage_table_populated',
    type: 'static',
    description: '§ Criteria Coverage table exists with rows for each criterion',
    run: checkCriteriaCoverageTablePopulated,
  },
  {
    id: 'scoring_table_well_formed',
    type: 'static',
    description: 'Scoring table has columns response_id/score/rationale, all rows populated',
    run: checkScoringTableWellFormed,
  },
  {
    id: 'tie_break_resolved',
    type: 'static',
    description: 'If top two scores are within 0.5 points, § Tie-Break section exists with named rationale',
    run: checkTieBreakResolved,
  },
  {
    id: 'no_award_action_yet',
    type: 'static',
    description: 'Doc does NOT claim award_response was already called (QA runs BEFORE the HITL gate)',
    run: checkNoAwardActionYet,
  },
];
