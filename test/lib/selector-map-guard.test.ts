import { describe, it, expect } from 'vitest';
import { findLiveVerifiedViolations } from '../../lib/selector-map-guard.js';

const base = `
apk_version: "2.63.2"
selectors:
  deliver-home-daily-visits:
    type: text
    value: "Daily Visits"
    purpose: "THE differentiator (#893). Live-verified 2026-07-30."
  unverified-row:
    type: id
    value: "org.commcare.dalvik:id/guess"
    purpose: "Transcribed from 2.62.0; not yet confirmed."
`;

describe('findLiveVerifiedViolations', () => {
  it('flags a mutated value on a Live-verified row', () => {
    const after = base.replace('"Daily Visits"', '"Daily visits"');
    const v = findLiveVerifiedViolations(base, after);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      selector: 'deliver-home-daily-visits',
      kind: 'mutated',
      field: 'value',
      before: 'Daily Visits',
      after: 'Daily visits',
    });
  });

  it('flags a deleted Live-verified row', () => {
    const after = `
apk_version: "2.63.2"
selectors:
  unverified-row:
    type: id
    value: "org.commcare.dalvik:id/guess"
    purpose: "Transcribed from 2.62.0; not yet confirmed."
`;
    const v = findLiveVerifiedViolations(base, after);
    expect(v).toEqual([{ selector: 'deliver-home-daily-visits', kind: 'deleted' }]);
  });

  it('ALLOWS editing the purpose prose of a Live-verified row', () => {
    // Load-bearing: Live-verified rows' notes will need correcting over
    // time (a caveat resolved, a companion anchor shipped, a citation
    // added) — only `type` and `value` are frozen.
    const after = base.replace('Live-verified 2026-07-30.', 'Live-verified 2026-07-30. See #863.');
    expect(findLiveVerifiedViolations(base, after)).toEqual([]);
  });

  it('ALLOWS adding a new row, and mutating an unverified one', () => {
    const withNew = base + `  brand-new:\n    type: id\n    value: "x"\n`;
    expect(findLiveVerifiedViolations(base, withNew)).toEqual([]);
    const mutatedUnverified = base.replace('org.commcare.dalvik:id/guess', 'org.commcare.dalvik:id/better');
    expect(findLiveVerifiedViolations(base, mutatedUnverified)).toEqual([]);
  });

  it('returns [] rather than throwing on unparseable yaml', () => {
    expect(findLiveVerifiedViolations(base, ':::not yaml:::')).toEqual([]);
  });
});
