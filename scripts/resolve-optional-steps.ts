/**
 * Resolve a run's optional steps and print the `optional_steps:` block the
 * orchestrator writes at the TOP LEVEL of the new run's run_state.yaml.
 * Pure, no network.
 *
 *   npx tsx scripts/resolve-optional-steps.ts [--with <csv>] [--opp-yaml <local opp.yaml>] [--invite-candidates]
 *
 * Exit 0 prints either the block, or `optional_steps: none` when nothing is
 * requested. In that case WRITE NO BLOCK, so a default run's run_state stays
 * exactly as it was before optional steps existed. Exit 2 prints
 * `status: fail` plus `code` and `message` on a refusal; the orchestrator halts
 * Pre-flight on it. Logic: lib/optional-steps.ts.
 * Called from agents/ace-orchestrator.md § Optional steps.
 */
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { OptionalStepsError, renderOptionalStepsYaml, resolveOptionalSteps } from '../lib/optional-steps.js';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function main(): number {
  const argv = process.argv.slice(2);
  const withFlag = arg('--with');
  const oppYamlPath = arg('--opp-yaml');
  const inviteCandidates =
    argv.includes('--invite-candidates') || process.env.ACE_SOLICITATION_INVITE_CANDIDATES === '1';
  try {
    let oppYamlSteps: unknown;
    if (oppYamlPath) {
      const doc = YAML.parse(readFileSync(oppYamlPath, 'utf8'));
      oppYamlSteps = doc && typeof doc === 'object' ? (doc as Record<string, unknown>).optional_steps : undefined;
    }
    const steps = resolveOptionalSteps({ withFlag, oppYamlSteps, inviteCandidates });
    process.stdout.write((steps ? renderOptionalStepsYaml(steps) : 'optional_steps: none') + '\n');
    return 0;
  } catch (e) {
    const code = e instanceof OptionalStepsError ? e.code : 'BAD_INPUT';
    const message = e instanceof Error ? e.message : String(e);
    process.stdout.write(`status: fail\ncode: ${code}\nmessage: ${JSON.stringify(message)}\n`);
    return 2;
  }
}

process.exit(main());
