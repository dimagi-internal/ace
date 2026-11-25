import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkNoDirectFlwPayment,
  checkPaymentConditionCountAgrees,
  checkCapsReachTheCoordinator,
  checkConsentPrecedesQuestions,
  checkContingentPhaseNotCalledSeparate,
  checkNoDeviceOrCameraGuidance,
  checkApprovalsStayGeneric,
  checkOneNamePerField,
  checkSupportRouteAgrees,
  checkFloorTaughtWithTarget,
  runReconciliation,
  CHECKS,
  RECONCILE_CHECKS,
  type Artifact,
} from '../../skills/reconcile-outputs/checks';

/**
 * Negative controls are the REAL Round 1 artifacts, captured from Drive.
 *
 * `test/fixtures/tekzal-round-1/` holds the exact documents tekzal reviewed on
 * `tekzal/20261013-2314` — the work order they were asked to sign and the four
 * training documents their team read. Not a paraphrase, and not a fixture typed
 * beside the assertion: a literal written in the same pass as the check
 * inherits the same misreading the implementation has, in both directions.
 *
 * That is not theoretical here. `payment_condition_count_agrees` originally
 * counted list markers and reported "fewer than two artifacts enumerate the
 * payment test" against these files — a clean pass over a logged blocker. The
 * real documents state the count in WORDS ("all four, and nothing else" in the
 * manager guide, "the four conditions" in the FAQ) against five enumerated
 * bullets in the contract. The check was wrong and the hand-written fixture
 * agreed with it.
 *
 * Observed on `tekzal/20261013-2314`. Rule: `skills/_program-facts.md`.
 */

const TEST_ROOT = join(__dirname, '..');

function artifact(label: string, relPath: string): Artifact {
  return { label, text: readFileSync(join(TEST_ROOT, relPath), 'utf8') };
}

/** The Round 1 set, exactly as the partner received it. */
const ROUND_1: Artifact[] = [
  artifact('work order', 'fixtures/tekzal-round-1/work-order.txt'),
  artifact('manager guide', 'fixtures/tekzal-round-1/manager-guide.txt'),
  artifact('FLW guide', 'fixtures/tekzal-round-1/flw-guide.txt'),
  artifact('quick reference card', 'fixtures/tekzal-round-1/quick-reference.txt'),
  artifact('FAQ', 'fixtures/tekzal-round-1/faq.txt'),
];

/** What the PDD settled for that run. */
const ROUND_1_FACTS = {
  workerCap: 5,
  perWorkerCap: 20,
  campaignTotal: 100,
  paymentConditionCount: 5,
  // Round 1's Phase B sat inside the same work order, same period, same cap.
  hasContingentPhase: true,
};

const STOCK_ALIASES = [['stock', 'availability']];

describe('reconcile-outputs: the real Round 1 artifacts must FAIL', () => {
  it('catches the who-pays contradiction — tekzal issue-log row 22', () => {
    const r = checkNoDirectFlwPayment(ROUND_1);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/work order/);
    expect(r.detail, 'the contract wording itself').toMatch(/disbursed/i);
  });

  it('catches four conditions in training against five in the contract — row 27', () => {
    const r = checkPaymentConditionCountAgrees(ROUND_1, ROUND_1_FACTS);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/work order = 5/);
    expect(r.detail).toMatch(/manager guide = 4/);
  });

  it('catches the five-worker cap never reaching the coordinator — row 25', () => {
    const r = checkCapsReachTheCoordinator(ROUND_1, ROUND_1_FACTS);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/manager guide/);
  });

  it('catches the card asking before it consents — row 23', () => {
    const r = checkConsentPrecedesQuestions(ROUND_1);
    expect(r.pass).toBe(false);
    expect(r.detail, 'asks what she sells at step 2, consents at step 4').toMatch(
      /quick reference card/,
    );
  });

  it('catches a contingent phase called a separate engagement — row 24', () => {
    const r = checkContingentPhaseNotCalledSeparate(ROUND_1, ROUND_1_FACTS);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/manager guide/);
  });

  it('catches the named permission no authority issues — rows 8 and 10', () => {
    const r = checkApprovalsStayGeneric(ROUND_1);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/work order/);
  });

  it('catches the stock / availability split name — row 16', () => {
    const r = checkOneNamePerField(ROUND_1, STOCK_ALIASES);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/stock|availability/);
  });

  it('catches the two escalation domains — row 29', () => {
    const r = checkSupportRouteAgrees(ROUND_1);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/dimagi-ai\.com|domain/);
  });

  it('catches training that teaches the floor without the target — row 32', () => {
    const r = checkFloorTaughtWithTarget(ROUND_1);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/manager guide|FLW guide|FAQ/);
  });

  it('the whole set fails reconciliation, and names more than one defect', () => {
    const { verdict, failures } = runReconciliation(ROUND_1, ROUND_1_FACTS, STOCK_ALIASES);
    expect(verdict).toBe('fail');
    // Nine of the ten checks reproduce a defect the partner logged
    // independently. If this drops, a check stopped seeing a real defect.
    expect(failures.length).toBeGreaterThanOrEqual(9);
    expect(failures.every((f) => f.auto_fix_hint.length > 0), 'every failure is actionable').toBe(
      true,
    );
  });

  it('correctly does NOT flag device guidance, because Round 1 had none', () => {
    // The positive control that matters most on this check: Round 1's defect was
    // the ABSENCE of a camera standard, and the operator then ruled that no such
    // standard should exist. A check that fired here would be inverted.
    expect(checkNoDeviceOrCameraGuidance(ROUND_1).pass).toBe(true);
  });
});

