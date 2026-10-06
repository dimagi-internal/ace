#!/usr/bin/env npx tsx
/**
 * demo-arc-precheck — the pre-render arc check over an authored DDD spec (ace#2735).
 *
 *   npx tsx scripts/demo-arc-precheck.ts --spec <spec.yaml> [--realized <realized.json>] \
 *     [--prompt-out <file for the text-only judge pass>] [--verdict <judge pass YAML>]
 *
 * Without --verdict: runs the deterministic half (`checkArcPrecheck`) and, with
 * --prompt-out, writes the single text-only judge prompt (`buildArcPrecheckPrompt`).
 * With --verdict: also gates the judge pass's YAML (`gateArcPrecheckVerdict`).
 * Prints `{pass, deterministic, judge?}` as JSON on the last stdout line; exit 0
 * whatever the verdict (the caller reads `pass`), non-zero only if it cannot run.
 */
import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { buildArcPrecheckPrompt, checkArcPrecheck, gateArcPrecheckVerdict, type PrecheckSpec } from '../lib/demo-arc-precheck.js';

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const specPath = arg('spec');
if (!specPath) {
  process.stderr.write('demo-arc-precheck: missing --spec\n');
  process.exit(2);
}
const spec = parseYaml(fs.readFileSync(specPath, 'utf8')) as PrecheckSpec;
const realizedPath = arg('realized');
const realized = realizedPath ? (JSON.parse(fs.readFileSync(realizedPath, 'utf8')) as Record<string, unknown>) : {};

const deterministic = checkArcPrecheck(spec, realized);
const promptOut = arg('prompt-out');
if (promptOut) fs.writeFileSync(promptOut, buildArcPrecheckPrompt(spec, deterministic, realized));

const verdictPath = arg('verdict');
const judge = verdictPath ? gateArcPrecheckVerdict(parseYaml(fs.readFileSync(verdictPath, 'utf8'))) : undefined;
const pass = deterministic.pass && (judge ? judge.pass : true);
process.stdout.write(JSON.stringify({ pass, deterministic, ...(judge ? { judge } : {}) }) + '\n');
