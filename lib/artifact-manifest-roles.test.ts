import { describe, it, expect } from 'vitest';
import { PHASE_FOLDERS, ROLE_VOCAB, baseRole } from './artifact-manifest-roles.js';

describe('PHASE_FOLDERS', () => {
  it('maps all 10 phase enum values to N-<phase> folder slugs', () => {
    expect(PHASE_FOLDERS).toEqual({
      'design': '1-design',
      'scenarios-and-acceptance': '2-scenarios',
      'commcare': '3-commcare',
      'connect': '4-connect',
      'ocs': '5-ocs',
      'qa-and-training': '6-qa-and-training',
      'synthetic-data-and-workflows': '7-synthetic',
      'solicitation-management': '8-solicitation-management',
      'execution-management': '9-execution-manager',
      'closeout': '10-closeout',
    });
  });

  it('folder slugs sort natural-ascending in phase order', () => {
    // Natural sort: leading numeric prefix first, then the rest of the slug.
    // (Lex sort would put '10-closeout' between '1-design' and '2-scenarios'.)
    const slugs = Object.values(PHASE_FOLDERS);
    const extract = (s: string) => {
      const m = s.match(/^(\d+)-(.*)$/);
      return m ? [parseInt(m[1], 10), m[2]] as const : [0, s] as const;
    };
    const sorted = [...slugs].sort((a, b) => {
      const [an, ar] = extract(a);
      const [bn, br] = extract(b);
      if (an !== bn) return an - bn;
      return ar < br ? -1 : ar > br ? 1 : 0;
    });
    expect(slugs).toEqual(sorted);
  });
});

describe('ROLE_VOCAB', () => {
  it('contains all base roles used by the manifest', () => {
    expect(ROLE_VOCAB.has('summary')).toBe(true);
    // 0.13.116: 'gate-brief' role retired; per-skill QA + eval verdicts replace it.
    expect(ROLE_VOCAB.has('verdict')).toBe(true);
    expect(ROLE_VOCAB.has('report')).toBe(true);
    expect(ROLE_VOCAB.has('transcript')).toBe(true);
    expect(ROLE_VOCAB.has('scorecard')).toBe(true);
    expect(ROLE_VOCAB.has('manifest')).toBe(true);
    expect(ROLE_VOCAB.has('list')).toBe(true);
    expect(ROLE_VOCAB.has('record')).toBe(true);
    expect(ROLE_VOCAB.has('comms-log')).toBe(true);
    expect(ROLE_VOCAB.has('results')).toBe(true);
    expect(ROLE_VOCAB.has('new-pdd')).toBe(true);
    expect(ROLE_VOCAB.has('invoices')).toBe(true);
    expect(ROLE_VOCAB.has('widget-handoff')).toBe(true);
    expect(ROLE_VOCAB.has('learn')).toBe(true);
    expect(ROLE_VOCAB.has('deliver')).toBe(true);
    expect(ROLE_VOCAB.has('draft')).toBe(true);
    expect(ROLE_VOCAB.has('published')).toBe(true);
    expect(ROLE_VOCAB.has('award-record')).toBe(true);
  });

  it('rejects roles outside the vocabulary', () => {
    expect(ROLE_VOCAB.has('summary-extra')).toBe(false);
    expect(ROLE_VOCAB.has('foo')).toBe(false);
  });
});

describe('baseRole', () => {
  it('returns single-word roles unchanged', () => {
    expect(baseRole('summary')).toBe('summary');
    expect(baseRole('verdict')).toBe('verdict');
  });

  it('returns base for hyphenated qualifiers', () => {
    expect(baseRole('verdict-deep')).toBe('verdict');
    expect(baseRole('verdict-quick')).toBe('verdict');
    expect(baseRole('transcript-monitor')).toBe('transcript');
    expect(baseRole('scorecard-deep')).toBe('scorecard');
  });

  it('returns multi-word base roles intact (gate-brief, comms-log, new-pdd, widget-handoff, award-record)', () => {
    expect(baseRole('gate-brief')).toBe('gate-brief');
    expect(baseRole('gate-brief-deep')).toBe('gate-brief');
    expect(baseRole('comms-log')).toBe('comms-log');
    expect(baseRole('new-pdd')).toBe('new-pdd');
    expect(baseRole('widget-handoff')).toBe('widget-handoff');
    expect(baseRole('award-record')).toBe('award-record');
  });
});
