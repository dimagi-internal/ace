/**
 * Tests for `lib/deliver-rerelease-invariants.ts` (dimagi-internal/ace#2691).
 *
 * Positive control: the REAL released Deliver meeting form of
 * spark-facilitator/20261004-1706 — connect-ace-prod app
 * 69f68365817c443ba6f9a846808c9717, v9 (build e0c351a4…, what Phase 4
 * configured the opportunity against) vs v23 (build 2c493f08…, the current
 * release). Same deliver @id, same three rule paths, different xmlns — which
 * live Connect accepted (six visits under one unit across two xmlns), so this
 * must PASS with exactly one WARN.
 *
 * Negative controls are synthetic edits of the v23 fixture: a renamed @id and
 * a removed rule question. Both must BLOCK.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkDeliverRerelease,
  formatDeliverRerelease,
  readFormShape,
  ruleToNodePath,
  type ConfiguredFormFieldRule,
} from '../../lib/deliver-rerelease-invariants.js';
import { assertChecked, assertUnable } from '../../lib/check-outcome.js';

const DIR = join(__dirname, '..', 'fixtures', 'deliver-rerelease');
const V9 = readFileSync(join(DIR, 'meeting-record-v9.xml'), 'utf8');
const V23 = readFileSync(join(DIR, 'meeting-record-v23.xml'), 'utf8');
const PATH = 'modules-1/forms-0.xml';
const V9_BUILD = 'e0c351a417814f85a192513089227460';
const V23_BUILD = '2c493f08cba14fd5a1f5749f043d26f2';

/** The three rules, in both spellings run_state has carried (ace#1301 normalised XPath → JSONPath). */
const RULES: ConfiguredFormFieldRule[] = [
  { name: 'meeting held', question_path: 'form.meeting.meeting_conducted', question_value: 'yes' },
  { name: 'community meeting', question_path: 'form.meeting.meeting_type', question_value: 'community_meeting' },
  { name: 'payable slot', question_path: '/data/payable_slot', question_value: 'yes' },
];

const build = (buildId: string, xml: string) => ({ buildId, forms: [{ path: PATH, xml }] });

describe('readFormShape on the real released forms', () => {
  it('reads xmlns, form name and the deliver @id', () => {
    const v9 = readFormShape({ path: PATH, xml: V9 })!;
    const v23 = readFormShape({ path: PATH, xml: V23 })!;
    expect(v9.xmlns).toBe('http://openrosa.org/formdesigner/a81ff5d176c9b54c');
    expect(v23.xmlns).toBe('http://openrosa.org/formdesigner/1583a130e985f316');
    expect(v9.formName).toBe('community_meeting_record');
    expect(v9.deliverIds).toEqual(['community_meeting']);
    expect(v23.deliverIds).toEqual(['community_meeting']);
    for (const p of ['/data/meeting/meeting_conducted', '/data/meeting/meeting_type', '/data/payable_slot']) {
      expect(v9.nodePaths.has(p)).toBe(true);
      expect(v23.nodePaths.has(p)).toBe(true);
    }
  });
});

describe('ruleToNodePath', () => {
  it('maps JSONPath and passes XPath through', () => {
    expect(ruleToNodePath('form.meeting.meeting_type')).toBe('/data/meeting/meeting_type');
    expect(ruleToNodePath('$.form.payable_slot')).toBe('/data/payable_slot');
    expect(ruleToNodePath('/data/payable_slot')).toBe('/data/payable_slot');
    expect(ruleToNodePath('')).toBeNull();
    expect(ruleToNodePath('meeting.meeting_type')).toBeNull();
  });
});

