/**
 * The two build-half products the Phase 7 cascade (ace-run provider) owes the
 * artifact manifest — and the QA check that fails when either is absent
 * (ace#3251).
 *
 * `lib/artifact-manifest.ts` requires `7-synthetic/demo-data-setup_manifest.yaml`
 * and `7-synthetic/dashboard-terms.yaml` from `demo-data-setup`. The cascade
 * path sends one generator manifest PER PARTNER and archived them under
 * `7-synthetic/cascade-build/`, so the single required path was never written;
 * `dashboard-terms.yaml` was one sentence of prose in § C7 with no step behind
 * it. On connect-fi/20261018-1440 `demo-data-setup-qa` passed 10/10 and Phase 7
 * finalize then found 7/10 required artifacts — after the hours-long DDD loop.
 *
 * So the cascade now WRITES both (via `scripts/cascade-build-artifacts.ts`):
 *
 * - `demo-data-setup_manifest.yaml` — an INDEX of the per-partner manifests:
 *   which opportunity each was sent to and where its sent bytes are archived,
 *   plus the timeline span and partner count (`lib/ddd-scene-actions.ts`
 *   reads `periods` / `groups` from this file).
 * - `dashboard-terms.yaml` — step 3d's enumeration, derived from the registry:
 *   every indicator label is a column header on each report, defined at point
 *   of use by the definitions popup IFF the indicator carries a `meta.plain`
 *   sentence (no sentence → no definition recorded, so check 15 can fail it).
 *
 * And `demo-data-setup-qa` check 29 (`cascade_build_artifacts_written`) fails
 * the build when either is missing, so the gap surfaces before the hand-off.
 */

import type { QACheckResult } from './qa-types';
import type { DashboardTerm, TermDefinition } from './demo-frame-legibility';
import { indicatorsDocOf } from './registry-display-text';

export const CASCADE_MANIFEST_INDEX_PATH = '7-synthetic/demo-data-setup_manifest.yaml';
export const CASCADE_DASHBOARD_TERMS_PATH = '7-synthetic/dashboard-terms.yaml';
export const CASCADE_BUILD_ARCHIVE_DIR = '7-synthetic/cascade-build';

/**
 * Every Phase 7 path the cascade path of `demo-data-setup` writes. Pinned by
 * `test/lib/cascade-build-artifacts.test.ts` against every REQUIRED manifest
 * row `demo-data-setup` owns, so a new required row fails CI until the cascade
 * produces it too.
 */
export const CASCADE_PRODUCED_ARTIFACTS: readonly string[] = [
  '7-synthetic/cascade-story.yaml',
  '7-synthetic/realized.json',
  CASCADE_MANIFEST_INDEX_PATH,
  CASCADE_DASHBOARD_TERMS_PATH,
];

/** The structural slice of `products.synthetic.cascade` these builders read. */
export interface CascadeArtifactsInput {
  registry?: { registry_id?: number };
  program_id?: number;
  partners?: Array<{ label?: string; opportunity_id?: number; manifest?: string }>;
  history?: { first_period_end?: string; last_period_end?: string };
}

export interface CascadeManifestIndex {
  provider: 'ace-run';
  kind: 'cascade-manifest-index';
  program_id: number | null;
  registry_id: number | null;
  /** Number of partner opportunities — the `groups` axis of a dataset shape. */
  groups: number;
  timeline: { first_period_end: string; last_period_end: string; weeks: number } | null;
  partners: Array<{ label: string; opportunity_id: number | null; manifest: string }>;
}

export interface DashboardTermsFile {
  dashboards: Array<{ key: string; terms: DashboardTerm[]; definitions: TermDefinition[] }>;
}

/** Where a partner's sent manifest is archived: `7-synthetic/cascade-build/manifest_<slug>.yaml`. */
export function partnerManifestPath(label: string): string {
  const slug = label
    .replace(/\(example\)/gi, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${CASCADE_BUILD_ARCHIVE_DIR}/manifest_${slug || 'partner'}.yaml`;
}

function weeksBetween(first: string, last: string): number | null {
  const a = Date.parse(`${first}T00:00:00Z`);
  const b = Date.parse(`${last}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / (7 * 86_400_000)) + 1;
}

