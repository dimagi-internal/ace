import { describe, it, expect } from 'vitest';
import {
  checkConstraintLocality,
  checkRelevanceReachability,
  formatConstraintLocalityReport,
  formatRelevanceReachabilityReport,
} from './constraint-locality';

//
// Negative control: the REAL defective binds from the released
// hh-poverty-targeting Deliver CCZ (connect-ace-prod app
// c3ca65a546984fdd86479d18b4c4c3f1, build 4a8e26482063486dab35474a4c762fd2),
// which `pdd-to-deliver-app-eval` scored 8.5/10 and Sophie Feintuch caught on
// first read (dimagi-internal/ace#980).
//
const DEFECTIVE_FORM = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns:jr="http://openrosa.org/javarosa">
  <h:head>
    <model>
      <instance>
        <data>
          <visit_outcome/>
          <consent/>
          <respondent_name/>
          <roster><member_name/></roster>
          <hh_size_count/>
          <i1_zone/>
          <gps/>
          <gps_accuracy/>
          <gps_onsite_confirm/>
        </data>
      </instance>
      <bind nodeset="/data/visit_outcome" required="true()"/>
      <bind nodeset="/data/consent" required="/data/visit_outcome = 'completed'"/>
      <bind nodeset="/data/respondent_name" constraint="string-length(.) &lt;= 80"
            jr:constraintMsg="Please keep the name to 80 characters or fewer."/>
      <bind nodeset="/data/roster/member_name" required="true()"/>
      <bind nodeset="/data/hh_size_count" calculate="count(/data/roster)"/>
      <bind nodeset="/data/i1_zone" constraint="count(/data/roster) &gt;= 1"
            jr:constraintMsg="Add at least one household member before continuing."/>
      <bind nodeset="/data/gps"/>
      <bind nodeset="/data/gps_accuracy" calculate="if(/data/gps = '', '', selected-at(/data/gps, 3))"/>
      <bind nodeset="/data/gps_onsite_confirm"
            constraint="number(selected-at(/data/gps, 3)) &lt;= 50"
            jr:constraintMsg="Location accuracy must be within 50 meters. Move to an open area and recapture the location before continuing."/>
    </model>
  </h:head>
  <h:body>
    <repeat nodeset="/data/roster"><input ref="/data/roster/member_name"/></repeat>
  </h:body>
</h:html>`;

// The corrected shape: the accuracy rule moved onto the geopoint itself, and
// the roster-minimum rule moved onto a gate immediately after the repeat.
const CORRECTED_FORM = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns:jr="http://openrosa.org/javarosa">
  <h:head>
    <model>
      <instance>
        <data>
          <respondent_name/>
          <roster><member_name/></roster>
          <roster_gate/>
          <i1_zone/>
          <gps/>
          <gps_onsite_confirm/>
        </data>
      </instance>
      <bind nodeset="/data/respondent_name" constraint="string-length(.) &lt;= 80"/>
      <bind nodeset="/data/roster/member_name" required="true()"
            constraint="string-length(.) &lt;= 80"/>
      <bind nodeset="/data/roster_gate" constraint="count(/data/roster) &gt;= 1"
            jr:constraintMsg="Add at least one household member to continue."/>
      <bind nodeset="/data/i1_zone" required="true()"/>
      <bind nodeset="/data/gps" constraint="selected-at(., 3) &lt;= 50"
            jr:constraintMsg="Accuracy is low. Move to an open area and capture again."/>
      <bind nodeset="/data/gps_onsite_confirm" required="true()"/>
    </model>
  </h:head>
  <h:body>
    <repeat nodeset="/data/roster"><input ref="/data/roster/member_name"/></repeat>
  </h:body>
</h:html>`;

