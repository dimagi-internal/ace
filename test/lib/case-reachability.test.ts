import { describe, it, expect } from 'vitest';

import {
  findReachableCaseTypes,
  findUnreachableCaseLists,
  hasCaseTransaction,
} from '../../lib/commcare-cli-validate.js';

// ---------------------------------------------------------------------------
// dimagi-internal/ace#977
//
// The issue's original headline — "Deliver XForms emit NO <case> block" — was
// DISPROVED on 2026-08-14 against a post-#989 released CCZ: it carried a
// complete transaction with all 34 declared properties. Every prior
// observation came from DRAFTS, and from inside the #989 prompt-truncation
// window, which is why a month of grepping produced nothing decidable.
//
// What survives is a different, fully ACE-owned defect on the same artifact:
// pdd-to-deliver-app Step 4d adds a case-list column to registration-only
// modules to clear a Nova validate_app error, and that list can never be put
// on screen. commcare-cli `play` structurally cannot notice — with no entity
// datum it walks straight to form entry and returns a clean pass.
// ---------------------------------------------------------------------------

/** The shape observed on the 2026-08-13 registration-only Deliver build. */
const REGISTRATION_ONLY_SUITE = `
<suite>
  <detail id="m0_case_short"><title><text>Households</text></title></detail>
  <detail id="m0_case_long"><title><text>Household</text></title></detail>
  <entry>
    <command id="m0-f0"><text>Register Household</text></command>
    <session>
      <datum id="case_id_new_household_0" function="uuid()"/>
    </session>
  </entry>
</suite>`;

/** A followup module: the entity datum puts the case list on screen. */
const FOLLOWUP_SUITE = `
<suite>
  <detail id="m1_case_short"><title><text>Households</text></title></detail>
  <detail id="m1_case_long"><title><text>Household</text></title></detail>
  <entry>
    <command id="m1-f0"><text>Follow-up Visit</text></command>
    <session>
      <datum id="case_id" nodeset="instance('casedb')/casedb/case[@case_type='household']"
             value="./@case_id" detail-select="m1_case_short" detail-confirm="m1_case_long"/>
    </session>
  </entry>
</suite>`;

