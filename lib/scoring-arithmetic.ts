/**
 * Does a Learn app's generated scoring arithmetic actually compute what it
 * claims?
 *
 * Why this exists (dimagi-internal/ace#1035). Connect reads `user_score` off
 * Learn assessment submissions (`dimagi/commcare-connect@5f69bb3d`
 * `commcare_connect/form_receiver/processor.py:230`), and CommCare has **no
 * "mark this option correct" primitive** — Vellum's Assessment Score mug takes
 * a hand-written XPath expression (`dimagi/Vellum@8a1ef02`
 * `src/commcareConnect.js:180-198`). Nova's maintainer confirmed that is the
 * platform's shape, not a Nova gap (nova#372, recommended for closure).
 *
 * So the score is arithmetic the ARCHITECT writes, and nothing checked it. The
 * Household Poverty Targeting Learn app spends 36+ hidden fields on scoring
 * alone — 20 post-test, 10 pre-test, plus per-area rollups. One wrong
 * `q<N>_score` condition, or a rollup that omits a single term, produces a
 * plausible score that is quietly wrong:
 *
 *  - no `-eval` grades the arithmetic — they grade the app against the PDD,
 *    and the PDD carries no per-item score expressions;
 *  - `app-release-qa` is structural: form counts and Connect markers, not
 *    calculate semantics.
 *
 * And a worker's pass/fail against the opportunity's `passing_score` depends on
 * it, so a wrong score **gates the wrong people out of paid work**.
 *
 * All of this is readable from the released form XML. No emulator, no device —
 * which is why it belongs beside `checkAssessmentRetryLeak` in
 * `app-release-qa`, which already parses the same artifact.
 *
 * ## What it deliberately does not do
 *
 * It does not judge whether the CORRECT ANSWER is correct — that is content,
 * not arithmetic, and `assessment_rule_coverage` owns it. It checks the five
 * things that are purely mechanical: every item scores its OWN question, every
 * item can award its point, the rollup names every item and no phantom, and
 * the percentage denominator matches the item count.
 */

import { DOMParser } from '@xmldom/xmldom';

export type ScoringFindingKind =
  /** The rollup omits an item that exists. */
  | 'missing-term'
  /** The rollup names an item with no bind. */
  | 'extra-term'
  /** `* 100 div N` where N is not the item count. */
  | 'denominator-mismatch'
  /** An item's calculate never references its own question node. */
  | 'self-reference-missing'
  /** An item can never award a point, so full marks are unreachable. */
  | 'unreachable-max'
  /** Items exist but nothing rolls them up. */
  | 'no-rollup';

export interface ScoringFinding {
  kind: ScoringFindingKind;
  detail: string;
}

export interface ScoringReport {
  /** False when the form carries no scoring at all — not applicable, NOT a pass. */
  checked: boolean;
  ok: boolean;
  itemScores: string[];
  findings: ScoringFinding[];
}

// Item-score nodes are `<prefix><n>_score` where the prefix is whatever the
// architect named the questions — `q1_score` on a post-test, `p1_score` on a
// pre-test, and both in the same Learn app whenever it carries baseline AND
// assessment instruments. This used to hard-code `q`, so a `p`-prefixed
// pre-test matched zero items and the function returned `checked: false` —
// which `app-release-qa` defines as "not applicable, NOT a pass". The gate
// silently covered nothing on a form that did carry item scores
// (dimagi-internal/ace#1538; observed on hh-poverty-targeting/20260819-1435,
// Learn build 35384a8007114f29b5e04b9ac78274a2, modules-0/forms-0.xml).
const ITEM_SCORE = /^\/data\/([a-z][\w-]*?\d+)_score$/;

interface Bind {
  nodeset: string;
  calculate: string;
}

function scoringBinds(xml: string): Bind[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  const out: Bind[] = [];
  for (const b of Array.from(doc.getElementsByTagName('bind'))) {
    const nodeset = b.getAttribute('nodeset');
    const calculate = b.getAttribute('calculate');
    if (nodeset && calculate) out.push({ nodeset, calculate });
  }
  return out;
}

