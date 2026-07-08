#!/usr/bin/env tsx
/**
 * ace-web Personal Access Token minter (gh-style loopback flow).
 *
 * Backs the `/ace:ace-web-pat-mint` slash command. Mints an
 * ace-web PersonalToken bound to the human operator (the one signed
 * into ace-web in their normal browser), then writes the raw token to
 * `${CLAUDE_PLUGIN_DATA}/.env` as ACE_WEB_PAT_TOKEN inside the
 * "local-only secrets" marker block (so `op inject` preserves it).
 *
 * Replaces the deployment-wide ACE_E2E_AUTH_TOKEN shared secret. See
 * docs/superpowers/specs/2026-05-08-ace-web-per-user-pat-design.md for
 * the full design.
 *
 * Flow (gh / fly / gcloud loopback pattern):
 *   1. Bind 127.0.0.1:RANDOM with a one-shot HTTP listener.
 *   2. Generate a state nonce (32 bytes urlsafe).
 *   3. Open the operator's browser to
 *        ${ACE_WEB_BASE}/auth/cli/authorize/
 *          ?cb=http://127.0.0.1:NNNN/cb&state=<nonce>&label=<label>
 *   4. ace-web (after @login_required bounce if needed) shows a
 *      one-click "Authorize" page. On click, it mints a PersonalToken
 *      and 302-redirects to <cb>?token=<raw>&state=<state>.
 *   5. Listener verifies state, extracts token, writes to .env, returns
 *      "OK you can close this tab" page, shuts down.
 *
 * Usage:
 *   npx tsx scripts/ace-web-pat-mint.ts [label]
 *     label  defaults to `<hostname>-YYYY-MM-DD`
 *
 * Env:
 *   ACE_WEB_BASE   default https://labs.connect.dimagi.com/ace
 *   CLAUDE_PLUGIN_DATA  required
 *
 * Exit codes:
 *   0 success — token written to .env
 *   1 timeout (5 min) — operator never approved
 *   2 state mismatch — possible race with another mint invocation
 *   3 listener error or browser-open failure
 *   4 .env write error
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { promises as fs } from 'node:fs';

import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';

const ACE_WEB_BASE = (process.env.ACE_WEB_BASE || 'https://labs.connect.dimagi.com/ace').replace(/\/$/, '');
const TIMEOUT_MS = 5 * 60 * 1000;
const ENV_KEY = 'ACE_WEB_PAT_TOKEN';
const MARKER_HEADER = '# --- ACE local-only secrets (preserved across op inject) ---';

function defaultLabel(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${hostname().split('.')[0]}-${date}`;
}

function openInBrowser(url: string): void {
  const cmd = platform() === 'darwin' ? 'open'
    : platform() === 'win32' ? 'start'
    : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch (e) {
    console.error(`warn: failed to auto-open browser (${(e as Error).message}); open the URL above manually`);
  }
}

async function captureToken(label: string): Promise<string> {
  const state = randomBytes(32).toString('base64url');
  return new Promise<string>((resolve, reject) => {
    const server = createServer();
    let timer: NodeJS.Timeout;

    server.once('error', (err) => reject(err));
    server.on('request', (req, res) => {
      if (!req.url?.startsWith('/cb')) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const u = new URL(req.url, 'http://127.0.0.1');
      const t = u.searchParams.get('token');
      const s = u.searchParams.get('state');

      if (s !== state) {
        res.statusCode = 400;
        res.end('state mismatch');
        clearTimeout(timer);
        server.close();
        reject(new Error('state mismatch — possible cross-process race'));
        return;
      }
      if (!t) {
        res.statusCode = 400;
        res.end('no token');
        clearTimeout(timer);
        server.close();
        reject(new Error('callback missing token query param'));
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>OK</title>
<style>body{font-family:system-ui;max-width:480px;margin:6rem auto;text-align:center;color:#1a1a1a}
h1{color:#15803d;font-size:1.4rem;margin:0 0 .75rem}
p{color:#555;line-height:1.5}</style>
<h1>Token captured</h1><p>You can close this tab and return to your terminal.</p>`);

      clearTimeout(timer);
      server.close();
      resolve(t);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to bind loopback port'));
        return;
      }
      const cb = `http://127.0.0.1:${addr.port}/cb`;
      const url = `${ACE_WEB_BASE}/auth/cli/authorize/?cb=${encodeURIComponent(cb)}&state=${state}&label=${encodeURIComponent(label)}`;

      console.error(`[1/3] listening on ${cb}`);
      console.error(`[2/3] open this URL in your browser to authorize:\n  ${url}`);
      console.error(`[3/3] waiting up to ${TIMEOUT_MS / 60000} minutes for callback...`);

      openInBrowser(url);

      timer = setTimeout(() => {
        server.close();
        reject(new Error(`timeout — no callback received in ${TIMEOUT_MS / 60000} minutes`));
      }, TIMEOUT_MS);
    });
  });
}

/**
 * Write token to .env in the local-only-secrets marker block.
 * - If the marker block exists and has a line for ENV_KEY, replace just that line.
 * - If the marker block exists without ENV_KEY, append the line inside the block.
 * - If the marker block does not exist, append the full block + line at EOF.
 */
