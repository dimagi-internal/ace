/**
 * Tests for `lib/learn-rerelease-invariants.ts` (dimagi-internal/ace#2705).
 *
 * Positive control: the REAL released Learn app of
 * spark-facilitator/20261004-1706 — connect-ace-prod app
 * dcd4889acfd8449896c603a03767f9af, v11 (build 4cafbd1b…) vs v12 (build
 * 6dbbbb2f…), a lesson-3 text fix. Fixtures are each form's primary instance
 * extracted from `commcare_download_ccz` (itext/binds dropped — the check
 * reads only the instance). Same seven module @ids, same assessment
 * final_quiz, same xmlns → PASS with no findings.
 *
 * Negative controls are synthetic edits of the v12 fixtures: a renamed module
 * @id and a removed assessment block. Both must BLOCK.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkLearnRerelease,
  formatLearnRerelease,
} from '../../lib/learn-rerelease-invariants.js';
import { assertChecked, assertUnable } from '../../lib/check-outcome.js';
import type { ReleasedBuild, ReleasedForm } from '../../lib/deliver-rerelease-invariants.js';

const DIR = join(__dirname, '..', 'fixtures', 'learn-rerelease');
const V11_BUILD = '4cafbd1b54884648b3459f3331b427d1';
const V12_BUILD = '6dbbbb2f391f435e9b55fc7ee212e22b';

/** `v11/modules-3-forms-0.xml` → `{ path: 'modules-3/forms-0.xml', xml }`. */
const toForm = (tag: string) => (f: string): ReleasedForm => ({
  path: f.replace(/^(modules-\d+)-(forms-\d+\.xml)$/, '$1/$2'),
  xml: readFileSync(join(DIR, tag, f), 'utf8'),
});
const V11 = readdirSync(join(DIR, 'v11')).sort().map(toForm('v11'));
const V12 = readdirSync(join(DIR, 'v12')).sort().map(toForm('v12'));
const MODULES = ['m0_pretest', 'm1_role', 'm2_register', 'm3_record', 'm4_counting', 'm5_steps', 'm6_payment'];

const build = (buildId: string, forms: ReleasedForm[]): ReleasedBuild => ({ buildId, forms });
const edit = (forms: ReleasedForm[], path: string, fn: (xml: string) => string): ReleasedForm[] =>
  forms.map((f) => (f.path === path ? { ...f, xml: fn(f.xml) } : f));

describe('v11 → v12 (real, ace#2705): passes clean', () => {
  const res = checkLearnRerelease({ baseline: build(V11_BUILD, V11), candidate: build(V12_BUILD, V12) });

  it('reads all eight forms', () => {
    expect(V11).toHaveLength(8);
    expect(V12).toHaveLength(8);
  });

  it('finds the seven modules and final_quiz in both builds, with no finding', () => {
    assertChecked(res);
    expect(res.baselineModuleIds).toEqual(MODULES);
    expect(res.candidateModuleIds).toEqual(MODULES);
    expect(res.baselineAssessmentIds).toEqual(['final_quiz']);
    expect(res.candidateAssessmentIds).toEqual(['final_quiz']);
    expect(res.xmlnsChanges).toEqual([]);
    expect(res.findings).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.blocking).toBe(false);
    expect(formatLearnRerelease(res)).toMatch(/^learn-rerelease-invariants: learn module @id\(s\) m0_pretest/);
  });
});

