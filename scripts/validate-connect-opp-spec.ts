#!/usr/bin/env npx tsx
/**
 * Validate a standalone Connect opportunity spec. The gate in
 * `/ace:connect-opp-create` § Validate the spec.
 *
 *   npx tsx "${CLAUDE_PLUGIN_ROOT:-.}/scripts/validate-connect-opp-spec.ts" <spec.yaml>
 *   npx tsx ".../validate-connect-opp-spec.ts" <spec.yaml> --phase pre-payment-units
 *
 * Exit 0 = safe to proceed. Exit 1 = blocking issues. Exit 2 = could not read,
 * parse, or validate the file.
 *
 * ## Two phases, because one rule is unanswerable before the create
 *
 * `required_deliver_units` takes `deliver_unit.server_id`s that Connect mints
 * in the create response, so a freshly-copied template cannot supply them.
 * Grading that `error` up front made the documented happy path -- copy the
 * template, run the gate -- an immediate red, whose only exits were inventing
 * ids Connect rejects or walking past a blocking error. The second is the
 * expensive one: an operator who learns to ignore a red gate has lost every
 * other rule in it. So `pre-create` warns and `pre-payment-units` blocks.
 *
 * ## Why this is a script and not an inline `tsx -e` snippet
 *
 * It was a snippet, and the snippet FAILED OPEN. `tsx -e` evaluates with no
 * module path, so the import could not resolve -- and in the multi-line form
 * the process exited 0 having printed nothing at all. The gate's instruction
 * is "halt on any error", so an operator reads the silence as "no issues" and
 * proceeds to a create whose app wiring is write-once. A gate that cannot run
 * must fail LOUD; that one failed silent, in front of the one irreversible
 * step in the flow.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  validateConnectOppSpec,
  formatSpecIssues,
  hasBlockingIssue,
  type SpecIssue,
  type SpecPhase,
} from '../lib/connect-opp-spec.js';

const PHASES: SpecPhase[] = ['pre-create', 'pre-payment-units'];

/** Read + parse, or explain why not. Exported for tests. */
export function loadSpec(path: string): { spec: unknown } | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { error: `cannot read ${path}: ${(e as Error).message}` };
  }
  try {
    return { spec: parse(raw) };
  } catch (e) {
    return { error: `${path} is not valid YAML: ${(e as Error).message}` };
  }
}

/** The whole gate, minus process exit. Exported so a test can drive it. */
export function runValidation(
  path: string,
  phase: SpecPhase = 'pre-create',
): { code: 0 | 1 | 2; output: string } {
  const loaded = loadSpec(path);
  if ('error' in loaded) return { code: 2, output: `[FATAL] ${loaded.error}` };

  let issues: SpecIssue[];
  try {
    issues = validateConnectOppSpec(loaded.spec, phase);
  } catch (e) {
    // The validator's contract is to report, not throw. If it ever does, that
    // is a bug -- and it must not read as "no issues".
    return {
      code: 2,
      output:
        `[FATAL] the validator threw on this spec: ${(e as Error).message}\n` +
        'This is a bug in lib/connect-opp-spec.ts. Nothing was created.',
    };
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.length - errors;
  const tally = issues.length === 0 ? '' : `\n\n${errors} error(s), ${warns} warning(s).`;

  return { code: hasBlockingIssue(issues) ? 1 : 0, output: formatSpecIssues(issues) + tally };
}

function main(): void {
  const args = process.argv.slice(2);
  const phaseAt = args.indexOf('--phase');
  let phase: SpecPhase = 'pre-create';
  if (phaseAt !== -1) {
    const given = args[phaseAt + 1];
    if (!PHASES.includes(given as SpecPhase)) {
      console.error(`--phase must be one of: ${PHASES.join(', ')}`);
      process.exit(2);
    }
    phase = given as SpecPhase;
    args.splice(phaseAt, 2);
  }

  const path = args[0];
  if (!path) {
    console.error('usage: validate-connect-opp-spec.ts <spec.yaml> [--phase <phase>]');
    process.exit(2);
  }

  const { code, output } = runValidation(path, phase);
  console.log(`# phase: ${phase}`);
  console.log(output);
  if (code === 1) {
    console.error('\nBlocking issues above. Nothing was created. Fix the spec and re-run.');
  }
  process.exit(code);
}

/**
 * Direct-invocation guard.
 *
 * Compared by RESOLVED PATH rather than the repo's more common
 * `` import.meta.url === `file://${process.argv[1]}` ``, which never matches on
 * Windows (node yields `file:///C:/...` while `argv[1]` is `C:\...`). Getting
 * this wrong here fails silent -- the module would import, print nothing and
 * exit 0 -- which is the exact shape this file exists to eliminate.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) main();
