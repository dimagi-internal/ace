/**
 * ace#3251 — the Phase 7 cascade path (ace-run provider) never wrote the two
 * build-half products the artifact manifest requires:
 * `7-synthetic/demo-data-setup_manifest.yaml` and `7-synthetic/dashboard-terms.yaml`.
 * connect-fi/20261018-1440 archived five per-partner manifests under
 * `7-synthetic/cascade-build/` and no dashboard-terms at all; demo-data-setup-qa
 * passed 10/10, and the gap surfaced only at Phase 7 finalize
 * (`verify_phase_artifacts`: 7/10 required found) after the DDD loop.
 *
 * These pin (1) that the cascade's produced artifact set covers every REQUIRED
 * manifest row `demo-data-setup` owns, (2) the two builders, and (3) the QA
 * check that fails at build time when either file is absent.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest';
import {
  CASCADE_BUILD_ARCHIVE_DIR,
  CASCADE_DASHBOARD_TERMS_PATH,
  CASCADE_MANIFEST_INDEX_PATH,
  CASCADE_PRODUCED_ARTIFACTS,
  buildCascadeDashboardTerms,
  buildCascadeManifestIndex,
  checkCascadeBuildArtifacts,
  partnerManifestPath,
} from '../../lib/cascade-build-artifacts';
import { checkCoinedTerms } from '../../lib/demo-frame-legibility';
import { checksForProvider, type CascadeBlock } from '../../skills/demo-data-setup-qa/checks';

const FIX = join(__dirname, '../fixtures/cascade');
const registry = JSON.parse(readFileSync(join(FIX, 'spark-facilitator-registry.json'), 'utf8')) as unknown;

// The connect-fi/20261018-1440 shape: five partners on labs-only opps.
const cascade: CascadeBlock = {
  registry: { registry_id: 9001, indicators: ['SF_P1', 'SF_S1'] },
  program_id: 10500,
  partners: [
    { label: 'Akwap Farmers Trust (example)', opportunity_id: 10500 },
    { label: 'Apedor Growers Network (example)', opportunity_id: 10501 },
    { label: 'Aturo Women\'s Forum (example)', opportunity_id: 10502 },
    { label: 'Ekisil Development Group (example)', opportunity_id: 10503 },
    { label: 'Ngikaala Outreach (example)', opportunity_id: 10504 },
  ],
  programme_report: { workflow_id: 7001, run_id: 7100, url: 'u' },
  opp_reports: [
    { partner: 'Akwap Farmers Trust (example)', opportunity_id: 10500, workflow_id: 7010 },
  ],
  history: { run_ids: [7090, 7100], first_period_end: '2026-07-12', last_period_end: '2026-10-04' },
};

describe('the cascade produces every required demo-data-setup artifact (ace#3251)', () => {
  it('CASCADE_PRODUCED_ARTIFACTS covers every required phase-7 manifest row demo-data-setup owns', () => {
    const required = ARTIFACT_MANIFEST.filter(
      (a) => a.phase === 'synthetic-data-and-workflows' && a.producedBy === 'demo-data-setup' && a.required,
    ).map((a) => a.path);
    expect(required).toContain(CASCADE_MANIFEST_INDEX_PATH);
    expect(required).toContain(CASCADE_DASHBOARD_TERMS_PATH);
    const missing = required.filter((p) => !CASCADE_PRODUCED_ARTIFACTS.includes(p));
    expect(missing).toEqual([]);
  });

  it('the skill § C7 names both files as cascade steps, not a passing sentence', () => {
    const skill = readFileSync(join(__dirname, '../../skills/demo-data-setup/SKILL.md'), 'utf8');
    const cascadeSection = skill.slice(skill.indexOf('**C7. Handoff.**'));
    expect(cascadeSection).toContain('scripts/cascade-build-artifacts.ts');
    expect(cascadeSection).toContain(CASCADE_MANIFEST_INDEX_PATH);
    expect(cascadeSection).toContain(CASCADE_DASHBOARD_TERMS_PATH);
  });

  it('demo-data-setup-qa runs the artifact check for the ace-run provider', () => {
    expect(checksForProvider('ace-run')).toContain('cascade_build_artifacts_written');
  });
});

describe('buildCascadeManifestIndex', () => {
  it('indexes one archived manifest per partner under cascade-build/', () => {
    const idx = buildCascadeManifestIndex(cascade);
    expect(idx.provider).toBe('ace-run');
    expect(idx.partners).toHaveLength(5);
    for (const p of idx.partners) expect(p.manifest.startsWith(`${CASCADE_BUILD_ARCHIVE_DIR}/`)).toBe(true);
    expect(idx.partners[0]).toMatchObject({ opportunity_id: 10500, manifest: '7-synthetic/cascade-build/manifest_akwap-farmers-trust.yaml' });
    expect(idx.timeline).toEqual({ first_period_end: '2026-07-12', last_period_end: '2026-10-04', weeks: 13 });
    expect(idx.groups).toBe(5);
  });

  it('keeps a manifest path the run already recorded on the partner', () => {
    const c: CascadeBlock = { ...cascade, partners: [{ label: 'Akwap', opportunity_id: 10500, manifest: '7-synthetic/cascade-build/manifest_akwap.yaml' }] };
    expect(buildCascadeManifestIndex(c).partners[0].manifest).toBe('7-synthetic/cascade-build/manifest_akwap.yaml');
  });

  it('partnerManifestPath drops the (example) marker and slugs the label', () => {
    expect(partnerManifestPath("Tsogolo Women's Forum (example)")).toBe('7-synthetic/cascade-build/manifest_tsogolo-women-s-forum.yaml');
  });
});

describe('buildCascadeDashboardTerms', () => {
  it('enumerates every indicator label as a column header on each report, defined at point of use', () => {
    const terms = buildCascadeDashboardTerms(registry, ['programme_report', 'worker_review']);
    expect(terms.dashboards.map((d) => d.key)).toEqual(['programme_report', 'worker_review']);
    const labels = terms.dashboards[0].terms.map((t) => t.label);
    expect(labels).toContain('Meeting regularity');
    expect(labels).toHaveLength(10);
    // Every Spark indicator carries `meta.plain`, so the definitions popup reaches every label.
    expect(checkCoinedTerms(terms.dashboards[0].terms, terms.dashboards[0].definitions).pass).toBe(true);
  });

  it('records no definition for an indicator with no plain sentence, so check 15 can fail it', () => {
    const r = JSON.parse(JSON.stringify(registry)) as { indicators_doc: { measures: Array<{ meta?: { plain?: string } }> } };
    for (const m of r.indicators_doc.measures) if (m.meta) delete m.meta.plain;
    const terms = buildCascadeDashboardTerms(r, ['programme_report']);
    expect(terms.dashboards[0].definitions).toEqual([]);
    expect(checkCoinedTerms(terms.dashboards[0].terms, terms.dashboards[0].definitions).pass).toBe(false);
  });
});

describe('checkCascadeBuildArtifacts — fails at build time, not at finalize', () => {
  const index = buildCascadeManifestIndex(cascade);
  const terms = buildCascadeDashboardTerms(registry, ['programme_report']);

  it('passes when both files exist and the index covers every partner', () => {
    const r = checkCascadeBuildArtifacts({ manifestIndex: index, dashboardTerms: terms, cascade });
    expect(r.pass).toBe(true);
  });

  it('fails the connect-fi/20261018-1440 shape: neither file written', () => {
    const r = checkCascadeBuildArtifacts({ manifestIndex: null, dashboardTerms: null, cascade });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain(CASCADE_MANIFEST_INDEX_PATH);
    expect(r.detail).toContain(CASCADE_DASHBOARD_TERMS_PATH);
    expect(r.auto_fix_hint).toContain('scripts/cascade-build-artifacts.ts');
  });

  it('fails an index missing a partner, and a terms file with no dashboards', () => {
    const short = { ...index, partners: index.partners.slice(0, 4) };
    const r1 = checkCascadeBuildArtifacts({ manifestIndex: short, dashboardTerms: terms, cascade });
    expect(r1.pass).toBe(false);
    expect(r1.detail).toMatch(/10504/);
    const r2 = checkCascadeBuildArtifacts({ manifestIndex: index, dashboardTerms: { dashboards: [] }, cascade });
    expect(r2.pass).toBe(false);
  });

  it('fails an index entry archived outside cascade-build/', () => {
    const bad = { ...index, partners: [{ ...index.partners[0], manifest: '7-synthetic/manifest.yaml' }, ...index.partners.slice(1)] };
    expect(checkCascadeBuildArtifacts({ manifestIndex: bad, dashboardTerms: terms, cascade }).pass).toBe(false);
  });
});