describe('negative controls (synthetic edits of v12)', () => {
  it('a renamed learn module @id BLOCKS as disappeared + added', () => {
    const renamed = edit(V12, 'modules-3/forms-0.xml', (x) => x.replace('id="m3_record"', 'id="m3_recording"'));
    expect(renamed).not.toEqual(V12);
    const res = checkLearnRerelease({ baseline: build(V11_BUILD, V11), candidate: build(V12_BUILD, renamed) });
    assertChecked(res);
    expect(res.blocking).toBe(true);
    const kinds = res.findings.filter((f) => f.severity === 'blocker').map((f) => f.kind);
    expect(kinds).toEqual(['learn-module-id-disappeared', 'learn-module-id-added']);
    expect(res.findings[0].message).toContain('"m3_record"');
    expect(res.findings[0].message).toMatch(/tasks\.py:86-95/);
    expect(res.findings[1].message).toContain('"m3_recording"');
    expect(formatLearnRerelease(res)).toMatch(/\[BLOCKER\] learn-module-id-disappeared/);
  });

  it('a removed assessment block BLOCKS', () => {
    const removed = edit(V12, 'modules-7/forms-0.xml', (x) =>
      x.replace(/<assessment xmlns="http:\/\/commcareconnect\.com\/data\/v1\/learn"[\s\S]*?<\/assessment>/, ''),
    );
    expect(removed).not.toEqual(V12);
    const res = checkLearnRerelease({ baseline: build(V11_BUILD, V11), candidate: build(V12_BUILD, removed) });
    assertChecked(res);
    expect(res.blocking).toBe(true);
    expect(res.findings.map((f) => f.kind)).toEqual(['assessment-disappeared']);
    expect(res.findings[0].message).toContain('final_quiz');
  });

  it('a removed module form BLOCKS as disappeared', () => {
    const dropped = V12.filter((f) => f.path !== 'modules-6/forms-0.xml');
    const res = checkLearnRerelease({ baseline: build(V11_BUILD, V11), candidate: build(V12_BUILD, dropped) });
    assertChecked(res);
    expect(res.blocking).toBe(true);
    expect(res.findings.map((f) => f.kind)).toEqual(['learn-module-id-disappeared']);
  });

  it('a renamed assessment @id only WARNS (Connect never reads it)', () => {
    const renamed = edit(V12, 'modules-7/forms-0.xml', (x) => x.replace('id="final_quiz"', 'id="final_assessment"'));
    const res = checkLearnRerelease({ baseline: build(V11_BUILD, V11), candidate: build(V12_BUILD, renamed) });
    assertChecked(res);
    expect(res.blocking).toBe(false);
    expect(res.findings.map((f) => [f.kind, f.severity])).toEqual([['assessment-id-changed', 'warn']]);
    expect(res.findings[0].message).toMatch(/processor\.py:208-241/);
  });

  it('a re-minted xmlns only WARNS', () => {
    const reminted = edit(V12, 'modules-0/forms-0.xml', (x) =>
      x.replace('formdesigner/dc7162fc7160102c', 'formdesigner/0000000000000000'),
    );
    const res = checkLearnRerelease({ baseline: build(V11_BUILD, V11), candidate: build(V12_BUILD, reminted) });
    assertChecked(res);
    expect(res.blocking).toBe(false);
    expect(res.findings.map((f) => f.kind)).toEqual(['form-xmlns-changed']);
    expect(res.xmlnsChanges).toEqual([
      {
        form: 'starting_quiz',
        from: 'http://openrosa.org/formdesigner/dc7162fc7160102c',
        to: 'http://openrosa.org/formdesigner/0000000000000000',
      },
    ]);
  });
});

describe('unable is never a pass', () => {
  it('an unreadable candidate form reports unable', () => {
    const broken = edit(V12, 'modules-2/forms-0.xml', () => '<not-xml');
    const res = checkLearnRerelease({ baseline: build(V11_BUILD, V11), candidate: build(V12_BUILD, broken) });
    assertUnable(res);
    expect(formatLearnRerelease(res)).toMatch(/UNABLE TO CHECK/);
  });

  it('a baseline with no Connect learn block (e.g. a Deliver build) reports unable', () => {
    const plain = V11.map((f) => ({
      ...f,
      xml: f.xml.replace(/<(module|assessment) xmlns="http:\/\/commcareconnect\.com\/data\/v1\/learn"[\s\S]*?<\/\1>/, ''),
    }));
    const res = checkLearnRerelease({ baseline: build(V11_BUILD, plain), candidate: build(V12_BUILD, V12) });
    assertUnable(res);
  });
});
