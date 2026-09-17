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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Real released CCZ form XMLs, vendored verbatim. */
const CCZ_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ccz');
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

/**
 * dimagi-internal/ace#2417 — a CONDITIONAL `entity_id` was read as one opaque
 * component, so two `[BLOCKER]`s landed on a key that is correct on both
 * branches and Phase 3 hard-halted.
 *
 * Both fixtures below are REAL released artifacts read from `test/fixtures/ccz/`,
 * not inline literals:
 *
 *   - POSITIVE — `poverty-graduation-targeting-survey.xml`: the verbatim
 *     `modules-0/forms-0.xml` of Deliver app e4594937038c42d2be4d01f45df44209,
 *     released build e55a640283e74900ba2453d0dea13714 on `connect-ace-prod`
 *     (`poverty-graduation/20260915-1518`). Its `/data/entity_key` is
 *     `if(/data/visit_outcome = 'completed', concat(hh_head_name, ' - ',
 *     respondent_name, ' - targeting_survey - completed'), concat(gps_lat, ',',
 *     gps_lon, ' - targeting_survey - ', visit_outcome))`. The conditional is
 *     what the PDD's non-payable branch requires — a vacant dwelling or a
 *     refusal has no household-head or respondent name, so the key falls back
 *     to the GPS point. Both branches carry household identity plus the
 *     activity code; neither carries a username or a date.
 *
 *   - NEGATIVE — `hh-poverty-targeting-visit.xml`: the released ace#1285 key,
 *     `concat(<casedb username>, ' | ', visit_outcome, ' | ', if(...))`. The
 *     conditional here is nested INSIDE a `concat`, which is deliberately NOT
 *     decomposed: splitting it would hand the clean `hh_head_key` sub-branch to
 *     the union and suppress `no-entity-component` on the worker-and-day one —
 *     the exact defect this module was written for.
 *
 * Measured on this fixture before the change: `components` was a single string
 * containing the whole `if(...)`, and the report carried `[answer-in-grain]` +
 * `[no-entity-component]`.
 */