export function checkScoringArithmetic(xml: string): ScoringReport {
  const binds = scoringBinds(xml);
  const items = binds.filter((b) => ITEM_SCORE.test(b.nodeset));
  const rollup = binds.find((b) => /\/user_score$/.test(b.nodeset));

  if (items.length === 0) {
    return { checked: false, ok: true, itemScores: [], findings: [] };
  }

  const findings: ScoringFinding[] = [];
  const itemScores = items.map((i) => i.nodeset);

  for (const item of items) {
    const question = item.nodeset.replace(/_score$/, '');
    // The item must compare its OWN question. Copy-paste across 20 hidden
    // fields is exactly how a wrong-but-plausible score is produced.
    if (!new RegExp(`${question.replace(/\//g, '\\/')}\\b`).test(item.calculate)) {
      findings.push({
        kind: 'self-reference-missing',
        detail: `${item.nodeset} never references ${question} — it scores a different question, or none`,
      });
    }
    // Every item must be able to award a point, or full marks are unreachable
    // and the gate is stricter than anyone intended.
    const branches = [...item.calculate.matchAll(/\bif\s*\([^,]+,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/g)];
    if (branches.length && !branches.some((b) => Number(b[1]) > 0 || Number(b[2]) > 0)) {
      findings.push({
        kind: 'unreachable-max',
        detail: `${item.nodeset} awards 0 on every branch — the maximum score is unreachable`,
      });
    }
  }

  if (!rollup) {
    findings.push({
      kind: 'no-rollup',
      detail:
        `${items.length} item score(s) are computed but no user_score rolls them up — Connect reads ` +
        'user_score and would find nothing',
    });
    return { checked: true, ok: false, itemScores, findings };
  }

  const referenced = new Set(
    [...rollup.calculate.matchAll(/\/data\/[\w/-]*?_score\b/g)].map((m) => m[0]),
  );
  for (const item of items) {
    if (!referenced.has(item.nodeset)) {
      findings.push({
        kind: 'missing-term',
        detail: `${rollup.nodeset} omits ${item.nodeset} — every submission scores lower than it should, silently`,
      });
    }
  }
  for (const ref of referenced) {
    if (ITEM_SCORE.test(ref) && !itemScores.includes(ref)) {
      findings.push({
        kind: 'extra-term',
        detail: `${rollup.nodeset} references ${ref}, which has no bind — it contributes nothing and hides a typo`,
      });
    }
  }

  // `* 100 div N` is the percentage form Connect's 0-100 passing_score needs.
  // A raw-sum rollup is a different (documented) shape and is not second-guessed
  // here — `_app-component-library § assessment-gate` owns that choice.
  const denom = /\*\s*100\s+div\s+(\d+)/.exec(rollup.calculate);
  if (denom && Number(denom[1]) !== items.length) {
    findings.push({
      kind: 'denominator-mismatch',
      detail:
        `${rollup.nodeset} divides by ${denom[1]} but the form carries ${items.length} scored item(s) — ` +
        `every worker's percentage is wrong by a factor of ${items.length}/${denom[1]}`,
    });
  }

  return { checked: true, ok: findings.length === 0, itemScores, findings };
}

export function formatScoringReport(r: ScoringReport): string {
  if (!r.checked) return 'scoring-arithmetic: not applicable (form carries no item scores)';
  if (r.ok) {
    return `scoring-arithmetic: clean — ${r.itemScores.length} item score(s) roll up correctly`;
  }
  return [
    `scoring-arithmetic: ${r.findings.length} defect(s) in the generated scoring —`,
    'the score is arithmetic the architect writes by hand (CommCare has no correct-option',
    "primitive), and a worker's pass/fail against the opportunity's passing_score depends on it,",
    'so a wrong score gates the wrong people out of paid work (dimagi-internal/ace#1035).',
    ...r.findings.map((f) => `  [${f.kind}] ${f.detail}`),
  ].join('\n');
}
