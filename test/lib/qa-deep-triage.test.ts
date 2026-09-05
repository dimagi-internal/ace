/**
 * Tests for `lib/qa-deep-triage.ts`.
 *
 * Fixture: the real findings from `spark-facilitator/20260828-0703`'s two deep
 * verdicts, quoted from `6-qa-and-training/app-ux-eval_verdict-deep.yaml` and
 * `5-ocs/ocs-chatbot-eval_verdict-deep.yaml`.
 *
 * That run is the calibration case for the whole module: five app BLOCKERs, of
 * which TWO were ACE's own harness defects (ace#1982, ace#1885) presented to the
 * operator as product defects. The operator had to route fifteen findings across
 * four owners by hand, over six rounds of conversation.
 */
import { describe, it, expect } from 'vitest';
import {
  explicitOwner,
  suggestOwner,
  triageFindings,
  buildDecisionSet,
  formatDecisionBrief,
  SELF_HEALABLE_OWNERS,
  type RawFinding,
} from '../../lib/qa-deep-triage.js';

/** Verbatim from the 20260828-0703 app verdict's `auto_surfaced`. */
const APP_BLOCKER_CASE_STATE =
  'The community case\'s durable state does not advance on a real meeting. ' +
  "Chilanga's \"Last meeting\" reads 29 Aug 2026 at 08:40, 08:49 and 09:00 after " +
  'three submitted-and-synced meetings dated 01 Sep 2026.';

const APP_BLOCKER_GEOPOINT =
  'The meeting geopoint preloads from the previous visit and self-certifies. ' +
  'The widget is already populated, the button relabelled REPLACE LOCATION and ' +
  '"Location accuracy is good." rendered before the CBF acts.';

const APP_WARN_ASSERTION =
  'Two structural criteria are recorded as `satisfied` in the manifest on ' +
  'assertions that do not test them. `case_state_updated_after_submit` was ' +
  'asserted as assertVisible "Chilanga.*" and never checked that the date changed.';

const OCS_BLOCKER_FABRICATION =
  '[FABRICATED-OPERATIONAL-SPECIFIC] opp-37 — states the ACE escalation contact ' +
  "as 'ace@dimagi.com'. The KB holds ace@dimagi-ai.com.";

describe('explicitOwner', () => {
  it('reads a marker the producing skill emitted', () => {
    expect(explicitOwner('[HARNESS] the recipe re-filed a preloaded date')).toBe('HARNESS');
    expect(explicitOwner('[product] the widget self-certifies')).toBe('PRODUCT');
  });

  it('returns undefined when there is no marker', () => {
    expect(explicitOwner(APP_BLOCKER_CASE_STATE)).toBeUndefined();
  });
});

describe('suggestOwner — advisory only', () => {
  it('suggests HARNESS for a finding about an assertion', () => {
    const { owner, cues } = suggestOwner(APP_WARN_ASSERTION);
    expect(owner).toBe('HARNESS');
    expect(cues.length).toBeGreaterThan(0);
  });

  it('withholds a guess when two owners tie, rather than picking one', () => {
    // Names a recipe AND a preload: genuinely ambiguous without more context,
    // and this ambiguity is exactly what cost 20260828-0703 three wrong guesses.
    const { owner, cues } = suggestOwner(
      'the recipe advanced past a field that preloads from the case',
    );
    expect(owner).toBeUndefined();
    expect(cues.length).toBeGreaterThan(0);
  });

  it('returns no signal for an unrelated message', () => {
    expect(suggestOwner('adversarial coverage 17 prompts').owner).toBeUndefined();
  });
});

describe('triageFindings — the safety property', () => {
  const findings: RawFinding[] = [
    { message: APP_BLOCKER_CASE_STATE, severity: 'BLOCKER', source: 'app-ux-eval' },
    { message: APP_BLOCKER_GEOPOINT, severity: 'BLOCKER', source: 'app-ux-eval', owner: 'PRODUCT' },
    { message: APP_WARN_ASSERTION, severity: 'WARN', source: 'app-ux-eval', owner: 'HARNESS' },
    { message: OCS_BLOCKER_FABRICATION, severity: 'BLOCKER', source: 'ocs-chatbot-eval', owner: 'PROMPT' },
  ];

  it('routes only findings with an explicit owner', () => {
    const { routed, needsTriage } = triageFindings(findings);
    expect(routed.map((f) => f.owner)).toEqual(['PRODUCT', 'HARNESS', 'PROMPT']);
    expect(needsTriage).toHaveLength(1);
    expect(needsTriage[0].message).toBe(APP_BLOCKER_CASE_STATE);
  });

  it('NEVER routes on a heuristic — every routed finding is explicit', () => {
    const { routed } = triageFindings(findings);
    expect(routed.every((f) => f.basis === 'explicit')).toBe(true);
  });

  it('the misattributed 20260828-0703 blocker lands in needsTriage, not self-heal', () => {
    // This is the regression the module exists to prevent, in both directions:
    // an unmarked finding is never silently self-healed AND never silently
    // shipped to the operator as a product defect.
    const { routed, needsTriage } = triageFindings([findings[0]]);
    expect(routed).toHaveLength(0);
    expect(needsTriage).toHaveLength(1);
  });

  it('an explicit owner on the finding beats a contradicting marker in the text', () => {
    const { routed } = triageFindings([
      { message: '[HARNESS] actually a product defect', severity: 'BLOCKER', source: 's', owner: 'PRODUCT' },
    ]);
    expect(routed[0].owner).toBe('PRODUCT');
  });

  it('attaches the right destination per owner', () => {
    const { routed } = triageFindings(findings);
    expect(routed.find((f) => f.owner === 'HARNESS')!.destination).toMatch(/self-heal PR/);
    expect(routed.find((f) => f.owner === 'PRODUCT')!.destination).toMatch(/Phase 3/);
    expect(routed.find((f) => f.owner === 'PROMPT')!.destination).toMatch(/Phase 5/);
  });
});

