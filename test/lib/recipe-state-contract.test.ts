/**
 * dimagi-internal/ace#1191 — `app-test-cases`'s canonical two-leg Deliver
 * snippet teaches a sequence that CANNOT EXECUTE.
 *
 * The SKILL gives this as the pattern:
 *
 *     runFlow deliver-form-walk.yaml   (leg A: registration)
 *     runFlow form-submit.yaml
 *     runFlow deliver-form-walk.yaml   (leg B: payable followup)
 *
 * with nothing between the legs. But the recipes' own documented contracts do
 * not meet:
 *
 *   deliver-form-walk.yaml   Pre-state: Deliver home (deliver-home-job-card /
 *                            viewJobCard visible); first action tapOn "Start"
 *   form-submit.yaml         Post-state: "depends on the form … Deliver forms
 *                            (TBD) likely have an explicit confirmation surface"
 *
 * `deliver-sync.yaml` documents the real answer in passing — "form-submit
 * returns to the form list (or the module list) rather than the app home" —
 * which is exactly why deliver-sync itself opens with two guarded `back` steps
 * before it can find the home tile.
 *
 * Live consequence (#1290, same run family): the Deliver smoke walked leg A,
 * then died at the inter-leg back-navigation on CommCare's "Exit Form?"
 * dialog.
 *
 * The palette entry that fixes it needs live-device validation, so it is NOT
 * in this change. What IS decidable statically — and is the preventer the
 * issue asks for — is that a documented chain must not contain a step whose
 * post-state cannot be shown to satisfy the next step's pre-state.
 */
import { describe, it, expect } from 'vitest';
import {
  parseStateContract,
  anchorsIn,
  checkChainContinuity,
} from '../../lib/recipe-state-contract.js';

const DELIVER_FORM_WALK = `# deliver-form-walk.yaml
#
# Pre-state: Deliver home (deliver-home-job-card / viewJobCard visible).
# Post-state: the first Deliver form question on screen (nav_btn_next visible).
appId: org.commcare.dalvik
`;

const FORM_SUBMIT = `# form-submit.yaml
#
# Post-state: depends on the form. Learn forms return to
# StandardHomeActivity with a "1 form sent to server!" toast +
# \`card_subtext\` update. Deliver forms (TBD) likely have an explicit
# confirmation surface.
appId: org.commcare.dalvik
`;

const HOME_REENTRY = `# deliver-home-reentry.yaml
#
# Pre-state: anywhere inside the Deliver app after a form finalize.
# Post-state: Deliver home (deliver-home-job-card visible).
appId: org.commcare.dalvik
`;

describe('parseStateContract (#1191)', () => {
  it('reads both header lines', () => {
    const c = parseStateContract(DELIVER_FORM_WALK);
    expect(c.pre).toMatch(/Deliver home/);
    expect(c.post).toMatch(/first Deliver form question/);
    expect(c.postIsUndetermined).toBe(false);
  });

  it('flags a post-state that is explicitly undetermined', () => {
    const c = parseStateContract(FORM_SUBMIT);
    expect(c.postIsUndetermined).toBe(true);
  });

  it('reports an absent contract rather than inventing one', () => {
    const c = parseStateContract('appId: x\n');
    expect(c.pre).toBeUndefined();
    expect(c.post).toBeUndefined();
  });
});

describe('anchorsIn (#1191)', () => {
  it('pulls the selector anchors out of a state sentence', () => {
    expect(anchorsIn('Deliver home (deliver-home-job-card / viewJobCard visible).')).toEqual(
      expect.arrayContaining(['deliver-home-job-card', 'viewJobCard']),
    );
  });

  it('does not treat ordinary prose as an anchor', () => {
    expect(anchorsIn('depends on the form.')).toEqual([]);
  });
});

describe('checkChainContinuity (#1191)', () => {
  it('flags the live two-leg snippet — form-submit lands nowhere provable', () => {
    const r = checkChainContinuity([
      { recipe: 'deliver-form-walk.yaml', text: DELIVER_FORM_WALK },
      { recipe: 'form-submit.yaml', text: FORM_SUBMIT },
      { recipe: 'deliver-form-walk.yaml', text: DELIVER_FORM_WALK },
    ]);
    expect(r.ok).toBe(false);
    const kinds = r.findings.map((f) => f.kind);
    expect(kinds).toContain('undetermined-post-state');
    expect(r.findings.find((f) => f.kind === 'undetermined-post-state')!.detail).toMatch(
      /deliver-form-walk\.yaml/,
    );
  });

  it('a re-entry step absorbs the undetermined post-state', () => {
    const r = checkChainContinuity([
      { recipe: 'deliver-form-walk.yaml', text: DELIVER_FORM_WALK },
      { recipe: 'form-submit.yaml', text: FORM_SUBMIT },
      { recipe: 'deliver-home-reentry.yaml', text: HOME_REENTRY },
      { recipe: 'deliver-form-walk.yaml', text: DELIVER_FORM_WALK },
    ]);
    // The chain-breaking finding is gone: a pre-state of "anywhere" is exactly
    // what a guarded re-entry offers, and flagging it would condemn the shape
    // that fixes the problem.
    expect(r.findings.map((f) => f.kind)).not.toContain('undetermined-post-state');
    expect(r.findings.map((f) => f.kind)).not.toContain('state-discontinuity');
  });

  it('a permissive pre-state does not excuse a MISSING one', () => {
    // form-submit.yaml genuinely documents no Pre-state — a second, real gap
    // in the palette that this linter surfaces on the way past.
    const r = checkChainContinuity([
      { recipe: 'deliver-form-walk.yaml', text: DELIVER_FORM_WALK },
      { recipe: 'form-submit.yaml', text: FORM_SUBMIT },
    ]);
    expect(r.findings.map((f) => f.kind)).toContain('missing-contract');
  });

  it('flags a genuine anchor discontinuity between two determined states', () => {
    const landsOnCaseList = `# x
# Pre-state: a form is open.
# Post-state: the case list is on screen (case-list-container visible).
`;
    const r = checkChainContinuity([
      { recipe: 'a.yaml', text: landsOnCaseList },
      { recipe: 'deliver-form-walk.yaml', text: DELIVER_FORM_WALK },
    ]);
    expect(r.findings.map((f) => f.kind)).toContain('state-discontinuity');
  });

  it('a single-step chain is trivially continuous', () => {
    expect(checkChainContinuity([{ recipe: 'a.yaml', text: DELIVER_FORM_WALK }]).ok).toBe(true);
  });

  it('says so when a chained recipe documents no contract at all', () => {
    const r = checkChainContinuity([
      { recipe: 'a.yaml', text: 'appId: x\n' },
      { recipe: 'deliver-form-walk.yaml', text: DELIVER_FORM_WALK },
    ]);
    expect(r.findings.map((f) => f.kind)).toContain('missing-contract');
  });
});
