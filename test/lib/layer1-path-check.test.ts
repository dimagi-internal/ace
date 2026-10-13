import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkLayer1Paths,
  formSubmissionPaths,
  isDeliverForm,
  xformRefToFormPath,
  type Layer1Field,
  type ReleasedForm,
} from '../../lib/layer1-path-check';
import { checkRegistryAuthoring, registryQAOutcomes, REGISTRY_AUTHORING_CHECKS, type RegistryDocs } from '../../lib/semantic-registry-authoring';
import { aggregateQAResult } from '../../lib/qa-types';

// Released-app shapes from smallholder-seasonal/20261012-1549 (ace#2883).
const SS = join(__dirname, '../fixtures/layer1/smallholder-seasonal-20261012-1549');
const ssForm = (p: string): ReleasedForm => ({ path: p, xml: readFileSync(join(SS, p), 'utf8') });
const SS_FORMS = ['modules-10/forms-0.xml', 'modules-11/forms-0.xml', 'modules-12/forms-0.xml'].map(ssForm);

// A Nova registration form with no Connect <deliver> block produces no visit.
const REGISTRATION: ReleasedForm = {
  path: 'modules-0/forms-0.xml',
  xml: `<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><h:title>Register participant</h:title><model><instance>
    <data name="Register participant"><woman_name/><__nova_operations><create_participant><case case_id=""><create><case_type>participant</case_type></create></case></create_participant></__nova_operations></data>
  </instance></model></h:head></h:html>`,
};

// The Spark released Deliver form, which DOES write the top-level case block.
const SPARK: ReleasedForm = {
  path: 'modules-1/forms-0.xml',
  xml: readFileSync(join(__dirname, '../fixtures/ccz/spark-facilitator-meeting-record.xml'), 'utf8'),
};

// What semantic-registry-author § 1 told the author to write, and registry 8527 did.
const KEYED_ON_FORM_CASE: Layer1Field[] = [
  { name: 'participant_case_id', path: 'form.case.@case_id' },
  { name: 'main_crop', path: 'form.plan.main_crop' },
  { name: 'harvest_kg', path: 'form.harvest.harvest_kg', transform: 'float' },
];

describe('formSubmissionPaths — Connect JSON paths from the released form XML', () => {
  it('reads the Nova case block under __nova_operations, attributes as @', () => {
    const { paths } = formSubmissionPaths(SS_FORMS[0].xml);
    expect(paths.has('form.__nova_operations.update_participant_plan.case.@case_id')).toBe(true);
    expect(paths.has('form.plan.main_crop')).toBe(true);
    expect(paths.has('form.@name')).toBe(true);
    expect(paths.has('form.meta.instanceID')).toBe(true); // orx: prefix stripped
    expect(paths.has('form.case.@case_id')).toBe(false); // the premise of ace#2883
  });

  it('reads the top-level case block where the app writes one (Spark)', () => {
    expect(formSubmissionPaths(SPARK.xml).paths.has('form.case.@case_id')).toBe(true);
    expect(isDeliverForm(SPARK.xml)).toBe(true);
  });

  it('records bind nodesets and the relevant that gates them', () => {
    const { paths, relevant } = formSubmissionPaths(SS_FORMS[2].xml);
    expect(paths.has('form.__nova_operations.create_noncrop_cycle.case.index.parent')).toBe(true);
    expect(relevant.get('form.__nova_operations.create_noncrop_cycle')).toBe("/data/harvest/cycle_kind = 'noncrop'");
  });

  it('maps xform refs to form paths', () => {
    expect(xformRefToFormPath('/data/__nova_operations/update_crop_cycle/case/@case_id')).toBe(
      'form.__nova_operations.update_crop_cycle.case.@case_id',
    );
    expect(xformRefToFormPath("instance('casedb')/x")).toBeNull();
  });
});

