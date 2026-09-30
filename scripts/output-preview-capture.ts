#!/usr/bin/env npx tsx
/**
 * Output preview capture — the browser half of `skills/output-preview-capture`.
 *
 *   npx tsx scripts/output-preview-capture.ts gaps    --opp O --run R [--phase P] [--workspace W]
 *   npx tsx scripts/output-preview-capture.ts capture --opp O --run R --captured-phase P --out DIR
 *                                                     [--phase P] [--run-end] [--workspace W]
 *                                                     [--run-state FILE] [--test-prompts FILE]
 *                                                     [--gaps-json FILE] [--only <gap-id>]
 *   npx tsx scripts/output-preview-capture.ts index   --plan DIR/plan.json --gap <gap-id> --uploaded FILE
 *   npx tsx scripts/output-preview-capture.ts verify  --plan DIR/plan.json --gap <gap-id> --readback FILE --count N
 *
 * `gaps` prints ace-web's gap list for the run (GET …/preview-gaps with the
 * ace-web PAT — the same `ACE_WEB_BASE_URL` / `ACE_WEB_PAT_TOKEN` pair
 * `bin/ace-bind` and `fork-run` use).
 *
 * `capture` photographs every selected gap into DIR/<slug>/NN-<step>.png and
 * writes DIR/plan.json — per gap: the target folder, the frames with their
 * captions and a deterministic screen verdict (login page / 404 / blank /
 * loading), or why nothing was captured. It never writes to Drive: the skill
 * LOOKS at every frame, uploads the good ones, then calls `index`.
 *
 * `index` turns the uploaded frames (`[{name, file_id}]`, JSON) into
 * DIR/<slug>/_previews.yaml; `verify` asserts the copy read back from Drive.
 *
 * Sessions — all headless, all restored rather than assumed (CLAUDE.md
 * § Phase preconditions are restored, not adapted):
 *   connect, hq  PlaywrightSession (mcp/connect/auth) — the ace-connect MCP's own
 *                session: probes Connect AND HQ, re-logs-in via ACE_HQ_USERNAME /
 *                ACE_HQ_PASSWORD, persists ~/.ace/connect-session.json.
 *   labs         bin/labs-walkthrough-login.ts, run once before the first labs gap
 *                (Phase 7 Step 3.0's restore) → ~/.ace/labs-session.json.
 *   canopy       canopy PAT as a Bearer header: CANOPY_WEB_PAT, else
 *                ~/.<CANOPY_AGENT|ace>/.env CANOPY_WEB_PAT, else
 *                ~/.claude/canopy/workbench-token — canopy's own resolution order.
 *   ocs          none — the chatbot's PUBLIC chat page is anonymous by design.
 *   google       the Drive service account (gws-sa-key.json), no browser session.
 *   public       none.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { google } from '../lib/google-shim.js';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import { PlaywrightSession } from '../mcp/connect/auth/playwright-session.js';
import { assertPreviewsIndexReadable, outputSlug, serializePreviewsIndex } from '../lib/output-previews.js';
import {
  buildCaptureIndex,
  captureFileName,
  parsePreviewGaps,
  pickChatQuestion,
  planCapture,
  previewGapsUrl,
  productNodeAt,
  screenPage,
  selectGaps,
  CAPTURED_BY,
  type CapturePlan,
  type PageSignals,
  type PreviewAuth,
  type PreviewGap,
  type ScreenResult,
  type Shot,
} from '../lib/preview-capture.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';

// Before any credential read: a Bash-launched script inherits none of ACE's .env (ace#1957).
loadPluginEnv(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWPORT = { width: 1440, height: 900 };
const CHAT_VIEWPORT = { width: 1280, height: 900 };

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const [, , cmd, ...rest] = process.argv;
function arg(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && i + 1 < rest.length ? rest[i + 1] : undefined;
}
function flag(name: string): boolean {
  return rest.includes(`--${name}`);
}
function need(name: string): string {
  const v = arg(name);
  if (!v) die(`missing --${name}`);
  return v as string;
}
function die(msg: string): never {
  process.stderr.write(`output-preview-capture: ${msg}\n`);
  process.exit(2);
}
function log(msg: string): void {
  process.stderr.write(`[output-preview-capture] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// ace-web
// ---------------------------------------------------------------------------

async function fetchGaps(opp: string, run: string): Promise<ReturnType<typeof parsePreviewGaps>> {
  const local = arg('gaps-json');
  if (local) return parsePreviewGaps(JSON.parse(fs.readFileSync(local, 'utf8')));
  const base = process.env.ACE_WEB_BASE_URL;
  const token = process.env.ACE_WEB_PAT_TOKEN;
  const workspace = arg('workspace') ?? process.env.ACE_WEB_WORKSPACE;
  if (!base || !token) die('ACE_WEB_BASE_URL and ACE_WEB_PAT_TOKEN are required (run /ace:setup — it writes ACE’s own ace-web token)');
  if (!workspace) die('no workspace: pass --workspace or set ACE_WEB_WORKSPACE in the plugin .env');
  const url = previewGapsUrl(base as string, workspace as string, opp, run);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) die(`GET ${url} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return parsePreviewGaps(await res.json());
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

class Sessions {
  private contexts = new Map<PreviewAuth, BrowserContext>();
  private connectSession?: PlaywrightSession;
  private labsRestored = false;
  constructor(private browser: Browser, private stateDir: string) {}

  async context(auth: PreviewAuth, fresh = false): Promise<BrowserContext> {
    const key: PreviewAuth = auth === 'hq' ? 'connect' : auth;
    if (fresh) {
      await this.contexts.get(key)?.close().catch(() => {});
      this.contexts.delete(key);
      if (key === 'connect') {
        await this.connectSession?.close().catch(() => {});
        this.connectSession = undefined;
      }
      if (key === 'labs') this.labsRestored = false;
    }
    const have = this.contexts.get(key);
    if (have) return have;
    const ctx = await this.open(key);
    this.contexts.set(key, ctx);
    return ctx;
  }

  private async open(auth: PreviewAuth): Promise<BrowserContext> {
    if (auth === 'connect') {
      this.connectSession = new PlaywrightSession({
        baseUrl: process.env.CONNECT_BASE_URL || 'https://connect.dimagi.com',
        cchqBaseUrl: process.env.ACE_HQ_BASE_URL || 'https://www.commcarehq.org',
        hqUsername: process.env.ACE_HQ_USERNAME,
        hqPassword: process.env.ACE_HQ_PASSWORD,
      });
      const authed = await this.connectSession.getContext();
      const statePath = path.join(this.stateDir, 'connect-state.json');
      await authed.storageState({ path: statePath });
      return this.browser.newContext({ viewport: VIEWPORT, storageState: statePath });
    }
    if (auth === 'labs') {
      if (!this.labsRestored) restoreLabsSession();
      this.labsRestored = true;
      return this.browser.newContext({ viewport: VIEWPORT, storageState: path.join(os.homedir(), '.ace', 'labs-session.json') });
    }
    if (auth === 'canopy') {
      const token = canopyToken();
      if (!token) throw new Error('no canopy PAT (CANOPY_WEB_PAT, ~/.ace/.env, or ~/.claude/canopy/workbench-token)');
      return this.browser.newContext({ viewport: VIEWPORT, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    }
    return this.browser.newContext({ viewport: auth === 'ocs' ? CHAT_VIEWPORT : VIEWPORT });
  }

  async close(): Promise<void> {
    for (const c of this.contexts.values()) await c.close().catch(() => {});
    await this.connectSession?.close().catch(() => {});
  }
}

/** Phase 7 Step 3.0's restore — unconditional, never probe-first. */
function restoreLabsSession(): void {
  const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const r = spawnSync(
    process.execPath,
    [tsx, path.join(ROOT, 'bin', 'labs-walkthrough-login.ts'), '--connect-base-url', process.env.CONNECT_BASE_URL || 'https://connect.dimagi.com', '--labs-base-url', 'https://labs.connect.dimagi.com'],
    { env: process.env, encoding: 'utf8', timeout: 180_000 },
  );
  if (r.status !== 0) throw new Error(`labs login failed (exit ${r.status}): ${(r.stderr || '').split('\n').filter(Boolean).slice(-3).join(' | ')}`);
  log('labs session restored');
}

