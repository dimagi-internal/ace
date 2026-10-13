#!/usr/bin/env node
/**
 * Capture each scene's END-FRAME text from a DDD spec, child frames included
 * (ace#2885).
 *
 * Labs draws a report's body in the `/labs/sandbox/render/` iframe. canopy's
 * recorder saves `document.body.innerText` of the TOP page only, which on a labs
 * report is the breadcrumb and the scope picker. Fetching the render URL does not
 * help either: the shell is data-free and receives the report over a
 * MessageChannel bridge. A live browser that enters the frame is the only
 * capture path. This is that path, read-only. It writes the same
 * `scene_<N>_page_text.json` layout canopy writes (N 1-based), plus `frame_texts`
 * and `outer_text`, so `scripts/narration-claims.ts --check --screen-text <out>`
 * reads it.
 *
 *   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/capture-scene-text.ts" \
 *     --spec <demo-run>/7-synthetic/<demo-slug>.yaml \
 *     --realized <demo-run>/7-synthetic/realized.json --out <scratch>/scene-text
 *
 * Per scene: a scene with `url` navigates (its `${var}` filled from
 * realized.json); a follow-on scene stays on the page. It then replays the
 * scene's `wait_for` and `click` actions so the drill the scene shows has
 * happened. Every target resolves exactly as canopy's recorder would, entering
 * the frame where the target does (lib/labs-report-frame.ts). It never replays a
 * click on a scene that declares `restore:`, or a click whose target names a
 * mutating verb, because those change the world. A replay miss is logged and the
 * text is still captured.
 *
 * Auth: the labs session (`~/.ace/labs-session.json`, restored by
 * bin/labs-walkthrough-login.ts), via scripts/browser-sessions.ts.
 * Exit 0 on a completed capture; 2 usage; 1 browser/auth failure.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';
import { parse as parseYaml } from 'yaml';
import { Sessions } from './browser-sessions.js';
import {
  combineFrameTexts,
  isLabsReportSurface,
  isSandboxFrameUrl,
  LABS_SANDBOX_FRAME_SELECTOR,
  recorderTargetToSelector,
  type FrameText,
} from '../lib/labs-report-frame.js';

interface Action {
  kind: string;
  target?: string;
}
interface Scene {
  title?: string;
  url?: string | null;
  actions?: Action[];
  restore?: Action[];
}

const MUTATING_VERB = /\b(draft|create|send|submit|award|approve|reject|delete|discard|publish|invite|assign|archive)\b/i;

const argv = process.argv.slice(2);
const arg = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const specPath = arg('--spec');
const realizedPath = arg('--realized');
const outDir = arg('--out');
if (!specPath || !outDir) {
  process.stderr.write('usage: capture-scene-text.ts --spec <spec.yaml> [--realized <realized.json>] --out <dir>\n');
  process.exit(2);
}

const log = (m: string) => process.stderr.write(`[capture-scene-text] ${m}\n`);
const spec = parseYaml(fs.readFileSync(specPath, 'utf8')) as { base_url?: string; scenes?: Scene[] };
const realized = realizedPath ? (JSON.parse(fs.readFileSync(realizedPath, 'utf8')) as Record<string, unknown>) : {};
const base = spec.base_url ?? 'https://labs.connect.dimagi.com';

function resolveUrl(url: string): string {
  const filled = url.replace(/\$\{([^}]+)\}/g, (m, k: string) => (typeof realized[k] === 'string' ? (realized[k] as string) : m));
  if (filled.includes('${')) throw new Error(`unresolved var in ${url} — pass --realized`);
  return new URL(filled, base).toString();
}

/** Wait until the sandbox frame has drawn text, when the page has one. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
  const hasFrame = await page.waitForSelector(LABS_SANDBOX_FRAME_SELECTOR, { timeout: 15_000 }).then(() => true, () => false);
  if (!hasFrame) return;
  for (let t = 0; t < 60; t++) {
    const f = page.frames().find((fr) => isSandboxFrameUrl(fr.url()));
    const text = f ? await f.evaluate(() => document.body?.innerText ?? '').catch(() => '') : '';
    if (text.trim().length > 0) return;
    await page.waitForTimeout(500);
  }
  log('sandbox frame present but drew no text within 30s');
}

async function replay(page: Page, scene: Scene): Promise<void> {
  const mutating = (scene.restore ?? []).length > 0;
  for (const a of scene.actions ?? []) {
    if (!a.target || (a.kind !== 'wait_for' && a.kind !== 'click')) continue;
    if (a.kind === 'wait_for' && /^\d+$/.test(a.target.trim())) continue;
    if (a.kind === 'click' && (mutating || MUTATING_VERB.test(a.target))) {
      log(`  skip click ${a.target} (mutating)`);
      continue;
    }
    const loc = page.locator(recorderTargetToSelector(a.target)).first();
    try {
      if (a.kind === 'wait_for') await loc.waitFor({ state: 'visible', timeout: 20_000 });
      else {
        await loc.click({ timeout: 20_000 });
        await page.waitForTimeout(800);
      }
    } catch (e) {
      log(`  ${a.kind} ${a.target} missed: ${(e as Error).message.split('\n')[0]}`);
    }
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(outDir!, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const sessions = new Sessions(browser, outDir!); // stateDir is used only for a connect session
  try {
    const ctx = await sessions.context('labs');
    const page = await ctx.newPage();
    const scenes = spec.scenes ?? [];
    let surface: string | null | undefined = null;
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      const n = i + 1;
      if (s.url) {
        surface = s.url;
        const url = resolveUrl(s.url);
        log(`scene ${n}: goto ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await settle(page);
      }
      await replay(page, s);
      const outer = await page.evaluate(() => document.body?.innerText ?? '');
      const frame_texts: FrameText[] = [];
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        frame_texts.push({ url: f.url(), text: await f.evaluate(() => document.body?.innerText ?? '').catch(() => '') });
      }
      const page_text = combineFrameTexts(outer, frame_texts);
      fs.writeFileSync(
        path.join(outDir!, `scene_${n}_page_text.json`),
        JSON.stringify(
          { scene_index: n, url: page.url(), title: s.title ?? `Scene ${n}`, page_text, outer_text: outer, frame_texts, captured_by: 'ace scripts/capture-scene-text.ts' },
          null,
          2,
        ),
      );
      const framed = frame_texts.some((f) => isSandboxFrameUrl(f.url));
      log(`scene ${n}: outer ${outer.length} chars, ${frame_texts.length} frame(s)${framed ? ' incl. sandbox' : ''}`);
      if (isLabsReportSurface(surface) && !framed) log(`scene ${n}: labs surface with NO sandbox frame (pre-sandbox page, or the frame did not load)`);
    }
  } finally {
    await sessions.close();
    await browser.close();
  }
}

main().catch((e) => {
  log(`failed: ${(e as Error).message}`);
  process.exit(1);
});
