/**
 * Print the backdated calendar a simulated Phase 9 runs on, as the YAML the
 * execution-manager writes to `phases.execution-management.products.simulation.calendar`.
 * Pure, no network.
 *
 *   npx tsx scripts/sim-calendar.ts --run-started-at <ISO date|timestamp> --weeks <N>
 *
 * `--run-started-at` is the run's `run_state.yaml` `started_at`, so a resume
 * prints the same calendar. Exit 0 prints `calendar:`; exit 2 prints
 * `status: fail` and `message`. Logic: lib/sim-calendar.ts (spec 2026-10-18 § G).
 * Called from agents/execution-manager.md § Simulated mode S0.
 */
import YAML from 'yaml';
import { computeSimCalendar } from '../lib/sim-calendar.js';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function main(): number {
  try {
    const started = arg('--run-started-at');
    const weeks = Number(arg('--weeks'));
    if (!started) throw new Error('--run-started-at is required');
    const cal = computeSimCalendar(started, weeks);
    process.stdout.write(YAML.stringify({ calendar: cal }, { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' }));
    return 0;
  } catch (e) {
    process.stdout.write(`status: fail\nmessage: ${JSON.stringify(e instanceof Error ? e.message : String(e))}\n`);
    return 2;
  }
}

process.exit(main());
