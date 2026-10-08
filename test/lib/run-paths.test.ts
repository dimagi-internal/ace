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
  it('parses bare opp slug (default workspace)', () => {
    expect(parseOppRef('turmeric')).toEqual({ workspace: null, opp: 'turmeric', runId: null });
  });

  it('parses <opp>/<run-id> exactly as before workspaces existed', () => {
    expect(parseOppRef('turmeric/20260502-1830')).toEqual({
      workspace: null,
      opp: 'turmeric',
      runId: '20260502-1830',
    });
  });

  it('treats a collision-suffixed run id as a run id', () => {
    expect(parseOppRef('turmeric/20260502-1830-2')).toEqual({
      workspace: null,
      opp: 'turmeric',
      runId: '20260502-1830-2',
    });
  });

  it('parses <workspace>/<opp> when the second segment is not a run id', () => {
    expect(parseOppRef('spark/spark-facilitator')).toEqual({
      workspace: 'spark',
      opp: 'spark-facilitator',
      runId: null,
    });
  });

  it('parses <workspace>/<opp>/<run-id>', () => {
    expect(parseOppRef('spark/spark-facilitator/20261004-1706')).toEqual({
      workspace: 'spark',
      opp: 'spark-facilitator',
      runId: '20261004-1706',
    });
  });

  it('rejects a three-segment path that does not end in a run id', () => {
    expect(() => parseOppRef('a/b/c')).toThrow(/run-id must look like/);
  });

  it('rejects four segments', () => {
    expect(() => parseOppRef('a/b/c/20260502-1830')).toThrow(/expected/);
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

  it('rejects an empty opp in the three-segment form', () => {
    expect(() => parseOppRef('spark//20261004-1706')).toThrow(/empty opp slug/);
  });
});

describe('runFolderPath', () => {
  it('joins opp + run-id with runs/ separator', () => {
    expect(runFolderPath('turmeric', '20260502-1830')).toBe(
      'turmeric/runs/20260502-1830'
    );
  });
});
