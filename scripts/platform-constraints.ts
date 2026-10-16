#!/usr/bin/env npx tsx
/**
 * Connect platform-constraint findings for a PDD, as text or as decision rows.
 *
 * The same evaluation `idea-to-pdd-qa § platform_constraints` runs, exposed so
 * the producer can turn each finding into its `decisions.yaml` row (the QA
 * check can only pass/fail — it cannot write rows).
 *
 * Usage:
 *   npx tsx scripts/platform-constraints.ts --pdd /tmp/pdd.md          # findings, one per line
 *   npx tsx scripts/platform-constraints.ts --pdd /tmp/pdd.md --rows   # JSON array of decision rows
 *
 * `--rows` output is ready for `decisions_append_rows` (write it to a file and
 * pass the rows). Exit 0 always on a readable PDD — a finding is data, not an
 * error; the QA check is the gate.
 */

import { readFileSync } from 'node:fs';

import { checkPlatformConstraints, describeFinding, findingToDecisionRow } from '../lib/platform-constraints.js';
import { extractArchetype, programParametersFromPdd } from '../skills/idea-to-pdd-qa/checks.js';

function main(argv: string[]): number {
  const i = argv.indexOf('--pdd');
  const path = i >= 0 ? argv[i + 1] : undefined;
  if (!path) {
    process.stderr.write('usage: platform-constraints.ts --pdd <pdd.md> [--rows]\n');
    return 1;
  }
  const raw = readFileSync(path, 'utf8');
  const findings = checkPlatformConstraints(programParametersFromPdd(raw), extractArchetype(raw));
  if (argv.includes('--rows')) {
    process.stdout.write(JSON.stringify(findings.map(findingToDecisionRow), null, 2) + '\n');
  } else {
    process.stdout.write(findings.length ? findings.map(describeFinding).join('\n') + '\n' : 'no Connect platform constraint contradicted\n');
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
