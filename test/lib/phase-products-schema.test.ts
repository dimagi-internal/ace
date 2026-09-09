import { describe, it, expect } from 'vitest';
import {
  validatePhaseProductsFragment,
  validatePhaseProductsComplete,
  classifyPhaseProducts,
} from '../../lib/phase-products-schema.js';
import { classifyComponentSet, type ComponentSet } from '../../lib/component-set.js';
import { assessProgrammeReadiness } from '../../lib/programme-overview.js';
import { buildComponentProducts } from '../../lib/component-products.js';

const DOC = {
  file_id: '1abcDEF',
  title: 'Onboarding email',
  web_view_link: 'https://docs.google.com/document/d/1abcDEF/edit',
};

describe('qa-and-training products.training.docs (jjackson/ace#748)', () => {
  it('accepts the five enumerated doc slots', () => {
    const res = validatePhaseProductsFragment('qa-and-training', {
      training: {
        deck: DOC,
        docs: {
          llo_guide: DOC,
          flw_guide: DOC,
          quick_reference: DOC,
          faq: DOC,
          onboarding_email: DOC,
        },
      },
    });
    expect(res.valid).toBe(true);
  });

  it('rejects an unknown doc key (deck_spec — the #705/#748 drift class), naming the path', () => {
    // training-deck-generate's SKILL.md used to instruct writing this slot;
    // nothing reads it and the summary page renders blank. The docs map is the
    // consumer-read enumeration, so unknown keys must fail loud at validateAs
    // rather than pass through silently.
    const res = validatePhaseProductsFragment('qa-and-training', {
      training: {
        docs: { deck_spec: DOC },
      },
    });
    expect(res.valid).toBe(false);
    expect(JSON.stringify(res.issues)).toContain('deck_spec');
  });
});

/**
 * dimagi-internal/ace#1184 — connect-setup must PROVE the ACE test-user invite
 * landed, not merely that the send was accepted.
 *
 * Incident (turmeric-market-study/20260807-1903, 2026-08-12): Phase 4 called
 * `connect_send_flw_invite`, got HTTP 202 + `invited_count: 1`, wrote
 * "status: queued" into run_state and marked itself `done`. Connect never
 * created the `UserInvite` row (Connect-side bug, CI-892). The documented
 * read-back via `connect_list_flw_invites` was never called — the MCP atom log
 * shows the first `listFlwInvites` of the whole run happened in PHASE 6.
 *
 * Prose in SKILL.md could not prevent that, because nothing structural noticed
 * the step had been skipped. So the products contract now REQUIRES the
 * read-back result to be recorded before connect-setup can reach a terminal
 * status. The schema enforces "you ran the check and wrote down what it said";
 * the skill enforces "a false result is a [BLOCKER], not a warning".
 */
describe('connect-setup ACE test-user invite read-back gate (ace#1184 / CI-892)', () => {
  const OPP = {
    domain: 'connect-ace-prod',
    organization_slug: 'ai-demo-space',
    opportunity: {
      id: '9e4cbb93-1bbc-4b8e-9827-bdd852a1e293',
      url: 'https://connect.dimagi.com/a/ai-demo-space/opportunity/9e4cbb93-1bbc-4b8e-9827-bdd852a1e293/',
    },
  };

  it('rejects a COMPLETED connect-setup that never recorded the read-back (the CI-892 regression)', () => {
    const res = validatePhaseProductsComplete('connect-setup', { connect: OPP });
    expect(res.valid).toBe(false);
    expect(JSON.stringify(res.issues)).toContain('ace_test_user.invite_row_present');
  });

  it('accepts a completed phase that read back and FOUND a linked row', () => {
    const res = validatePhaseProductsComplete('connect-setup', {
      connect: {
        ...OPP,
        ace_test_user: {
          phone: '+74260000101',
          invite_row_present: true,
          connect_user_id: '1277adbd0ceea89e367d',
          status: 'pending',
          checked_at: '2026-08-12T07:27:00Z',
        },
      },
    });
    expect(res.valid).toBe(true);
  });

  it('accepts invite_row_present:false — recording a verified ABSENT row is the point', () => {
    // `false` must satisfy the contract: the phase DID run the check. Blocking
    // on the value is the skill's job (status must then be error/partial, never
    // done). If the presence check treated `false` as missing, a phase that
    // honestly reported the failure would be indistinguishable from one that
    // skipped the step entirely.
    const res = validatePhaseProductsComplete('connect-setup', {
      connect: {
        ...OPP,
        ace_test_user: {
          phone: '+74260000101',
          invite_row_present: false,
          connect_user_id: null,
          checked_at: '2026-08-12T07:40:10Z',
        },
      },
    });
    expect(res.valid).toBe(true);
  });

  it('still allows an in-flight FRAGMENT write without the read-back', () => {
    // Incremental writes land before the invite step runs; only the phase
    // boundary demands completeness.
    const res = validatePhaseProductsFragment('connect-setup', { connect: OPP });
    expect(res.valid).toBe(true);
  });

  it('type-checks invite_row_present as a boolean, not a truthy string', () => {
    // Guards the "status: queued" failure mode directly: a phase that pastes the
    // send response in here instead of the read-back result must fail loud.
    const res = validatePhaseProductsFragment('connect-setup', {
      connect: { ...OPP, ace_test_user: { invite_row_present: 'queued' } },
    });
    expect(res.valid).toBe(false);
    expect(JSON.stringify(res.issues)).toContain('invite_row_present');
  });
});


