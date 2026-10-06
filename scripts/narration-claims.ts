#!/usr/bin/env node
/**
 * Narration ↔ screen, from a unified spec (ace#2727; `lib/narration-on-screen.ts`).
 *
 *   # the authoring check (demo-narrative step 3b): every narrated figure on the end frame
 *   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/narration-claims.ts" \
 *     --spec <unified_spec.yaml> --check
 *
 *   # the per-page ledger of locked claims the Phase 7 Step 3 dispatch carries
 *   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/narration-claims.ts" \
 *     --spec <unified_spec.yaml> --ledger
 *
 * `--check` prints `{ok, findings}` as JSON; `--ledger` prints markdown.
 * Exit 0 always for a readable spec (a finding is a flag the author resolves,
 * not a crash); 2 usage / unreadable spec.
 */
import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  checkNarratedFiguresOnScreen,
  narrationClaimsBySurface,
  renderClaimsLedger,
  type NarratedScene,
} from '../lib/narration-on-screen.js';

const argv = process.argv.slice(2);
let specPath: string | undefined;
let mode: 'check' | 'ledger' | undefined;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--spec') specPath = argv[++i];
  else if (a === '--check') mode = 'check';
  else if (a === '--ledger') mode = 'ledger';
  else {
    process.stderr.write(`narration-claims: unknown argument ${a}\n`);
    process.exit(2);
  }
}
if (!specPath || !mode) {
  process.stderr.write('usage: narration-claims.ts --spec <unified_spec.yaml> (--check | --ledger)\n');
  process.exit(2);
}

let scenes: NarratedScene[];
try {
  const spec = parseYaml(fs.readFileSync(specPath, 'utf8')) as { scenes?: NarratedScene[] } | null;
  scenes = spec?.scenes ?? [];
} catch (e) {
  process.stderr.write(`narration-claims: cannot read ${specPath}: ${(e as Error).message}\n`);
  process.exit(2);
}

if (mode === 'check') process.stdout.write(JSON.stringify(checkNarratedFiguresOnScreen(scenes), null, 2) + '\n');
else process.stdout.write(renderClaimsLedger(narrationClaimsBySurface(scenes)) + '\n');
