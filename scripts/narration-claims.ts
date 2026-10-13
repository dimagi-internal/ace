#!/usr/bin/env node
/**
 * Narration ↔ screen, from a unified spec (ace#2727; `lib/narration-on-screen.ts`).
 *
 *   # the authoring check (demo-narrative step 3b): every narrated figure on the end frame
 *   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/narration-claims.ts" \
 *     --spec <unified_spec.yaml> --check
 *
 *   # the same, plus every figure against the text the end frame PRINTED (ace#2885).
 *   # <dir> holds scene_<N>_page_text.json (directly or under snapshots/): the output
 *   # of scripts/capture-scene-text.ts, which enters the labs sandbox iframe.
 *   # canopy's own run dir also works, but its capture reads the top page only,
 *   # so a labs report scene reports `screen-text-outer-page-only`.
 *   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/narration-claims.ts" \
 *     --spec <unified_spec.yaml> --check --screen-text <dir>
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
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  checkNarratedFiguresAgainstScreenText,
  checkNarratedFiguresOnScreen,
  narrationClaimsBySurface,
  renderClaimsLedger,
  type NarratedScene,
  type SceneScreenText,
} from '../lib/narration-on-screen.js';

const argv = process.argv.slice(2);
let specPath: string | undefined;
let screenDir: string | undefined;
let mode: 'check' | 'ledger' | undefined;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--spec') specPath = argv[++i];
  else if (a === '--screen-text') screenDir = argv[++i];
  else if (a === '--check') mode = 'check';
  else if (a === '--ledger') mode = 'ledger';
  else {
    process.stderr.write(`narration-claims: unknown argument ${a}\n`);
    process.exit(2);
  }
}
if (!specPath || !mode) {
  process.stderr.write('usage: narration-claims.ts --spec <unified_spec.yaml> (--check [--screen-text <dir>] | --ledger)\n');
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

/** Read `scene_<N>_page_text.json` files, from `<dir>/snapshots/` first as canopy's narrated_numbers does. */
function readCaptures(dir: string): SceneScreenText[] {
  const out: SceneScreenText[] = [];
  for (let n = 1; n <= scenes.length; n++) {
    const candidates = [path.join(dir, 'snapshots', `scene_${n}_page_text.json`), path.join(dir, `scene_${n}_page_text.json`)];
    const file = candidates.find((f) => fs.existsSync(f));
    if (!file) continue;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SceneScreenText>;
    out.push({ scene_index: n, page_text: raw.page_text ?? '', frame_texts: raw.frame_texts });
  }
  return out;
}

if (mode === 'check') {
  const spec = checkNarratedFiguresOnScreen(scenes);
  if (!screenDir) {
    process.stdout.write(JSON.stringify(spec, null, 2) + '\n');
  } else {
    const screen = checkNarratedFiguresAgainstScreenText(scenes, readCaptures(screenDir));
    const findings = [...spec.findings, ...screen.findings];
    process.stdout.write(JSON.stringify({ ok: findings.length === 0, findings }, null, 2) + '\n');
  }
} else process.stdout.write(renderClaimsLedger(narrationClaimsBySurface(scenes)) + '\n');
