/**
 * dimagi-internal/ace#1285 — the released Deliver app keyed the payment grain
 * on (FLW username, visit date, consent answer) when the PDD mandates a
 * per-HOUSEHOLD business key. Silent, quantifiable UNDER-payment: an FLW who
 * legitimately follows up 5 different households on one day accrues **1**
 * payable unit instead of 5.
 *
 * Nothing caught it. `app-release-qa` passed, `pdd-to-deliver-app-eval` scored
 * 9.2/pass, and the released-CCZ projection was clean (`collision_count: 0` —
 * of course it was; a key that collapses 5 units into 1 has no collisions).
 * It surfaced only in `connect-program-setup-eval`'s `delivery_unit_wiring`,
 * the one rubric that compares the composite against the PDD — and that runs
 * AFTER Phase 4 has already wired a payment unit around the wrong grain.
 * Phase 4 cannot fix it either: Connect consumes `entity_id` from the form and
 * has no override.
 *
 * Live, run bednet-check-2-visit/20260814-0357, released build
 * 3f6844647cfd4f9c92f9d3f9088452d8 (v5), modules-1/forms-0.xml.
 *
 * Three previously-closed fixes each MOVED entity_id and none restored the
 * mandated grain, because no gate compared the composite to the PDD. #969's
 * fix in particular looks over-corrected: the payability predicate was moved
 * INTO the key, which fixes slot consumption and breaks the household grain.
 */
import { describe, it, expect } from 'vitest';
import {
  extractEntityIdComponents,
  checkEntityIdGrain,
} from '../../lib/entity-id-grain.js';

/** The live released shape, including the entity_key indirection. */
const LIVE = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head><model>
    <bind nodeset="/data/entity_key" type="xsd:string"
          calculate="concat(instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/username, '|', /data/visit_date, '|', /data/asking_permission_again/consent_confirmed)"/>
    <bind nodeset="/data/du_followup/deliver/entity_id" calculate="/data/entity_key"/>
  </model></h:head>
