import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  buildAssetMap,
  classifyClonePath,
  docTextFromExport,
  findSourceRefs,
  processCloneFile,
  rewriteAssetRefs,
  rewriteRunState,
  runAssetsFromRunState,
  stripProvenanceNote,
} from '../../lib/clone-asset-refs.js';

// Shapes and ids from the live repro (dimagi-internal/ace#2606,
// dimagi-team → spark/spark-facilitator/20261001-2208).
const SOURCE_RS = {
  phases: {
    'commcare-setup': {
      products: {
        apps: {
          // The source run records the space only in hq_url.
          learn: {
            hq_app_id: '81eab9f6804b4c2ea5e67cbecdd6601c',
            hq_url: 'https://www.commcarehq.org/a/connect-ace-prod/apps/view/81eab9f6804b4c2ea5e67cbecdd6601c/',
            released_build_id: '7876e5bca74f4e21adda296c6478af25',
            released_version: 22,
          },
          deliver: {
            hq_app_id: '58ef8132e5ac4b5cafa575d9d570c368',
            hq_url: 'https://www.commcarehq.org/a/connect-ace-prod/apps/view/58ef8132e5ac4b5cafa575d9d570c368/',
            released_build_id: '4aa52f2fb5ff40b392797d00aaca1585',
            released_version: 9,
          },
        },
      },
    },
    'connect-setup': {
      products: {
        connect: {
          domain: 'connect-ace-prod',
          pm_org_slug: 'ace-pm-org',
          holding_org_slug: 'ace-nm-org',
          program: { id: 'e7ca0792-4e2b-4b9e-afd7-cea6b6745a1e' },
          opportunity: { id: '308a6932-a4a4-4a35-bfe7-c231106e17c9', connect_int_id: 2318 },
        },
      },
    },
  },
};

const TARGET_RS = {
  ace_web_summary_url: 'https://labs.connect.dimagi.com/ace/opps/spark/spark-facilitator/runs/20261001-2208/summary',
  phases: {
    'commcare-setup': {
      products: {
        apps: {
          domain: 'connect-ace-spark',
          learn: {
            hq_app_id: '8c073531bbb94350a7f0e8b894709ec0',
            released_build_id: 'eb192e6880ad4b20bab2dff83f1425ac',
            released_version: 1,
            domain: 'connect-ace-spark',
          },
          deliver: {
            hq_app_id: '7c34a5505182408c99c537b97fe3e56b',
            released_build_id: '255249b659bf4f2d82fb852674995209',
            released_version: 1,
            domain: 'connect-ace-spark',
          },
        },
      },
      status_note:
        'Both apps built fresh, deployed to connect-ace-prod, released (Learn v22, Deliver v9); all three judges pass.',
      residuals: [
        {
          what: 'Connect verification rule payable_slot = yes',
          where_to_apply:
            'Phase 4 connect-opp-setup on the opportunity built on Deliver HQ app 58ef8132e5ac4b5cafa575d9d570c368',
        },
        { what: 'Native-speaker review', where_to_apply: 'Nova apps 00c8a612' },
      ],
    },
    'connect-setup': {
      products: {
        connect: {
          pm_org_slug: 'spark-pm-org-test',
          holding_org_slug: 'spark-nm-org-test',
          program: { id: 'f537601b-9a58-40de-add0-fe3fed10f2ef' },
          opportunity: { id: 'ad6c2d40-474f-4b52-a334-82d17387aeaf', connect_int_id: 2319 },
        },
      },
    },
    'solicitation-management': {
      products: {
        solicitation: { connect_program_id: 'e7ca0792-4e2b-4b9e-afd7-cea6b6745a1e', connect_opportunity_id: 2318 },
      },
    },
  },
  clone: {
    from: { workspace: 'dimagi-team', opp: 'spark-facilitator', run: '20261001-2208' },
    hq: { copied_from_builds: { learn: '7876e5bca74f4e21adda296c6478af25 (v22)' } },
  },
};

const LABEL = { from: 'dimagi-team/spark-facilitator/20261001-2208', to: 'spark' };
const map = buildAssetMap(runAssetsFromRunState(SOURCE_RS), runAssetsFromRunState(TARGET_RS));

describe('buildAssetMap', () => {
  it('derives the source HQ space from hq_url when apps carry no domain', () => {
    expect(map.pairs).toContainEqual({ kind: 'hq_domain', from: 'connect-ace-prod', to: 'connect-ace-spark' });
  });

  it('pairs every moved asset and each build version', () => {
    expect(map.pairs.map((p) => p.kind).sort()).toEqual(
      ['app', 'app', 'build', 'build', 'hq_domain', 'opportunity', 'opportunity_int', 'org', 'org', 'program'].sort(),
    );
    expect(map.versions).toEqual({ learn: { from: '22', to: '1' }, deliver: { from: '9', to: '1' } });
    expect(map.connectRebuilt).toBe(true);
  });

  it('adds no Connect pairs when Connect was kept shared (same opportunity)', () => {
    const kept = structuredClone(TARGET_RS) as any;
    kept.phases['connect-setup'] = SOURCE_RS.phases['connect-setup'];
    const m = buildAssetMap(runAssetsFromRunState(SOURCE_RS), runAssetsFromRunState(kept));
    expect(m.connectRebuilt).toBe(false);
    expect(m.pairs.some((p) => ['org', 'opportunity', 'program', 'opportunity_int'].includes(p.kind))).toBe(false);
  });
});

