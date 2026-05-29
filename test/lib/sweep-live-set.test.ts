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

// Shapes verified against live Drive state 2026-05-29 — the extractor must
// accept every alias key name, not just the canonical one, or the OCS/labs
// sweeps will see live resources as orphan candidates and delete them.
describe('extractOppFragment — real-world key-shape drift', () => {
  it('captures OCS chatbot + collection from the live `ocs_chatbot` block (not `chatbot`)', () => {
    const run = `
phases:
  ocs-setup:
    products:
      ocs_chatbot:
        experiment_id: 12027
        public_id: pub-uuid-aaa
        collection_id: 418
`;
    const frag = extractOppFragment('turmeric', '', [run]);
    // integer experiment_id coerced to string + public_id both captured
    expect(frag.identifiers.ocsChatbotIds).toContain('12027');
    expect(frag.identifiers.ocsChatbotIds).toContain('pub-uuid-aaa');
    expect(frag.identifiers.ocsCollectionIds).toContain('418');
  });

  it('captures all 3 OCS chatbot id aliases (id / experiment_id / chatbot_id)', () => {
    const run = `
phases:
  ocs-setup:
    products:
      ocs_chatbot:
        id: 555
        experiment_id: 12027
        chatbot_id: 999
`;
    const frag = extractOppFragment('malaria-rdt', '', [run]);
    expect(frag.identifiers.ocsChatbotIds.sort()).toEqual(['12027', '555', '999']);
  });

  it('captures all 4 OCS collection id aliases', () => {
    const opp = `
ocs_chatbot:
  collection_id_per_opp: 395
  collection_id_shared: 350
  opp_collection_id: 375
  shared_collection_id: 350
`;
    const frag = extractOppFragment('turmeric', opp, []);
    expect(frag.identifiers.ocsCollectionIds.sort()).toEqual(['350', '375', '395']);
  });

  it('captures solicitation id under both `solicitation_id` and `labs_id`', () => {
    const oppLeep = 'solicitation:\n  solicitation_id: 2845\n';
    const oppTurmeric = 'solicitation:\n  labs_id: 2841\n';
    expect(extractOppFragment('leep', oppLeep, []).identifiers.labsRecordIds).toContain('2845');
    expect(extractOppFragment('turmeric', oppTurmeric, []).identifiers.labsRecordIds).toContain('2841');
  });

  it('captures synthetic opp id under both `labs_opp_id` and `labs_opportunity_id`', () => {
    expect(
      extractOppFragment('turmeric', 'synthetic:\n  labs_opp_id: 1749\n', []).identifiers
        .labsSyntheticIds,
    ).toContain('1749');
    expect(
      extractOppFragment('leep', 'synthetic:\n  labs_opportunity_id: 1750\n', []).identifiers
        .labsSyntheticIds,
    ).toContain('1750');
  });

  it('captures labs workflow/pipeline ids from both flat opp.yaml and nested run_state shapes', () => {
    const opp = `
synthetic:
  workflows:
    llo_weekly_review_id: 2957
    program_admin_audit_id: 2959
    llo_pipeline_id: 2945
`;
    const run = `
phases:
  synthetic-data-and-workflows:
    products:
      synthetic:
        workflows:
          llo_weekly_review:
            workflow_id: 3001
            pipeline_id: 3002
          program_admin_audit:
            workflow_id: 3003
`;
    const frag = extractOppFragment('leep', opp, [run]);
    expect(frag.identifiers.labsWorkflowIds.sort()).toEqual(['2957', '2959', '3001', '3003']);
    expect(frag.identifiers.labsPipelineIds.sort()).toEqual(['2945', '3002']);
  });

  it('captures Connect program/opp ids whether flat or nested', () => {
    const flat = `
phases:
  connect-setup:
    products:
      connect:
        program_id: prog-flat
        opportunity_id: opp-flat
`;
    const nested = `
phases:
  connect-setup:
    products:
      connect:
        program:
          id: prog-nested
        opportunity:
          id: opp-nested
`;
    const f = extractOppFragment('bednet', '', [flat]).identifiers;
    expect(f.connectProgramIds).toContain('prog-flat');
    expect(f.connectOpportunityIds).toContain('opp-flat');
    const n = extractOppFragment('turmeric', '', [nested]).identifiers;
    expect(n.connectProgramIds).toContain('prog-nested');
    expect(n.connectOpportunityIds).toContain('opp-nested');
  });

  it('captures a top-level `connect_program.id` on in-progress runs', () => {
    const run = 'connect_program:\n  id: prog-top-level\nphases: {}\n';
    expect(extractOppFragment('malaria-itn-app', '', [run]).identifiers.connectProgramIds).toContain(
      'prog-top-level',
    );
  });

  it('captures payment unit ids across singular / array / uuid shapes', () => {
    const run = `
phases:
  connect-setup:
    products:
      connect:
        payment_units:
          - uuid: pu-uuid-1
            server_id: 71
          - payment_unit_uuid: pu-uuid-2
`;
    const ids = extractOppFragment('turmeric', '', [run]).identifiers.connectPaymentUnitIds;
    expect(ids).toEqual(expect.arrayContaining(['pu-uuid-1', '71', 'pu-uuid-2']));
  });

  it('captures commcare hq_app_ids under both `apps.*` and `commcare.*` wrappers', () => {
    const appsShape =
      'phases:\n  commcare-setup:\n    products:\n      apps:\n        learn:\n          hq_app_id: app-a\n        deliver:\n          hq_app_id: app-b\n';
    const commcareShape =
      'phases:\n  commcare-setup:\n    products:\n      commcare:\n        learn:\n          hq_app_id: app-c\n        deliver:\n          hq_app_id: app-d\n';
    expect(extractOppFragment('bednet', '', [appsShape]).identifiers.commcareAppIds.sort()).toEqual([
      'app-a',
      'app-b',
    ]);
    expect(
      extractOppFragment('itn-fgd', '', [commcareShape]).identifiers.commcareAppIds.sort(),
    ).toEqual(['app-c', 'app-d']);
  });

  it('dedupes an id that appears in both opp.yaml and a run_state', () => {
    const opp = 'solicitation:\n  labs_id: 2841\n';
    const run = `
phases:
  solicitation-management:
    products:
      solicitation:
        labs_id: 2841
`;
    expect(extractOppFragment('turmeric', opp, [run]).identifiers.labsRecordIds).toEqual(['2841']);
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
