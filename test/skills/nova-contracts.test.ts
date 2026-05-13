/**
 * Contract tests for the Nova-plugin migration (2026-04-27).
 *
 * The three skills that drive CommCare app generation + deploy
 * (`pdd-to-learn-app`, `pdd-to-deliver-app`, `app-deploy`) were rewritten
 * to invoke the Nova plugin's slash commands instead of a manual
 * Nova-UI / HQ-UI handoff.
 *
 * Originally this file also contained 15 regex-on-prose tests against
 * SKILL.md and .env.tpl files (e.g. `expect(body).toMatch(/\/nova:autobuild/)`).
 * Those were dropped 2026-05-09 after a /canopy:test-audit pass:
 *   - Brittle to meaning-preserving rewords (renaming "invokes" to "calls"
 *     would break the test without changing skill behavior)
 *   - Vacuous when over-specific (3 "does not retain Current Workaround"
 *     post-migration scarecrows that pass forever once removed)
 *   - Don't actually exercise the skill at runtime
 * Skill-prose drift would surface in real usage instead. If a CI signal
 * is wanted back, prefer end-to-end skill exercise over text-grep.
 *
 * What remains: tests against ARTIFACT_MANIFEST data structure, and
 * fixture-frontmatter shape tests — both validate concrete contracts the
 * runtime depends on, not editorial choices in skill prose.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_MANIFEST,
  artifactsConsumedBy,
  artifactsProducedBy,
} from '../../lib/artifact-manifest.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('Nova-plugin migration: artifact manifest reflects new contract', () => {
  it('snapshot JSON paths (now under 3-commcare/) are optional (Nova owns app storage)', () => {
    const learnSnap = ARTIFACT_MANIFEST.find((a) => a.path === '3-commcare/pdd-to-learn-app_snapshot.json');
    const deliverSnap = ARTIFACT_MANIFEST.find((a) => a.path === '3-commcare/pdd-to-deliver-app_snapshot.json');
    expect(learnSnap?.required).toBe(false);
    expect(deliverSnap?.required).toBe(false);
    // No skill should consume the JSON snapshots — the canonical handle
    // is `nova_app_id` in the summary, which app-deploy reads.
    expect(learnSnap?.consumedBy).toEqual([]);
    expect(deliverSnap?.consumedBy).toEqual([]);
  });

  it('app-deploy now consumes the app summaries (not the JSON snapshots)', () => {
    const consumed = artifactsConsumedBy('app-deploy').map((a) => a.path);
    expect(consumed).toContain('3-commcare/pdd-to-learn-app_summary.md');
    expect(consumed).toContain('3-commcare/pdd-to-deliver-app_summary.md');
    expect(consumed).not.toContain('3-commcare/pdd-to-learn-app_snapshot.json');
    expect(consumed).not.toContain('3-commcare/pdd-to-deliver-app_snapshot.json');
  });

  it('pdd-to-learn-app and pdd-to-deliver-app still produce the (now-optional) snapshots', () => {
    // The skills can choose to write the snapshot via `/nova:show` if the
    // operator wants an audit trail; the manifest still names the producer
    // so the path doesn't become orphan if it does land on disk.
    expect(artifactsProducedBy('pdd-to-learn-app').map((a) => a.path))
      .toContain('3-commcare/pdd-to-learn-app_snapshot.json');
    expect(artifactsProducedBy('pdd-to-deliver-app').map((a) => a.path))
      .toContain('3-commcare/pdd-to-deliver-app_snapshot.json');
  });
});

describe('Nova-plugin migration: app-summary fixtures carry nova_app_id frontmatter', () => {
  const fixtures = ['CRISPR-Test-001', 'CRISPR-Test-002'];
  const summaryFiles = [
    '3-commcare/pdd-to-learn-app_summary.md',
    '3-commcare/pdd-to-deliver-app_summary.md',
  ];

  for (const fixture of fixtures) {
    for (const summary of summaryFiles) {
      it(`${fixture}/${summary} declares nova_app_id and archetype`, () => {
        const fp = path.join(REPO_ROOT, 'test/fixtures', fixture, summary);
        const body = fs.readFileSync(fp, 'utf-8');
        // YAML frontmatter must be at the top
        expect(body).toMatch(/^---\n/);
        expect(body).toMatch(/^nova_app_id:\s*\S+/m);
        expect(body).toMatch(/^nova_app_url:\s*https:\/\/commcare\.app\/apps\//m);
        expect(body).toMatch(/^archetype:\s*(atomic-visit|focus-group|multi-stage)\s*$/m);
      });
    }
  }

  // Extra contract just for deliver summaries: delivery_unit must be set
  for (const fixture of fixtures) {
    it(`${fixture}/3-commcare/pdd-to-deliver-app_summary.md declares delivery_unit`, () => {
      const fp = path.join(REPO_ROOT, 'test/fixtures', fixture, '3-commcare/pdd-to-deliver-app_summary.md');
      const body = fs.readFileSync(fp, 'utf-8');
      expect(body).toMatch(/^delivery_unit:\s*\S+/m);
    });
  }
});
