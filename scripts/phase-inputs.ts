/**
 * CLI over `lib/phase-inputs.ts` — the resume fence's input list (ace#2134).
 *
 *   npx tsx scripts/phase-inputs.ts <phase> [--mode=app-QA-only]
 *     [--present=<file>] [--statuses=<file>]
 *
 * `<phase>` is a manifest key (`commcare`) or agent name (`commcare-setup`).
 * Without `--present`, prints the phase's cross-phase REQUIRED inputs as JSON.
 * With `--present` (a JSON array of run-folder paths that exist, e.g. from
 * `verify_phase_artifacts` / `drive_list_folder`) and `--statuses` (JSON
 * `{ "<agentName>": "<status>" }` from run_state `phases.*.status`), runs the
 * precondition check and prints the missing inputs.
 *
 * Exit 0 = resolved and (when checking) nothing missing; 1 = inputs missing;
 * 2 = UNABLE TO CHECK (unknown phase / no skills in the agent frontmatter) —
 * NOT a pass.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPhasePreconditions, crossPhaseInputs, phaseSkillsFromRepo } from '../lib/phase-inputs.js';
import { formatUnable } from '../lib/check-outcome.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const phase = args.find((a) => !a.startsWith('--'));
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

if (!phase) {
  console.error('usage: phase-inputs.ts <phase> [--mode=<mode>] [--present=<file> --statuses=<file>]');
  process.exit(2);
}
const skills = phaseSkillsFromRepo(phase, repoRoot);
const mode = flag('mode');
const presentFile = flag('present');

if (!presentFile) {
  const r = crossPhaseInputs(phase, skills, mode);
  if (r.status === 'unable') {
    console.error(formatUnable(`phase-inputs ${phase}`, r.reason));
    process.exit(2);
  }
  console.log(JSON.stringify({ phase, inputs: r.inputs }, null, 2));
  process.exit(0);
}

const statusesFile = flag('statuses');
const r = checkPhasePreconditions({
  phase,
  skills,
  mode,
  presentPaths: JSON.parse(readFileSync(presentFile, 'utf8')) as string[],
  phaseStatuses: statusesFile ? (JSON.parse(readFileSync(statusesFile, 'utf8')) as Record<string, string>) : {},
});
if (r.status === 'unable') {
  console.error(formatUnable(`phase-inputs ${phase}`, r.reason));
  process.exit(2);
}
console.log(JSON.stringify({ phase, ok: r.ok, missing: r.findings }, null, 2));
process.exit(r.ok ? 0 : 1);