describe('a CONDITIONAL entity_id key (ace#2417)', () => {
  const SHIPPED = readFileSync(
    join(CCZ_FIXTURES, 'poverty-graduation-targeting-survey.xml'),
    'utf8',
  );
  /** The released bind, quoted from the fixture — the mutations below target it. */
  const SHIPPED_KEY =
    "calculate=\"if(/data/visit_outcome = 'completed', " +
    "concat(/data/g_identity/hh_head_name, ' - ', /data/g_identity/respondent_name, " +
    "' - targeting_survey - completed'), " +
    "concat(/data/g_gps/gps_lat, ',', /data/g_gps/gps_lon, ' - targeting_survey - ', " +
    '/data/visit_outcome))"';
  /** What `app-release-qa` passes for this PDD: a declared non-payable branch. */
  const OPTS = { hasNonPayableBranch: true, payabilityDiscriminator: 'visit_outcome' };

  it('the captured fixture really carries the conditional key', () => {
    // Without this, every mutation below could be a silent no-op.
    expect(SHIPPED).toContain(SHIPPED_KEY);
  });

  it('decomposes the conditional into its branches, dropping the predicate', () => {
    const c = extractEntityIdComponents(SHIPPED);
    expect(c.resolved).toBe(true);
    expect(c.branches).toEqual([
      ['/data/g_identity/hh_head_name', '/data/g_identity/respondent_name'],
      ['/data/g_gps/gps_lat', '/data/g_gps/gps_lon', '/data/visit_outcome'],
    ]);
    // The predicate `/data/visit_outcome = 'completed'` selects a key; it is
    // not part of one, and must never appear as a component.
    expect(c.components).not.toContain("/data/visit_outcome = 'completed'");
    // The union, for the declared-node test — a declared business key
    // legitimately appears on the payable branch only.
    expect(c.components).toEqual([
      '/data/g_identity/hh_head_name',
      '/data/g_identity/respondent_name',
      '/data/g_gps/gps_lat',
      '/data/g_gps/gps_lon',
      '/data/visit_outcome',
    ]);
  });

  it('POSITIVE CONTROL — the real released conditional key is clean', () => {
    const r = checkEntityIdGrain(SHIPPED, [], OPTS);
    assertChecked(r);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(isPass(r)).toBe(true);
  });

  it('NEGATIVE CONTROL — the released ace#1285 worker-and-day key still fails', () => {
    // Real captured artifact, a different released build, unmodified. Its
    // conditional sits INSIDE a concat and stays opaque on purpose.
    const live = readFileSync(join(CCZ_FIXTURES, 'hh-poverty-targeting-visit.xml'), 'utf8');
    const r = checkEntityIdGrain(live, []);
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toEqual(
      expect.arrayContaining(['answer-in-grain', 'no-entity-component']),
    );
  });

  it('NEGATIVE CONTROL — a branch keyed on worker + date is still a [BLOCKER]', () => {
    // THE laundering case. Branch 1 is the shipped, correct household key;
    // branch 2 is replaced with worker + date. Reading the union would pass
    // this — every branch must carry entity identity.
    const oneBadBranch = SHIPPED.replace(
      SHIPPED_KEY,
      "calculate=\"if(/data/visit_outcome = 'completed', " +
        "concat(/data/g_identity/hh_head_name, ' - ', /data/g_identity/respondent_name, " +
        "' - targeting_survey - completed'), " +
        "concat(instance('casedb')/casedb/case[@case_type='commcare-user']" +
        "[hq_user_id=instance('commcaresession')/session/context/userid]/username, ' - ', " +
        '/data/survey_date, \' - targeting_survey - \', /data/visit_outcome))"',
    );
    expect(oneBadBranch).not.toBe(SHIPPED);
    const r = checkEntityIdGrain(oneBadBranch, [], OPTS);
    assertChecked(r);
    expect(r.ok).toBe(false);
    const noEntity = r.findings.filter((f) => f.kind === 'no-entity-component');
    expect(noEntity).toHaveLength(1);
    expect(noEntity[0].detail).toMatch(/branch 2 of 2/);
    expect(noEntity[0].detail).toMatch(/username/);
    expect(noEntity[0].detail).toMatch(/weakest branch/);
  });

  it('NEGATIVE CONTROL — an ANSWER in a branch is still a [BLOCKER]', () => {
    // The ace#969 over-correction wearing a conditional: the payable branch
    // gains a consent answer that no mandate puts there. Decomposition must
    // not hide it — before this change it was hidden the other way round, by
    // the whole blob being one unreadable component.
    const answerInBranch = SHIPPED.replace(
      "concat(/data/g_identity/hh_head_name, ' - ', /data/g_identity/respondent_name, " +
        "' - targeting_survey - completed')",
      "concat(/data/g_identity/hh_head_name, ' - ', /data/g_consent/consent, " +
        "' - targeting_survey - completed')",
    );
    expect(answerInBranch).not.toBe(SHIPPED);
    const r = checkEntityIdGrain(answerInBranch, [], OPTS);
    assertChecked(r);
    expect(r.ok).toBe(false);
    const answers = r.findings.filter((f) => f.kind === 'answer-in-grain');
    expect(answers).toHaveLength(1);
    // The finding names the NODE, not the whole `if(...)` blob — before this
    // change the blob was the component, so the detail was unreadable and the
    // discriminator exemption could never match its tail.
    expect(answers[0].detail.startsWith('/data/g_consent/consent ')).toBe(true);
  });

  it('NEGATIVE CONTROL — a declared node in NEITHER branch is still missing', () => {
    const r = checkEntityIdGrain(SHIPPED, ['hh_head_name', 'household_id'], OPTS);
    assertChecked(r);
    expect(r.findings.map((f) => f.kind)).toEqual(['missing-declared-node']);
    expect(r.findings[0].detail).toMatch(/household_id/);
  });

  it('a declared node on the PAYABLE branch only is present — the union is right here', () => {
    // The non-payable branch cannot carry a household-head name; there is
    // none. Requiring every branch to carry the declared grain would refuse
    // the very shape the PDD mandates.
    const r = checkEntityIdGrain(SHIPPED, ['hh_head_name', 'respondent_name'], OPTS);
    assertChecked(r);
    expect(r.findings).toEqual([]);
  });

  it('the discriminator is still the ONLY answer field suppressed (ace#1441)', () => {
    // `visit_outcome` is in branch 2 as a real component and is exempt because
    // `payability-scoped-key` mandates it. Drop the mandate and it fires.
    const r = checkEntityIdGrain(SHIPPED, [], {});
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('answer-in-grain');
    expect(r.findings.find((f) => f.kind === 'answer-in-grain')!.detail).toMatch(
      /\/data\/visit_outcome/,
    );
  });
});

