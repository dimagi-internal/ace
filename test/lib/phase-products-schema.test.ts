import { describe, it, expect } from 'vitest';
import {
  validatePhaseProductsFragment,
  validatePhaseProductsComplete,
} from '../../lib/phase-products-schema.js';

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
