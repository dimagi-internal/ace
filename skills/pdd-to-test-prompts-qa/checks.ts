/**
 * Static QA checks for `pdd-to-test-prompts-qa`.
 *
 * Validates structural correctness of the `pdd-to-test-prompts.md`
 * artifact: header + count, ≥8 prompts, each prompt has the required
 * fields, all 7 adversarial categories present, ≥20% adversarial share,
 * at least one training-gap / product-feedback / escalation prompt.
 *
 * Quality concerns (whether expected answers are specific enough,
 * whether adversarial prompts are genuinely tricky, whether the prompt
 * phrasing sounds like a real LLO supervisor) live in the companion
 * `pdd-to-test-prompts-eval`.
 */

import type { QACheck, QACheckResult } from '../../lib/qa-types';
import { normalizeDriveExport } from '../../lib/drive-export';

/**
 * Drive-export escape normalisation, applied at the entry of every check so
 * the reader's `exportAs` stops being load-bearing.
 *
 * WHY: every anchor in this file is markdown SYNTAX — `listPrompts` matches
 * `^##\s+Prompt\s+N`, the title matches `^#\s+Test Prompts`, and every field
 * check matches `**<Field>:**`. `pdd-to-test-prompts` writes the artifact with
 * `drive_create_file`, which lands a Google Doc whose body was imported as
 * `text/plain` — so those markers survive as LITERAL characters rather than
 * becoming heading styles and bold runs. A `text/markdown` export therefore
 * has to escape them to preserve them, and `## Prompt 4` comes back as
 * `\#\# Prompt 4`, `**Category:**` as `\*\*Category:\*\*`.
 *
 * Measured on the real artifact for `bednet-check-2-visit/20260907-1126`
 * (fileId `1l0satmkozVVDH0A0vcjw3u6bjFQsgZs3G5OXcDb4X8E`, revision 7, 58
 * prompts, structurally correct): the `text/plain` export scored 8/8 and the
 * `text/markdown` export scored 2/8 — 0 prompts found, six hard failures, and
 * the two "passes" vacuous (an empty prompt list has no missing fields and no
 * adversarial share to fall short of). The auto-fix loop cannot converge on
 * that, because nothing is wrong with the document (dimagi-internal/ace#2169).
 *
 * `SKILL.md` § Process step 1 mandates `text/plain` for this skill. This is
 * the safety net for when a caller passes the other one anyway — the same
 * shape both siblings landed (`pdd-to-work-order-qa` ace#1609,
 * `idea-to-pdd-qa` ace#1617), sharing the same normaliser.
 */
export { normalizeDriveExport } from '../../lib/drive-export';

const REQUIRED_FIELDS = [
  'Category',
  'Question',
  'Expected answer summary',
  'Expected tags',
  'Expected escalation',
] as const;

const ADVERSARIAL_CATEGORIES = [
  'should-refuse',
  'out-of-scope',
  'hallucination-probe',
  'leading-question',
  'negative-frame',
  'safety-critical',
  'ambiguous-intent',
] as const;

/** Minimum share of the suite that must be adversarial (matches producer). */
const ADVERSARIAL_SHARE_FLOOR = 0.2;

/** Check 1: Has a top-level title and a "Total prompts: N" line. */
export function checkHeaderWithTotalCount(raw: string): QACheckResult {
  const doc = normalizeDriveExport(raw);
  const titleRe = /^#\s+(?:OCS\s+)?Test\s+Prompts\b/im;
  if (!titleRe.test(doc)) {
    return {
      pass: false,
      detail: 'missing top-level # Test Prompts heading',
      auto_fix_hint: 'add a `# OCS Test Prompts — <opp-name>` heading at the top of the doc',
    };
  }
  const totalRe = /Total\s+prompts:\s*(\d+)/im;
  const m = doc.match(totalRe);
  if (!m) {
    return {
      pass: false,
      detail: 'missing `Total prompts: N` line',
      auto_fix_hint: 'add a `Total prompts: N` line in the header (where N matches the actual prompt count)',
    };
  }
  const declared = parseInt(m[1], 10);
  const actual = listPrompts(doc).length;
  if (declared !== actual) {
    return {
      pass: false,
      detail: `header declares ${declared} prompts but doc contains ${actual}`,
      auto_fix_hint: `update the header line to read "Total prompts: ${actual}" (or add/remove prompts to match the declared count)`,
    };
  }
  return { pass: true, detail: `${declared} prompts declared and present` };
}