// ---------------------------------------------------------------------------
// dimagi-internal/ace#1069 — REQUIRED_PRODUCT_KEYS was mode-blind too:
// `training.deck` / `training.docs.onboarding_email` cannot exist in
// app-QA-only mode, and the doc string routes the orchestrator into
// "heal the producing skill / re-dispatch" — which can never converge.
// The mode already lives in the phase block this classifier reads, so no
// signature change is needed to see it.
// ---------------------------------------------------------------------------

describe('classifyPhaseProducts — app-QA-only mode (ace#1069)', () => {
  const appQaOnlyRun = (extra: Record<string, unknown> = {}) => ({
    phases: {
      'ocs-setup': { status: 'skipped' },
      'qa-and-training': {
        status: 'done',
        mode: 'app-QA-only',
        products: {},
        ...extra,
      },
    },
  });

  it('accepts a terminal app-QA-only phase with no training products', () => {
    const r = classifyPhaseProducts(appQaOnlyRun(), 'qa-and-training');
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('still demands the training products when no mode is declared', () => {
    const r = classifyPhaseProducts(
      {
        phases: {
          'qa-and-training': { status: 'done', products: {} },
        },
      },
      'qa-and-training',
    );
    expect(r.ok).toBe(false);
  });

  it('does NOT relax on an unrecognized mode string', () => {
    const r = classifyPhaseProducts(appQaOnlyRun({ mode: 'app-qa-only' }), 'qa-and-training');
    expect(r.ok).toBe(false);
  });
});

// ace#1996 — DesignProducts is `.strict()`, so a key it does not name is
// REJECTED, not ignored. `skills/idea-to-pdd` and `lib/component-products.ts`
// both mandate five componentized keys that the schema did not carry, so on
// `poverty-graduation/20260905-0924` — the first live componentized run —
// the mandated handoff could not be written at all. The run smuggled the
// component set through `products.pdd` (`.passthrough()`) plus a side file,
// and `verify_phase_products` still returned `ok:true`, because a contract
// that cannot be written is indistinguishable from one that was not.
//
// Validating the BUILDER'S OWN OUTPUT is what makes that class impossible:
// the two files can no longer drift without this going red.
describe('componentDesignProductsMatchSchema — DesignProducts accepts what Phase 1 builds (ace#1996)', () => {
  const set: ComponentSet = classifyComponentSet([
    {
      // ace#2056: the framework declares the FULL inventory, so
      // `framework_component_ids` is actually present in `built` below — a
      // fixture without it would validate the schema against a key that is
      // never emitted, which is how a `.strict()` contract goes green on a
      // handoff it would reject in production.
      file_id: 'ffw',
      name: 'framework.gdoc',
      text:
        'Poverty Graduation on Connect: Models and Components Framework\n' +
        'Purpose: A map · Components: 1, 2, 3, 4, 5, 5b, 6',
    },
    {
      file_id: 'f2',
      name: 'targeting.gdoc',
      text: 'Program Design Document (PDD): Household Poverty Targeting Survey\nVersion: 1.0 · Component: 2 of the graduation component set',
    },
    {
      file_id: 'f4',
      name: 'enrollment.gdoc',
      text: 'Program Design Document (PDD): Enrollment\nVersion: 0.1 · Component: 4 of the graduation component set',
    },
    {
      file_id: 'fL',
      name: 'learn.gdoc',
      text: 'Program Design Document (PDD): Learn (Program Training and Certification)\nVersion: 0.4 · Scope: program-level (cross-component)',
    },
  ]);

  const readiness = assessProgrammeReadiness(set, [
    { component_id: '2', text: 'Standalone.' },
    { component_id: '4', text: 'Enrollment confirms against Component 2, and needs Component 3.' },
  ]);

  const built = buildComponentProducts(set, readiness);

  it('is a componentized set with an absent-reference obligation to carry', () => {
    // Guards the fixture, so a green result below cannot come from an empty one.
    expect(built.mode).toBe('componentized');
    expect(built.components.map((c) => c.component_id)).toEqual(['2', '4']);
    expect(built.program_level).toHaveLength(1);
    expect(built.unresolved_references).toEqual([{ from: '4', to: '3' }]);
    expect(built.overview_obligations.some((o) => o.code === 'resolve-absent-reference')).toBe(true);
    // ace#2056 — the sixth componentized key. `.strict()` REJECTS a key it does
    // not name, so this assertion is what makes the validation below a real
    // test of `framework_component_ids` rather than of its absence.
    expect(built.framework_component_ids).toEqual(['1', '2', '3', '4', '5', '5b', '6']);
  });

  it('validates as a complete idea-to-design products block, alongside pdd', () => {
    const res = validatePhaseProductsComplete('idea-to-design', {
      pdd: { title: 'Programme Overview', file_id: '1overview' },
      ...built,
    });
    expect(res.issues).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it('reaches the boundary fence green through classifyPhaseProducts', () => {
    const res = classifyPhaseProducts(
      {
        phases: {
          'idea-to-design': {
            status: 'done',
            products: { pdd: { title: 'Programme Overview', file_id: '1overview' }, ...built },
          },
        },
      },
      'idea-to-design',
    );
    expect(res.issues).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('still rejects a key no schema names — the strictness this restores is real', () => {
    const res = validatePhaseProductsComplete('idea-to-design', {
      pdd: { title: 'Programme Overview', file_id: '1overview' },
      ...built,
      componnts: built.components, // typo'd key must not pass silently
    });
    expect(res.valid).toBe(false);
  });

  it('leaves the synthesized path untouched — every componentized key is optional', () => {
    const res = validatePhaseProductsComplete('idea-to-design', {
      pdd: { title: 'A single synthesized PDD', file_id: '1pdd' },
    });
    expect(res.issues).toEqual([]);
    expect(res.valid).toBe(true);
  });
});

/**
 * ace#2296 — the Phase 4 payability predicate had no shape in this schema at
 * all, so `validateAs: {kind:'phase-products', phase:'connect-setup'}` was
 * structurally blind to it: `opportunity` is `.passthrough()`, and the whole
 * `verification` block rode through unvalidated.
 *
 * `question_value` is a string in Connect's own contract
 * (`connect_set_verification_flags` declares `question_value: z.string()`), and
 * it is the field that decides whether a follow-up visit is payable. Typing it
 * here is what catches a BOOLEAN landing in it — the shape a YAML 1.1
 * read-modify-write produces, and the one case the raw-text quoting detector
 * cannot see (a boolean `true` is unambiguous in both dialects; it is simply
 * the wrong type).
 */
describe('connect-setup products.connect.opportunity.verification (ace#2296)', () => {
  const RULE = {
    name: 'consent_confirmed=yes',
    question_path: 'form.consent_to_continue.consent_confirmed',
    question_value: 'yes',
    deliver_unit_id: 6862,
  };

  it('accepts the verbatim block from bednet-check-2-visit/20260908-1544', () => {
    const res = validatePhaseProductsFragment('connect-setup', {
      connect: {
        opportunity: {
          verification: { form_field_rules: [RULE], form_field_rules_saved: 1 },
        },
      },
    });
    expect(res.valid).toBe(true);
  });

  it('rejects a BOOLEAN question_value, naming the path', () => {
    const res = validatePhaseProductsFragment('connect-setup', {
      connect: {
        opportunity: {
          verification: { form_field_rules: [{ ...RULE, question_value: true }] },
        },
      },
    });
    expect(res.valid).toBe(false);
    expect(res.issues.map((i) => i.path).join(' ')).toContain('question_value');
  });

  it('rejects a NUMERIC question_value too (the sexagesimal / lossy-number shape)', () => {
    const res = validatePhaseProductsFragment('connect-setup', {
      connect: {
        opportunity: { verification: { form_field_rules: [{ ...RULE, question_value: 90 }] } },
      },
    });
    expect(res.valid).toBe(false);
  });

  it('stays permissive about extra rule keys and an absent verification block', () => {
    // Adding this shape must not newly reject a run that records more than the
    // four known keys, or one that records no verification at all — an
    // INVALID_PHASE_PRODUCTS here blocks the Drive write and stalls Phase 4.
    expect(
      validatePhaseProductsFragment('connect-setup', {
        connect: {
          opportunity: {
            verification: {
              form_field_rules: [{ ...RULE, observed_at: '2026-09-09T02:42:00Z' }],
              form_submission_start: '08:00',
              notes: 'read from the released CCZ',
            },
          },
        },
      }).valid,
    ).toBe(true);
    expect(
      validatePhaseProductsFragment('connect-setup', { connect: { opportunity: { id: 'x' } } }).valid,
    ).toBe(true);
  });
});