// ── Positive controls: corrected artifacts pass ────────────────────

describe('reconcile-outputs: corrected artifacts PASS', () => {
  const FIXED_WORK_ORDER: Artifact = {
    label: 'work order',
    text: `
6.2 Payment Schedule
Dimagi pays Tekzal. Tekzal pays each Frontline Worker and records the payment in Connect.
A unit is payable under this Work Order when all five of the following are met:
1. started inside the work window, 2. took at least five minutes, 3. consent recorded,
4. the seller sells turmeric, 5. submitted within the per-worker limits.
8.1 Approvals
Take all required approvals from respective authorities for smooth deployment.
Escalate to support@dimagi.com.
Record the availability she reports.
`,
  };

  const FIXED_GUIDE: Artifact = {
    label: 'manager guide',
    text: `
Dimagi pays Tekzal. Tekzal pays each Frontline Worker and records the payment in Connect.
Phase B is contingent on acceptance of Phase A.
Up to five field workers may be onboarded, against a campaign total of 100 surveys.
What makes a survey payable — all five, and nothing else.
A visit should take six to fifteen minutes, and at least five minutes.
Escalate to support@dimagi.com.
Verify the availability answer is picked from the published list.
`,
  };

  const FIXED = [FIXED_WORK_ORDER, FIXED_GUIDE];

  it('accepts the corrected payment direction', () => {
    expect(checkNoDirectFlwPayment(FIXED).pass).toBe(true);
  });

  it('accepts a payment test stated as five in both', () => {
    expect(checkPaymentConditionCountAgrees(FIXED, ROUND_1_FACTS).pass).toBe(true);
  });

  it('accepts Phase B described as contingent', () => {
    expect(checkContingentPhaseNotCalledSeparate(FIXED, ROUND_1_FACTS).pass).toBe(true);
  });

  it('accepts one name for the field across artifacts', () => {
    expect(checkOneNamePerField(FIXED, STOCK_ALIASES).pass).toBe(true);
  });

  it('accepts the generic approvals line', () => {
    expect(checkApprovalsStayGeneric(FIXED).pass).toBe(true);
  });

  it('accepts one domain and one reply-time claim', () => {
    expect(checkSupportRouteAgrees(FIXED).pass).toBe(true);
  });

  it('accepts a floor taught with its target', () => {
    expect(checkFloorTaughtWithTarget([FIXED_GUIDE]).pass).toBe(true);
  });

  it('accepts the worker cap reaching the manager guide', () => {
    expect(checkCapsReachTheCoordinator([FIXED_GUIDE], ROUND_1_FACTS).pass).toBe(true);
  });

  it('accepts a card that consents first', () => {
    const card: Artifact = {
      label: 'quick reference card',
      text: '1. Greet her. 2. Read the consent script and wait for her to say yes. 3. Ask what she sells. 4. Take the photographs.',
    };
    expect(checkConsentPrecedesQuestions([card]).pass).toBe(true);
  });

  it('the corrected set reconciles clean', () => {
    const { verdict, failures } = runReconciliation(FIXED, ROUND_1_FACTS, STOCK_ALIASES);
    expect(failures.map((f) => f.check), 'a corrected set must leave nothing').toEqual([]);
    expect(verdict).toBe('pass');
  });
});

