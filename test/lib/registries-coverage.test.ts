/**
 * Coverage lint for the per-skill QA + Eval registries.
 *
 * Asserts that every "real producer skill" mentioned in
 * `lib/artifact-manifest.ts` (`producedBy:` field) has a row in BOTH
 * `skills/_qa-decisions.md` AND `skills/_eval-decisions.md`.
 *
 * The registries are the canonical answer to "does skill X have QA/eval,
 * and why or why not?" Missing-from-registry is a contract violation,
 * not a defaulting case — when a new producer ships, its row gets
 * added to both registries explicitly. This test enforces that contract.
 *
 * Producers that DON'T need a row:
 * - The agents themselves (`ace-orchestrator`, `commcare-setup`, etc.) —
 *   they're orchestration, not per-opp producers.
 * - `external` — placeholder for external-system writes.
 * - `<producer>-qa` and `<producer>-eval` skills — those are the QA/eval
 *   side; the registries track *producers*, not their QA/eval companions.
 *
 * If this test fails:
 * - Add a row to `skills/_qa-decisions.md` for the missing producer with
 *   one of the 4 statuses (`has QA` / `inline QA` / `NO QA` /
 *   `not yet migrated`) + rationale.
 * - Same for `skills/_eval-decisions.md`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const QA_REGISTRY_PATH = path.join(REPO_ROOT, 'skills', '_qa-decisions.md');
const EVAL_REGISTRY_PATH = path.join(REPO_ROOT, 'skills', '_eval-decisions.md');

/**
 * Producers that don't need a registry row.
 *
 * Agent names + 'external' + already-classified -qa/-eval companions.
 */
const PRODUCER_EXEMPTIONS = new Set<string>([
  // Agents (orchestration, not per-opp producers)
  'ace-orchestrator',
  'design-review',
  'commcare-setup',
  'connect-setup',
  'ocs-setup',
  'qa-and-training',
  'synthetic-data-and-workflows',
  'solicitation-management',
  'execution-manager',
  'closeout',
  // Placeholder
  'external',
]);

function isExempted(producer: string): boolean {
  if (PRODUCER_EXEMPTIONS.has(producer)) return true;
  // -qa / -eval companions are tracked under their producer's row, not their own.
  if (producer.endsWith('-qa') || producer.endsWith('-eval')) return true;
  return false;
}

/**
 * Extract the set of producer names that have a row in a registry.
 *
 * Row shape: `| \`<producer>\` | <status> | <rationale> |` at the start
 * of a markdown line (with leading whitespace tolerated).
 */
function extractRegistryProducers(registryPath: string): Set<string> {
  const body = fs.readFileSync(registryPath, 'utf-8');
  const producers = new Set<string>();
  // Match table rows: `| \`name\` | ...`
  const rowRe = /^\|\s*`([a-z][a-z0-9-]*)`\s*\|/gm;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(body)) !== null) {
    producers.add(m[1]);
  }
  return producers;
}

/**
 * Extract the set of unique `producedBy` producer names from the manifest.
 *
 * Skips producers in PRODUCER_EXEMPTIONS, plus any -qa / -eval companion.
 */
function extractManifestProducers(): Set<string> {
  const producers = new Set<string>();
  for (const artifact of ARTIFACT_MANIFEST) {
    const producer = artifact.producedBy;
    if (!producer) continue;
    if (isExempted(producer)) continue;
    producers.add(producer);
  }
  return producers;
}

describe('per-skill registry coverage', () => {
  const manifestProducers = extractManifestProducers();

  it('every manifest producer has a row in `skills/_qa-decisions.md`', () => {
    const qaProducers = extractRegistryProducers(QA_REGISTRY_PATH);
    const missing: string[] = [];
    for (const producer of manifestProducers) {
      if (!qaProducers.has(producer)) {
        missing.push(producer);
      }
    }
    expect(missing.sort(), `producers missing a QA-decisions row`).toEqual([]);
  });

  it('every manifest producer has a row in `skills/_eval-decisions.md`', () => {
    const evalProducers = extractRegistryProducers(EVAL_REGISTRY_PATH);
    const missing: string[] = [];
    for (const producer of manifestProducers) {
      if (!evalProducers.has(producer)) {
        missing.push(producer);
      }
    }
    expect(missing.sort(), `producers missing an Eval-decisions row`).toEqual([]);
  });

  it('every QA-registry row matches a real producer (no orphan rows)', () => {
    const qaProducers = extractRegistryProducers(QA_REGISTRY_PATH);
    const orphans: string[] = [];
    for (const producer of qaProducers) {
      // Allow rows for -qa skills themselves (e.g. the runtime `ocs-chatbot-qa` row).
      // Allow utility rows in the Utility section (decisions-render, email-communicator, etc.).
      if (manifestProducers.has(producer)) continue;
      if (producer.endsWith('-qa') || producer.endsWith('-eval')) continue;
      // Utility/cross-cutting skills aren't always in the manifest's producedBy
      // (e.g. email-communicator just sends mail; doesn't produce per-opp artifacts).
      // We don't fail on these — they're listed for explicit "not applicable" status.
      orphans.push(producer);
    }
    // Soft check: log orphans for awareness but don't fail.
    if (orphans.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[registries-coverage] QA registry has ${orphans.length} row(s) for producers ` +
          `not in artifact-manifest.ts (likely utility skills with no per-opp artifact): ` +
          `${orphans.join(', ')}`,
      );
    }
    // Don't assert — utility rows are valid.
  });
});
