/**
 * dimagi-internal/ace#1301 — Connect's `FormJsonValidationRules.question_path`
 * is a JSONPath into the HQ form-JSON doc, not an XForm XPath.
 *
 * See lib/connect-question-path.ts for the full evidence trail (HQ motech log
 * 500, the jsonpath-ng reproducer, and the before/after Connect reads).
 *
 * This is deterministic string mapping, so it is a unit test, not a live probe:
 * the ground truth is commcare-connect's own
 * `parse(f"$.{question_path}")` + the shape of the doc HQ forwards, both of
 * which are source facts rather than device facts.
 */
import { describe, it, expect } from 'vitest';
import { toConnectQuestionPath, isXFormXPath } from '../../lib/connect-question-path.js';

describe('toConnectQuestionPath (ace#1301)', () => {
  it('maps the exact paths that 500d the receiver on spark-facilitator/20260813-2126', () => {
    expect(toConnectQuestionPath('/data/meeting_basics/meeting_conducted'))
      .toBe('form.meeting_basics.meeting_conducted');
    expect(toConnectQuestionPath('/data/meeting_basics/meeting_type'))
      .toBe('form.meeting_basics.meeting_type');
  });

  it('maps a top-level (Nova-flattened) question', () => {
    expect(toConnectQuestionPath('/data/meeting_conducted')).toBe('form.meeting_conducted');
  });

  it('maps nested groups at any depth', () => {
    expect(toConnectQuestionPath('/data/a/b/c/d')).toBe('form.a.b.c.d');
  });

  it('renames whatever the instance root is called — HQ always nests under `form`', () => {
    expect(toConnectQuestionPath('/mydata/x/y')).toBe('form.x.y');
  });

  it('is idempotent — an already-correct JSONPath passes through unchanged', () => {
    expect(toConnectQuestionPath('form.meeting_basics.meeting_type'))
      .toBe('form.meeting_basics.meeting_type');
    expect(toConnectQuestionPath('$.form.meeting_basics.meeting_type'))
      .toBe('$.form.meeting_basics.meeting_type');
  });

  it('normalising twice equals normalising once', () => {
    const once = toConnectQuestionPath('/data/meeting_basics/meeting_type');
    expect(toConnectQuestionPath(once)).toBe(once);
  });

  it('trims surrounding whitespace but does not invent a path', () => {
    expect(toConnectQuestionPath('  form.x  ')).toBe('form.x');
    expect(toConnectQuestionPath('')).toBe('');
    expect(toConnectQuestionPath('   ')).toBe('');
  });

  it('never emits a leading slash — that is precisely the value Connect cannot parse', () => {
    for (const p of ['/data/x', '/data/x/y', '/x', '/data/']) {
      expect(toConnectQuestionPath(p).startsWith('/')).toBe(false);
    }
  });
});

describe('isXFormXPath (ace#1301)', () => {
  it('flags XPaths and only XPaths', () => {
    expect(isXFormXPath('/data/x')).toBe(true);
    expect(isXFormXPath('  /data/x')).toBe(true);
    expect(isXFormXPath('form.x')).toBe(false);
    expect(isXFormXPath('$.form.x')).toBe(false);
  });
});