describe('v9 → v23 (real, ace#2691): passes with one xmlns WARN', () => {
  const res = checkDeliverRerelease({ baseline: build(V9_BUILD, V9), candidate: build(V23_BUILD, V23), rules: RULES });

  it('does not block', () => {
    assertChecked(res);
    expect(res.blocking).toBe(false);
    expect(res.baselineDeliverIds).toEqual(['community_meeting']);
    expect(res.candidateDeliverIds).toEqual(['community_meeting']);
    expect(res.rulePathsChecked).toHaveLength(3);
  });

  it('warns on the xmlns change and names the consumers it splits', () => {
    assertChecked(res);
    expect(res.findings).toHaveLength(1);
    const [f] = res.findings;
    expect(f.kind).toBe('form-xmlns-changed');
    expect(f.severity).toBe('warn');
    expect(res.xmlnsChanges).toEqual([
      {
        form: 'community_meeting_record',
        from: 'http://openrosa.org/formdesigner/a81ff5d176c9b54c',
        to: 'http://openrosa.org/formdesigner/1583a130e985f316',
      },
    ]);
    expect(f.message).toMatch(/Connect payment is unaffected/);
    expect(f.message).toMatch(/cchq_fetcher\.py/);
    expect(formatDeliverRerelease(res)).toMatch(/^\[WARN\] form-xmlns-changed/);
  });

  it('is fully clean against itself', () => {
    const same = checkDeliverRerelease({ baseline: build(V9_BUILD, V9), candidate: build(V9_BUILD, V9), rules: RULES });
    assertChecked(same);
    expect(same.ok).toBe(true);
    expect(same.blocking).toBe(false);
  });
});

describe('negative controls (synthetic edits of v23): BLOCK', () => {
  it('a renamed deliver @id blocks as disappeared + added', () => {
    const renamed = V23.replace('id="community_meeting"', 'id="community_meeting_v2"');
    expect(renamed).not.toBe(V23);
    const res = checkDeliverRerelease({ baseline: build(V9_BUILD, V9), candidate: build(V23_BUILD, renamed), rules: RULES });
    assertChecked(res);
    expect(res.blocking).toBe(true);
    const kinds = res.findings.filter((f) => f.severity === 'blocker').map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(['deliver-id-disappeared', 'deliver-id-added']));
    expect(formatDeliverRerelease(res)).toMatch(/\[BLOCKER\] deliver-id-disappeared/);
  });

  it('a configured rule question missing from the new form blocks', () => {
    const dropped = V23.replace(/\s*<meeting_type\/>/, '');
    expect(dropped).not.toBe(V23);
    const res = checkDeliverRerelease({ baseline: build(V9_BUILD, V9), candidate: build(V23_BUILD, dropped), rules: RULES });
    assertChecked(res);
    expect(res.blocking).toBe(true);
    const missing = res.findings.filter((f) => f.kind === 'rule-path-missing');
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain('form.meeting.meeting_type');
  });

  it('a question moved to another group blocks (Connect keys on the path, not the name)', () => {
    const moved = V23.replace(/\s*<payable_slot\/>/, '').replace('<meeting_conducted/>', '<meeting_conducted/><payable_slot/>');
    const res = checkDeliverRerelease({ baseline: build(V9_BUILD, V9), candidate: build(V23_BUILD, moved), rules: RULES });
    assertChecked(res);
    expect(res.blocking).toBe(true);
    expect(res.findings.some((f) => f.kind === 'rule-path-missing' && f.message.includes('/data/payable_slot'))).toBe(true);
  });
});

describe('unable is never a pass', () => {
  it('an unreadable candidate reports unable', () => {
    const res = checkDeliverRerelease({ baseline: build(V9_BUILD, V9), candidate: build(V23_BUILD, '<not-xml'), rules: RULES });
    assertUnable(res);
    expect(formatDeliverRerelease(res)).toMatch(/UNABLE TO CHECK/);
  });

  it('a baseline with no deliver block reports unable', () => {
    const noDeliver = V9.replace(/<community_meeting>[\s\S]*?<\/community_meeting>/, '');
    const res = checkDeliverRerelease({ baseline: build(V9_BUILD, noDeliver), candidate: build(V23_BUILD, V23), rules: RULES });
    assertUnable(res);
  });
});