export async function writeTokenToEnv(envPath: string, key: string, value: string): Promise<void> {
  let content = '';
  try {
    content = await fs.readFile(envPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  const newLine = `${key}=${value}`;
  const markerIdx = content.indexOf(MARKER_HEADER);
  const keyRe = new RegExp(`^[ \\t]*${key}=.*$`, 'm');

  if (markerIdx === -1) {
    // No marker block — append it.
    const block =
      (content.length && !content.endsWith('\n') ? '\n' : '') +
      `\n${MARKER_HEADER}\n` +
      `# Set by operator, NOT 1Password-backed. Keys here must NOT appear in .env.tpl;\n` +
      `# bin/ace-setup auto-preserves them on re-inject. Edit values directly in this file.\n` +
      `${newLine}\n`;
    content = content + block;
  } else if (keyRe.test(content)) {
    // Marker block exists and key already present — replace in-place.
    content = content.replace(keyRe, newLine);
  } else {
    // Marker block exists but key absent — append inside the block (= at EOF; the
    // block has no terminator, so appending at EOF is inside it).
    content = content + (content.endsWith('\n') ? '' : '\n') + newLine + '\n';
  }

  await fs.writeFile(envPath, content, { mode: 0o600 });
}

async function main(): Promise<number> {
  // Claude Code does NOT expand ${CLAUDE_PLUGIN_DATA} everywhere (anthropics/
  // claude-code#9427), so never require the env var — resolve the data dir the
  // same way the MCP servers do (env → derive from this file's install path →
  // installed default). Surfaced by agent-review: a mint attempt exited 3 here.
  const claudePluginData =
    resolvePluginDataDir(import.meta.url) ??
    `${process.env.HOME}/.claude/plugins/data/ace-ace`;
  const envPath = `${claudePluginData}/.env`;
  const label = process.argv[2] || defaultLabel();
  console.error(`[mint] label=${label} ace_web_base=${ACE_WEB_BASE}`);

  let token: string;
  try {
    token = await captureToken(label);
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`error: ${msg}`);
    if (msg.includes('timeout')) return 1;
    if (msg.includes('state mismatch')) return 2;
    return 3;
  }

  try {
    await writeTokenToEnv(envPath, ENV_KEY, token);
  } catch (e) {
    console.error(`error: writing ${envPath}: ${(e as Error).message}`);
    return 4;
  }

  console.error(`[done] minted "${label}" (${token.length} chars), wrote ${ENV_KEY} to ${envPath}`);
  console.error(`       /reload-plugins to pick up the new env, then bin/ace-doctor to verify.`);
  return 0;
}

// Only run main when invoked as a script (not when imported by tests).
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main().then((code) => process.exit(code));
}
