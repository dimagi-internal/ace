/**
 * lib/clone-labs-rebuild.ts — the pure half of clone-to-new-workspace § 4c
 * (ace#3020): rebuild Phase 7 Labs in the clone's own program, then rewrite the
 * target run's products.synthetic to the new ids.
 */
import { describe, expect, it } from 'vitest';
import {
  labsIdsIn,
  labsRebuildSource,
  missingWorkspaceLlos,
  remapSyntheticProducts,
} from '../../lib/clone-labs-rebuild';

// Shape copied from noora-health/20261015-1129 run_state (2026-10-16), trimmed.
const synthetic = {
  provider: 'ace-run',
  labs_opp_id: 10137,
  cascade: {
    program_id: 10137,
    partners: [
      { label: 'Kulawa Newborn Trust (example)', opportunity_id: 10137 },
      { label: "Tallafi Mothers' Network (example)", opportunity_id: 10138 },
    ],
    registry: { registry_id: 9684, program_id: 10137, version: 2 },
    programme_report: { workflow_id: 9686, run_id: 9806, url: 'https://labs.connect.dimagi.com/labs/workflow/9686/run/?run_id=9806&program_id=10137' },
    worker_review: { workflow_id: 9688, run_id: 9690 },
    cohort_id: 13,
    visits_pipeline_id: 9685,
    opp_reports: [
      { partner: 'Kulawa', opportunity_id: 10137, workflow_id: 9691, run_id: 9808, url: 'https://labs.connect.dimagi.com/labs/workflow/9691/run/?run_id=9808&opportunity_id=10137' },
      { partner: 'Tallafi', opportunity_id: 10138, workflow_id: 9693, run_id: 9809, url: 'https://labs.connect.dimagi.com/labs/workflow/9693/run/?run_id=9809&opportunity_id=10138' },
    ],
    history: { run_ids: [9701, 9806] },
    benchmark_publications: { cohort_id: 13, first: 274, last: 289 },
  },
  workflows: {
    worker_review: { workflow_id: 9688, run_url: 'https://labs.connect.dimagi.com/labs/workflow/9688/run/?run_id=9690&program_id=10137&flw=10138%3A%3Aedu_ta05&source_run=9806' },
  },
  source: { labs_synthetic_opp_id: 10137, record_counts: { user_visits: { '10137': 645, '10138': 625 }, total_visits: 1270 } },
};
const runState = { phases: { 'synthetic-data-and-workflows': { products: { synthetic } } } };

const MAP: Record<number, number> = {
  10137: 10300, 10138: 10301, 9684: 9900, 9686: 9902, 9806: 9950, 9688: 9904, 9690: 9905, 13: 21, 9685: 9901,
  9691: 9906, 9808: 9951, 9693: 9908, 9809: 9952, 9701: 9940, 274: 300, 289: 315,
};

describe('labsRebuildSource', () => {
  it('reads the partners, program and what Phase 7 built', () => {
    expect(labsRebuildSource(runState)).toEqual({
      program_id: 10137,
      partners: [
        { label: 'Kulawa Newborn Trust (example)', source_opportunity_id: 10137 },
        { label: "Tallafi Mothers' Network (example)", source_opportunity_id: 10138 },
      ],
      registry_id: 9684, has_programme_report: true, opp_report_count: 2, history_runs: 2, has_benchmarks: true,
    });
  });
  it('refuses a run with no cascade — nothing to rebuild, never a guess', () => {
    expect(() => labsRebuildSource({ phases: {} })).toThrow(/not an ace-run cascade/);
  });
});

describe('remapSyntheticProducts', () => {
  it('rewrites every id, URL and id-keyed map, leaving no source id behind', () => {
    const { products, leftover } = remapSyntheticProducts(synthetic, MAP);
    expect(leftover).toEqual([]);
    const p = products as typeof synthetic;
    expect(p.cascade.partners.map((x) => x.opportunity_id)).toEqual([10300, 10301]);
    expect(p.cascade.programme_report.url).toBe('https://labs.connect.dimagi.com/labs/workflow/9902/run/?run_id=9950&program_id=10300');
    expect(p.workflows.worker_review.run_url).toBe('https://labs.connect.dimagi.com/labs/workflow/9904/run/?run_id=9905&program_id=10300&flw=10301%3A%3Aedu_ta05&source_run=9950');
    expect(p.source.record_counts.user_visits).toEqual({ '10300': 645, '10301': 625 });
    expect(p.source.record_counts.total_visits).toBe(1270); // a count, not an id
    expect(p.cascade.partners[0].label).toBe('Kulawa Newborn Trust (example)');
  });
  it('names every source id a partial map leaves behind', () => {
    const partial = { ...MAP };
    delete partial[9809];
    delete partial[289];
    expect(remapSyntheticProducts(synthetic, partial).leftover).toEqual([289, 9809]);
  });
  it('labsIdsIn finds ids in values, keys and URLs', () => {
    const ids = labsIdsIn(synthetic);
    for (const id of [10137, 10138, 9684, 9686, 9806, 9690, 13, 274, 289]) expect(ids.has(id), String(id)).toBe(true);
    expect(ids.has(645)).toBe(false);
  });
});

describe('a copied registry', () => {
  it("retargets deployment.llo_map (keyed by partner opp id) — live shape of registry 9684", () => {
    const reg = { indicators_doc: { NH_M1: { threshold: 0.8 } }, deployment: { version: 1, llo_map: { '10137': 'Kulawa Newborn Trust (example)', '10138': "Tallafi Mothers' Network (example)" } } };
    const { products, leftover } = remapSyntheticProducts(reg, MAP);
    expect(leftover).toEqual([]);
    expect((products as typeof reg).deployment.llo_map).toEqual({ '10300': 'Kulawa Newborn Trust (example)', '10301': "Tallafi Mothers' Network (example)" });
    expect((products as typeof reg).indicators_doc).toEqual(reg.indicators_doc);
  });
});

describe('missingWorkspaceLlos', () => {
  it('names the Connect orgs the rebuilt workspace does not list as LLOs', () => {
    expect(missingWorkspaceLlos({ workspace: { llos: ['noora-health-nm-test'] } }, ['noora-health-nm-test', 'noora-health-pm-test', null])).toEqual(['noora-health-pm-test']);
    expect(missingWorkspaceLlos({ workspace: { llos: ['A', 'b'] } }, ['a', 'B'])).toEqual([]);
  });
});