describe('rewriteAssetRefs', () => {
  it('rewrites the partner-facing LLO guide lines (space, app ids, opportunity URL)', () => {
    const before = [
      '* CommCare HQ project space: connect-ace-prod — Learn app 81eab9f6804b4c2ea5e67cbecdd6601c, Deliver app 58ef8132e5ac4b5cafa575d9d570c368.',
      '* Connect opportunity: https://connect.dimagi.com/a/ace-nm-org/opportunity/308a6932-a4a4-4a35-bfe7-c231106e17c9/ — the Workers tab',
    ].join('\n');
    const { text } = rewriteAssetRefs(before, map);
    expect(text).toContain('connect-ace-spark — Learn app 8c073531bbb94350a7f0e8b894709ec0, Deliver app 7c34a5505182408c99c537b97fe3e56b');
    expect(text).toContain('https://connect.dimagi.com/a/spark-nm-org-test/opportunity/ad6c2d40-474f-4b52-a334-82d17387aeaf/');
    expect(findSourceRefs(text, map)).toEqual([]);
  });

  it('rewrites a build version next to its build or app id, and in "Learn vN" shorthand', () => {
    const before = [
      '| Spark Facilitator Learn app | 81eab9f6804b4c2ea5e67cbecdd6601c | 7876e5bca74f4e21adda296c6478af25 | 22 |',
      "| [Deliver](x) | `58ef8132e5ac4b5cafa575d9d570c368` | `4aa52f2f…` v9 |",
      'Released build `4aa52f2fb5ff40b392797d00aaca1585`, version 9: 1 deliver unit',
      '(Nova 5b0aa4c3 / HQ 58ef8132 v9, form "Community Meeting Record")',
      'released (Learn v22, Deliver v9); rev 9 stays',
      '    released_build_id: 7876e5bca74f4e21adda296c6478af25',
      '    released_version: 22',
      '  learn_app: { hq_app_id: 81eab9f6804b4c2ea5e67cbecdd6601c, build_id: 7876e5bca74f4e21adda296c6478af25, version: 22, x: 1 }',
    ].join('\n');
    const lines = rewriteAssetRefs(before, map).text.split('\n');
    expect(lines[0]).toBe('| Spark Facilitator Learn app | 8c073531bbb94350a7f0e8b894709ec0 | eb192e6880ad4b20bab2dff83f1425ac | 1 |');
    expect(lines[1]).toBe("| [Deliver](x) | `7c34a5505182408c99c537b97fe3e56b` | `255249b6…` v1 |");
    expect(lines[2]).toBe('Released build `255249b659bf4f2d82fb852674995209`, version 1: 1 deliver unit');
    expect(lines[3]).toBe('(Nova 5b0aa4c3 / HQ 7c34a550 v1, form "Community Meeting Record")');
    expect(lines[4]).toBe('released (Learn v1, Deliver v1); rev 9 stays');
    expect(lines[6]).toBe('    released_version: 1');
    expect(lines[7]).toContain('version: 1, x: 1');
  });

  it('rewrites the opportunity int id only in context, and org slugs only whole', () => {
    const before = 'opportunity 2318 (int 2318); Connect opp 2318; budget 2318 MWK; ace-pm-org / ace-nm-org; ace-pm-org-archive';
    const { text } = rewriteAssetRefs(before, map);
    expect(text).toBe(
      'opportunity 2319 (int 2319); Connect opp 2319; budget 2318 MWK; spark-pm-org-test / spark-nm-org-test; ace-pm-org-archive',
    );
  });
});

describe('classifyClonePath', () => {
  const rebuilt = { connectRebuilt: true };
  it.each([
    ['decisions.yaml', 'skip'],
    ['decisions.gdoc', 'skip'],
    ['8-solicitation-management/solicitation-create_published.md', 'skip'],
    ['release-check_report.md', 'skip'],
    ['4-connect/connect-setup_summary.md', 'skip'],
    ['3-commcare/app-release-qa_result.yaml', 'note'],
    ['5-ocs/ocs-widget-handoff-eval_verdict.yaml', 'note'],
    ['6-qa-and-training/training-llo-guide.md', 'rewrite'],
    ['7-synthetic/cascade-pool.py', 'rewrite'],
  ])('%s → %s', (path, kind) => {
    expect(classifyClonePath(path, rebuilt)).toBe(kind);
  });

  it('rewrites 4-connect when Connect was NOT rebuilt (kept shared → nothing to rewrite there anyway)', () => {
    expect(classifyClonePath('4-connect/connect-opp-setup.md', { connectRebuilt: false })).toBe('rewrite');
  });

  it('honours an operator-chosen set of kept phase folders', () => {
    expect(classifyClonePath('8-solicitation-management/x.md', { keepPhaseFolders: [] })).toBe('rewrite');
  });
});

