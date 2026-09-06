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
  formatGrainReport,
  expandEntityIdComponents,
} from '../../lib/entity-id-grain.js';

import { assertChecked, assertUnable, isPass } from '../../lib/check-outcome.js';
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
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('missing-declared-node');
    expect(r.detail).toMatch(/hh_name_preload/);
  });

  it('names the concrete cost, not just the mismatch', () => {
    expect(formatGrainReport(checkEntityIdGrain(LIVE, declared))).toMatch(
      /same.?day|collapse|one payable unit/i,
    );
  });

  it('flags a payability ANSWER inside the key — the #969 over-correction', () => {
    const r = checkEntityIdGrain(LIVE, declared);
    assertChecked(r);
    expect(r.findings.map((f) => f.kind)).toContain('answer-in-grain');
    expect(r.findings.find((f) => f.kind === 'answer-in-grain')!.detail).toMatch(/consent_confirmed/);
  });

  it('passes the mandated composite', () => {
    expect(isPass(checkEntityIdGrain(CORRECT, declared))).toBe(true);
  });

  it('fires with NO declaration at all when the key carries no entity-identifying node', () => {
    // username + date + an answer is worker-and-day scoped by construction.
    const r = checkEntityIdGrain(LIVE, []);
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('no-entity-component');
  });

  it('does not fire the no-entity heuristic when the key carries a per-entity node', () => {
    const r = checkEntityIdGrain(CORRECT, []);
    assertChecked(r);
    expect(r.findings.map((f) => f.kind)).not.toContain('no-entity-component');
  });

  it('is UNABLE, not clean, when entity_id cannot be resolved', () => {
    const r = checkEntityIdGrain('<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:head/></h:html>', declared);
    // No `ok` on this branch, so a caller cannot read an unresolved key as a
    // clean one — and `isPass` says so explicitly (ace#1634).
    expect(r.status).toBe('unable');
    expect(isPass(r)).toBe(false);
    assertUnable(r);
    expect(r.reason).toMatch(/no readable entity_id calculate/i);
    const text = formatGrainReport(r);
    expect(text).toMatch(/UNABLE TO CHECK/);
    expect(text).toMatch(/NOT a pass/);
    // No green-looking word anywhere: "clean" is what the checked-and-fine
    // branch says, and "not applicable" is the benign phrasing three prior
    // instances of this class were signed off under.
    expect(text).not.toMatch(/\bclean\b/i);
    expect(text).not.toMatch(/not applicable/i);
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
    assertChecked(r);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('still FAILS the same key when no non-payable branch is declared', () => {
    // The #969 over-correction the gate exists to catch: an answer in the key
    // with nothing requiring it there.
    const r = checkEntityIdGrain(xml, declared);
    assertChecked(r);
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
    assertChecked(r);
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
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.detail.includes('visit_outcome'))).toBe(true);
  });

  it('needs BOTH inputs — a discriminator without the branch suppresses nothing', () => {
    const r = checkEntityIdGrain(xml, declared, { payabilityDiscriminator: 'consent_confirmed' });
    assertChecked(r);
    expect(r.ok).toBe(false);
  });

  it('still fires no-entity-component when the residual is NOT the declared grain', () => {
    // worker + day + answer with no declared grain behind it is the real defect.
    const r = checkEntityIdGrain(xml, [], {
      hasNonPayableBranch: true,
      payabilityDiscriminator: 'consent_confirmed',
    });
    assertChecked(r);
    expect(r.findings.map((f) => f.kind)).toContain('no-entity-component');
  });

  it('a missing declared node still fails, branch or no branch', () => {
    const r = checkEntityIdGrain(xml, ['username', 'visit_date', 'household_id'], {
      hasNonPayableBranch: true,
      payabilityDiscriminator: 'consent_confirmed',
    });
    assertChecked(r);
    expect(r.findings.map((f) => f.kind)).toContain('missing-declared-node');
  });
});

/**
 * ace#1810 — a declared component that reaches `entity_id` through an
 * INTERMEDIATE node was read as absent, emitting `missing-declared-node`: a
 * `[BLOCKER]` that hard-halts Phase 3 on a build that obeys the PDD.
 *
 * The two sibling blind spots in this gate family (#1441, #1808) make a check
 * fail to RUN. This one refused a correct build, which is the more expensive
 * direction in a ten-phase pipeline.
 *
 * Fixture: released Deliver build `b08533bdf26a48a295a362ff204fb88d`
 * (spark-facilitator/20260828-0703, HQ app 89881fa67ec74f21b95e37d41e39ba93),
 * `modules-1/forms-0.xml`. Both binds below are the released text, trimmed
 * only by shortening the repeated casedb predicate — verified by downloading
 * the CCZ and running the pre-fix code, which reproduced the issue's finding
 * verbatim.
 */
