import { describe, expect, it } from 'vitest';
import { renderOrphanReport } from '../../lib/sweep-report';
import type { OrphanReport } from '../../lib/sweep-types';

const baseReport: OrphanReport = {
  system: 'drive',
  generatedAt: '2026-05-15T18:00:00Z',
  liveSetGeneratedAt: '2026-05-15T17:58:00Z',
  totals: { high: 0, medium: 0, low: 0 },
  orphans: [],
};

describe('renderOrphanReport', () => {
  it('renders header with system, timestamps, and totals', () => {
    const md = renderOrphanReport({
      ...baseReport,
      totals: { high: 2, medium: 1, low: 0 },
      orphans: [
        { id: 'a', name: 'ACE-Test-001', createdTime: '2026-04-01T00:00:00Z',
          confidence: 'high', signals: ['CRISPR- prefix'] },
        { id: 'b', name: 'paprika-pilot', createdTime: '2026-04-02T00:00:00Z',
          confidence: 'high', signals: ['kebab opp style'] },
        { id: 'c', name: 'README', createdTime: '2026-03-01T00:00:00Z',
          confidence: 'medium', signals: ['under ACE root, unknown pattern'] },
      ],
    });
    expect(md).toContain('# Sweep report — drive');
    expect(md).toContain('Generated: 2026-05-15T18:00:00Z');
    expect(md).toContain('Live set: 2026-05-15T17:58:00Z');
    expect(md).toContain('high: 2');
    expect(md).toContain('medium: 1');
    expect(md).toContain('low: 0');
  });

  it('groups orphans by confidence with high first', () => {
    const md = renderOrphanReport({
      ...baseReport,
      totals: { high: 1, medium: 1, low: 0 },
      orphans: [
        { id: 'm', name: 'unknown', createdTime: '2026-04-02T00:00:00Z',
          confidence: 'medium', signals: ['?'] },
        { id: 'h', name: 'ACE-Test-X', createdTime: '2026-04-01T00:00:00Z',
          confidence: 'high', signals: ['CRISPR-'] },
      ],
    });
    expect(md.indexOf('## High confidence')).toBeLessThan(md.indexOf('## Medium confidence'));
    expect(md.indexOf('ACE-Test-X')).toBeLessThan(md.indexOf('unknown'));
  });

  it('skips empty confidence sections', () => {
    const md = renderOrphanReport({
      ...baseReport,
      totals: { high: 1, medium: 0, low: 0 },
      orphans: [
        { id: 'h', name: 'h', createdTime: '2026-04-01T00:00:00Z',
          confidence: 'high', signals: ['x'] },
      ],
    });
    expect(md).toContain('## High confidence');
    expect(md).not.toContain('## Medium confidence');
    expect(md).not.toContain('## Low confidence');
  });

  it('renders "No orphans found" when totals are all zero', () => {
    const md = renderOrphanReport(baseReport);
    expect(md).toContain('No orphans found.');
  });
});