describe('checkConstraintLocality', () => {
  it('flags both real non-local constraints from the shipped hh-poverty-targeting form', () => {
    const report = checkConstraintLocality(DEFECTIVE_FORM);
    const ids = report.violations.map((v) => v.fieldId).sort();
    expect(ids).toEqual(['gps_onsite_confirm', 'i1_zone']);
  });

  it('names the foreign node the user cannot reach, per violation', () => {
    const { violations } = checkConstraintLocality(DEFECTIVE_FORM);
    const gps = violations.find((v) => v.fieldId === 'gps_onsite_confirm')!;
    expect(gps.foreignRefs).toContain('/data/gps');
    const zone = violations.find((v) => v.fieldId === 'i1_zone')!;
    expect(zone.foreignRefs).toContain('/data/roster');
  });

  it('carries the misleading message through, so the QA report can quote it', () => {
    const { violations } = checkConstraintLocality(DEFECTIVE_FORM);
    const gps = violations.find((v) => v.fieldId === 'gps_onsite_confirm')!;
    // The message tells the FLW to do something impossible on that screen.
    expect(gps.message).toMatch(/recapture the location/i);
  });

  it('passes the corrected form — constraints moved onto their own nodes', () => {
    const report = checkConstraintLocality(CORRECTED_FORM);
    expect(report.violations).toEqual([]);
    expect(report.constraintsChecked).toBe(4);
  });

  it('treats `.` self-reference as local (a question constraining itself)', () => {
    const { violations } = checkConstraintLocality(CORRECTED_FORM);
    expect(violations.find((v) => v.fieldId === 'gps')).toBeUndefined();
  });

  it('treats a same-repeat sibling as local', () => {
    const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml">
  <h:head><model>
    <bind nodeset="/data/roster/age" constraint=". &lt;= /data/roster/max_age"/>
    <bind nodeset="/data/roster/max_age"/>
  </model></h:head>
  <h:body><repeat nodeset="/data/roster"/></h:body>
</h:html>`;
    expect(checkConstraintLocality(xml).violations).toEqual([]);
  });

  it('does not flag a calculate over constants — the fix is your own answer', () => {
    const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml">
  <h:head><model>
    <bind nodeset="/data/total" calculate="1 + 2"/>
    <bind nodeset="/data/answer" constraint=". &lt;= /data/total"/>
  </model></h:head>
  <h:body/>
</h:html>`;
    // /data/total is not a screen; the user satisfies this by changing `.`.
    expect(checkConstraintLocality(xml).violations).toEqual([]);
  });

  it('sees THROUGH a calculate to the foreign question behind it', () => {
    // The obfuscated form of the gps_onsite_confirm defect: the constraint
    // reads a hidden calculate, which itself reads the earlier geopoint.
    // Resolving calculates transitively is what stops indirection from
    // laundering a non-local constraint past the check.
    const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml">
  <h:head><model>
    <bind nodeset="/data/gps"/>
    <bind nodeset="/data/gps_accuracy" calculate="selected-at(/data/gps, 3)"/>
    <bind nodeset="/data/confirm" constraint="number(/data/gps_accuracy) &lt;= 50"/>
  </model></h:head>
  <h:body/>
</h:html>`;
    const { violations } = checkConstraintLocality(xml);
    expect(violations.map((v) => v.fieldId)).toEqual(['confirm']);
    expect(violations[0].foreignRefs).toContain('/data/gps');
  });

  it('allows a min-rows gate placed IMMEDIATELY after its repeat (one Back tap)', () => {
    const { violations } = checkConstraintLocality(CORRECTED_FORM);
    expect(violations.find((v) => v.fieldId === 'roster_gate')).toBeUndefined();
  });

  it('still flags the SAME rule when it drifts away from the repeat', () => {
    // Identical constraint, moved two questions later — this is exactly the
    // ace#980 i1_zone defect, and adjacency is the only thing separating it
    // from the sanctioned gate above.
    const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml">
  <h:head><model>
    <bind nodeset="/data/roster/member_name" required="true()"/>
    <bind nodeset="/data/unrelated_a"/>
    <bind nodeset="/data/i1_zone" constraint="count(/data/roster) &gt;= 1"/>
  </model></h:head>
  <h:body><repeat nodeset="/data/roster"/></h:body>
</h:html>`;
    const { violations } = checkConstraintLocality(xml);
    expect(violations.map((v) => v.fieldId)).toEqual(['i1_zone']);
  });

  it('does not infinitely recurse on a cyclic calculate chain', () => {
    const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml">
  <h:head><model>
    <bind nodeset="/data/a" calculate="/data/b"/>
    <bind nodeset="/data/b" calculate="/data/a"/>
    <bind nodeset="/data/q" constraint=". &lt; /data/a"/>
  </model></h:head>
  <h:body/>
</h:html>`;
    expect(() => checkConstraintLocality(xml)).not.toThrow();
  });

  it('counts every constraint it inspected, not just the failures', () => {
    expect(checkConstraintLocality(DEFECTIVE_FORM).constraintsChecked).toBe(3);
  });

  it('reports PASS text when there is nothing to flag', () => {
    const out = formatConstraintLocalityReport(
      checkConstraintLocality(CORRECTED_FORM),
    );
    expect(out).toMatch(/^constraint-locality: PASS/);
  });

  it('reports FAIL text naming each offending field', () => {
    const out = formatConstraintLocalityReport(
      checkConstraintLocality(DEFECTIVE_FORM),
    );
    expect(out).toMatch(/^constraint-locality: FAIL \(2 of 3/);
    expect(out).toContain('gps_onsite_confirm');
    expect(out).toContain('i1_zone');
  });

  it('handles a form with no constraints at all', () => {
    const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml">
  <h:head><model><bind nodeset="/data/a" required="true()"/></model></h:head>
  <h:body/>
</h:html>`;
    const report = checkConstraintLocality(xml);
    expect(report.constraintsChecked).toBe(0);
    expect(report.violations).toEqual([]);
  });
});

