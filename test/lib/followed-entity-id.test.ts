/**
 * dimagi-internal/ace#2889 — a paid Deliver form must record the id of the
 * followed entity it serves. Negative control: the released smallholder-seasonal
 * forms (20261012-1549, HQ 6137de98 v23), whose "Harvest visit" names the crop
 * cycle and never the woman. Positive control: the SAME released Harvest visit
 * XML with the build rule applied (a hidden `participant_case_id` derived from
 * the session case's parent), so the pass is proved on a real form shape.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkFollowedEntityId,
  followedEntityIdField,
  parseFollowedEntityCaseType,
} from '../../lib/followed-entity-id';
import type { ReleasedForm } from '../../lib/layer1-path-check';
import { checkFollowedEntityCaseTypeDeclared } from '../../skills/idea-to-pdd-qa/checks';

const SS = join(__dirname, '../fixtures/layer1/smallholder-seasonal-20261012-1549');
const SS_FORMS: ReleasedForm[] = ['modules-10/forms-0.xml', 'modules-11/forms-0.xml', 'modules-12/forms-0.xml'].map(
  (p) => ({ path: p, xml: readFileSync(join(SS, p), 'utf8') }),
);
const HARVEST: ReleasedForm = {
  path: 'modules-12/forms-0.xml',
  xml: readFileSync(join(SS, 'modules-12/forms-0.xml'), 'utf8'),
};

const PARENT_OF_SESSION_CASE =
  "instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/index/parent";

/** Apply the pdd-to-deliver-app build rule to a released form. */
function withFollowedId(form: ReleasedForm, bindAttrs: string): ReleasedForm {
  const xml = form.xml
    .replace(/(<data [^>]*name="Harvest visit">)/, '$1<participant_case_id/>')
    .replace(
      /(<bind nodeset="\/data\/harvest\/cycle_kind")/,
      `<bind nodeset="/data/participant_case_id" type="xsd:string"${bindAttrs}/>\n      $1`,
    );
  expect(xml).not.toBe(form.xml); // the injection landed
  return { path: form.path, xml };
}

describe('parseFollowedEntityCaseType', () => {
  it('reads a case type, ignoring trailing prose', () => {
    expect(parseFollowedEntityCaseType('participant (the woman enrolled)')).toMatchObject({
      declared: true,
      caseType: 'participant',
    });
    expect(parseFollowedEntityCaseType('`household`').caseType).toBe('household');
  });

  it('treats an unfilled row as undeclared', () => {
    for (const v of ['', 'n/a', 'TBD', '[case type]']) {
      expect(parseFollowedEntityCaseType(v).declared).toBe(false);
    }
  });

  it('accepts `none (<reason>)` and refuses a bare none', () => {
    expect(parseFollowedEntityCaseType('none (cross-sectional stages only)')).toMatchObject({
      declared: true,
      none: true,
      reason: 'cross-sectional stages only',
    });
    expect(parseFollowedEntityCaseType('none').declared).toBe(false);
  });

  it('refuses prose that is not a case type', () => {
    const p = parseFollowedEntityCaseType('The Woman');
    expect(p.declared).toBe(false);
    expect(p.problems).toHaveLength(1);
  });

  it('names the hidden field per case type', () => {
    expect(followedEntityIdField('participant')).toBe('participant_case_id');
    expect(followedEntityIdField('crop-cycle')).toBe('crop_cycle_case_id');
  });
});

describe('checkFollowedEntityId — released smallholder-seasonal forms (negative control)', () => {
  const res = checkFollowedEntityId({ caseType: 'participant', forms: SS_FORMS });

  it('checks every paid form and fails each one', () => {
    expect(res.paidForms).toEqual(SS_FORMS.map((f) => f.path));
    expect(res.ok).toBe(false);
    expect(res.findings.map((f) => f.form)).toEqual(SS_FORMS.map((f) => f.path));
  });

  it('names the Harvest visit case paths that do NOT name the woman', () => {
    const harvest = res.findings.find((f) => f.form === HARVEST.path)!;
    expect(harvest.severity).toBe('fail');
    expect(harvest.detail).toMatch(/Harvest visit/);
    expect(harvest.detail).toContain('form.__nova_operations.update_crop_cycle.case.@case_id');
    expect(harvest.detail).toContain('participant_case_id');
  });
});

describe('checkFollowedEntityId — the build rule applied (positive control)', () => {
  it('passes a hidden field derived from the session case parent', () => {
    const res = checkFollowedEntityId({
      caseType: 'participant',
      forms: [withFollowedId(HARVEST, ` calculate="${PARENT_OF_SESSION_CASE}"`)],
    });
    expect(res.findings).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('fails the field when it is worker-entered (no calculate)', () => {
    const res = checkFollowedEntityId({ caseType: 'participant', forms: [withFollowedId(HARVEST, '')] });
    expect(res.ok).toBe(false);
    expect(res.findings[0].detail).toMatch(/not computed/);
  });

  it('fails a hard-coded literal', () => {
    const res = checkFollowedEntityId({
      caseType: 'participant',
      forms: [withFollowedId(HARVEST, ` calculate="'abc'"`)],
    });
    expect(res.ok).toBe(false);
  });

  it('warns when the field is only written under a relevant', () => {
    const res = checkFollowedEntityId({
      caseType: 'participant',
      forms: [
        withFollowedId(
          HARVEST,
          ` calculate="${PARENT_OF_SESSION_CASE}" relevant="/data/harvest/cycle_kind = &apos;crop&apos;"`,
        ),
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].severity).toBe('warn');
  });

  it('honours a declared exemption and ignores non-paid forms', () => {
    const unpaid: ReleasedForm = {
      path: 'modules-0/forms-0.xml',
      xml: '<h:html><h:head><h:title>Register</h:title><model><instance><data name="Register"><x/></data></instance></model></h:head></h:html>',
    };
    const res = checkFollowedEntityId({
      caseType: 'participant',
      forms: [unpaid, HARVEST],
      exempt: { [HARVEST.path]: 'per-cycle record, followed entity recorded on the cycle registration' },
    });
    expect(res.paidForms).toEqual([HARVEST.path]);
    expect(res.exempted).toEqual([HARVEST.path]);
    expect(res.ok).toBe(true);
  });
});

describe('idea-to-pdd-qa followed_entity_case_type_declared on a real PDD', () => {
  // Grounded on a real longitudinal PDD (spark-facilitator/20260907-1120),
  // authored before ace#2889: it names `Case type: community` only in prose.
  const SPARK_PDD = readFileSync(
    join(__dirname, '../fixtures/fixed-instrument/spark-facilitator-20260907-1120-pdd.md'),
    'utf8',
  );

  it('the real spark PDD fails — the case type lives only in prose', () => {
    const r = checkFollowedEntityCaseTypeDeclared(SPARK_PDD);
    expect(r.pass).toBe(false);
  });

  it('the real spark PDD passes once the row is added', () => {
    const fixed = SPARK_PDD.replace(
      '| `archetype` | `longitudinal-visits` |',
      '| `archetype` | `longitudinal-visits` |\n| `followed_entity_case_type` | `community` |',
    );
    expect(fixed).not.toBe(SPARK_PDD);
    const r = checkFollowedEntityCaseTypeDeclared(fixed);
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('community_case_id');
  });
});
