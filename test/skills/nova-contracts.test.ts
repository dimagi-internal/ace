/**
 * Contract tests for the Nova-plugin migration (2026-04-27).
 *
 * The three skills that drive CommCare app generation + deploy
 * (`pdd-to-learn-app`, `pdd-to-deliver-app`, `app-deploy`) were rewritten
 * to invoke the Nova plugin's slash commands instead of a manual
 * Nova-UI / HQ-UI handoff. These tests pin the new contract so a
 * future edit can't silently regress to the workaround flow.
 *
 * They also pin the `.env.tpl` and app-summary fixtures the new flow
 * depends on: `ACE_HQ_DOMAIN` for `app-deploy`'s pre-flight, and
 * `nova_app_id` frontmatter in every `app-summaries/*.md` fixture.
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

function readSkill(name: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'skills', name, 'SKILL.md'), 'utf-8');
}

function readEnvTemplate(): string {
  return fs.readFileSync(path.join(REPO_ROOT, '.env.tpl'), 'utf-8');
}

describe('Nova-plugin migration: skill contracts', () => {
  describe('pdd-to-learn-app', () => {
    const body = readSkill('pdd-to-learn-app');

    it('invokes /nova:autobuild', () => {
      expect(body).toMatch(/\/nova:autobuild/);
    });

    it('does not retain the pre-Nova "Current Workaround" section', () => {
      expect(body).not.toMatch(/##\s*Current Workaround/);
    });

    it('records nova_app_id and nova_app_url in the summary frontmatter contract', () => {
      expect(body).toMatch(/nova_app_id:/);
      expect(body).toMatch(/nova_app_url:/);
    });

    it('writes the app summary to GDrive', () => {
      expect(body).toMatch(/app-summaries\/learn-app-summary\.md/);
    });
  });

  describe('pdd-to-deliver-app', () => {
    const body = readSkill('pdd-to-deliver-app');

    it('invokes /nova:autobuild', () => {
      expect(body).toMatch(/\/nova:autobuild/);
    });

    it('does not retain the pre-Nova "Current Workaround" section', () => {
      expect(body).not.toMatch(/##\s*Current Workaround/);
    });

    it('records nova_app_id, nova_app_url, and delivery_unit in the summary frontmatter', () => {
      expect(body).toMatch(/nova_app_id:/);
      expect(body).toMatch(/nova_app_url:/);
      expect(body).toMatch(/delivery_unit:/);
    });

    it('writes the app summary to GDrive', () => {
      expect(body).toMatch(/app-summaries\/deliver-app-summary\.md/);
    });
  });

  describe('app-deploy', () => {
    const body = readSkill('app-deploy');

    it('invokes /nova:upload_to_hq', () => {
      expect(body).toMatch(/\/nova:upload_to_hq/);
    });

    it('does not retain the pre-Nova "Current Workaround" section', () => {
      expect(body).not.toMatch(/##\s*Current Workaround/);
    });

    it('reads nova_app_id from app summaries (not from apps/*.json)', () => {
      expect(body).toMatch(/nova_app_id/);
      // No instruction to read from the JSON snapshots — those are
      // optional historical artifacts, not inputs to the upload call.
      expect(body).not.toMatch(/Read app files .* apps\/learn-app\.json/);
    });

    it('pre-flights ACE_HQ_DOMAIN before calling Nova', () => {
      expect(body).toMatch(/ACE_HQ_DOMAIN/);
    });

    it('gate brief surfaces a domain-mismatch BLOCKER', () => {
      expect(body).toMatch(/BLOCKER.*domain/i);
    });
  });
});

describe('Nova-plugin migration: .env.tpl declares HQ pre-flight vars', () => {
  const env = readEnvTemplate();

  it('mentions ACE_HQ_DOMAIN (declared or documented; operator-set per deployment)', () => {
    expect(env).toMatch(/ACE_HQ_DOMAIN/);
  });

  it('declares ACE_HQ_BASE_URL pointing at the HQ origin', () => {
    expect(env).toMatch(/^ACE_HQ_BASE_URL=https:\/\/www\.commcarehq\.org\b/m);
  });

  it('does not commit a literal HQ project space (operator-specific value)', () => {
    // The committed template must not pin a particular HQ project space —
    // only the per-deployment `.env` (gitignored) should hold the value.
    expect(env).not.toMatch(/^ACE_HQ_DOMAIN=\S/m);
  });
});

describe('Nova-plugin migration: artifact manifest reflects new contract', () => {
  it('apps/*.json snapshots are now optional (Nova owns app storage)', () => {
    const learnSnap = ARTIFACT_MANIFEST.find((a) => a.path === 'apps/learn-app.json');
    const deliverSnap = ARTIFACT_MANIFEST.find((a) => a.path === 'apps/deliver-app.json');
    expect(learnSnap?.required).toBe(false);
    expect(deliverSnap?.required).toBe(false);
    // No skill should consume the JSON snapshots — the canonical handle
    // is `nova_app_id` in the summary, which app-deploy reads.
    expect(learnSnap?.consumedBy).toEqual([]);
    expect(deliverSnap?.consumedBy).toEqual([]);
  });

  it('app-deploy now consumes the app summaries (not the JSON snapshots)', () => {
    const consumed = artifactsConsumedBy('app-deploy').map((a) => a.path);
    expect(consumed).toContain('app-summaries/learn-app-summary.md');
    expect(consumed).toContain('app-summaries/deliver-app-summary.md');
    expect(consumed).not.toContain('apps/learn-app.json');
    expect(consumed).not.toContain('apps/deliver-app.json');
  });

  it('pdd-to-learn-app and pdd-to-deliver-app still produce the (now-optional) snapshots', () => {
    // The skills can choose to write the snapshot via `/nova:show` if the
    // operator wants an audit trail; the manifest still names the producer
    // so the path doesn't become orphan if it does land on disk.
    expect(artifactsProducedBy('pdd-to-learn-app').map((a) => a.path)).toContain('apps/learn-app.json');
    expect(artifactsProducedBy('pdd-to-deliver-app').map((a) => a.path)).toContain('apps/deliver-app.json');
  });
});

describe('Nova-plugin migration: app-summary fixtures carry nova_app_id frontmatter', () => {
  const fixtures = ['CRISPR-Test-001', 'CRISPR-Test-002', 'CRISPR-Test-003-Turmeric'];
  const summaryFiles = [
    'app-summaries/learn-app-summary.md',
    'app-summaries/deliver-app-summary.md',
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
    it(`${fixture}/app-summaries/deliver-app-summary.md declares delivery_unit`, () => {
      const fp = path.join(REPO_ROOT, 'test/fixtures', fixture, 'app-summaries/deliver-app-summary.md');
      const body = fs.readFileSync(fp, 'utf-8');
      expect(body).toMatch(/^delivery_unit:\s*\S+/m);
    });
  }
});
