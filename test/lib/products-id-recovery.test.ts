import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest';
import { validatePhaseProductsFragment } from '../../lib/phase-products-schema';
import {
  PRODUCT_ID_SOURCES,
  declaredSourcePaths,
  recoverProductIds,
} from '../../lib/products-id-recovery';

/**
 * ace#2412 — external ids are rebuilt from DECLARED frontmatter, never a scan.
 * Repro: `poverty-graduation/20260915-1518`, Phase 3 killed mid-phase with two
 * Nova apps built and `phases.commcare-setup.products: null`.
 */

const REPO = join(__dirname, '..', '..');
const T002 = join(REPO, 'test', 'fixtures', 'ACE-Test-002', '3-commcare');
const read = (f: string) => readFileSync(join(T002, f), 'utf8');
const LEARN = '3-commcare/pdd-to-learn-app_summary.md';
const DELIVER = '3-commcare/pdd-to-deliver-app_summary.md';
const DEPLOY = '3-commcare/app-deploy_summary.md';

describe('PRODUCT_ID_SOURCES is pinned to the manifest', () => {
  it('every source artifact is a manifest entry whose description declares the field', () => {
    for (const [phase, sources] of Object.entries(PRODUCT_ID_SOURCES)) {
      for (const s of sources) {
        const entry = ARTIFACT_MANIFEST.find((a) => a.path === s.artifact);
        expect(entry, `${phase}: ${s.artifact} not in the manifest`).toBeDefined();
        expect(entry!.description, `${s.artifact} must declare frontmatter \`${s.field}\``).toMatch(
          new RegExp(`Required frontmatter:[^.]*\`${s.field}\``),
        );
      }
    }
  });

  it('every productKey is a key the phase products schema accepts', () => {
    for (const [phase, sources] of Object.entries(PRODUCT_ID_SOURCES)) {
      const r = recoverProductIds({
        phase,
        products: null,
        artifacts: Object.fromEntries(
          declaredSourcePaths(phase).map((p) => [
            p,
            `---\n${sources.filter((s) => s.artifact === p).map((s) => `${s.field}: x-${s.field}`).join('\n')}\n---\n`,
          ]),
        ),
      });
      if (r.status !== 'ok') throw new Error(JSON.stringify(r));
      expect(r.recovered).toHaveLength(sources.length);
      expect(validatePhaseProductsFragment(phase, r.patch).issues).toEqual([]);
    }
  });

  it('the caller is told exactly which files to fetch — the declared ones, nothing else', () => {
    expect(declaredSourcePaths('commcare-setup').sort()).toEqual([DEPLOY, DELIVER, LEARN].sort());
    expect(declaredSourcePaths('connect-setup')).toEqual([]);
  });
});

describe('recoverProductIds', () => {
  it('POSITIVE CONTROL: the 20260915-1518 shape — products null, both app summaries written — recovers both Nova ids', () => {
    const r = recoverProductIds({
      phase: 'commcare-setup',
      products: null,
      artifacts: { [LEARN]: read('pdd-to-learn-app_summary.md'), [DELIVER]: read('pdd-to-deliver-app_summary.md') },
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.patch).toEqual({
      apps: { learn: { nova_app_id: 'LRN-TEST002-SYN-0001' }, deliver: { nova_app_id: 'DEL-TEST002-SYN-0001' } },
    });
    expect(r.noEvidence.map((n) => n.productKey).sort()).toEqual(['apps.deliver.hq_app_id', 'apps.learn.hq_app_id']);
  });

  it('NEGATIVE CONTROL: a declared source with no frontmatter HALTS (captured pre-contract app-deploy_summary)', () => {
    const r = recoverProductIds({ phase: 'commcare-setup', products: null, artifacts: { [DEPLOY]: read('app-deploy_summary.md') } });
    expect(r.status).toBe('halt');
    if (r.status !== 'halt') return;
    expect(r.problems.map((p) => [p.productKey, p.problem])).toEqual([
      ['apps.learn.hq_app_id', 'no-frontmatter'],
      ['apps.deliver.hq_app_id', 'no-frontmatter'],
    ]);
  });

  it('NEGATIVE CONTROL: frontmatter without the declared field HALTS rather than guessing', () => {
    const noId = read('pdd-to-learn-app_summary.md').replace(/^nova_app_id: .*\n/m, '');
    const r = recoverProductIds({ phase: 'commcare-setup', products: null, artifacts: { [LEARN]: noId } });
    expect(r.status).toBe('halt');
    if (r.status === 'halt') expect(r.problems[0].problem).toBe('field-missing');
  });

  it('NEGATIVE CONTROL: an artifact that disagrees with a recorded id HALTS', () => {
    const r = recoverProductIds({
      phase: 'commcare-setup',
      products: { apps: { learn: { nova_app_id: 'some-other-app' } } },
      artifacts: { [LEARN]: read('pdd-to-learn-app_summary.md') },
    });
    expect(r.status).toBe('halt');
    if (r.status === 'halt') expect(r.problems[0].problem).toBe('conflict');
  });

  it('an id products already records is left alone', () => {
    const r = recoverProductIds({
      phase: 'commcare-setup',
      products: { apps: { learn: { nova_app_id: 'LRN-TEST002-SYN-0001' } } },
      artifacts: { [LEARN]: read('pdd-to-learn-app_summary.md') },
    });
    if (r.status !== 'ok') throw new Error(r.status);
    expect(r.alreadyRecorded).toEqual(['apps.learn.nova_app_id']);
    expect(r.patch).toEqual({});
  });

  it('nothing on disk and nothing recorded is "no evidence", not a recovery', () => {
    const r = recoverProductIds({ phase: 'commcare-setup', products: undefined, artifacts: {} });
    if (r.status !== 'ok') throw new Error(r.status);
    expect(r.recovered).toEqual([]);
    expect(r.noEvidence).toHaveLength(4);
  });

  it('a phase with no declared sources is UNABLE, never ok', () => {
    expect(recoverProductIds({ phase: 'connect-setup', products: null, artifacts: {} }).status).toBe('unable');
  });
});

describe('orchestrator Step 2a calls the recovery before reading "no app ids" as "built nothing"', () => {
  it('names scripts/recover-product-ids.ts in the commcare-setup principal branch', () => {
    const doc = readFileSync(join(REPO, 'agents', 'ace-orchestrator.md'), 'utf8');
    const step2a = doc.slice(doc.indexOf('**Step 2a — Assert the atoms actually resolved'), doc.indexOf('On a miss, halt with the same `[BLOCKER]` shape'));
    expect(step2a).toContain('scripts/recover-product-ids.ts');
  });
});
