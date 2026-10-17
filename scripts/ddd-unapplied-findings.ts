/**
 * Read a finished canopy DDD run and print Phase 7's reading of its ending,
 * including the dashboard defects the loop found but could not apply
 * (`found_not_fixed`, ace#2337).
 *
 *   npx tsx scripts/ddd-unapplied-findings.ts <runs_dir>/<ddd_run_id>/run_state.yaml [--spec <unified-spec.yaml>]
 *
 * Prints JSON `{ddd_terminal_status, outcome, verdict, unapplied_dashboard_findings}`.
 * `--spec` resolves each finding's scene to the dashboard URL it films.
 * Logic: lib/ddd-unapplied-findings.ts. Run by
 * agents/synthetic-data-and-workflows.md § Step 3 (finalize).
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { phase7DddOutcome, sceneUrlsFromSpec } from '../lib/ddd-unapplied-findings.js';

const args = process.argv.slice(2);
const statePath = args.find((a) => !a.startsWith('--'));
const specIdx = args.indexOf('--spec');
if (!statePath) {
  process.stderr.write('usage: ddd-unapplied-findings.ts <ddd run_state.yaml> [--spec <spec.yaml>]\n');
  process.exit(64);
}
const state = parseYaml(readFileSync(statePath, 'utf8'));
const urls = specIdx >= 0 && args[specIdx + 1] ? sceneUrlsFromSpec(parseYaml(readFileSync(args[specIdx + 1], 'utf8'))) : {};
process.stdout.write(JSON.stringify(phase7DddOutcome(state, urls), null, 2) + '\n');
