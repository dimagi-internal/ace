#!/usr/bin/env npx tsx
/**
 * Print build-memo-eval's FACT SHEET — what was built, from run_state and live
 * Connect reads, never from the memo itself (`lib/build-memo-facts.ts`).
 *
 *   npx tsx scripts/build-memo-facts.ts --run-state <local run_state.yaml> \
 *     [--live-opportunity <connect_get_opportunity JSON>] \
 *     [--live-payment-units <connect_list_payment_units JSON>]
 *
 * Prints a markdown table on stdout.
 */
import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { buildMemoFacts, renderFactSheet } from '../lib/build-memo-facts.js';

const args = process.argv.slice(2);
const arg = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const read = (p?: string) => (p ? fs.readFileSync(p, 'utf8').replace(/^﻿/, '') : null);

const runStatePath = arg('run-state');
if (!runStatePath) {
  process.stderr.write('build-memo-facts: missing --run-state\n');
  process.exit(2);
}
const runState = parseYaml(read(runStatePath) ?? '');
const oppText = read(arg('live-opportunity'));
const puText = read(arg('live-payment-units'));
const pu = puText ? JSON.parse(puText) : null;
const facts = buildMemoFacts(runState, {
  opportunity: oppText ? JSON.parse(oppText) : null,
  paymentUnits: pu ? (Array.isArray(pu) ? pu : pu.payment_units ?? null) : null,
});
process.stdout.write(renderFactSheet(facts) + '\n');
