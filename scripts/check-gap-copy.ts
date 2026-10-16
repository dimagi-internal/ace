#!/usr/bin/env npx tsx
/**
 * check-gap-copy — run `checkGapCopy` over a demo's authored prose (ace#1750, ace#1759, ace#2244).
 *
 *   npx tsx scripts/check-gap-copy.ts --why-brief <why_brief.yaml> [--spec <unified_spec.yaml>] \
 *     [--render <name>=<render_code file>]...
 *
 * The gaps come from the why-brief, so this runs in `demo-narrative` AFTER the
 * brief is authored — never in `demo-data-setup`, which uploads its dashboards
 * before any gap list exists (ace#2244). Each `--render` is one dashboard's
 * render_code as read back with `workflow_get` (save it locally first).
 *
 * Prints the GapCopyReport as JSON on the last stdout line. Exit 0 whatever it
 * finds — the check FLAGS, it never rejects; the caller resolves each finding.
 * Non-zero only when it cannot run. Reads no credentials.
 */
import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { checkGapCopy, narrativeSources, type GapCopySource, type GapLike } from '../lib/gap-copy-check.js';

const args = process.argv.slice(2);
const one = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const many = (name: string): string[] => args.flatMap((a, i) => (a === `--${name}` && i + 1 < args.length ? [args[i + 1]] : []));

const briefPath = one('why-brief');
if (!briefPath) {
  process.stderr.write('check-gap-copy: missing --why-brief\n');
  process.exit(2);
}
const brief = parseYaml(fs.readFileSync(briefPath, 'utf8')) as { gaps?: GapLike[] } & Parameters<typeof narrativeSources>[0];
const specPath = one('spec');
const spec = specPath ? (parseYaml(fs.readFileSync(specPath, 'utf8')) as Parameters<typeof narrativeSources>[1]) : null;

const sources: GapCopySource[] = [];
for (const r of many('render')) {
  const eq = r.indexOf('=');
  if (eq <= 0) {
    process.stderr.write(`check-gap-copy: --render wants <name>=<file>, got ${r}\n`);
    process.exit(2);
  }
  sources.push({ name: `render:${r.slice(0, eq)}`, code: fs.readFileSync(r.slice(eq + 1), 'utf8') });
}
sources.push(...narrativeSources(brief, spec));

const report = checkGapCopy(brief?.gaps ?? [], sources);
process.stdout.write(JSON.stringify({ ...report, scanned: sources.map((s) => s.name) }) + '\n');
