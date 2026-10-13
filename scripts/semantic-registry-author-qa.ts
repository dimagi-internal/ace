#!/usr/bin/env npx tsx
/**
 * semantic-registry-author-qa — run both gates and write the result.
 *
 *   npx tsx scripts/semantic-registry-author-qa.ts --registry <semantic-registry-author_registry.json> \
 *     --pdd <PDD markdown> --partners <comma-separated opportunity ids> \
 *     --labs-validate <semantic_registry_validate JSON> \
 *     --layer1 <semantic-registry-author_layer1.json> --ccz-dir <unzipped released Deliver CCZ> \
 *     [--key-exempt <JSON {"modules-N/forms-M.xml": "why"}>] \
 *     --target <opp>/<run> --out <result.yaml>
 *
 * `--layer1` + `--ccz-dir` resolve every Layer-1 path, the entity key above all,
 * against the released form XML (ace#2883). `--layer1` takes `{fields: [...]}`, a
 * pipeline `{schema: {fields}}`, or a bare field array.
 *
 * No PDD (a programme built from a real app): pass `--app <Deliver app structure JSON>`
 * (`get_opportunity_apps` output, or the bare deliver app) instead of `--pdd`, and
 * `--partner-source programme` when the partners are the programme's real ones.
 *
 * One outcome per check (`registryQAOutcomes`) through the shared writer
 * (`aggregateQAResult`), so the result counts what it checked. Prints
 * `{verdict, stats, out}`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { aggregateQAResult } from '../lib/qa-types.js';
import { normalizeDriveExport } from '../lib/drive-export.js';
import type { Layer1Field, ReleasedForm } from '../lib/layer1-path-check.js';
import { appFormNames, checkRegistryAuthoring, pddSectionIds, registryQAOutcomes, type RegistryDocs } from '../lib/semantic-registry-authoring.js';

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
const appText = read(arg('app'));
const appForms = appText ? appFormNames(JSON.parse(appText)) : [];
const ps = arg('partner-source');
const partnerSource = ps === 'programme' || ps === 'invented' ? ps : undefined;
const labsText = read(arg('labs-validate'));

// Layer 1 against the released app (ace#2883).
const layer1Text = read(arg('layer1'));
const cczDir = arg('ccz-dir');
const forms: ReleasedForm[] = [];
if (cczDir && fs.existsSync(cczDir)) {
  for (const mod of fs.readdirSync(cczDir).filter((d) => /^modules-\d+$/.test(d)).sort()) {
    const dir = path.join(cczDir, mod);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((n) => /^forms-\d+\.xml$/.test(n)).sort()) {
      forms.push({ path: `${mod}/${f}`, xml: fs.readFileSync(path.join(dir, f), 'utf8') });
    }
  }
}
const layer1Fields = (() => {
  if (!layer1Text) return null;
  const j = JSON.parse(layer1Text);
  const fields = Array.isArray(j) ? j : (j.fields ?? j.schema?.fields);
  return Array.isArray(fields) ? (fields as Layer1Field[]) : null;
})();
const keyExemptText = read(arg('key-exempt'));
const layer1 = layer1Fields && forms.length
  ? { fields: layer1Fields, forms, keyExempt: keyExemptText ? (JSON.parse(keyExemptText) as Record<string, string>) : undefined }
  : undefined;

const report = checkRegistryAuthoring(registry, { pddSections, opportunityIds, appForms, partnerSource, layer1 });
const outcomes = registryQAOutcomes(report, labsText ? JSON.parse(labsText) : null, { pddSections, opportunityIds, appForms, pddSupplied: !!pdd, layer1Supplied: !!layer1 });
const result = aggregateQAResult({
  skill: 'semantic-registry-author-qa',
  target: arg('target') as string,
  capture_path: '7-synthetic/semantic-registry-author_registry.json',
  outcomes,
});
fs.writeFileSync(arg('out') as string, stringifyYaml(result, { lineWidth: 0 }));
process.stdout.write(JSON.stringify({ verdict: result.verdict, stats: result.stats, out: arg('out') }) + '\n');