</h:html>`;

/** The same form keyed the way the PDD mandates. */
const CORRECT = LIVE.replace(
  /calculate="concat\([^"]*"/,
  `calculate="concat(/data/hh_name_preload, '|', /data/hh_bednet_date_preload)"`,
);

describe('extractEntityIdComponents (#1285)', () => {
  it('resolves the entity_key indirection and lists the real components', () => {
    const c = extractEntityIdComponents(LIVE);
    expect(c.resolved).toBe(true);
    expect(c.components).toEqual(['username', '/data/visit_date', '/data/asking_permission_again/consent_confirmed']);
  });

  it('reads a direct concat with no indirection', () => {
    expect(extractEntityIdComponents(CORRECT).components).toEqual([
      '/data/hh_name_preload',
      '/data/hh_bednet_date_preload',
    ]);
  });

  it('reports UNRESOLVED rather than empty when there is no entity_id bind', () => {
    const r = extractEntityIdComponents('<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:head/></h:html>');
    expect(r.resolved).toBe(false);
  });
});

describe('checkEntityIdGrain (#1285)', () => {
  const declared = ['hh_name_preload', 'hh_bednet_date_preload'];

  it('fails the live key: none of the PDD-declared nodes appear', () => {
    const r = checkEntityIdGrain(LIVE, declared);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('missing-declared-node');
    expect(r.detail).toMatch(/hh_name_preload/);
  });

  it('names the concrete cost, not just the mismatch', () => {
    expect(checkEntityIdGrain(LIVE, declared).detail).toMatch(/same.?day|collapse|one payable unit/i);
  });

  it('flags a payability ANSWER inside the key — the #969 over-correction', () => {
    const r = checkEntityIdGrain(LIVE, declared);
    expect(r.findings.map((f) => f.kind)).toContain('answer-in-grain');
    expect(r.findings.find((f) => f.kind === 'answer-in-grain')!.detail).toMatch(/consent_confirmed/);
  });

  it('passes the mandated composite', () => {
    expect(checkEntityIdGrain(CORRECT, declared).ok).toBe(true);
  });

  it('fires with NO declaration at all when the key carries no entity-identifying node', () => {
    // username + date + an answer is worker-and-day scoped by construction.
    const r = checkEntityIdGrain(LIVE, []);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('no-entity-component');
  });

  it('does not fire the no-entity heuristic when the key carries a per-entity node', () => {
    const r = checkEntityIdGrain(CORRECT, []);
    expect(r.findings.map((f) => f.kind)).not.toContain('no-entity-component');
  });

  it('reports BLIND rather than clean when entity_id cannot be resolved', () => {
    const r = checkEntityIdGrain('<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:head/></h:html>', declared);
    expect(r.checked).toBe(false);
    expect(r.ok).toBe(true);
  });
});

/**
 * ace#1441 — ace#1434's precedence ruling shipped on 0.13.897 and this gate was
 * never reconciled with it. `_app-component-library § payability-scoped-key`
 * requires the payability discriminator inside `entity_id`; a discriminator is
 * an ANSWER by construction, so every build obeying the mandate tripped
 * `answer-in-grain` and, with the residual key being worker + date, also
 * `no-entity-component`.
 *
 * `app-release-qa` is halt-loud at Phase 3, so any opportunity declaring a
 * non-payable branch could not clear it — the component library told the
 * builder to ship a key the release gate refused. #1285's counter-evidence
 * comment predicted exactly this.
 */
describe('the payability-scoped key passes the gate (ace#1441)', () => {
  // The released key from bednet-check-2-visit/20260814-2019, Deliver app
  // af48aa88-d980-423a-a831-87c42a1f6fd6, HQ build 8e654f32… (v5).
  const xml = `
    <h:html xmlns:h="http://www.w3.org/1999/xhtml">
      <h:head><model>
        <bind nodeset="/data/entity_id" type="string"
              calculate="concat(instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/user/data/case_id]/username, ' - ', /data/visit_date, ' - ', /data/consent_block/consent_confirmed)"/>
      </model></h:head>
    </h:html>`;
  const declared = ['username', 'visit_date'];

  it('PASSES when the PDD declares a non-payable branch', () => {
    const r = checkEntityIdGrain(xml, declared, {
      hasNonPayableBranch: true,
      payabilityDiscriminator: 'consent_confirmed',
    });
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('still FAILS the same key when no non-payable branch is declared', () => {
    // The #969 over-correction the gate exists to catch: an answer in the key
    // with nothing requiring it there.
    const r = checkEntityIdGrain(xml, declared);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('answer-in-grain');
  });

  it('matches a declared short name against the released full path', () => {
    // The PDD says `consent_confirmed`; the form says
    // `/data/consent_block/consent_confirmed`.
    const r = checkEntityIdGrain(xml, declared, {
      hasNonPayableBranch: true,
      payabilityDiscriminator: '/data/consent_block/consent_confirmed',
    });
    expect(r.ok).toBe(true);
  });

  it('does not suppress an answer field that is NOT the discriminator', () => {
    const twoAnswers = xml.replace(
      "/data/consent_block/consent_confirmed)\"/>",
      "/data/consent_block/consent_confirmed, ' - ', /data/visit_outcome)\"/>",
    );
    const r = checkEntityIdGrain(twoAnswers, declared, {
      hasNonPayableBranch: true,
      payabilityDiscriminator: 'consent_confirmed',
    });
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.detail.includes('visit_outcome'))).toBe(true);
  });

  it('needs BOTH inputs — a discriminator without the branch suppresses nothing', () => {
    const r = checkEntityIdGrain(xml, declared, { payabilityDiscriminator: 'consent_confirmed' });
    expect(r.ok).toBe(false);
  });

  it('still fires no-entity-component when the residual is NOT the declared grain', () => {
    // worker + day + answer with no declared grain behind it is the real defect.
    const r = checkEntityIdGrain(xml, [], {
      hasNonPayableBranch: true,
      payabilityDiscriminator: 'consent_confirmed',
    });
    expect(r.findings.map((f) => f.kind)).toContain('no-entity-component');
  });

  it('a missing declared node still fails, branch or no branch', () => {
    const r = checkEntityIdGrain(xml, ['username', 'visit_date', 'household_id'], {
      hasNonPayableBranch: true,
      payabilityDiscriminator: 'consent_confirmed',
    });
    expect(r.findings.map((f) => f.kind)).toContain('missing-declared-node');
  });
});
