import { describe, expect, it } from 'vitest';
import { extractOppFragment, mergeFragments } from '../../lib/sweep-live-set';
import type { LiveSet } from '../../lib/sweep-types';

const OPP_YAML = `
display_name: Turmeric
connect:
  program:
    id: prog-abc-123
    url: https://connect.dimagi.com/programs/prog-abc-123
    labs_int_id: 42
`;

const RUN_STATE_YAML = `
opp: turmeric
run_id: 20260502-1830
phases:
  connect-setup:
    products:
      opportunity:
        id: opp-xyz-789
      payment_units:
        - id: pu-001
        - id: pu-002
  ocs-setup:
    products:
      chatbot:
        id: chat-555
        collection_id: coll-666
  solicitation-management:
    products:
      solicitation:
        id: labs-rec-1001
        url: https://labs.connect.dimagi.com/solicitations/1001
  synthetic-data-and-workflows:
    products:
      workflow_id: wf-200
      pipeline_id: pl-300
      synthetic_opp_id: syn-400
  commcare-setup:
    products:
      learn_app:
        hq_app_id: app-aaa
      deliver_app:
        hq_app_id: app-bbb
`;

describe('extractOppFragment', () => {
  it('extracts Connect program id from opp.yaml', () => {
    const frag = extractOppFragment('turmeric', OPP_YAML, []);
    expect(frag.identifiers.connectProgramIds).toEqual(['prog-abc-123']);
    expect(frag.oppSlugs).toEqual(['turmeric']);
  });

  it('extracts per-phase products from run_state.yaml', () => {
    const frag = extractOppFragment('turmeric', OPP_YAML, [RUN_STATE_YAML]);
    expect(frag.identifiers.connectOpportunityIds).toEqual(['opp-xyz-789']);
    expect(frag.identifiers.connectPaymentUnitIds).toEqual(['pu-001', 'pu-002']);
    expect(frag.identifiers.ocsChatbotIds).toEqual(['chat-555']);
    expect(frag.identifiers.ocsCollectionIds).toEqual(['coll-666']);
    expect(frag.identifiers.labsRecordIds).toEqual(['labs-rec-1001']);
    expect(frag.identifiers.labsWorkflowIds).toEqual(['wf-200']);
    expect(frag.identifiers.labsPipelineIds).toEqual(['pl-300']);
    expect(frag.identifiers.labsSyntheticIds).toEqual(['syn-400']);
    expect(frag.identifiers.commcareAppIds).toEqual(['app-aaa', 'app-bbb']);
  });

  it('tolerates missing phases', () => {
    const frag = extractOppFragment('turmeric', OPP_YAML, ['opp: turmeric\nrun_id: x\nphases: {}\n']);
    expect(frag.identifiers.connectOpportunityIds).toEqual([]);
    expect(frag.identifiers.connectProgramIds).toEqual(['prog-abc-123']);
  });

  it('tolerates invalid YAML by treating it as empty', () => {
    const frag = extractOppFragment('turmeric', 'this: is: not: yaml: [', []);
    expect(frag.oppSlugs).toEqual(['turmeric']);
    expect(frag.identifiers.connectProgramIds).toEqual([]);
  });
});

describe('mergeFragments', () => {
  it('merges identifiers, dedupes, sorts opp slugs', () => {
    const a: LiveSet = {
      generatedAt: '2026-05-15T00:00:00Z',
      oppSlugs: ['turmeric'],
      identifiers: {
        connectProgramIds: ['p1'],
        connectOpportunityIds: ['o1'],
        connectPaymentUnitIds: [],
        ocsChatbotIds: ['c1'],
        ocsCollectionIds: [],
        ocsSessionIds: [],
        commcareAppIds: [],
        labsWorkflowIds: [],
        labsPipelineIds: [],
        labsSyntheticIds: [],
        labsRecordIds: [],
        driveFileIds: [],
      },
    };
    const b: LiveSet = {
      generatedAt: '2026-05-15T00:00:00Z',
      oppSlugs: ['arnica'],
      identifiers: {
        connectProgramIds: ['p2'],
        connectOpportunityIds: ['o1'],
        connectPaymentUnitIds: [],
        ocsChatbotIds: ['c2'],
        ocsCollectionIds: [],
        ocsSessionIds: [],
        commcareAppIds: [],
        labsWorkflowIds: [],
        labsPipelineIds: [],
        labsSyntheticIds: [],
        labsRecordIds: [],
        driveFileIds: [],
      },
    };
    const merged = mergeFragments([a, b], '2026-05-15T12:00:00Z');
    expect(merged.oppSlugs).toEqual(['arnica', 'turmeric']);
    expect(merged.identifiers.connectProgramIds.sort()).toEqual(['p1', 'p2']);
    expect(merged.identifiers.connectOpportunityIds).toEqual(['o1']);
    expect(merged.generatedAt).toBe('2026-05-15T12:00:00Z');
  });
});
