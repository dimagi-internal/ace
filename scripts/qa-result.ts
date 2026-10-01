#!/usr/bin/env npx tsx
/**
 * The shared writer for EVERY `-qa` skill's result file.
 *
 *   npx tsx scripts/qa-result.ts write --skill <name> --target <opp>/<run> \
 *       --capture-path <path under the run> --outcomes <outcomes.json> --out <result.yaml>
 *   npx tsx scripts/qa-result.ts check --file <result.yaml>
 *
 * `outcomes.json` is a list, one entry per check the skill evaluated:
 *   [{"check": "<id>", "type": "static"|"llm", "result": {"pass": true|false, "detail": "...", "auto_fix_hint": "..."}},
 *    {"check": "<id>", "not_judged": "<why it could not run now>"}]
 *
 * `write` builds the canonical lib/qa-types.ts shape through
 * `aggregateQAResult` — stats derived, never typed; a result that evaluated
 * nothing is a FAIL — and prints `{verdict, stats, out}`. `check` validates an
 * existing file (exit 1 when invalid). ace-gdrive refuses to write a
 * `*-qa_result.yaml` that would not pass `check` (lib/qa-result-write-guard.ts),
 * so this is the path that always lands.
 */
import * as fs from 'node:fs';
import { stringify as stringifyYaml } from 'yaml';
import { aggregateQAResult, type QACheckOutcome } from '../lib/qa-types.js';
import { qaResultWriteRefusal } from '../lib/qa-result-write-guard.js';

const [, , cmd, ...args] = process.argv;
const arg = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
function need(n: string): string {
  const v = arg(n);
  if (!v) {
    process.stderr.write(`qa-result: missing --${n}\n`);
    process.exit(2);
  }
  return v as string;
}

if (cmd === 'write') {
  const outcomes = JSON.parse(fs.readFileSync(need('outcomes'), 'utf8')) as QACheckOutcome[];
  const result = aggregateQAResult({ skill: need('skill'), target: need('target'), capture_path: need('capture-path'), outcomes });
  const out = need('out');
  fs.writeFileSync(out, stringifyYaml(result, { lineWidth: 0 }));
  process.stdout.write(JSON.stringify({ verdict: result.verdict, stats: result.stats, out }) + '\n');
} else if (cmd === 'check') {
  const file = need('file');
  const refusal = qaResultWriteRefusal(file.endsWith('-qa_result.yaml') ? file : `${file}-qa_result.yaml`, fs.readFileSync(file, 'utf8'));
  process.stdout.write(JSON.stringify({ ok: refusal === null, problem: refusal }) + '\n');
  if (refusal) process.exit(1);
} else {
  process.stderr.write('usage: qa-result.ts write|check … (see the header)\n');
  process.exit(2);
}
