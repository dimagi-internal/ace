#!/usr/bin/env node
/**
 * The deterministic half of `skills/build-memo` (`lib/build-memo-compose.ts`).
 *
 * FRAME — print the parts of the memo that have a right answer: the title (from
 * run_state.run_id, never carried from a fork's source), the intro, "Known
 * limitations", "Decisions you own", "Where each rule is enforced" (per-worker
 * scopes corrected) and the appendix of internal references:
 *
 *   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/build-memo-compose.ts" \
 *     --run-state <run_state.yaml> --decisions <decisions.yaml> --phase4 <connect-opp-setup.md> \
 *     --pdd <pdd text> --display-name "<opp display name>" --frame <out-dir>
 *
 *   writes <out-dir>/head.md, <out-dir>/appendix.md, <out-dir>/frame.json
 *
 * CHECK — gate a composed memo before it is published:
 *
 *   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/build-memo-compose.ts" \
 *     --run-state <run_state.yaml> --decisions <decisions.yaml> --phase4 <connect-opp-setup.md> \
 *     --check <memo.md>
 *
 * Exit 0 = every check ok; 1 = a check failed (each finding printed); 2 = usage.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runMemoChecks, composeMemoFrame, renderFrameHead } from '../lib/build-memo-compose.js';

let runStatePath: string | undefined;
let decisionsPath: string | undefined;
let phase4Path: string | undefined;
let pddPath: string | undefined;
let displayName: string | undefined;
let frameDir: string | undefined;
let checkPath: string | undefined;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--run-state') runStatePath = argv[++i];
  else if (a === '--decisions') decisionsPath = argv[++i];
  else if (a === '--phase4') phase4Path = argv[++i];
  else if (a === '--pdd') pddPath = argv[++i];
  else if (a === '--display-name') displayName = argv[++i];
  else if (a === '--frame') frameDir = argv[++i];
  else if (a === '--check') checkPath = argv[++i];
  else {
    process.stderr.write(`build-memo-compose: unknown argument ${a}\n`);
    process.exit(2);
  }
}

const read = (p: string) => fs.readFileSync(p, 'utf8').replace(/^﻿/, '').replace(/\r/g, '');

if (!runStatePath || !decisionsPath || !phase4Path || (!frameDir && !checkPath)) {
  process.stderr.write(
    'build-memo-compose: need --run-state, --decisions, --phase4, and --frame <dir> or --check <memo.md>\n',
  );
  process.exit(2);
}

const runState = parseYaml(read(runStatePath));
const decisions = ((parseYaml(read(decisionsPath)) as { decisions?: unknown[] })?.decisions ?? []) as unknown[];
const phase4Section = read(phase4Path);

if (frameDir) {
  if (!displayName) {
    process.stderr.write('build-memo-compose: --frame needs --display-name\n');
    process.exit(2);
  }
  const frame = composeMemoFrame({
    runState,
    decisions,
    phase4Section,
    pddText: pddPath ? read(pddPath) : undefined,
    displayName,
  });
  fs.mkdirSync(frameDir, { recursive: true });
  fs.writeFileSync(path.join(frameDir, 'head.md'), renderFrameHead(frame) + '\n');
  fs.writeFileSync(path.join(frameDir, 'appendix.md'), frame.appendix + '\n');
  fs.writeFileSync(
    path.join(frameDir, 'frame.json'),
    JSON.stringify(
      {
        title: frame.title,
        asks: frame.asks,
        gaps: frame.limitations.gaps,
        by_design: frame.limitations.byDesign,
        corrections: frame.corrections,
        glossary: frame.glossary,
      },
      null,
      2,
    ) + '\n',
  );
  process.stdout.write(
    `frame: ${frame.asks.length} decision(s) you own, ${frame.limitations.gaps.length} real gap(s), ` +
      `${frame.limitations.byDesign.length} by-design, ${frame.corrections.length} scope correction(s) -> ${frameDir}\n`,
  );
}

if (checkPath) {
  const pluginRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  let skillNames: string[] = [];
  try {
    skillNames = fs
      .readdirSync(path.join(pluginRoot, 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_') && d.name.includes('-'))
      .map((d) => d.name);
  } catch {
    /* fall back to the lib's skill-name pattern */
  }
  const results = runMemoChecks({ memo: read(checkPath), runState, decisions, phase4Section, skillNames });
  let failed = false;
  for (const [name, r] of Object.entries(results)) {
    process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${name}: ${r.ok ? r.detail : ''}\n`);
    if (!r.ok) {
      failed = true;
      for (const f of r.findings) process.stdout.write(`       - ${f.kind}: ${f.detail}\n`);
    }
  }
  process.exit(failed ? 1 : 0);
}