/** Check 2: ≥8 prompts and ≤80 prompts. */
export function checkPromptCountInRange(raw: string): QACheckResult {
  const doc = normalizeDriveExport(raw);
  const prompts = listPrompts(doc);
  if (prompts.length < 8) {
    return {
      pass: false,
      detail: `${prompts.length} prompts, expected ≥8 (cross-archetype categories + 7 adversarial)`,
      auto_fix_hint: 'add prompts to cover at least the cross-archetype categories (intervention-basics, escalation, training-gap, product-feedback) plus all 7 adversarial categories',
    };
  }
  if (prompts.length > 80) {
    return {
      pass: false,
      detail: `${prompts.length} prompts, expected ≤80`,
      auto_fix_hint: 'consolidate; ocs-chatbot-eval-deep grader budget caps at ~50-80 prompts to keep wall-clock reasonable',
    };
  }
  return { pass: true, detail: `${prompts.length} prompts` };
}

/** Check 3: Every prompt has all 5 required fields. */
export function checkEachPromptHasRequiredFields(raw: string): QACheckResult {
  const doc = normalizeDriveExport(raw);
  const failures: string[] = [];
  for (const { name, body } of listPrompts(doc)) {
    const missing: string[] = [];
    for (const field of REQUIRED_FIELDS) {
      const re = new RegExp(`\\*\\*${field}:?\\*\\*`, 'i');
      if (!re.test(body)) {
        missing.push(field);
      }
    }
    if (missing.length > 0) {
      failures.push(`${name} (missing: ${missing.join(', ')})`);
    }
  }
  if (failures.length > 0) {
    return {
      pass: false,
      detail: `${failures.length} prompt(s) missing required fields: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? '…' : ''}`,
      auto_fix_hint: `every prompt must have these fields: ${REQUIRED_FIELDS.join(', ')}`,
    };
  }
  return { pass: true };
}

/** Check 4: All 7 adversarial categories are represented in at least one prompt. */
export function checkAdversarialCoverage(raw: string): QACheckResult {
  const doc = normalizeDriveExport(raw);
  const categoriesPresent = new Set<string>();
  for (const { body } of listPrompts(doc)) {
    const categoryMatch = body.match(/\*\*Category:?\*\*\s*([a-z-]+)/im);
    if (categoryMatch) {
      categoriesPresent.add(categoryMatch[1].toLowerCase());
    }
  }
  const missing = ADVERSARIAL_CATEGORIES.filter((c) => !categoriesPresent.has(c));
  if (missing.length > 0) {
    return {
      pass: false,
      detail: `missing adversarial categories: ${missing.join(', ')}`,
      auto_fix_hint: `add at least one prompt in each missing adversarial category: ${missing.join(', ')} (per skills/pdd-to-test-prompts/SKILL.md § Process step 3)`,
    };
  }
  return { pass: true, detail: 'all 7 adversarial categories represented' };
}

/** Check 5: ≥20% of prompts are in adversarial categories. */
export function checkAdversarialShareMinimum(raw: string): QACheckResult {
  const doc = normalizeDriveExport(raw);
  const prompts = listPrompts(doc);
  if (prompts.length === 0) {
    return { pass: true, detail: 'no prompts to evaluate' };
  }
  let adversarialCount = 0;
  for (const { body } of prompts) {
    const m = body.match(/\*\*Category:?\*\*\s*([a-z-]+)/im);
    if (m && (ADVERSARIAL_CATEGORIES as readonly string[]).includes(m[1].toLowerCase())) {
      adversarialCount++;
    }
  }
  const share = adversarialCount / prompts.length;
  if (share < ADVERSARIAL_SHARE_FLOOR) {
    return {
      pass: false,
      detail: `${adversarialCount}/${prompts.length} (${(share * 100).toFixed(0)}%) adversarial; ≥20% required`,
      auto_fix_hint: `increase adversarial share to ≥20% — add prompts in should-refuse / out-of-scope / hallucination-probe / leading-question / negative-frame / safety-critical / ambiguous-intent categories. Currently need ${Math.ceil(ADVERSARIAL_SHARE_FLOOR * prompts.length) - adversarialCount} more`,
    };
  }
  return { pass: true, detail: `${adversarialCount}/${prompts.length} (${(share * 100).toFixed(0)}%) adversarial` };
}