describe('checkLayer1Paths — the ace#2883 repro', () => {
  it('FAILS a key on form.case.@case_id against Nova forms that write __nova_operations', () => {
    const r = checkLayer1Paths({ fields: KEYED_ON_FORM_CASE, keyField: 'participant_case_id', forms: SS_FORMS });
    const keyFails = r.findings.filter((f) => f.check === 'entity-key' && f.severity === 'fail');
    expect(keyFails.map((f) => f.form)).toEqual(['modules-10/forms-0.xml', 'modules-11/forms-0.xml', 'modules-12/forms-0.xml']);
    expect(keyFails[0].detail).toMatch(/form\.__nova_operations\.update_participant_plan\.case\.@case_id/);
    expect(keyFails[0].detail).toMatch(/WHERE participant_case_id IS NOT NULL/);
    // and the field itself reads a path no released form writes
    expect(r.findings).toContainEqual(expect.objectContaining({ check: 'layer1-paths', severity: 'fail', field: 'participant_case_id' }));
  });

  it('passes the plan and grant forms on the session-case op paths, and names the Harvest gap', () => {
    const fields: Layer1Field[] = [
      {
        name: 'participant_case_id',
        paths: [
          'form.__nova_operations.update_participant_plan.case.@case_id',
          'form.__nova_operations.update_participant_grant.case.@case_id',
          'form.case.@case_id', // the synthetic generator's path, last
        ],
      },
    ];
    const r = checkLayer1Paths({ fields, keyField: 'participant_case_id', forms: SS_FORMS });
    const fails = r.findings.filter((f) => f.severity === 'fail');
    expect(fails).toHaveLength(1);
    expect(fails[0].form).toBe('modules-12/forms-0.xml');
    expect(fails[0].detail).toMatch(/Harvest visit/);
    expect(fails[0].detail).toMatch(/update_crop_cycle\.case\.@case_id/); // what it DOES write, so the author can decide
    // The generator path is the synthetic half of the coalesce, not a warning.
    expect(r.findings.some((f) => f.detail.includes('`form.case.@case_id` is written by no released form'))).toBe(false);
  });

  it('warns when the key only resolves under a relevant (crop-cycle harvests carry none) and on an attributed element', () => {
    const fields: Layer1Field[] = [
      {
        name: 'participant_case_id',
        paths: [
          'form.__nova_operations.update_participant_plan.case.@case_id',
          'form.__nova_operations.update_participant_grant.case.@case_id',
          'form.__nova_operations.create_noncrop_cycle.case.index.parent',
          'form.case.@case_id',
        ],
      },
    ];
    const r = checkLayer1Paths({ fields, keyField: 'participant_case_id', forms: SS_FORMS });
    expect(r.findings.filter((f) => f.severity === 'fail')).toEqual([]);
    const gated = r.findings.find((f) => f.check === 'entity-key' && f.severity === 'warn');
    expect(gated?.form).toBe('modules-12/forms-0.xml');
    expect(gated?.detail).toMatch(/cycle_kind = 'noncrop'/);
    const attr = r.findings.find((f) => f.check === 'layer1-paths' && f.detail.includes('#text'));
    expect(attr?.detail).toMatch(/index\.parent\.#text/);
  });

  it('honours a declared key exemption, and ignores forms that produce no visit', () => {
    const fields: Layer1Field[] = [
      { name: 'participant_case_id', paths: ['form.__nova_operations.update_participant_plan.case.@case_id', 'form.__nova_operations.update_participant_grant.case.@case_id'] },
    ];
    const r = checkLayer1Paths({
      fields,
      keyField: 'participant_case_id',
      forms: [REGISTRATION, ...SS_FORMS],
      keyExempt: { 'modules-12/forms-0.xml': 'cycle-level visit; reported per cycle, not per woman' },
    });
    expect(r.visitForms).not.toContain('modules-0/forms-0.xml');
    expect(r.findings.filter((f) => f.severity === 'fail')).toEqual([]);
  });

  it('says so when a visit form records no case id at all', () => {
    const bare: ReleasedForm = {
      path: 'modules-13/forms-0.xml',
      xml: `<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:head><h:title>Field day</h:title><model><instance><data><x/><deliver xmlns="http://commcareconnect.com/data/v1/learn" id="d"><entity_id/></deliver></data></instance></model></h:head></h:html>`,
    };
    const k = checkLayer1Paths({ fields: [{ name: 'k', path: 'form.case.@case_id' }], keyField: 'k', forms: [bare] });
    expect(k.findings.find((x) => x.check === 'entity-key')?.detail).toMatch(/writes no case id at all/);
  });

  it('fails a key that names no Layer-1 field, and passes the Spark positive control', () => {
    expect(checkLayer1Paths({ fields: [], keyField: 'community_case_id', forms: [SPARK] }).findings[0]).toMatchObject({ check: 'entity-key', severity: 'fail' });
    const spark = checkLayer1Paths({
      fields: [
        { name: 'community_case_id', path: 'form.case.@case_id' },
        { name: 'meeting_conducted', path: 'form.meeting_held.meeting_conducted' },
        { name: 'location', paths: ['metadata.location', 'form.meta.location.#text'] }, // non-form paths are not the app's
      ],
      keyField: 'community_case_id',
      forms: [SPARK],
    });
    expect(spark.findings.filter((f) => f.severity === 'fail')).toEqual([]);
  });
});

describe('semantic-registry-author-qa — layer1-paths and entity-key outcomes', () => {
  const reg = (): RegistryDocs => {
    const r = JSON.parse(readFileSync(join(__dirname, '../fixtures/cascade/spark-facilitator-registry.json'), 'utf8')) as RegistryDocs;
    (r.properties_doc.entity as Record<string, unknown>).key = 'participant_case_id';
    return r;
  };

  it('a registry keyed on form.case.@case_id over Nova forms now FAILS QA (it passed 12/12 before)', () => {
    const report = checkRegistryAuthoring(reg(), { opportunityIds: [10082, 10083, 10084], layer1: { fields: KEYED_ON_FORM_CASE, forms: SS_FORMS } });
    const outcomes = registryQAOutcomes(report, { valid: true, errors: [] }, { pddSections: ['8', '8.1', '8.2', '5.4', '5.6', '7.2'], opportunityIds: [10082, 10083, 10084], layer1Supplied: true });
    expect(outcomes.map((o) => o.check)).toEqual(['labs-validate', ...REGISTRY_AUTHORING_CHECKS]);
    const failed = outcomes.filter((o) => !o.result.pass).map((o) => o.check);
    expect(failed).toEqual(expect.arrayContaining(['layer1-paths', 'entity-key']));
    expect(aggregateQAResult({ skill: 'semantic-registry-author-qa', target: 't', capture_path: 'p', outcomes }).verdict).toBe('fail');
  });

  it('fails both checks when the Layer-1 fields or the released forms were not supplied', () => {
    const outcomes = registryQAOutcomes(checkRegistryAuthoring(reg()), { valid: true }, {});
    for (const c of ['layer1-paths', 'entity-key']) {
      const o = outcomes.find((x) => x.check === c)!;
      expect(o.result.pass).toBe(false);
      expect(o.result.detail).toMatch(/not both supplied/);
    }
  });
});
