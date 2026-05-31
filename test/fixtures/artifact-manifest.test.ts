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

describe('ACE-Test-001 fixture', () => {
  const fixtureDir = path.join(FIXTURES_DIR, 'ACE-Test-001');

  it('fixture directory exists', () => {
    expect(fs.existsSync(fixtureDir)).toBe(true);
  });

  it('has all files recognized by the manifest (no unexpected files)', () => {
    const files = listFiles(fixtureDir);
    const result = validateFixture(files, 'qa-and-training', ['README.md']);

    if (result.unexpected.length > 0) {
      console.log('Unexpected files:', result.unexpected);
    }
    expect(result.unexpected).toEqual([]);
  });

  it('reports expected missing files for this partial fixture', () => {
    // ACE-Test-001 provides inputs for ocs-agent-setup, not a complete
    // opportunity folder. These artifacts are intentionally absent:
    // test-prompts.md is consumed by ocs-chatbot-qa (not ocs-agent-setup);
    // gate-briefs/* are produced during gate pauses that this fixture never
    // reached (state.yaml shows every phase as pending, so no skill has run).
    //
    // Note: apps/learn-app.json and apps/deliver-app.json were dropped from
    // this list on 2026-04-27 when ACE migrated CommCare app generation to
    // the Nova plugin. Those JSON snapshots are now optional — the canonical
    // handle is `nova_app_id` in the app summaries — so validateFixture no
    // longer flags them as missing.
    //
    // Note: test-results/{test-plan,test-results,bugs}.md were dropped on
    // 2026-05-04 (shallow/deep QA split) when the `app-test` skill was
    // retired. The fixture gained `expected-journeys.md` (Phase 1) and
    // `app-test-cases.yaml` (Phase 3) in the same release; both ship in
    // the fixture so they don't appear in expectedMissing.
    const expectedMissing = [
      // inputs/ is an opp-level required artifact; ACE-Test-001 is a
      // partial fixture scoped to ocs-agent-setup inputs and doesn't model
      // the full opp folder layout, so inputs/ is intentionally absent here.
      'inputs/',
      // Phase 1 outputs missing in this fixture.
      '1-design/idea-to-design_summary.md',
      // PR-517: Phase 1 `-eval` verdicts flipped to required:true.
      '1-design/idea-to-pdd-eval_verdict.yaml',
      '1-design/pdd-to-work-order-eval_verdict.yaml',
      // Phase 2 outputs missing in this fixture.
      '2-scenarios/pdd-to-test-prompts.md',
      '2-scenarios/scenarios-and-acceptance_summary.md',
      // PR-517: Phase 2 `-eval` verdicts flipped to required:true.
      '2-scenarios/pdd-to-app-journeys-eval_verdict.yaml',
      '2-scenarios/pdd-to-test-prompts-eval_verdict.yaml',
      // Phase 3 outputs missing in this fixture.
      '3-commcare/commcare-setup_summary.md',
      '3-commcare/app-release-qa_result.yaml',
      // PR-517: Phase 3 `-eval` verdicts flipped to required:true.
      '3-commcare/app-release-eval_verdict.yaml',
      '3-commcare/pdd-to-deliver-app-eval_verdict.yaml',
      '3-commcare/pdd-to-learn-app-eval_verdict.yaml',
      // Phase 4 summary missing.
      '4-connect/connect-setup_summary.md',
      // PR-517: Phase 4 `-eval` verdict flipped to required:true.
      '4-connect/connect-program-setup-eval_verdict.yaml',
      // Phase 5 OCS artifacts (the fixture covers earlier phases only).
      '5-ocs/ocs-agent-setup.md',
      '5-ocs/ocs-setup_summary.md',
      '5-ocs/ocs-setup_widget-handoff.md',
      // PR-517: declared `-eval` verdict outputs flipped to required:true so
      // the orchestrator's phase-closeout fence can enforce them. The fixture
      // doesn't ship any of these (it predates the closeout gate), so they
      // all surface as expected missing.
      '5-ocs/ocs-widget-handoff-eval_verdict.yaml',
      // 0.13.116: gate-brief artifacts removed across all phases.
      // Phase 6 verdicts + onboarding email (training docs are present;
      // verdicts and the onboarding email are not).
      '6-qa-and-training/app-screenshot-capture_verdict-shallow.yaml',
      '6-qa-and-training/app-screenshot-capture_verdict.yaml',
      // PR-517: Phase 6 training-* `-eval` verdicts flipped to required:true.
      '6-qa-and-training/training-deck-generate-eval_verdict.yaml',
      '6-qa-and-training/training-faq-eval_verdict.yaml',
      '6-qa-and-training/training-flw-guide-eval_verdict.yaml',
      '6-qa-and-training/training-llo-guide-eval_verdict.yaml',
      '6-qa-and-training/training-onboarding-email-eval_verdict.yaml',
      '6-qa-and-training/training-onboarding-email.md',
      '6-qa-and-training/training-quick-reference-eval_verdict.yaml',
    ];
    const files = listFiles(fixtureDir);
    const result = validateFixture(files, 'qa-and-training', ['README.md']);
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

describe('ACE-Test-002 fixture', () => {
  const fixtureDir = path.join(FIXTURES_DIR, 'ACE-Test-002');

  it('fixture directory exists', () => {
    expect(fs.existsSync(fixtureDir)).toBe(true);
  });
});

describe('ACE-Test-004-Solicitation fixture (Phase 7)', () => {
  const fixtureDir = path.join(FIXTURES_DIR, 'ACE-Test-004-Solicitation');

  it('fixture directory exists', () => {
    expect(fs.existsSync(fixtureDir)).toBe(true);
  });

  it('PDD has all three optional Solicitation fields', () => {
    const pddPath = path.join(fixtureDir, 'inputs', 'pdd.md');
    const pdd = fs.readFileSync(pddPath, 'utf8');
    expect(pdd).toMatch(/## Solicitation/);
    expect(pdd).toMatch(/Solicitation type:/);
    expect(pdd).toMatch(/Response window:/);
    expect(pdd).toMatch(/Response template:/);
  });

  it('opp.yaml has solicitation block + stubbed selected_llo', () => {
    const oppYaml = fs.readFileSync(path.join(fixtureDir, 'opp.yaml'), 'utf8');
    expect(oppYaml).toMatch(/solicitation:/);
    expect(oppYaml).toMatch(/solicitation_id:/);
    expect(oppYaml).toMatch(/public_url:/);
    expect(oppYaml).toMatch(/selected_llo:/);
    // selected_llo stays stubbed (null org_slug) until solicitation-review awards.
    expect(oppYaml).toMatch(/org_slug: null/);
  });
});