describe('buildDecisionSet', () => {
  const findings: RawFinding[] = [
    { message: APP_BLOCKER_GEOPOINT, severity: 'BLOCKER', source: 'app-ux-eval', owner: 'PRODUCT' },
    { message: 'attendance preloads silently', severity: 'BLOCKER', source: 'app-ux-eval', owner: 'PRODUCT' },
    { message: APP_WARN_ASSERTION, severity: 'WARN', source: 'app-ux-eval', owner: 'HARNESS' },
    { message: 'expected_tags contradicts the prompt', severity: 'WARN', source: 'ocs', owner: 'INSTRUMENT' },
    { message: OCS_BLOCKER_FABRICATION, severity: 'BLOCKER', source: 'ocs', owner: 'PROMPT' },
    { message: APP_BLOCKER_CASE_STATE, severity: 'BLOCKER', source: 'app-ux-eval' },
  ];

  it('collapses fifteen-findings-across-four-owners into two decisions', () => {
    const set = buildDecisionSet(triageFindings(findings));
    expect(set.decisions).toHaveLength(2);
    expect(set.decisions.map((d) => d.owner)).toEqual(['PRODUCT', 'PROMPT']);
  });

  it('self-heals only HARNESS and INSTRUMENT', () => {
    const set = buildDecisionSet(triageFindings(findings));
    expect(set.selfHeal).toHaveLength(2);
    expect(set.selfHeal.every((f) => SELF_HEALABLE_OWNERS.includes(f.owner))).toBe(true);
  });

  it('orders decisions by blocker count', () => {
    const set = buildDecisionSet(triageFindings(findings));
    expect(set.decisions[0].blockerCount).toBe(2);
    expect(set.decisions[1].blockerCount).toBe(1);
  });

  it('keeps the unclassified finding out of both buckets', () => {
    const set = buildDecisionSet(triageFindings(findings));
    const all = [...set.selfHeal, ...set.decisions.flatMap((d) => d.findings)];
    expect(all.some((f) => f.message === APP_BLOCKER_CASE_STATE)).toBe(false);
    expect(set.needsTriage).toHaveLength(1);
  });
});

describe('formatDecisionBrief', () => {
  const set = buildDecisionSet(
    triageFindings([
      { message: APP_BLOCKER_GEOPOINT, severity: 'BLOCKER', source: 'app-ux-eval', owner: 'PRODUCT' },
      { message: APP_WARN_ASSERTION, severity: 'WARN', source: 'app-ux-eval', owner: 'HARNESS' },
      { message: APP_BLOCKER_CASE_STATE, severity: 'BLOCKER', source: 'app-ux-eval' },
    ]),
  );

  const brief = formatDecisionBrief(set, {
    appVerdict: 'reject',
    appScore: 5.7,
    ocsVerdict: 'iterate',
    ocsScore: 8.5,
  });

  it('leads with the gate', () => {
    expect(brief).toContain('app 5.7 (reject)');
    expect(brief).toContain('bot 8.5 (iterate)');
  });

  it('separates self-healed from decisions', () => {
    expect(brief).toContain('Self-healed — no decision needed (1)');
    expect(brief).toContain('Your decisions (1)');
  });

  it('asks the rework-or-accept question per decision', () => {
    expect(brief).toContain('Rework, or accept and record the residual?');
  });

  it('surfaces the unclassified finding without acting on it', () => {
    expect(brief).toContain('Unclassified (1)');
    expect(brief).toContain('confirm owner before anything is done');
  });

  it('says nothing operator-owned when there is nothing', () => {
    const empty = buildDecisionSet(triageFindings([]));
    expect(formatDecisionBrief(empty, {})).toContain('None — nothing operator-owned surfaced');
  });
});