describe('a declared component reached through an intermediate node (ace#1810)', () => {
  const CASE = "instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]";
  /** The released `meeting_index` calculate: min(meetings_on_current_step + 1, 3) on the payable branch. */
  const CLAMPED =
    `if(/data/fcap_step/step = '', '', if(/data/meeting_held/meeting_conducted = 'yes' and ` +
    `/data/meeting_type_screen/meeting_type = 'community_meeting', if(/data/fcap_step/step = ${CASE}/pilot_fcap_step, ` +
    `min(if(${CASE}/meetings_on_current_step = '', 0, number(${CASE}/meetings_on_current_step)) + 1, 3), 1), 0))`;
  /** The same shape with the declared component genuinely absent. */
  const UNRELATED = `if(/data/fcap_step/step = '', '', 1)`;

  const form = (indexCalc: string, key?: string): string => `
    <h:html xmlns:h="http://www.w3.org/1999/xhtml">
      <h:head><model>
        <bind nodeset="/data/meeting_summary/meeting_index" type="xsd:string" calculate="${indexCalc.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}"/>
        <bind nodeset="/data/record_a_community_meeting/deliver/entity_id" calculate="${(key ?? `concat(${CASE}/@case_id, '-', /data/fcap_step/step, '-', /data/meeting_summary/meeting_index, '-', /data/meeting_type_screen/meeting_type)`).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}"/>
      </model></h:head>
    </h:html>`;

  /** Exactly what SKILL.md tells the operator to pass for this PDD. */
  const declared = ['case_id', 'step', 'meetings_on_current_step'];

  it('FALSE-POSITIVE CONTROL: the correct build passes and does not halt Phase 3', () => {
    const r = checkEntityIdGrain(form(CLAMPED), declared);
    assertChecked(r);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('names the indirection so the operator sees WHY it passed', () => {
    const r = checkEntityIdGrain(form(CLAMPED), declared);
    assertChecked(r);
    expect(r.resolvedThroughIntermediate).toEqual([
      'meetings_on_current_step via /data/meeting_summary/meeting_index',
    ]);
    expect(r.detail).toMatch(/resolved-through-intermediate/);
    // Presence is established; the clamp semantics are NOT, and the report
    // must not let a reader believe otherwise.
    expect(r.detail).toMatch(/SEMANTICS are not/);
  });

  it('POSITIVE CONTROL: still fails when the intermediate node does NOT carry the component', () => {
    const r = checkEntityIdGrain(form(UNRELATED), declared);
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toEqual(['missing-declared-node']);
    expect(r.findings[0].detail).toMatch(/meetings_on_current_step/);
    expect(r.resolvedThroughIntermediate).toEqual([]);
  });

  it('a node with no bind of its own expands to nothing — no silent pass', () => {
    // /data/meeting_summary/meeting_index present in the key but never bound.
    const noBind = `
      <h:html xmlns:h="http://www.w3.org/1999/xhtml">
        <h:head><model>
          <bind nodeset="/data/record_a_community_meeting/deliver/entity_id" calculate="concat(/data/a, '-', /data/meeting_summary/meeting_index)"/>
        </model></h:head>
      </h:html>`;
    const r = checkEntityIdGrain(noBind, declared);
    assertChecked(r);
    expect(r.findings.map((f) => f.kind)).toContain('missing-declared-node');
  });

  it('ANTI-LAUNDERING: expansion never suppresses answer-in-grain', () => {
    // Every declared node resolves (two literally, one through meeting_index),
    // and a consent answer sits in the key as a literal component. The
    // declared-node test is satisfied; the answer finding must still fire.
    const laundered = form(
      CLAMPED,
      `concat(${CASE}/@case_id, '-', /data/fcap_step/step, '-', /data/meeting_summary/meeting_index, '-', /data/consent_block/consent_confirmed)`,
    );
    const r = checkEntityIdGrain(laundered, declared);
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('answer-in-grain');
    // and the indirection still resolved, so this is not a pass earned by the
    // declared test failing instead.
    expect(r.resolvedThroughIntermediate).toHaveLength(1);
  });

  it('ANSWER_LIKE stays on the UNEXPANDED list — an answer a helper READS is not an answer in the key', () => {
    // The released `meeting_index` calculate branches on `meeting_conducted`,
    // which is ANSWER_LIKE. Running the answer test over expanded text would
    // fail the very build ace#1810 calls correct — over-firing is the failure
    // this issue exists to remove, so the expansion is scoped to the
    // declared-node test only.
    expect(CLAMPED).toMatch(/meeting_conducted/);
    const r = checkEntityIdGrain(form(CLAMPED), declared);
    assertChecked(r);
    expect(r.findings.map((f) => f.kind)).not.toContain('answer-in-grain');
  });

  it('expansion is bounded and cycle-guarded', () => {
    const cyclic = `
      <h:html xmlns:h="http://www.w3.org/1999/xhtml">
        <h:head><model>
          <bind nodeset="/data/a" calculate="/data/b"/>
          <bind nodeset="/data/b" calculate="/data/a"/>
          <bind nodeset="/data/x/entity_id" calculate="concat(/data/a, '-', /data/hh_id)"/>
        </model></h:head>
      </h:html>`;
    const r = checkEntityIdGrain(cyclic, ['hh_id', 'nowhere']);
    assertChecked(r);
    expect(r.findings.map((f) => f.kind)).toContain('missing-declared-node');
  });
});

describe('expandEntityIdComponents (ace#1810)', () => {
  const xml = `
    <h:html xmlns:h="http://www.w3.org/1999/xhtml">
      <h:head><model>
        <bind nodeset="/data/one" calculate="/data/two"/>
        <bind nodeset="/data/two" calculate="/data/three"/>
        <bind nodeset="/data/three" calculate="min(/data/leaf, 3)"/>
      </model></h:head>
    </h:html>`;

  it('follows a multi-hop chain and records every hop in order', () => {
    const [e] = expandEntityIdComponents(xml, ['/data/one']);
    expect(e.via).toEqual(['/data/one', '/data/two', '/data/three']);
    expect(e.text).toMatch(/\/data\/leaf/);
  });

  it('leaves a component with no bind untouched', () => {
    const [e] = expandEntityIdComponents(xml, ['/data/unbound']);
    expect(e.via).toEqual([]);
    expect(e.text).toBe('/data/unbound');
  });
});