/** Check 6: At least one prompt expects `[training-gap]` tag. */
export function checkTrainingGapPromptPresent(raw: string): QACheckResult {
  const doc = normalizeDriveExport(raw);
  for (const { body } of listPrompts(doc)) {
    const tags = extractFieldValue(body, 'Expected tags');
    if (tags && /training[- ]gap/i.test(tags)) {
      return { pass: true };
    }
  }
  return {
    pass: false,
    detail: 'no prompt declares Expected tags: [training-gap]',
    auto_fix_hint: 'add at least one prompt whose Expected tags include `[training-gap]` — questions the bot should tag because the answer is in the KB but the LLO didn\'t know',
  };
}

/** Check 7: At least one prompt expects `[product-feedback]` tag. */
export function checkProductFeedbackPromptPresent(raw: string): QACheckResult {
  const doc = normalizeDriveExport(raw);
  for (const { body } of listPrompts(doc)) {
    const tags = extractFieldValue(body, 'Expected tags');
    if (tags && /product[- ]feedback/i.test(tags)) {
      return { pass: true };
    }
  }
  return {
    pass: false,
    detail: 'no prompt declares Expected tags: [product-feedback]',
    auto_fix_hint: 'add at least one prompt whose Expected tags include `[product-feedback]` — questions about known product limitations',
  };
}

/** Check 8: At least one prompt expects an escalation (mentions ace@dimagi-ai.com or admin group). */
export function checkEscalationPromptPresent(raw: string): QACheckResult {
  const doc = normalizeDriveExport(raw);
  for (const { body } of listPrompts(doc)) {
    const escalation = extractFieldValue(body, 'Expected escalation');
    if (escalation && (escalation.includes('@') || /admin\s+group|escal/i.test(escalation))) {
      return { pass: true };
    }
  }
  return {
    pass: false,
    detail: 'no prompt has a non-trivial Expected escalation',
    auto_fix_hint: 'add at least one prompt whose Expected escalation mentions ace@dimagi-ai.com or the admin group (a question that should trigger the bot to escalate)',
  };
}

// ── Helpers ────────────────────────────────────────────────────────

interface Prompt {
  name: string;
  body: string;
}

function listPrompts(doc: string): Prompt[] {
  const out: Prompt[] = [];
  const re = /^##\s+Prompt\s+(\d+)([^\n]*)$/gim;
  const matches: { name: string; index: number; length: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    matches.push({
      name: `Prompt ${m[1]}`,
      index: m.index,
      length: m[0].length,
    });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : doc.length;
    out.push({
      name: matches[i].name,
      body: doc.slice(start, end),
    });
  }
  return out;
}

/** Extract the value of a `**Field:** <value>` line within a prompt body. */
function extractFieldValue(body: string, field: string): string | null {
  const re = new RegExp(`\\*\\*${field}:?\\*\\*\\s*(.+?)(?=\\n\\*\\*|\\n##|$)`, 'is');
  const m = body.match(re);
  return m ? m[1].trim() : null;
}

// ── Canonical CHECKS array ────────────────────────────────────────

export const CHECKS: QACheck[] = [
  {
    id: 'header_with_total_count',
    type: 'static',
    description: 'Title heading present + "Total prompts: N" matches actual count',
    run: checkHeaderWithTotalCount,
  },
  {
    id: 'prompt_count_in_range',
    type: 'static',
    description: '≥8 and ≤80 prompts',
    run: checkPromptCountInRange,
  },
  {
    id: 'each_prompt_has_required_fields',
    type: 'static',
    description: 'Every prompt has Category, Question, Expected answer summary, Expected tags, Expected escalation',
    run: checkEachPromptHasRequiredFields,
  },
  {
    id: 'adversarial_coverage',
    type: 'static',
    description: 'All 7 adversarial categories represented in ≥1 prompt each',
    run: checkAdversarialCoverage,
  },
  {
    id: 'adversarial_share_minimum',
    type: 'static',
    description: '≥20% of prompts are adversarial',
    run: checkAdversarialShareMinimum,
  },
  {
    id: 'training_gap_prompt_present',
    type: 'static',
    description: '≥1 prompt with Expected tags: [training-gap]',
    run: checkTrainingGapPromptPresent,
  },
  {
    id: 'product_feedback_prompt_present',
    type: 'static',
    description: '≥1 prompt with Expected tags: [product-feedback]',
    run: checkProductFeedbackPromptPresent,
  },
  {
    id: 'escalation_prompt_present',
    type: 'static',
    description: '≥1 prompt with non-trivial Expected escalation',
    run: checkEscalationPromptPresent,
  },
];
