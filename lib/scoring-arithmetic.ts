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
import { type CheckOutcome, checked, unable, formatUnable } from './check-outcome.js';

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

/**
 * `status: 'unable'` when the form carries no scoring at all. That is NOT a
 * pass, and it is no longer expressible as one — see `lib/check-outcome.ts`.
 * This helper's own `checked: false, ok: true` return was the canonical
 * instance of the class (ace#1634).
 */
export type ScoringReport = CheckOutcome<ScoringFinding, { itemScores: string[] }>;

// Item-score nodes are `<prefix><n>_score` where the prefix is whatever the
// architect named the questions — `q1_score` on a post-test, `p1_score` on a
// pre-test, and both in the same Learn app whenever it carries baseline AND
// assessment instruments. This used to hard-code `q`, so a `p`-prefixed
// pre-test matched zero items and the function returned `checked: false` —
// which `app-release-qa` defines as "not applicable, NOT a pass". The gate
// silently covered nothing on a form that did carry item scores
// (dimagi-internal/ace#1538; observed on hh-poverty-targeting/20260819-1435,
// Learn build 35384a8007114f29b5e04b9ac78274a2, modules-0/forms-0.xml).
// ...and it must match at ANY depth. This used to anchor as
// `^/data/<name>_score$`, admitting only a score node sitting DIRECTLY under
// `/data`. Nova nests fields inside their section/group container, so on any
// form built with `set_form_sections` — ACE's standard Nova output shape — the
// score nodes are one level deeper and matched zero, and the function again
// returned `checked: false`. ace#1538 fixed the PREFIX half of this regex and
// never touched the DEPTH half (dimagi-internal/ace#1634; observed on
// bednet-check-2-visit/20260825-1310, Learn build
// 59e714e4d46b444690c3b7ea00be68ef, `/data/check_result/q1_score` and
// `/data/your_baseline/b1_score`).
const ITEM_SCORE = /^\/data\/(?:[\w-]+\/)*([a-z][\w-]*?\d+)_score$/;

interface Bind {
  nodeset: string;
  calculate: string;
}

const CONNECT_LEARN_NS = 'http://commcareconnect.com/data/v1/learn';
const SCORE_REF = /\/data\/[\w/-]*?_score\b/g;

function parse(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
}

function scoringBinds(doc: Document): Bind[] {
  const out: Bind[] = [];
  for (const b of Array.from(doc.getElementsByTagName('bind'))) {
    const nodeset = b.getAttribute('nodeset');
    const calculate = b.getAttribute('calculate');
    if (nodeset && calculate) out.push({ nodeset, calculate });
  }
  return out;
}

/** Does the form carry Connect's `<assessment xmlns=".../data/v1/learn">` block? */
function isAssessmentForm(doc: Document): boolean {
  return doc.getElementsByTagNameNS(CONNECT_LEARN_NS, 'assessment').length > 0;
}

/**
 * The rollup on a form WITHOUT a Connect assessment block — an ungraded
 * baseline/pre-test (dimagi-internal/ace#2958). Such a form must NOT carry
 * `user_score`: Connect's `process_assessments` sets `passed` for every
 * submitted block carrying one, with any-passed semantics, so a baseline with
 * a `user_score` passes a worker who never opened a module (ace#1131). Its
 * items roll up into a node of any other name (`baseline_score` on
 * noora-health/20261015-1129), and that node gets the same term and
 * denominator checks. Chosen as the non-item calculate referencing the most
 * item scores.
 */
function ungradedRollup(binds: Bind[], itemScores: string[]): Bind | undefined {
  let best: Bind | undefined;
  let bestHits = 0;
  for (const b of binds) {
    if (itemScores.includes(b.nodeset)) continue;
    const refs = new Set([...b.calculate.matchAll(SCORE_REF)].map((m) => m[0]));
    const hits = itemScores.filter((s) => refs.has(s)).length;
    if (hits > bestHits) {
      best = b;
      bestHits = hits;
    }
  }
  return best;
}

/**
 * The branches of a rollup that is a top-level `if(pred, A, B)` — a
 * role-partitioned score, where each worker answers only her own bank and the
 * rollup picks the bank by role (kaduna-graduation/20261015-1411: two 10-item
 * banks, each `* 100 div 10`, over a 20-item form; dimagi-internal/ace#2990).
 * A nested `if` in either branch is flattened, so three or more banks work
 * too. Returns `undefined` when the rollup is not a top-level `if`, which
 * keeps the whole-form denominator check for everything else. The split is
 * balanced over `()` and `[]` and ignores commas inside quoted literals, so a
 * predicate carrying a `casedb` lookup does not break it.
 */
function ifBranches(calc: string): string[] | undefined {
  const args = topLevelIfArgs(calc);
  if (!args) return undefined;
  return args.slice(1).flatMap((b) => ifBranches(b) ?? [b]);
}