function canopyToken(): string | null {
  if (process.env.CANOPY_WEB_PAT) return process.env.CANOPY_WEB_PAT.trim();
  const slug = /^[a-z0-9][a-z0-9_-]*$/i.test(process.env.CANOPY_AGENT ?? '') ? (process.env.CANOPY_AGENT as string) : 'ace';
  try {
    for (const line of fs.readFileSync(path.join(os.homedir(), `.${slug}`, '.env'), 'utf8').split('\n')) {
      if (line.trim().startsWith('CANOPY_WEB_PAT=')) return line.trim().slice('CANOPY_WEB_PAT='.length).replace(/^["']|["']$/g, '');
    }
  } catch { /* fall through */ }
  try {
    return fs.readFileSync(path.join(os.homedir(), '.claude', 'canopy', 'workbench-token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

interface FrameOut {
  path: string;
  name: string;
  step: string;
  caption: string;
  screen: ScreenResult;
}

interface GapOut {
  gap: PreviewGap;
  folder: string;
  slug: string;
  auth: PreviewAuth;
  url: string | null;
  status: 'captured' | 'skipped' | 'failed';
  reason?: string;
  frames: FrameOut[];
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2_500);
  // A report still drawing: wait (bounded) while the page is short and says so.
  for (let i = 0; i < 10; i++) {
    const t = await bodyText(page);
    if (!(t.length < 400 && /\bloading\b|please wait/i.test(t))) break;
    await page.waitForTimeout(2_000);
  }
}

async function bodyText(page: Page): Promise<string> {
  return ((await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')) as string).replace(/\s+/g, ' ').trim();
}

async function signals(page: Page, status: number): Promise<PageSignals> {
  return { status, finalUrl: page.url(), title: await page.title().catch(() => ''), text: await bodyText(page) };
}

/** Hide fixed/sticky chrome that would otherwise paint across an element shot. */
async function hideFloating(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') el.style.visibility = 'hidden';
    }
  });
}

async function shoot(page: Page, shot: Shot, file: string): Promise<string | null> {
  if (shot.mode === 'viewport') {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: file });
    return null;
  }
  const exact = page.getByText(shot.text ?? '', { exact: true });
  const loc = (await exact.count()) > 0 ? exact.first() : page.getByText(shot.text ?? '').first();
  if ((await loc.count()) === 0) return `text ${JSON.stringify(shot.text)} not on the page`;
  if (shot.mode === 'scroll-to-text') {
    await loc.evaluate((el) => {
      el.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -96);
    });
    await page.waitForTimeout(800);
    await page.screenshot({ path: file });
    return null;
  }
  // card: the nearest ancestor that LOOKS like a card (shadow, or a rounded
  // filled box) and is narrower than the page; else the first tall ancestor.
  const handle = await loc.evaluateHandle((el, vw) => {
    let e: HTMLElement | null = el as HTMLElement;
    let tall: HTMLElement | null = null;
    for (let i = 0; i < 12 && e && e !== document.body; i++) {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      const filled = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
      const cardLike = cs.boxShadow !== 'none' || (filled && cs.borderRadius !== '0px');
      if (r.width < vw * 0.9 && r.height >= 120 && cardLike) return e;
      if (!tall && r.height >= 180 && r.width < vw * 0.9) tall = e;
      e = e.parentElement;
    }
    return tall ?? el;
  }, VIEWPORT.width);
  await hideFloating(page);
  await handle.asElement()!.scrollIntoViewIfNeeded();
  await handle.asElement()!.screenshot({ path: file });
  return null;
}

async function capturePage(ctx: BrowserContext, plan: CapturePlan, dir: string): Promise<{ frames: FrameOut[]; fail?: string }> {
  const page = await ctx.newPage();
  try {
    const res = await page.goto(plan.url as string, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await settle(page);
    const sig = await signals(page, res?.status() ?? 0);
    const screen = screenPage(sig);
    if (!screen.ok) return { frames: [], fail: `${screen.reason}: ${screen.detail}` };
    const frames: FrameOut[] = [];
    let n = 0;
    for (const shot of plan.shots) {
      const name = captureFileName(n + 1, shot);
      const file = path.join(dir, name);
      const miss = await shoot(page, shot, file);
      if (miss) {
        log(`${plan.gap.id}: shot ${shot.step} skipped — ${miss}`);
        continue;
      }
      n += 1;
      frames.push({ path: file, name, step: shot.step, caption: shot.caption, screen });
    }
    return frames.length ? { frames } : { frames, fail: 'no shot landed' };
  } finally {
    await page.close().catch(() => {});
  }
}

async function captureChat(ctx: BrowserContext, plan: CapturePlan, dir: string): Promise<{ frames: FrameOut[]; fail?: string }> {
  const page = await ctx.newPage();
  try {
    const res = await page.goto(plan.url as string, { waitUntil: 'networkidle', timeout: 60_000 });
    const pre = screenPage(await signals(page, res?.status() ?? 0));
    if (!pre.ok && pre.reason !== 'blank') return { frames: [], fail: `${pre.reason}: ${pre.detail}` };
    const input = page.locator('input[name=message], textarea[name=message]').first();
    if ((await input.count()) === 0) return { frames: [], fail: 'no chat input on the public page' };
    const bot = page.locator('#message-list .chat-message-system');
    const before = await bot.count();
    await input.fill(plan.question as string);
    await page.locator('#message-submit, button[type=submit]').first().click();
    let last = '';
    let stable = 0;
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(2_000);
      const n = await bot.count();
      const txt = n > before ? await bot.last().innerText() : '';
      if (n > before && txt.trim().length > 20 && txt === last) {
        if (++stable >= 2) break;
      } else stable = 0;
      last = txt;
    }
    if (last.trim().length <= 20) return { frames: [], fail: 'the bot did not answer within 120s' };
    if (/something went wrong|intermittent error/i.test(last)) return { frames: [], fail: `the bot answered with an error: ${last.slice(0, 120)}` };
    const shot = plan.shots[0];
    const name = captureFileName(1, shot);
    const file = path.join(dir, name);
    await page.screenshot({ path: file });
    return { frames: [{ path: file, name, step: shot.step, caption: shot.caption, screen: { ok: true } }] };
  } finally {
    await page.close().catch(() => {});
  }
}

function saKeyPath(): string {
  const env = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (env && fs.existsSync(env)) return env;
  const data = resolvePluginDataDir(import.meta.url);
  const p = data ? path.join(data, 'gws-sa-key.json') : '';
  if (p && fs.existsSync(p)) return p;
  throw new Error('no Drive service-account key (gws-sa-key.json) — run /ace:setup');
}

async function captureDriveFile(browser: Browser, plan: CapturePlan, dir: string): Promise<{ frames: FrameOut[]; fail?: string }> {
  const fileId = plan.gap.file_id ?? /\/d\/([A-Za-z0-9_-]{10,})|[?&]id=([A-Za-z0-9_-]{10,})/.exec(plan.gap.url ?? '')?.slice(1).find(Boolean);
  if (!fileId) return { frames: [], fail: 'no Drive file id' };
  const auth = new google.auth.GoogleAuth({ keyFile: saKeyPath(), scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const drive = google.drive({ version: 'v3', auth });
  const meta = await drive.files.get({ fileId, fields: 'name,mimeType,thumbnailLink', supportsAllDrives: true });
  const mime = meta.data.mimeType ?? '';
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  try {
    if (mime === 'text/html') {
      const body = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
      const html = path.join(dir, '_source.html');
      fs.writeFileSync(html, String(body.data));
      await page.goto(`file://${html}`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(2_000);
      fs.rmSync(html, { force: true });
    } else {
      let bytes: Buffer | null = null;
      let type = mime;
      if (mime.startsWith('image/')) {
        const r = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
        bytes = Buffer.from(r.data as ArrayBuffer);
      } else if (meta.data.thumbnailLink) {
        const token = (await auth.getAccessToken()) as string | null;
        const r = await fetch(meta.data.thumbnailLink.replace(/=s\d+$/, '=s1600'), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (r.ok) {
          bytes = Buffer.from(await r.arrayBuffer());
          type = r.headers.get('content-type') ?? 'image/png';
        }
      }
      if (!bytes) return { frames: [], fail: `Drive has no thumbnail for ${meta.data.name} (${mime})` };
      await page.setContent(`<body style="margin:0;background:#fff"><img id="t" style="max-width:1440px;display:block" src="data:${type};base64,${bytes.toString('base64')}"></body>`);
      await page.waitForTimeout(500);
    }
    const shot = plan.shots[0];
    const name = captureFileName(1, shot);
    const file = path.join(dir, name);
    const img = page.locator('#t');
    if ((await img.count()) > 0) await img.screenshot({ path: file });
    else await page.screenshot({ path: file });
    return { frames: [{ path: file, name, step: shot.step, caption: `${meta.data.name} — ${shot.caption.split(' — ').pop()}`, screen: { ok: true } }] };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function runCapture(): Promise<void> {
  const opp = need('opp');
  const run = need('run');
  const capturedPhase = need('captured-phase');
  const out = path.resolve(need('out'));
  fs.mkdirSync(out, { recursive: true });

  const list = await fetchGaps(opp, run);
  const sel = selectGaps(list.outputs, { phaseFilter: arg('phase'), capturedPhase, runEnd: flag('run-end') });
  const only = arg('only');
  const capture = only ? sel.capture.filter((g) => g.id === only) : sel.capture;

  const runStatePath = arg('run-state');
  const runState = runStatePath ? parseYaml(fs.readFileSync(runStatePath, 'utf8')) : null;
  const promptsPath = arg('test-prompts');
  const chatQuestion = promptsPath ? pickChatQuestion(fs.readFileSync(promptsPath, 'utf8')) : null;

  const browser = await chromium.launch({ headless: true });
  const sessions = new Sessions(browser, out);
  const results: GapOut[] = [];
  try {
    for (const gap of capture) {
      const plan = planCapture(gap, { product: productNodeAt(runState, gap.phase, gap.output_key), chatQuestion });
      const slug = outputSlug(gap.output_key);
      const dir = path.join(out, slug);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const base: GapOut = { gap, folder: plan.folder, slug, auth: plan.auth, url: plan.url, status: 'skipped', frames: [] };
      if (plan.skip) {
        results.push({ ...base, reason: plan.skip });
        log(`${gap.id}: skipped — ${plan.skip}`);
        continue;
      }
      let outcome: { frames: FrameOut[]; fail?: string } = { frames: [], fail: 'not attempted' };
      // One retry: re-open the session from scratch (re-login) and wait longer.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (plan.strategy === 'drive-file') outcome = await captureDriveFile(browser, plan, dir);
          else {
            const ctx = await sessions.context(plan.auth, attempt > 1);
            outcome = plan.strategy === 'ocs-chat' ? await captureChat(ctx, plan, dir) : await capturePage(ctx, plan, dir);
          }
        } catch (err) {
          outcome = { frames: [], fail: (err as Error).message.split('\n')[0] };
        }
        if (outcome.frames.length) break;
        log(`${gap.id}: attempt ${attempt} failed — ${outcome.fail}`);
      }
      results.push(
        outcome.frames.length
          ? { ...base, status: 'captured', frames: outcome.frames }
          : { ...base, status: 'failed', reason: outcome.fail },
      );
      log(`${gap.id}: ${outcome.frames.length ? `${outcome.frames.length} frame(s)` : `FAILED — ${outcome.fail}`}`);
    }
  } finally {
    await sessions.close();
    await browser.close();
  }

  const plan = {
    opp,
    run,
    captured_by: CAPTURED_BY,
    captured_phase: capturedPhase,
    captured_at: new Date().toISOString(),
    out,
    gaps: results,
    deferred: sel.deferred.map((d) => ({ id: d.gap.id, why: d.why })),
  };
  fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify(plan, null, 2));
  const summary = {
    plan: path.join(out, 'plan.json'),
    captured: results.filter((r) => r.status === 'captured').map((r) => ({ id: r.gap.id, frames: r.frames.map((f) => f.path) })),
    failed: results.filter((r) => r.status === 'failed').map((r) => ({ id: r.gap.id, reason: r.reason })),
    skipped: results.filter((r) => r.status === 'skipped').map((r) => ({ id: r.gap.id, reason: r.reason })),
    deferred: plan.deferred,
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
}

// ---------------------------------------------------------------------------
// index / verify
// ---------------------------------------------------------------------------

function loadGap(planPath: string, id: string): { plan: { captured_phase: string; captured_at: string; out: string }; g: GapOut } {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const g = (plan.gaps as GapOut[]).find((x) => x.gap.id === id);
  if (!g) die(`gap ${id} is not in ${planPath}`);
  return { plan, g: g as GapOut };
}

function runIndex(): void {
  const { plan, g } = loadGap(need('plan'), need('gap'));
  const uploaded = JSON.parse(fs.readFileSync(need('uploaded'), 'utf8')) as Array<{ name: string; file_id: string }>;
  if (!Array.isArray(uploaded) || uploaded.length === 0) die('--uploaded must be a non-empty JSON list of {name, file_id}');
  const frames = uploaded.map((u) => {
    const f = g.frames.find((x) => x.name === u.name);
    if (!f) die(`${u.name} is not a frame of ${g.gap.id}`);
    return { file_id: u.file_id, name: u.name, caption: (f as FrameOut).caption };
  });
  const index = buildCaptureIndex(g.gap, plan.captured_phase, plan.captured_at, frames);
  const file = path.join(plan.out, g.slug, '_previews.yaml');
  fs.writeFileSync(file, serializePreviewsIndex(index));
  process.stdout.write(JSON.stringify({ path: file, folder: g.folder, items: index.items.length }) + '\n');
}

function runVerify(): void {
  const { g } = loadGap(need('plan'), need('gap'));
  const text = fs.readFileSync(need('readback'), 'utf8');
  const r = assertPreviewsIndexReadable(text, {
    folderSlug: g.slug,
    phase: g.gap.phase,
    outputKey: g.gap.output_key,
    capturedBy: CAPTURED_BY,
    expectedCount: Number(need('count')),
  });
  process.stdout.write(JSON.stringify({ ok: r.ok, findings: r.findings }) + '\n');
  if (!r.ok) process.exit(1);
}

async function runGaps(): Promise<void> {
  const list = await fetchGaps(need('opp'), need('run'));
  const phase = arg('phase');
  const sel = phase ? selectGaps(list.outputs, { phaseFilter: phase, capturedPhase: phase, runEnd: true }).capture : list.outputs;
  process.stdout.write(JSON.stringify({ run_id: list.run_id, covered: list.covered, outputs: sel }) + '\n');
}

async function main(): Promise<void> {
  if (cmd === 'gaps') return runGaps();
  if (cmd === 'capture') return runCapture();
  if (cmd === 'index') return runIndex();
  if (cmd === 'verify') return runVerify();
  die('usage: output-preview-capture.ts gaps|capture|index|verify … (see the header)');
}

main().catch((err) => {
  process.stderr.write(`output-preview-capture: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
