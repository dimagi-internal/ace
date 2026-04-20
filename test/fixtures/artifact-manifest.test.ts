/**
 * Validates test fixtures against the canonical artifact manifest.
 *
 * Runs as part of the normal `npm test` suite (no OCS_INTEGRATION gate).
 * Catches drift between what the fixtures contain and what the manifest expects.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  validateFixture,
  artifactsConsumedBy,
  ARTIFACT_MANIFEST,
} from '../../lib/artifact-manifest.js';

const FIXTURES_DIR = path.resolve(import.meta.dirname, '.');

/** Recursively list all files in a directory, returning paths relative to root. */
function listFiles(dir: string, root: string = dir): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full, root));
    } else {
      files.push(path.relative(root, full));
    }
  }
  return files;
}

describe('artifact manifest', () => {
  it('manifest has no duplicate paths', () => {
    const paths = ARTIFACT_MANIFEST.map((a) => a.path);
    const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
    expect(dupes).toEqual([]);
  });

  it('has all six phases represented', () => {
    const phases = new Set(ARTIFACT_MANIFEST.map((a) => a.phase));
    expect(phases).toEqual(new Set(['design', 'commcare', 'connect', 'ocs', 'operate', 'closeout']));
  });

  it('every artifact has at least a producedBy', () => {
    for (const a of ARTIFACT_MANIFEST) {
      expect(a.producedBy, `${a.path} missing producedBy`).toBeTruthy();
    }
  });
});

describe('CRISPR-Test-001 fixture', () => {
  const fixtureDir = path.join(FIXTURES_DIR, 'CRISPR-Test-001');

  it('fixture directory exists', () => {
    expect(fs.existsSync(fixtureDir)).toBe(true);
  });

  it('has all files recognized by the manifest (no unexpected files)', () => {
    const files = listFiles(fixtureDir);
    const result = validateFixture(files, 'connect', ['README.md']);

    if (result.unexpected.length > 0) {
      console.log('Unexpected files:', result.unexpected);
    }
    expect(result.unexpected).toEqual([]);
  });

  it('reports expected missing files for this partial fixture', () => {
    // CRISPR-Test-001 provides inputs for ocs-agent-setup, not a complete
    // opportunity folder. These artifacts are intentionally absent:
    // test-prompts.md is consumed by ocs-chatbot-qa (not ocs-agent-setup);
    // apps + test-results live in Phase 2 and aren't needed for OCS config;
    // gate-briefs/* are produced during gate pauses that this fixture never
    // reached (state.yaml shows every phase as pending, so no skill has run).
    const expectedMissing = [
      'apps/learn-app.json',
      'apps/deliver-app.json',
      'test-prompts.md',
      'test-results/test-plan.md',
      'test-results/test-results.md',
      'test-results/bugs.md',
      'gate-briefs/idea-to-pdd.md',
      'gate-briefs/app-deploy.md',
      // gate-briefs/llo-invite.md moved to Phase 5 (operate) as of
      // 2026-04-20 — no longer required at the ``connect`` cutoff.
    ];
    const files = listFiles(fixtureDir);
    const result = validateFixture(files, 'connect', ['README.md']);
    expect(result.missing.sort()).toEqual(expectedMissing.sort());
  });

  it('has all inputs required by ocs-agent-setup', () => {
    // The fixture is designed to provide inputs for the ocs-agent-setup skill.
    // Verify it has every artifact that ocs-agent-setup consumes.
    const files = new Set(listFiles(fixtureDir));
    const required = artifactsConsumedBy('ocs-agent-setup');

    const missing: string[] = [];
    for (const artifact of required) {
      if (!files.has(artifact.path)) {
        missing.push(artifact.path);
      }
    }

    if (missing.length > 0) {
      console.log('Missing inputs for ocs-agent-setup:', missing);
    }
    expect(missing).toEqual([]);
  });
});

describe('CRISPR-Test-002 fixture', () => {
  const fixtureDir = path.join(FIXTURES_DIR, 'CRISPR-Test-002');

  it('fixture directory exists', () => {
    expect(fs.existsSync(fixtureDir)).toBe(true);
  });
});

describe('CRISPR-Test-003-Turmeric fixture (complete E2E)', () => {
  const fixtureDir = path.join(FIXTURES_DIR, 'CRISPR-Test-003-Turmeric');

  it('fixture directory exists', () => {
    expect(fs.existsSync(fixtureDir)).toBe(true);
  });

  it('has all files recognized by the manifest through all 6 phases (no unexpected files)', () => {
    const files = listFiles(fixtureDir);
    const result = validateFixture(files, 'closeout', ['README.md']);

    if (result.unexpected.length > 0) {
      console.log('Unexpected files:', result.unexpected);
    }
    expect(result.unexpected).toEqual([]);
  });

  it('has every required artifact for all 6 phases (no missing files)', () => {
    // Unlike CRISPR-Test-001 (partial fixture stopping at Phase 3 inputs),
    // CRISPR-Test-003-Turmeric ships every required artifact as a synthetic
    // stub. Catches manifest drift across phases 4-6 (OCS, operate,
    // closeout) that the partial fixtures can't see.
    const files = listFiles(fixtureDir);
    const result = validateFixture(files, 'closeout', ['README.md']);

    if (result.missing.length > 0) {
      console.log('Missing required artifacts:', result.missing);
    }
    expect(result.missing).toEqual([]);
  });
});
