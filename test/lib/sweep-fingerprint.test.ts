import { describe, expect, it } from 'vitest';
import {
  scoreDriveFolder,
  scoreConnectItem,
  scoreOcsItem,
  scoreHqApp,
  scoreLabsItem,
} from '../../lib/sweep-fingerprint';
import type { LiveSet, DriveFolderInfo } from '../../lib/sweep-types';

const LIVE_SET: LiveSet = {
  generatedAt: '2026-05-15T12:00:00Z',
  oppSlugs: ['turmeric', 'arnica'],
  identifiers: {
    connectProgramIds: [], connectOpportunityIds: ['opp-active-1'], connectPaymentUnitIds: [],
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
  it('returns high for ACE-shaped name (ACE- prefix)', () => {
    const r = scoreDriveFolder(folder({ name: 'ACE-Test-001' }), LIVE_SET, 'ace-root');
    expect(r.confidence).toBe('high');
    expect(r.signals.some((s) => s.toLowerCase().includes('ace'))).toBe(true);
  });

  it('still returns high for legacy CRISPR- prefix', () => {
    const r = scoreDriveFolder(folder({ name: 'CRISPR-Test-001' }), LIVE_SET, 'ace-root');
    expect(r.confidence).toBe('high');
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
      folder({ name: 'ACE-Test-001', parentId: 'some-other-folder' }),
      LIVE_SET,
      'ace-root',
    );
    expect(r.confidence).toBe('low');
  });

  it('returns low for well-known shared project folders (never an orphan)', () => {
    for (const name of [
      'documentation',
      'templates',
      'videos',
      'labs-ai-videos',
      'ai-input-creation-runs',
      'rooftop-surveys',
      'human output examples',
    ]) {
      const r = scoreDriveFolder(folder({ name }), LIVE_SET, 'ace-root');
      expect(r.confidence, `${name} should be low`).toBe('low');
      expect(r.signals.some((s) => s.includes('shared project folder'))).toBe(true);
    }
  });

  it('returns low for `_`-prefixed scratch folders (e.g. _sweep)', () => {
    const r = scoreDriveFolder(folder({ name: '_sweep' }), LIVE_SET, 'ace-root');
    expect(r.confidence).toBe('low');
  });

  it('returns low for a kebab-named folder that is NOT opp-shaped (probed)', () => {
    // A folder whose name looks opp-like but has no opp.yaml/inputs is not an opp.
    const r = scoreDriveFolder(
      folder({ name: 'some-working-folder', isOppShaped: false }),
      LIVE_SET,
      'ace-root',
    );
    expect(r.confidence).toBe('low');
    expect(r.signals.some((s) => s.includes('not opp-shaped'))).toBe(true);
  });

  it('returns high for a confirmed opp folder not referenced by any active opp', () => {
    const r = scoreDriveFolder(
      folder({ name: 'abandoned-pilot', isOppShaped: true }),
      LIVE_SET,
      'ace-root',
    );
    expect(r.confidence).toBe('high');
    expect(r.signals.some((s) => s.includes('opp-shaped'))).toBe(true);
  });

  it('isOppShaped === false overrides an opp-style name', () => {
    const r = scoreDriveFolder(
      folder({ name: 'ACE-Test-999', isOppShaped: false }),
      LIVE_SET,
      'ace-root',
    );
    expect(r.confidence).toBe('low');
  });
});

describe('scoreConnectItem', () => {
  it('returns high for CRISPR-named opportunity', () => {
    const r = scoreConnectItem({ id: 'o1', name: 'CRISPR-Pilot-X', type: 'opportunity' }, LIVE_SET);
    expect(r.confidence).toBe('high');
  });

  it('returns high for kebab-case opportunity name', () => {
    const r = scoreConnectItem({ id: 'o1', name: 'turmeric-pilot', type: 'opportunity' }, LIVE_SET);
    expect(r.confidence).toBe('high');
  });

  it('returns high for already-inactive opportunity', () => {
    const r = scoreConnectItem(
      { id: 'o1', name: 'Some Org', type: 'opportunity', active: false },
      LIVE_SET,
    );
    expect(r.confidence).toBe('high');
    expect(r.signals.some((s) => s.includes('inactive'))).toBe(true);
  });

  it('returns medium for non-ACE-shaped name', () => {
    const r = scoreConnectItem({ id: 'p1', name: 'Real LLO Program', type: 'program' }, LIVE_SET);
    expect(r.confidence).toBe('medium');
  });
});

describe('scoreOcsItem', () => {
  it('returns high when chatbot cloned from golden template', () => {
    const r = scoreOcsItem(
      { id: 'c1', name: 'Bot 1', type: 'chatbot', parentChatbotId: 'golden-123' },
      LIVE_SET,
      'golden-123',
    );
    expect(r.confidence).toBe('high');
    expect(r.signals.some((s) => s.includes('golden template'))).toBe(true);
  });

  it('returns high for ACE-prefixed name', () => {
    const r = scoreOcsItem({ id: 'c1', name: 'ACE-helpbot-pilot', type: 'collection' }, LIVE_SET, null);
    expect(r.confidence).toBe('high');
  });

  it('returns medium for non-ACE-shaped chatbot when no template id', () => {
    const r = scoreOcsItem({ id: 'c1', name: 'CompanyBot', type: 'chatbot' }, LIVE_SET, null);
    expect(r.confidence).toBe('medium');
  });
});

describe('scoreHqApp', () => {
  it('returns high for app in ACE domain with Learn/Deliver in name', () => {
    const r = scoreHqApp(
      { id: 'a1', name: 'Turmeric Learn', domain: 'connect-ace-prod' },
      'connect-ace-prod',
    );
    expect(r.confidence).toBe('high');
  });

  it('returns medium for app in ACE domain without standard name', () => {
    const r = scoreHqApp({ id: 'a1', name: 'Random', domain: 'connect-ace-prod' }, 'connect-ace-prod');
    expect(r.confidence).toBe('medium');
  });

  it('returns low for app in a different domain', () => {
    const r = scoreHqApp({ id: 'a1', name: 'Learn App', domain: 'real-llo' }, 'connect-ace-prod');
    expect(r.confidence).toBe('low');
  });
});

describe('scoreLabsItem', () => {
  it('returns high for ACE-prefixed workflow', () => {
    const r = scoreLabsItem({ id: 'w1', type: 'workflow', name: 'ACE-weekly-review' }, LIVE_SET);
    expect(r.confidence).toBe('high');
  });

  it('returns high by default — ACE owns connect-labs writes', () => {
    const r = scoreLabsItem({ id: 'w1', type: 'pipeline' }, LIVE_SET);
    expect(r.confidence).toBe('high');
  });

  it('returns low when item references an active opportunity', () => {
    const r = scoreLabsItem(
      { id: 'wr1', type: 'response', opportunityId: 'opp-active-1' },
      LIVE_SET,
    );
    expect(r.confidence).toBe('low');
    expect(r.signals.some((s) => s.includes('active opportunity'))).toBe(true);
  });
});
