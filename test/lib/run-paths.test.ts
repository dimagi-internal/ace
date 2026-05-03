import { describe, expect, it } from 'vitest';
import { generateRunId, parseOppRef, runFolderPath } from '../../lib/run-paths';

describe('generateRunId', () => {
  it('formats local time as YYYYMMDD-HHMM', () => {
    const d = new Date(2026, 4, 2, 18, 30); // local; month is 0-indexed
    expect(generateRunId(d)).toBe('20260502-1830');
  });

  it('zero-pads single-digit fields', () => {
    const d = new Date(2026, 0, 5, 9, 7);
    expect(generateRunId(d)).toBe('20260105-0907');
  });
});

describe('parseOppRef', () => {
  it('parses bare opp slug', () => {
    expect(parseOppRef('turmeric')).toEqual({ opp: 'turmeric', runId: null });
  });

  it('parses <opp>/<run-id>', () => {
    expect(parseOppRef('turmeric/20260502-1830')).toEqual({
      opp: 'turmeric',
      runId: '20260502-1830',
    });
  });

  it('rejects multi-slash', () => {
    expect(() => parseOppRef('a/b/c')).toThrow(/expected/);
  });

  it('rejects empty', () => {
    expect(() => parseOppRef('')).toThrow(/empty/);
  });

  it('rejects leading slash', () => {
    expect(() => parseOppRef('/turmeric')).toThrow(/empty opp slug/);
  });

  it('rejects trailing slash', () => {
    expect(() => parseOppRef('turmeric/')).toThrow(/empty run-id/);
  });
});

describe('runFolderPath', () => {
  it('joins opp + run-id with runs/ separator', () => {
    expect(runFolderPath('turmeric', '20260502-1830')).toBe(
      'turmeric/runs/20260502-1830'
    );
  });
});