// ── Counter-ratchets: legitimate prose must not trip ───────────────

describe('reconcile-outputs: does not over-fire', () => {
  it('flags "Connect does not pay for X", which implies it pays for the rest', () => {
    // The trap introduced by the test-submission ruling of 2026-11-25. The rule
    // is right; this phrasing of it contradicts the payment flow.
    const a: Artifact = {
      label: 'FAQ',
      text: 'Connect does not pay for test submissions.',
    };
    expect(checkNoDirectFlwPayment([a]).pass).toBe(false);
  });

  it('allows the correct phrasings that mention Connect and payment', () => {
    // These must keep passing, or the check above becomes the always-fires kind
    // and gets routed around inside one run.
    const ok: Artifact[] = [
      { label: 'FAQ', text: 'Connect does not move money.' },
      { label: 'guide', text: 'Test submissions are recorded but never payable.' },
      { label: 'work order', text: 'Tekzal pays each Frontline Worker and records the payment in Connect.' },
    ];
    for (const a of ok) {
      expect(checkNoDirectFlwPayment([a]).pass, `should pass: ${a.text}`).toBe(true);
    }
  });

  it('allows Connect to RECORD a payment the partner makes', () => {
    // Connect legitimately records payments. The rule is against Connect or
    // Dimagi being the PAYER, not against mentioning both in one sentence.
    const a: Artifact = {
      label: 'FAQ',
      text: 'Connect does not move money. Your organisation sends the payment and records it in Connect.',
    };
    expect(checkNoDirectFlwPayment([a]).pass).toBe(true);
  });

  it('allows describing the app opening the camera', () => {
    const a: Artifact = {
      label: 'FLW guide',
      text: 'Tap TAKE PICTURE and the app opens the camera. Hold the phone steady over the turmeric.',
    };
    expect(checkNoDeviceOrCameraGuidance([a]).pass).toBe(true);
  });

  it('flags an actual device recommendation', () => {
    const a: Artifact = {
      label: 'FLW guide',
      text: 'Use a standard handset for the team, and turn off HDR before photographing.',
    };
    expect(checkNoDeviceOrCameraGuidance([a]).pass).toBe(false);
  });

  it('does not judge a payment test only one artifact states', () => {
    const r = checkPaymentConditionCountAgrees([ROUND_1[0]], ROUND_1_FACTS);
    expect(r.pass, 'one artifact cannot disagree with itself').toBe(true);
  });

  it('does not fire on a programme whose next stage IS a separate engagement', () => {
    // Fleet safety. Every opp in the fleet runs this check; one whose next stage
    // genuinely needs its own work order must be able to say so without being
    // failed by a rule written for a programme that had a contingent phase.
    expect(checkContingentPhaseNotCalledSeparate(ROUND_1, {}).pass).toBe(true);
    expect(
      checkContingentPhaseNotCalledSeparate(ROUND_1, { hasContingentPhase: false }).pass,
    ).toBe(true);
  });

  it('does not fire on caps the PDD has not settled', () => {
    expect(checkCapsReachTheCoordinator(ROUND_1, {}).pass).toBe(true);
  });

  it('returns incomplete rather than fail on a single artifact', () => {
    // `fail` would send the orchestrator into an auto-fix loop over a document
    // that is not wrong. Reconciliation is a relation; one document has nothing
    // to be in relation with.
    const { verdict, failures } = runReconciliation([ROUND_1[0]], ROUND_1_FACTS, STOCK_ALIASES);
    expect(verdict).toBe('incomplete');
    expect(failures).toEqual([]);
  });
});

describe('the check registry', () => {
  it('every id in RECONCILE_CHECKS is runnable', () => {
    // Guards the ace#1877 class: a list of names with no callable behind it
    // reads as a check set and runs nothing.
    expect(RECONCILE_CHECKS.length).toBe(CHECKS.length);
    expect(CHECKS.every((c) => typeof c.run === 'function')).toBe(true);
    expect(RECONCILE_CHECKS).toEqual(CHECKS.map((c) => c.id));
  });
});
