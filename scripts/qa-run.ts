#!/usr/bin/env npx tsx
/**
 * Generic CLI runner for QA skills.
 *
 * Each `<producer>-qa` skill ships a `checks.ts` exporting a `CHECKS` array
 * of `QACheck`s. This runner:
 *
 *   1. Imports `CHECKS` from `skills/<skill>/checks.ts`
 *   2. Reads the artifact from disk
 *   3. Runs each check via `lib/qa-runner.ts`
 *   4. Prints a canonical `QAResult` YAML to stdout
 *
 * Skill bodies invoke this from a Bash step; tests import the underlying
 * functions directly. Same shape comes out either way.
 *
 * Usage:
 *   npx tsx scripts/qa-run.ts \
 *     --skill idea-to-pdd-qa \
 *     --artifact /tmp/pdd.md \
 *     --target turmeric \
 *     --capture-path 1-design/idea-to-pdd.md
 *
 * Exit codes:
 *   0 — runner completed (verdict could be pass OR fail; check the YAML)
 *   1 — runner usage / IO error (skill not found, artifact unreadable, etc.)
 *   2 — internal error (check threw)
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import { runChecks } from '../lib/qa-runner.js';
import type { QACheck, QACheckContext } from '../lib/qa-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

interface Args {
  skill: string;
  artifact: string;
  target: string;
  capture_path: string;
  include_passed: boolean;
  /** Optional: path to a decisions.yaml whose text becomes ctx.decisionsYaml. */
  decisions?: string;
  /** Optional: archetype value passed through as ctx.archetype. */
  archetype?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { include_passed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--skill':
        args.skill = argv[++i];
        break;
      case '--artifact':
        args.artifact = argv[++i];
        break;
      case '--target':
        args.target = argv[++i];
        break;
      case '--capture-path':
        args.capture_path = argv[++i];
        break;
      case '--include-passed':
        args.include_passed = true;
        break;
      case '--decisions':
        args.decisions = argv[++i];
        break;
      case '--archetype':
        args.archetype = argv[++i];
        break;
      case '-h':
      case '--help':
        printUsage();
        process.exit(0);
      default:
        process.stderr.write(`unknown arg: ${a}\n`);
        printUsage();
        process.exit(1);
    }
  }
  for (const required of ['skill', 'artifact', 'target', 'capture_path'] as const) {
    if (!args[required]) {
      process.stderr.write(`missing required --${required.replace('_', '-')}\n`);
      printUsage();
      process.exit(1);
    }
  }
  return args as Args;
}

function printUsage(): void {
  process.stderr.write(
    'usage: qa-run.ts --skill <skill> --artifact <path> --target <id> --capture-path <relative> [--include-passed] [--decisions <path>] [--archetype <value>]\n',
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Dynamic import the skill's checks module.
  const checksPath = join(REPO_ROOT, 'skills', args.skill, 'checks.ts');
  let CHECKS: QACheck[];
  try {
    const mod = (await import(checksPath)) as { CHECKS?: QACheck[] };
    if (!mod.CHECKS || !Array.isArray(mod.CHECKS)) {
      throw new Error(`skill '${args.skill}' has no exported CHECKS array at ${checksPath}`);
    }
    CHECKS = mod.CHECKS;
  } catch (err) {
    process.stderr.write(`failed to load checks for '${args.skill}': ${(err as Error).message}\n`);
    process.exit(1);
  }

  let artifact: string;
  try {
    artifact = readFileSync(args.artifact, 'utf-8');
  } catch (err) {
    process.stderr.write(`failed to read artifact at '${args.artifact}': ${(err as Error).message}\n`);
    process.exit(1);
  }

  // Build optional context for context-dependent checks. Only include fields
  // that were actually supplied so skills that don't need context are unaffected.
  const context: QACheckContext = {};
  if (args.decisions !== undefined) {
    try {
      context.decisionsYaml = readFileSync(args.decisions, 'utf-8');
    } catch (err) {
      process.stderr.write(
        `failed to read decisions at '${args.decisions}': ${(err as Error).message}\n`,
      );
      process.exit(1);
    }
  }
  if (args.archetype !== undefined) {
    context.archetype = args.archetype;
  }
  const hasContext = Object.keys(context).length > 0;

  let result;
  try {
    result = await runChecks({
      skill: args.skill,
      target: args.target,
      capture_path: args.capture_path,
      artifact,
      checks: CHECKS,
      include_passed: args.include_passed,
      context: hasContext ? context : undefined,
    });
  } catch (err) {
    process.stderr.write(`internal error running checks: ${(err as Error).message}\n`);
    process.exit(2);
  }

  process.stdout.write(stringifyYaml(result));
}

main().catch((err) => {
  process.stderr.write(`unhandled error: ${(err as Error).message}\n`);
  process.exit(2);
});