describe('conditional decomposition — the boundary (ace#2417)', () => {
  const key = (calc: string): string => `
    <h:html xmlns:h="http://www.w3.org/1999/xhtml">
      <h:head><model>
        <bind nodeset="/data/x/deliver/entity_id" calculate="${calc
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/"/g, '&quot;')}"/>
      </model></h:head>
    </h:html>`;

  it('expands a nested conditional branch into a third key', () => {
    const c = extractEntityIdComponents(
      key("if(/data/a = 'y', /data/hh_id, if(/data/b = 'y', /data/gps, /data/plot_id))"),
    );
    expect(c.branches).toEqual([['/data/hh_id'], ['/data/gps'], ['/data/plot_id']]);
  });

  it('does NOT split a conditional nested inside a concat — that is the ace#1285 shape', () => {
    const c = extractEntityIdComponents(
      key("concat(/data/hh_id, ' | ', if(/data/a = 'y', /data/b, /data/visit_date))"),
    );
    expect(c.branches).toBeUndefined();
    expect(c.components).toEqual([
      '/data/hh_id',
      "if(/data/a = 'y', /data/b, /data/visit_date)",
    ]);
  });

  it.each([
    ["if(/data/a = 'y', /data/b, /data/c) + 1", 'an if() that is only part of the expression'],
    ["if(/data/a = 'y', /data/b)", 'a two-argument if()'],
    ["concat('if(', /data/hh_id)", 'a literal that merely mentions if('],
    ['/data/hh_id', 'a bare node'],
  ])('%s is not a conditional key (%s)', (calc) => {
    expect(extractEntityIdComponents(key(calc)).branches).toBeUndefined();
  });

  it('splits a predicate containing a comma without losing an argument', () => {
    const c = extractEntityIdComponents(
      key("if(selected(/data/outcome, 'completed'), /data/hh_id, /data/gps)"),
    );
    expect(c.branches).toEqual([['/data/hh_id'], ['/data/gps']]);
  });

  it('is bounded, so a deeply nested conditional cannot hang the gate', () => {
    let calc = '/data/leaf';
    for (let i = 0; i < 12; i++) calc = `if(/data/p${i} = 'y', /data/hh${i}, ${calc})`;
    expect(() => extractEntityIdComponents(key(calc))).not.toThrow();
    expect(extractEntityIdComponents(key(calc)).branches!.length).toBeGreaterThan(1);
  });

  it('REGRESSION — a comma inside a separator literal is not an argument break', () => {
    // `concat(lat, ',', lon)` is how a GPS point is spelled. Splitting inside
    // the literal yielded two bare `'` arguments, which survive the
    // string-literal filter and read as entity-identifying nodes — so
    // `concat(username, ',', visit_date)` scored an entity component it does
    // not have, and the junk landed in the operator-facing report.
    const c = extractEntityIdComponents(
      key("concat(/data/g_gps/gps_lat, ',', /data/g_gps/gps_lon)"),
    );
    expect(c.components).toEqual(['/data/g_gps/gps_lat', '/data/g_gps/gps_lon']);
    expect(c.components).not.toContain("'");
  });

  it("REGRESSION — a ',' separator cannot launder no-entity-component", () => {
    const r = checkEntityIdGrain(
      key(
        "concat(instance('casedb')/casedb/case[@case_type='commcare-user']" +
          "[hq_user_id=instance('commcaresession')/session/context/userid]/username, ','," +
          ' /data/visit_date)',
      ),
      [],
    );
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('no-entity-component');
  });
});
