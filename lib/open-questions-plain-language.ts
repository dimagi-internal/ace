/**
 * The open-questions ledger's OUTSIDER-PLAINNESS check.
 *
 * `ACE/<opp>/open-questions.md` is not only ACE's work list. ace-web renders
 * its `## Open` rows on the PUBLIC run-summary page an outside partner reads:
 * `question:` is the item, rows are grouped by `owner:`, `blocking:` becomes a
 * plain stage name, and `latest:` / `raised_by:` sit behind "Working notes".
 * So `question:` and `answered_where:` are addressed to the named owner, and
 * they must be answerable without knowing anything about ACE.
 *
 * The row contract this enforces lives in ONE place —
 * `skills/idea-to-pdd/SKILL.md § The durable open-questions doc` → "Row
 * contract — written for the named owner". Every other writer links there.
 *
 * ── The reproducer ─────────────────────────────────────────────────────────
 *
 * spark-facilitator's ledger (Drive revision 6, read 2026-10-03; verbatim rows
 * in `test/fixtures/open-questions/spark-facilitator-outsider-jargon.text-markdown.md`):
 * `household-count-denominator` asked Spark about `hh_count_tt`;
 * `lookup-table-provisioning` about "the v1392 app" and twelve lookup-table
 * names; `phase-authoritative-writer` about forms `m0f0, m0f3, m0f5, m0f8`;
 * `savings-indicator-denominator-bias` about `currently_saving`; and
 * `answered_where:` values named "Nova update_translations review" and "work
 * order §6". run-surface-audit-eval capped the page's jargon score at 4/10,
 * which held the release gate at `warn`.
 *
 * ── What is checked, and what is exempt ────────────────────────────────────
 *
 *   - Only `## Open` rows — the live list the page renders. `## Archive` is
 *     closed history.
 *   - Only `question:` and `answered_where:`. The technical evidence belongs
 *     in `latest:`, which outsiders see only behind "Working notes", so it is
 *     deliberately NOT scanned.
 *   - A row whose owner is internal ONLY (ACE / Operator / Connect team /
 *     Dimagi, alone or combined) is exempt: nobody outside is asked it. A row
 *     with NO owner is checked — an unowned question is still shown publicly.
 *
 * The detector is the shared outsider-text checker
 * (`auditOutsiderText(text, 'outsider')` in
 * `lib/pdd-description-plain-language.ts`), not a fourth jargon list.
 *
 * Pure — no I/O. Intra-record: it scans ACE's own output for ACE's own
 * identifier shapes, so there is no external rejection to predict.
 */

import {
  auditOutsiderText,
  plainLanguageKindLabel,
  type PlainLanguageIssueKind,
} from './pdd-description-plain-language.js';
import { extractOpenSection, parseOpenRows } from './open-questions-inline.js';

/** Owners nobody outside Dimagi / ACE answers for. Compared case-insensitively. */
const INTERNAL_OWNERS = new Set(['ace', 'operator', 'connect team', 'connect', 'dimagi', 'ace operator']);

/** The ledger fields an outside owner reads as the question put to them. */
export type OutsiderLedgerField = 'question' | 'answered_where';

export interface OpenQuestionPlainFinding {
  /** The row's `id:`, or `<unidentified row N>`. */
  rowId: string;
  /** The row's `owner:` as written, or `null` when absent. */
  owner: string | null;
  field: OutsiderLedgerField;
  kind: PlainLanguageIssueKind;
  /** The offending text, verbatim. */
  token: string;
}

export interface OpenQuestionsPlainCheck {
  /** True iff no outsider-owned `## Open` row carries an engineer-facing token. */
  ok: boolean;
  findings: OpenQuestionPlainFinding[];
  /** Ids of the rows that were exempt because their owner is internal only. */
  exemptRowIds: string[];
  /** One paragraph, pasteable into a halt. */
  reason: string;
}

