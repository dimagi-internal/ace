#!/usr/bin/env npx tsx
/**
 * semantic-registry-author-qa — run both gates and write the result.
 *
 *   npx tsx scripts/semantic-registry-author-qa.ts --registry <semantic-registry-author_registry.json> \
 *     --pdd <PDD markdown> --partners <comma-separated opportunity ids> \
 *     --labs-validate <semantic_registry_validate JSON> --target <opp>/<run> --out <result.yaml>
 *
 * One outcome per check (`registryQAOutcomes`) through the shared writer
 * (`aggregateQAResult`), so the result counts what it checked. Prints
 * `{verdict, stats, out}`.
 */
import * as fs from 'node:fs';
import { stringify as stringifyYaml } from 'yaml';
import { aggregateQAResult } from '../lib/qa-types.js';
import { normalizeDriveExport } from '../lib/drive-export.js';
import { checkRegistryAuthoring, pddSectionIds, registryQAOutcomes, type RegistryDocs } from '../lib/semantic-registry-authoring.js';

const args = process.argv.slice(2);
const arg = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const read = (p?: string) => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/^﻿/, '') : null);

const regText = read(arg('registry'));
if (!regText || !arg('out') || !arg('target')) {
  process.stderr.write('semantic-registry-author-qa: --registry, --target and --out are required\n');
  process.exit(2);
}
const registry = JSON.parse(regText as string) as RegistryDocs;
const pdd = read(arg('pdd'));
// Read the PDD with exportAs text/markdown: the text/plain export drops the `#`
// heading markers pddSectionIds keys on, which silently disables the anchor
// check. normalizeDriveExport undoes the markdown export's `1\.` escapes.
const pddSections = pdd ? pddSectionIds(normalizeDriveExport(pdd)) : [];
const opportunityIds = (arg('partners') ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const labsText = read(arg('labs-validate'));
const report = checkRegistryAuthoring(registry, { pddSections, opportunityIds });
const outcomes = registryQAOutcomes(report, labsText ? JSON.parse(labsText) : null, { pddSections, opportunityIds });
const result = aggregateQAResult({
  skill: 'semantic-registry-author-qa',
  target: arg('target') as string,
  capture_path: '7-synthetic/semantic-registry-author_registry.json',
  outcomes,
});
fs.writeFileSync(arg('out') as string, stringifyYaml(result, { lineWidth: 0 }));
process.stdout.write(JSON.stringify({ verdict: result.verdict, stats: result.stats, out: arg('out') }) + '\n');