export function buildCascadeManifestIndex(cascade: CascadeArtifactsInput): CascadeManifestIndex {
  const partners = (cascade.partners ?? []).map((p) => ({
    label: p.label ?? String(p.opportunity_id ?? ''),
    opportunity_id: typeof p.opportunity_id === 'number' ? p.opportunity_id : null,
    manifest: p.manifest ?? partnerManifestPath(p.label ?? String(p.opportunity_id ?? '')),
  }));
  const first = cascade.history?.first_period_end;
  const last = cascade.history?.last_period_end;
  const weeks = first && last ? weeksBetween(first, last) : null;
  return {
    provider: 'ace-run',
    kind: 'cascade-manifest-index',
    program_id: cascade.program_id ?? null,
    registry_id: cascade.registry?.registry_id ?? null,
    groups: partners.length,
    timeline: first && last && weeks ? { first_period_end: first, last_period_end: last, weeks } : null,
    partners,
  };
}

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Step 3d for the cascade, from the registry: each indicator `meta.label` is a
 * column header on every report; each visit flag `label` is a column on the
 * visit tables. A definition is recorded only where the page has one to show
 * from the label — an indicator's `meta.plain` (the definitions popup on the
 * header) or a flag's `description`.
 */
export function buildCascadeDashboardTerms(registry: unknown, dashboardKeys: readonly string[]): DashboardTermsFile {
  const doc = indicatorsDocOf(registry) ?? asObj(registry);
  const terms: DashboardTerm[] = [];
  const definitions: TermDefinition[] = [];
  for (const m of asArr(doc.measures)) {
    const meta = asObj(asObj(m).meta);
    const label = str(meta.label);
    if (!meta.indicator || !label) continue;
    terms.push({ label, surface: 'column header', prominent: true });
    if (str(meta.plain)) {
      definitions.push({ term: label, at_point_of_use: true, where: 'indicator definitions popup on the column header' });
    }
  }
  for (const f of asArr(asObj(doc.display).visit_flags)) {
    const label = str(asObj(f).label);
    if (!label) continue;
    terms.push({ label, surface: 'visit flag column', prominent: false });
    if (str(asObj(f).description)) {
      definitions.push({ term: label, at_point_of_use: true, where: 'flag description on the column header' });
    }
  }
  return { dashboards: dashboardKeys.map((key) => ({ key, terms: [...terms], definitions: [...definitions] })) };
}

/**
 * Check 29 — both build-half artifacts exist, and the index covers every
 * partner opportunity with a manifest archived under `cascade-build/`.
 * A null input means the file was not supplied / not found: a FAIL.
 */
export function checkCascadeBuildArtifacts(input: {
  manifestIndex: unknown;
  dashboardTerms: unknown;
  cascade: CascadeArtifactsInput | null | undefined;
}): QACheckResult {
  const problems: string[] = [];
  const idx = input.manifestIndex == null ? null : asObj(input.manifestIndex);
  if (!idx) {
    problems.push(`${CASCADE_MANIFEST_INDEX_PATH} is missing`);
  } else {
    const entries = asArr(idx.partners).map(asObj);
    if (entries.length === 0) problems.push(`${CASCADE_MANIFEST_INDEX_PATH} lists no partner manifests`);
    for (const e of entries) {
      const m = str(e.manifest);
      if (!m || !m.startsWith(`${CASCADE_BUILD_ARCHIVE_DIR}/`)) {
        problems.push(`index entry ${String(e.label ?? e.opportunity_id)} has no manifest under ${CASCADE_BUILD_ARCHIVE_DIR}/`);
      }
    }
    const indexed = new Set(entries.map((e) => e.opportunity_id));
    for (const p of input.cascade?.partners ?? []) {
      if (!indexed.has(p.opportunity_id)) problems.push(`partner ${p.label ?? '?'} (opportunity ${p.opportunity_id}) is not in the manifest index`);
    }
  }
  const terms = input.dashboardTerms == null ? null : asObj(input.dashboardTerms);
  if (!terms) {
    problems.push(`${CASCADE_DASHBOARD_TERMS_PATH} is missing`);
  } else {
    const dashboards = asArr(terms.dashboards).map(asObj);
    if (dashboards.length === 0) problems.push(`${CASCADE_DASHBOARD_TERMS_PATH} enumerates no dashboards`);
    for (const d of dashboards) {
      if (!Array.isArray(d.terms)) problems.push(`dashboard ${String(d.key ?? '?')} has no terms list (an empty list is a legitimate answer; an omitted one is not)`);
    }
  }
  if (problems.length === 0) {
    const n = asArr(idx?.partners).length;
    const d = asArr(terms?.dashboards).length;
    return { pass: true, detail: `manifest index lists ${n} partner manifest(s); dashboard-terms enumerates ${d} dashboard(s)` };
  }
  return {
    pass: false,
    detail: problems.join('; '),
    auto_fix_hint:
      'write both with scripts/cascade-build-artifacts.ts --run-state <run_state.yaml> --registry <registry.json> ' +
      '--out-dir <dir>, archive each partner manifest at the path the index names, and upload both to 7-synthetic/ ' +
      '(demo-data-setup § C7); Phase 7 cannot reach status: done without them',
  };
}