function topLevelIfArgs(calc: string): string[] | undefined {
  const s = calc.trim();
  const head = /^if\s*\(/.exec(s);
  if (!head) return undefined;
  const args: string[] = [];
  let depth = 1;
  let quote: string | null = null;
  let start = head[0].length;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') {
      depth--;
      if (depth === 0) {
        // The `if(...)` must be the WHOLE expression — `if(...) + x` is not a
        // partition, and its branches do not each carry the full score.
        if (s.slice(i + 1).trim() !== '') return undefined;
        args.push(s.slice(start, i));
        return args.length === 3 ? args : undefined;
      }
    } else if (c === ',' && depth === 1) {
      args.push(s.slice(start, i));
      start = i + 1;
    }
  }
  return undefined;
}

const PERCENT_DENOM = /\*\s*100\s+div\s+(\d+)/;

export function checkScoringArithmetic(xml: string): ScoringReport {
  const doc = parse(xml);
  const binds = scoringBinds(doc);
  const items = binds.filter((b) => ITEM_SCORE.test(b.nodeset));
  const assessment = isAssessmentForm(doc);
  const userScore = binds.find((b) => /\/user_score$/.test(b.nodeset));
  // On an ungraded form a user_score is ace#1131's defect, not the rollup we
  // want; look for its own rollup. An assessment form is read by Connect via
  // user_score only, so nothing else can stand in for it there.
  const rollup =
    userScore ??
    (assessment ? undefined : ungradedRollup(binds, items.map((i) => i.nodeset)));

  if (items.length === 0) {
    return unable(
      `the form declares ${binds.length} calculate bind(s) but none match an item-score node ` +
        '(`<prefix><n>_score` at any depth under /data), so there is no scoring arithmetic to ' +
        'verify. If this form DOES carry item scores, ITEM_SCORE is the bug',
    );
  }

  const findings: ScoringFinding[] = [];
  const itemScores = items.map((i) => i.nodeset);

  for (const item of items) {
    // Match on the node's TAIL segment, not its full path. The score node and
    // the question it scores are siblings only on a FLAT form; once the
    // architect groups them into sections the score lives at
    // `/data/check_result/q1_score` while the question is at
    // `/data/check_q1/q1`, and a full-path derivation reports every correct
    // item as `self-reference-missing`. Coupled to the ITEM_SCORE depth fix
    // above — landing that one alone turns this into a false BLOCKER on
    // exactly the forms it was widened to cover (ace#1634).
    const question = ITEM_SCORE.exec(item.nodeset)?.[1] ?? '';
    if (!new RegExp(`(^|/)${question}\\b`).test(item.calculate)) {
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
      detail: assessment
        ? `${items.length} item score(s) are computed but no user_score rolls them up — Connect reads ` +
          'user_score and would find nothing'
        : `${items.length} item score(s) are computed but no calculate rolls them up — the scoring is ` +
          'dead weight. This form carries no Connect assessment block, so the rollup must NOT be ' +
          'named user_score (ace#1131)',
    });
    return { ...checked(false, findings), itemScores };
  }

  const referenced = new Set([...rollup.calculate.matchAll(SCORE_REF)].map((m) => m[0]));
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
  //
  // A role-partitioned `if(pred, A, B)` rollup is judged per branch: each
  // branch's denominator must equal the item terms THAT branch sums, since a
  // worker only ever answers one bank (ace#2990). The term checks above still
  // run over the union, so together the branches must cover every item.
  const branches = ifBranches(rollup.calculate);
  if (branches) {
    branches.forEach((branch, i) => {
      const d = PERCENT_DENOM.exec(branch);
      if (!d) return;
      const terms = new Set(
        [...branch.matchAll(SCORE_REF)].map((m) => m[0]).filter((r) => ITEM_SCORE.test(r)),
      ).size;
      if (terms > 0 && Number(d[1]) !== terms) {
        findings.push({
          kind: 'denominator-mismatch',
          detail:
            `${rollup.nodeset} branch ${i + 1} of its if() divides by ${d[1]} but sums ${terms} scored ` +
            `item(s) — every worker on that branch scores wrong by a factor of ${terms}/${d[1]}`,
        });
      }
    });
    return { ...checked(findings.length === 0, findings), itemScores };
  }
  const denom = PERCENT_DENOM.exec(rollup.calculate);
  if (denom && Number(denom[1]) !== items.length) {
    findings.push({
      kind: 'denominator-mismatch',
      detail:
        `${rollup.nodeset} divides by ${denom[1]} but the form carries ${items.length} scored item(s) — ` +
        `every worker's percentage is wrong by a factor of ${items.length}/${denom[1]}`,
    });
  }

  return { ...checked(findings.length === 0, findings), itemScores };
}

export function formatScoringReport(r: ScoringReport): string {
  if (r.status === 'unable') return formatUnable('scoring-arithmetic', r.reason);
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
