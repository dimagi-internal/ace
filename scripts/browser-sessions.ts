/**
 * Headless browser sessions for every host an ACE run's outputs live on —
 * shared by `scripts/output-preview-capture.ts` and `scripts/release-readiness.ts` (validate-release-readiness)
 * so the two never disagree about how a session is obtained.
 *
 *   connect, hq  PlaywrightSession (mcp/connect/auth) — probes Connect AND HQ,
 *                re-logs-in via ACE_HQ_USERNAME / ACE_HQ_PASSWORD.
 *   labs         bin/labs-walkthrough-login.ts, run once, unconditionally
 *                (Phase 7 Step 3.0's restore) → ~/.ace/labs-session.json.
 *   canopy       ACE's OWN canopy PAT as a Bearer header — CANOPY_WEB_PAT read from
 *                ACE's .env only (the same source bin/ace-canopy-web uses). Never an
 *                inherited CANOPY_WEB_PAT and never the machine owner's workbench
 *                token: both can belong to a human (ace#2805).
 *   ocs, public  anonymous.
 *
 */
import type { Browser, BrowserContext } from 'playwright';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlaywrightSession } from '../mcp/connect/auth/playwright-session.js';
import type { PreviewAuth } from '../lib/preview-capture.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';

// Idempotent; a caller that already loaded it loses nothing (ace#1957).
loadPluginEnv(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VIEWPORT = { width: 1440, height: 900 };
export const CHAT_VIEWPORT = { width: 1280, height: 900 };

function log(msg: string): void {
  process.stderr.write(`[browser-sessions] ${msg}\n`);
}

export class Sessions {
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
      if (!token) throw new Error(`no CANOPY_WEB_PAT in ACE's .env (${aceEnvFiles().join(', ')}) — run /ace:setup. ACE reads canopy-web as itself, never as the machine owner (ace#2805).`);
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
export function restoreLabsSession(): void {
  const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const r = spawnSync(
    process.execPath,
    [tsx, path.join(ROOT, 'bin', 'labs-walkthrough-login.ts'), '--connect-base-url', process.env.CONNECT_BASE_URL || 'https://connect.dimagi.com', '--labs-base-url', 'https://labs.connect.dimagi.com'],
    { env: process.env, encoding: 'utf8', timeout: 180_000 },
  );
  if (r.status !== 0) throw new Error(`labs login failed (exit ${r.status}): ${(r.stderr || '').split('\n').filter(Boolean).slice(-3).join(' | ')}`);
  log('labs session restored');
}

/** ACE's .env files, in the order bin/ace-canopy-web reads them. */
export function aceEnvFiles(): string[] {
  if (process.env.ACE_ENV_FILE) return [process.env.ACE_ENV_FILE];
  return [path.join(os.homedir(), '.claude', 'plugins', 'data', 'ace-ace', '.env'), path.join(os.homedir(), '.ace', '.env')];
}

/**
 * ACE's own canopy-web PAT, from ACE's .env ONLY — the same source as bin/ace-canopy-web.
 * Deliberately ignores an inherited CANOPY_WEB_PAT and never falls back to
 * ~/.claude/canopy/workbench-token: either can be the machine owner's, and an agent reading
 * as a human is the identity substitution behind ace#2805.
 */
export function canopyToken(): string | null {
  for (const f of aceEnvFiles()) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const t = line.trim();
        if (t.startsWith('CANOPY_WEB_PAT=')) {
          const v = t.slice('CANOPY_WEB_PAT='.length).trim().replace(/^["']|["']$/g, '');
          if (v) return v;
        }
      }
    } catch { /* next file */ }
  }
  return null;
}