/** `field:` value from a ledger row — runs to the next `**field:**` marker. */
function rowField(text: string, name: string): string | null {
  const re = new RegExp(`\\*\\*${name}:\\*\\*\\s*([\\s\\S]*?)(?=\\*\\*[A-Za-z_]+:\\*\\*|<!--|$)`);
  const v = re.exec(text)?.[1]?.trim();
  return v ? v : null;
}

/** True iff every owner named in `owner` is internal. `null` → false (checked). */
export function isInternalOnlyOwner(owner: string | null): boolean {
  if (!owner) return false;
  const parts = owner
    .split(/\s*(?:\/|,|&|\+|\band\b)\s*/i)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0 && p !== '—' && p !== '-');
  return parts.length > 0 && parts.every((p) => INTERNAL_OWNERS.has(p));
}

/**
 * Scan every `## Open` row of an open-questions ledger (pre-write markdown or
 * a `text/markdown` read-back) for text its outside owner could not read.
 *
 * A doc with no parseable `## Open` section returns `ok: true` with a reason
 * saying so — the SHAPE gate (`checkOpenQuestionsWriteShape`) owns that
 * refusal, and this check must not double-report it.
 */
export function checkOpenQuestionsPlainLanguage(markdown: string): OpenQuestionsPlainCheck {
  const outcome = extractOpenSection(markdown, 'text/markdown');
  if (outcome.status !== 'ok' && outcome.status !== 'flattened-headings') {
    return {
      ok: true,
      findings: [],
      exemptRowIds: [],
      reason: 'No `## Open` section to scan — the shape check reports that, not this one.',
    };
  }

  const { rows } = parseOpenRows(outcome.section);
  const findings: OpenQuestionPlainFinding[] = [];
  const exemptRowIds: string[] = [];

  rows.forEach((row, index) => {
    const rowId = row.id ?? `<unidentified row ${index + 1}>`;
    const owner = rowField(row.text, 'owner');
    if (isInternalOnlyOwner(owner)) {
      exemptRowIds.push(rowId);
      return;
    }
    for (const field of ['question', 'answered_where'] as const) {
      const value = rowField(row.text, field);
      if (!value) continue;
      const issues = auditOutsiderText(value, 'outsider');
      const seen = new Set<string>();
      for (const issue of issues) {
        // A backticked identifier is reported once, as the identifier: drop the
        // code span when another finding already names what is inside it.
        if (
          issue.kind === 'code_markup' &&
          issues.some((o) => o !== issue && o.kind !== 'code_markup' && issue.token.includes(o.token))
        ) {
          continue;
        }
        const key = `${issue.kind}\u0000${issue.token}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ rowId, owner, field, kind: issue.kind, token: issue.token });
      }
    }
  });

  if (findings.length === 0) {
    return {
      ok: true,
      findings,
      exemptRowIds,
      reason:
        'Every outsider-owned `## Open` row reads as a question its owner can answer without knowing ACE.',
    };
  }

  const byRow = new Map<string, string[]>();
  for (const f of findings) {
    const list = byRow.get(f.rowId) ?? [];
    list.push(`${f.field} ${plainLanguageKindLabel(f.kind)} "${f.token}"`);
    byRow.set(f.rowId, list);
  }
  const listed = [...byRow.entries()].map(([id, hits]) => `${id}: ${hits.join(', ')}`).join('; ');

  return {
    ok: false,
    findings,
    exemptRowIds,
    reason:
      'REFUSED — do not write this. ace-web shows `question:` and `answered_where:` to the named owner ' +
      `on the public run-summary page, and these rows are written for ACE instead: ${listed}. ` +
      'Rewrite `question:` so its owner can answer it without knowing ACE (name the thing as they know ' +
      'it — "the household count the app saves on the community record", not a field id), and make ' +
      '`answered_where:` a place they recognise ("your reply to this review", "the implementing ' +
      "organisation's application\", \"a call with Dimagi\"). Move the technical evidence into `latest:`, " +
      'which outsiders see only behind "Working notes" (skills/idea-to-pdd/SKILL.md § The durable ' +
      'open-questions doc → Row contract).',
  };
}