describe('processCloneFile', () => {
  const md = '---\nhq_domain: connect-ace-prod\n---\n\n# Deploy\n\nUploaded to `connect-ace-prod` as `81eab9f6…`.\n';
  const yml = '# Journey: Deliver\n# HQ draft 58ef8132e5ac4b5cafa575d9d570c368 (connect-ace-prod)\nappId: org.commcare.dalvik\n';
  const verdict = 'verdict: pass\nnote: "commcare_download_ccz(81eab9f6804b4c2ea5e67cbecdd6601c) for connect-ace-prod"\n';

  it('rewrites markdown, keeps front matter first, adds one provenance note, and is idempotent', () => {
    const r = processCloneFile('3-commcare/app-deploy_summary.md', md, map, LABEL);
    expect(r.kind).toBe('rewrite');
    expect(r.text.startsWith('---\nhq_domain: connect-ace-spark\n---\n')).toBe(true);
    expect(r.text).toContain('> **Note:** Copied into the spark workspace for review from dimagi-team/spark-facilitator/20261001-2208.');
    expect(findSourceRefs(stripProvenanceNote(r.text), map)).toEqual([]);
    const again = processCloneFile('3-commcare/app-deploy_summary.md', r.text, map, LABEL);
    expect(again.changed).toBe(false);
  });

  it('keeps YAML parseable and never eats the file\'s own leading comments', () => {
    const r = processCloneFile('3-commcare/recipes/journey-deliver.yaml', yml, map, LABEL);
    expect(YAML.parse(r.text)).toEqual({ appId: 'org.commcare.dalvik' });
    expect(r.text).toContain('# Journey: Deliver\n# HQ draft 7c34a5505182408c99c537b97fe3e56b (connect-ace-spark)');
    expect(processCloneFile('3-commcare/recipes/journey-deliver.yaml', r.text, map, LABEL).changed).toBe(false);
  });

  it('notes — does not rewrite — an eval/QA record, once', () => {
    const r = processCloneFile('3-commcare/app-release-eval_verdict.yaml', verdict, map, LABEL);
    expect(r.kind).toBe('note');
    expect(r.text).toContain('81eab9f6804b4c2ea5e67cbecdd6601c) for connect-ace-prod');
    expect(r.text).toContain('was not re-run on the');
    expect(YAML.parse(r.text).verdict).toBe('pass');
    expect(processCloneFile('3-commcare/app-release-eval_verdict.yaml', r.text, map, LABEL).changed).toBe(false);
  });

  it('leaves a file that names no source asset byte-identical', () => {
    const r = processCloneFile('1-design/pdd.md', '# PDD\nnothing here\n', map, LABEL);
    expect(r.changed).toBe(false);
  });
});

describe('docTextFromExport', () => {
  // Measured live 2026-10-02: upload → Docs text/plain export.
  it.each([
    ['A\r\nB', 'A\nB'],
    ['A\r\n\r\n\r\nB', 'A\n\nB'],
    ['A\r\n\r\n\r\n\r\n\r\nB', 'A\n\n\nB'],
    ['﻿# H\r\n\r\n\r\nB', '# H\n\nB'],
  ])('inverts %j', (exported, source) => {
    expect(docTextFromExport(exported)).toBe(source);
  });
});

describe('rewriteRunState', () => {
  const r = rewriteRunState(TARGET_RS, map, LABEL);

  it('rewrites changed phase keys whole (arrays included) and notes the narrative', () => {
    expect(r.changed).toEqual(['phases.commcare-setup.status_note', 'phases.commcare-setup.residuals']);
    const cs = r.patch.phases!['commcare-setup'] as any;
    expect(cs.status_note).toContain('deployed to connect-ace-spark, released (Learn v1, Deliver v1)');
    expect(cs.status_note).toContain('[Copied into the spark workspace for review');
    expect(cs.residuals).toHaveLength(2);
    expect(cs.residuals[0].where_to_apply).toContain('7c34a5505182408c99c537b97fe3e56b');
  });

  it('leaves the kept Phase 8 block and the clone record alone, and reports Phase 8', () => {
    expect(r.patch.phases!['solicitation-management']).toBeUndefined();
    expect((r.patch as any).clone).toBeUndefined();
    expect(r.skippedWithRefs).toEqual(['phases.solicitation-management']);
  });
});