describe('itext resolution', () => {
  it('resolves a jr:itext() constraint message to its real text', () => {
    // Real CommCare forms store constraint messages in itext; an unresolved
    // reference hides the very instruction that proves the defect.
    const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns:jr="http://openrosa.org/javarosa">
  <h:head><model>
    <itext>
      <translation lang="en" default="">
        <text id="confirm-constraintMsg">
          <value>Location accuracy must be within 50 meters. Move to an open area and recapture the location before continuing.</value>
        </text>
      </translation>
    </itext>
    <bind nodeset="/data/gps"/>
    <bind nodeset="/data/confirm" constraint="selected-at(/data/gps, 3) &lt;= 50"
          jr:constraintMsg="jr:itext('confirm-constraintMsg')"/>
  </model></h:head>
  <h:body/>
</h:html>`;
    const { violations } = checkConstraintLocality(xml);
    expect(violations[0].message).toMatch(/recapture the location/i);
    expect(violations[0].message).not.toMatch(/jr:itext/);
  });

  it('leaves a literal message untouched', () => {
    const { violations } = checkConstraintLocality(DEFECTIVE_FORM);
    const zone = violations.find((v) => v.fieldId === 'i1_zone')!;
    expect(zone.message).toBe('Add at least one household member before continuing.');
  });
});

describe('checkRelevanceReachability', () => {
  // The REAL shape from hh-poverty-targeting/20260727-1406 (ace#996):
  // outcome_note sits on the dwelling-status screen but its relevance also
  // references respondent_eligible and consent, both answered a screen later.
  const OUTCOME_NOTE_FORM = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml">
  <h:head><model>
    <bind nodeset="/data/dwelling_status" required="true()"/>
    <bind nodeset="/data/outcome_note"
          relevant="/data/dwelling_status != 'occupied_eligible' or /data/respondent_eligible = 'neither' or /data/consent = 'no'"/>
    <bind nodeset="/data/respondent_eligible" required="true()"/>
    <bind nodeset="/data/consent" required="true()"/>
  </model></h:head>
  <h:body/>
</h:html>`;

  it('flags a relevance that references later-answered fields', () => {
    const { violations } = checkRelevanceReachability(OUTCOME_NOTE_FORM);
    expect(violations.map((v) => v.fieldId)).toEqual(['outcome_note']);
    expect(violations[0].laterRefs.sort()).toEqual([
      '/data/consent',
      '/data/respondent_eligible',
    ]);
  });

  it('distinguishes partially-decidable from wholly-unreachable', () => {
    // dwelling_status IS answered before outcome_note, so one clause resolves.
    const { violations } = checkRelevanceReachability(OUTCOME_NOTE_FORM);
    expect(violations[0].whollyUnreachable).toBe(false);
  });

  it('marks a field wholly unreachable when EVERY reference is later', () => {
    const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml">
  <h:head><model>
    <bind nodeset="/data/note" relevant="/data/consent = 'no'"/>
    <bind nodeset="/data/consent" required="true()"/>
  </model></h:head>
  <h:body/>
</h:html>`;
    const { violations } = checkRelevanceReachability(xml);
    expect(violations[0].whollyUnreachable).toBe(true);
  });

  it('passes when relevance references only earlier answers', () => {
    const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml">
  <h:head><model>
    <bind nodeset="/data/consent" required="true()"/>
    <bind nodeset="/data/name" relevant="/data/consent = 'yes'"/>
  </model></h:head>
  <h:body/>
</h:html>`;
    const r = checkRelevanceReachability(xml);
    expect(r.violations).toEqual([]);
    expect(r.relevancesChecked).toBe(1);
  });

  it('sees THROUGH a calculate to the later question behind it', () => {
    // A hidden calculate inherits the position of the latest real question it
    // depends on — so wrapping a later answer in a calculate does not launder it.
    const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml">
  <h:head><model>
    <bind nodeset="/data/note" relevant="/data/outcome = 'refused'"/>
    <bind nodeset="/data/consent" required="true()"/>
    <bind nodeset="/data/outcome" calculate="if(/data/consent = 'no', 'refused', 'completed')"/>
  </model></h:head>
  <h:body/>
</h:html>`;
    const { violations } = checkRelevanceReachability(xml);
    expect(violations.map((v) => v.fieldId)).toEqual(['note']);
    expect(violations[0].laterRefs).toContain('/data/outcome');
  });

  it('does not flag a calculate over constants', () => {
    const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml">
  <h:head><model>
    <bind nodeset="/data/flag" relevant="/data/k = 1"/>
    <bind nodeset="/data/k" calculate="1 + 2"/>
  </model></h:head>
  <h:body/>
</h:html>`;
    expect(checkRelevanceReachability(xml).violations).toEqual([]);
  });

  it('handles a form with no relevance expressions', () => {
    const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml">
  <h:head><model><bind nodeset="/data/a" required="true()"/></model></h:head>
  <h:body/>
</h:html>`;
    const r = checkRelevanceReachability(xml);
    expect(r.relevancesChecked).toBe(0);
    expect(r.violations).toEqual([]);
  });

  it('reports PASS text when nothing is flagged', () => {
    const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml">
  <h:head><model>
    <bind nodeset="/data/consent"/>
    <bind nodeset="/data/name" relevant="/data/consent = 'yes'"/>
  </model></h:head>
  <h:body/>
</h:html>`;
    expect(
      formatRelevanceReachabilityReport(checkRelevanceReachability(xml)),
    ).toMatch(/^relevance-reachability: PASS/);
  });

  it('reports FAIL text naming the field and saying it can never show', () => {
    const out = formatRelevanceReachabilityReport(
      checkRelevanceReachability(OUTCOME_NOTE_FORM),
    );
    expect(out).toMatch(/^relevance-reachability: FAIL \(1 of 1/);
    expect(out).toContain('outcome_note');
    expect(out).toContain('never contribute');
  });
});
