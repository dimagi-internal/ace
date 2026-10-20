/**
 * ace#3191 — the PDD and Work Order were shared anyone-with-link even on a
 * confidential opp. connect-fi/20261018-1440 has inputs/confidentiality.yaml
 * (fixture: a verbatim copy of ACE/connect-fi/inputs/confidentiality.yaml,
 * Drive 1IcTP7MS9hC_E21ztEoM9-c8KRCgLsQbxUabEwXPEZ_A rev 9, read 2026-10-20,
 * CRLFs normalised) and a PDD that names the funder its deny list protects.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  designDocSharePlan,
  isConfidentialOpp,
  parseConfidentialityReviewers,
} from '../../lib/opp-confidentiality';
import { exportForConfidentialDoc, judgePublishedRender } from '../../lib/published-doc-render-check';

const CONNECT_FI = readFileSync(
  join(__dirname, '..', 'fixtures', 'opp-confidentiality', 'connect-fi-confidentiality.yaml'),
  'utf8',
);

describe('published-render gate on a confidential opp', () => {
  it('judges the authenticated text and still fails on raw markdown', () => {
    const v = judgePublishedRender(exportForConfidentialDoc(CONNECT_FI, '## Overview\n\nprose'));
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toMatch(/raw markdown/);
  });

  it('passes a cleanly rendered text export', () => {
    expect(judgePublishedRender(exportForConfidentialDoc(CONNECT_FI, 'Overview\n\nprose')).ok).toBe(true);
  });

  it('refuses on a non-confidential opp — the anonymous read is the check there', () => {
    expect(() => exportForConfidentialDoc(null, 'Overview')).toThrow(/not a confidential opp/);
  });
});

describe('designDocSharePlan', () => {
  it('negative control: the reproducer opp is confidential and is NOT link-shared', () => {
    const plan = designDocSharePlan(CONNECT_FI);
    expect(plan.confidential).toBe(true);
    expect(plan.mode).toBe('unshared');
    expect(plan.mode).not.toBe('anyone-with-link');
    expect(plan.reviewers).toEqual([]);
  });

  it('positive control: no confidentiality file keeps the ace#1843 anyone-with-link commenter share', () => {
    expect(designDocSharePlan(null)).toMatchObject({
      confidential: false,
      mode: 'anyone-with-link',
      role: 'commenter',
    });
    expect(designDocSharePlan(undefined).mode).toBe('anyone-with-link');
  });

  it('named reviewers are shared individually, de-duplicated and lower-cased', () => {
    const plan = designDocSharePlan(
      `${CONNECT_FI}\nreviewers:\n  - Jane@Example.org\n  - jane@example.org\n  - ops@dimagi.com\n`,
    );
    expect(plan.mode).toBe('named-reviewers');
    expect(plan.role).toBe('commenter');
    expect(plan.reviewers).toEqual(['jane@example.org', 'ops@dimagi.com']);
  });

  it('an EMPTY confidentiality file still marks the opp confidential (the file exists)', () => {
    expect(isConfidentialOpp('')).toBe(true);
    expect(designDocSharePlan('').mode).toBe('unshared');
  });

  it('a malformed reviewers entry throws rather than silently sharing wider', () => {
    expect(() => parseConfidentialityReviewers('reviewers:\n  - not-an-email\n')).toThrow(/not an email/);
    expect(() => parseConfidentialityReviewers('reviewers: jane@example.org\n')).toThrow(/list/);
    expect(() => parseConfidentialityReviewers('- a\n- b\n')).toThrow(/mapping/);
  });

  it('accepts the Google Doc export shape (CRLF, BOM)', () => {
    const exported = '﻿' + `${CONNECT_FI}reviewers:\n  - a@b.co\n`.replace(/\n/g, '\r\n');
    expect(designDocSharePlan(exported).reviewers).toEqual(['a@b.co']);
  });
});