describe('findUnreachableCaseLists — the surviving ace#977 defect', () => {
  it('THE REGRESSION: a registration-only module with a configured case list', () => {
    // The entry's only datum is function="uuid()" — no entity selection — yet
    // m0_case_short / m0_case_long exist. Those columns are dead config, and
    // ACE's own Step 4d "case-list column heal" is what created them.
    const out = findUnreachableCaseLists(REGISTRATION_ONLY_SUITE);
    expect(out).toHaveLength(1);
    expect(out[0].commandId).toBe('m0-f0');
    expect(out[0].detailIds).toEqual(['m0_case_short', 'm0_case_long'].sort());
    // Nothing else in this app selects on `household`, so it is dead app-wide.
    expect(out[0].severity).toBe('blocker');
    expect(out[0].caseType).toBe('household');
    expect(out[0].reachableVia).toBeUndefined();
  });

  it('a followup module with an entity datum is reachable — no finding', () => {
    expect(findUnreachableCaseLists(FOLLOWUP_SUITE)).toEqual([]);
  });

  it('a registration entry with NO case-list details is not a finding', () => {
    // Registration-only is perfectly legitimate. The defect is specifically
    // configuring a list that cannot be shown — not the absence of one.
    const suite = `
      <suite>
        <entry>
          <command id="m0-f0"><text>Register</text></command>
          <session><datum id="case_id_new_x_0" function="uuid()"/></session>
        </entry>
      </suite>`;
    expect(findUnreachableCaseLists(suite)).toEqual([]);
  });

  it('reports only the non-entity entry in a mixed app', () => {
    const mixed = REGISTRATION_ONLY_SUITE.replace('</suite>', '') + FOLLOWUP_SUITE.replace('<suite>', '');
    const out = findUnreachableCaseLists(mixed);
    expect(out.map((o) => o.commandId)).toEqual(['m0-f0']);
    // ...and because m1 selects on the SAME case type, it is not a blocker.
    expect(out[0].severity).toBe('info');
  });

  it('a value= datum is computed silently and does not make a list reachable', () => {
    // Same rule deriveNavInput already uses: only `nodeset` puts a list on
    // screen. A `value=` datum is the other silent shape.
    const suite = `
      <suite>
        <detail id="m0_case_short"/>
        <entry>
          <command id="m0-f0"/>
          <session><datum id="case_id" value="instance('commcaresession')/session/data/x"/></session>
        </entry>
      </suite>`;
    expect(findUnreachableCaseLists(suite)).toHaveLength(1);
  });

  it('returns [] on empty or unparseable suite xml rather than throwing', () => {
    expect(findUnreachableCaseLists('')).toEqual([]);
    expect(findUnreachableCaseLists('<not-a-suite/>')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1281 — the per-module form of the check was a FALSE
// POSITIVE BY CONSTRUCTION and halted Phase 3 on every ACE Deliver app.
//
// Observed live on spark-facilitator/20260813-2126 (Deliver app
// c6cdfa87-3bc1-4d85-aa98-f4eb521d5fa1, released build e57853f9dcef…): the
// registration module m0 gets ONLY `<datum id="case_id_new_community_0"
// function="uuid()"/>`, while the sibling Village Monitoring Visit module m1
// carries a real entity datum over the SAME `community` case type. `play`
// traces confirmed both: entry [0,0] goes menu -> DATUM -> COMMAND with no
// Case screen; entry [1,0] renders `Case | demo` with both columns.
//
// The producer side CANNOT fix it. Asked to remove the last case-list column
// from m0, Nova refused: "Module ... shows \"community\" cases but its Results
// screen has no visible fields. Every case list needs at least one visible
// Results field ... Nothing was changed." Nova requires the column; the checker
// blocked on the inert detail that necessarily results.
// ---------------------------------------------------------------------------

/** Verbatim shape of the spark-facilitator 2026-08-13 released Deliver suite. */
const SPARK_FACILITATOR_SUITE = `
<suite>
  <detail id="m0_case_short"><title><text>Communities</text></title></detail>
  <detail id="m0_case_long"><title><text>Community</text></title></detail>
  <detail id="m1_case_short"><title><text>Communities</text></title></detail>
  <detail id="m1_case_long"><title><text>Community</text></title></detail>
  <entry>
    <command id="m0-f0"><text>CBF Registration</text></command>
    <session>
      <datum id="case_id_new_community_0" function="uuid()"/>
    </session>
  </entry>
  <entry>
    <command id="m1-f0"><text>Village Monitoring Visit</text></command>
    <session>
      <datum id="case_id"
             nodeset="instance('casedb')/casedb/case[@case_type='community'][@status='open']"
             value="./@case_id" detail-select="m1_case_short" detail-confirm="m1_case_long"/>
    </session>
  </entry>
</suite>`;

describe('findUnreachableCaseLists — app-wide severity (ace#1281)', () => {
  it('DOWNGRADES to info when a sibling module selects on the same case type', () => {
    const out = findUnreachableCaseLists(SPARK_FACILITATOR_SUITE);
    const m0 = out.find((o) => o.commandId === 'm0-f0');
    expect(m0).toBeDefined();
    expect(m0!.severity).toBe('info');
    expect(m0!.caseType).toBe('community');
    expect(m0!.reachableVia).toBe('m1-f0');
    // The inert details are still NAMED — the finding is informational, not gone.
    expect(m0!.detailIds).toEqual(['m0_case_long', 'm0_case_short']);
    // And the reachable module is never itself a finding.
    expect(out.some((o) => o.commandId === 'm1-f0')).toBe(false);
    // Nothing in this app blocks the release.
    expect(out.filter((o) => o.severity === 'blocker')).toEqual([]);
  });

  it('NEGATIVE CONTROL: the only entry is uuid()-only — BLOCKER still fires', () => {
    // Same app with the followup module deleted: `community` is now reachable
    // from nowhere, which is the genuine ace#977 dead-configuration case.
    const registrationOnly = SPARK_FACILITATOR_SUITE.replace(
      /<entry>\s*<command id="m1-f0"[\s\S]*?<\/entry>/,
      '',
    );
    const out = findUnreachableCaseLists(registrationOnly);
    expect(out).toHaveLength(1);
    expect(out[0].commandId).toBe('m0-f0');
    expect(out[0].severity).toBe('blocker');
    expect(out[0].caseType).toBe('community');
    expect(out[0].reachableVia).toBeUndefined();
  });

  it('a sibling list over a DIFFERENT case type does not make it reachable', () => {
    const otherType = SPARK_FACILITATOR_SUITE.replace(
      "@case_type='community'",
      "@case_type='village'",
    );
    const out = findUnreachableCaseLists(otherType);
    const m0 = out.find((o) => o.commandId === 'm0-f0');
    expect(m0!.severity).toBe('blocker');
    expect(m0!.reachableVia).toBeUndefined();
  });

  it('a nodeset datum with no detail-select renders no list — not reachability', () => {
    const noDetailSelect = SPARK_FACILITATOR_SUITE.replace(
      ' detail-select="m1_case_short" detail-confirm="m1_case_long"',
      '',
    );
    const out = findUnreachableCaseLists(noDetailSelect);
    expect(out.find((o) => o.commandId === 'm0-f0')!.severity).toBe('blocker');
  });
});

describe('findReachableCaseTypes', () => {
  it('maps each selectable case type to the command that puts it on screen', () => {
    const map = findReachableCaseTypes(SPARK_FACILITATOR_SUITE);
    expect(map.get('community')).toBe('m1-f0');
    expect(map.size).toBe(1);
  });

  it('is empty for a registration-only app and for junk input', () => {
    expect(findReachableCaseTypes(REGISTRATION_ONLY_SUITE).size).toBe(0);
    expect(findReachableCaseTypes('').size).toBe(0);
    expect(findReachableCaseTypes('<not-a-suite/>').size).toBe(0);
  });
});

describe('hasCaseTransaction — the regression preventer (passes today)', () => {
  it('finds the top-level transaction shape from the released CCZ', () => {
    // hh-poverty-targeting/20260813-1612, build a3ade306, is_released: true.
    const xml = `
      <data xmlns="http://openrosa.org/formdesigner/abc">
        <household_name/>
        <case xmlns="http://commcarehq.org/case/transaction/v2" case_id="" date_modified="">
          <create><case_type>household</case_type><case_name/></create>
          <update><hh_size/><village/></update>
        </case>
      </data>`;
    expect(hasCaseTransaction(xml)).toBe(true);
  });

  it('finds the Vellum SaveToCase shape nested in __nova_operations', () => {
    // spark-facilitator/20260812-1635.
    const xml = `
      <data xmlns="http://openrosa.org/formdesigner/abc">
        <__nova_operations>
          <case xmlns="http://commcarehq.org/case/transaction/v2"><update><x/></update></case>
        </__nova_operations>
      </data>`;
    expect(hasCaseTransaction(xml)).toBe(true);
  });

  it('finds a prefix-bound transaction', () => {
    const xml = `<data xmlns:cx="http://commcarehq.org/case/transaction/v2"><cx:case><cx:create/></cx:case></data>`;
    expect(hasCaseTransaction(xml)).toBe(true);
  });

  it('is NOT fooled by an unrelated <case> element', () => {
    // Anchored on the namespace, not the tag name — a form field literally
    // named `case` must not read as a case transaction.
    const xml = `<data xmlns="http://openrosa.org/formdesigner/abc"><case>some answer</case></data>`;
    expect(hasCaseTransaction(xml)).toBe(false);
  });

  it('reports false on a form with no case machinery at all', () => {
    // The draft shape observed at 2026-08-14T00:09 — 68 binds, zero case.
    expect(hasCaseTransaction('<data><q1/><q2/></data>')).toBe(false);
    expect(hasCaseTransaction('')).toBe(false);
  });
});
