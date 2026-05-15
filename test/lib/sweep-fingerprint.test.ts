import { describe, expect, it } from 'vitest';
import { scoreDriveFolder } from '../../lib/sweep-fingerprint';
import type { LiveSet, DriveFolderInfo } from '../../lib/sweep-types';

const LIVE_SET: LiveSet = {
  generatedAt: '2026-05-15T12:00:00Z',
  oppSlugs: ['turmeric', 'arnica'],
  identifiers: {
    connectProgramIds: [], connectOpportunityIds: [], connectPaymentUnitIds: [],
    ocsChatbotIds: [], ocsCollectionIds: [], ocsSessionIds: [],
    commcareAppIds: [], labsWorkflowIds: [], labsPipelineIds: [],
    labsSyntheticIds: [], labsRecordIds: [], driveFileIds: [],
  },
};

const folder = (overrides: Partial<DriveFolderInfo> = {}): DriveFolderInfo => ({
  id: 'fld-x',
  name: 'something',
  createdTime: '2026-04-01T00:00:00Z',
  parentId: 'ace-root',
  ...overrides,
});

describe('scoreDriveFolder', () => {
  it('returns high for ACE-shaped name (CRISPR-prefix)', () => {
    const r = scoreDriveFolder(folder({ name: 'CRISPR-Test-001' }), LIVE_SET, 'ace-root');
    expect(r.confidence).toBe('high');
    expect(r.signals.some((s) => s.toLowerCase().includes('crispr'))).toBe(true);
  });

  it('returns high for kebab-case opp-style name', () => {
    const r = scoreDriveFolder(folder({ name: 'paprika-pilot' }), LIVE_SET, 'ace-root');
    expect(r.confidence).toBe('high');
  });

  it('returns medium for unrecognized name at ACE root', () => {
    const r = scoreDriveFolder(folder({ name: 'README' }), LIVE_SET, 'ace-root');
    expect(r.confidence).toBe('medium');
  });

  it('does not return high for an active opp slug', () => {
    const r = scoreDriveFolder(folder({ name: 'turmeric' }), LIVE_SET, 'ace-root');
    expect(r.confidence).not.toBe('high');
  });

  it('returns low for folders not under ACE root', () => {
    const r = scoreDriveFolder(
      folder({ name: 'CRISPR-Test-001', parentId: 'some-other-folder' }),
      LIVE_SET,
      'ace-root',
    );
    expect(r.confidence).toBe('low');
  });
});
