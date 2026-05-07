#!/usr/bin/env tsx
/**
 * Labs walkthrough login driver. Invoked by bin/ace-labs-walkthrough-login.
 *
 * Runs the full headless OAuth flow:
 *   1. Launch Chromium, load any existing ~/.ace/labs-session.json.
 *   2. Probe labs /labs/overview/ — if 200, session is fresh; skip login.
 *   3. Else: ensure Connect session via hqOAuthLogin (uses ACE_HQ_*).
 *   4. Drive labs's "Authorize with Connect" click-through.
 *   5. Persist storageState to ~/.ace/labs-session.json.
 *   6. Print a JSON envelope `{statePath, labsHost, cookieCount}` on the
 *      LAST line of stdout so the parent shell can extract paths.
 *
 * Logs go to stderr (so the parent can tee them through). Result JSON is
 * the only stdout content; consumers parse `tail -n 1`.
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { hqOAuthLogin } from '../mcp/connect/auth/hq-oauth-login.js';
import { labsOAuthLogin } from '../mcp/connect-labs/auth/labs-oauth-login.js';
import {
  defaultStateDir,
  resolveSavedStorageState,
  persistStorageState,
} from '../mcp/lib/playwright-session.js';

void fileURLToPath; // keep esmodule import side-effect

function arg(name: string, dflt?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  if (dflt !== undefined) return dflt;
  throw new Error(`missing required arg --${name}`);
}

function log(msg: string): void {
  process.stderr.write(`[labs-walkthrough-login] ${msg}\n`);
}

async function main(): Promise<void> {
  const labsBaseUrl = arg('labs-base-url', 'https://labs.connect.dimagi.com');
  const connectBaseUrl = arg('connect-base-url', 'https://connect.dimagi.com');
  const stateDir = process.env.ACE_STATE_DIR ?? defaultStateDir();
  const statePath = path.join(stateDir, 'labs-session.json');

  const hqUsername = process.env.ACE_HQ_USERNAME;
  const hqPassword = process.env.ACE_HQ_PASSWORD;
  if (!hqUsername || !hqPassword) {
    log('ACE_HQ_USERNAME / ACE_HQ_PASSWORD not in env');
    process.exit(2);
  }

  fs.mkdirSync(stateDir, { recursive: true });
  log(`labs base: ${labsBaseUrl}`);
  log(`connect base: ${connectBaseUrl}`);
  log(`state file: ${statePath}`);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      storageState: resolveSavedStorageState(statePath),
    });

    // Fast-path probe: if labs already considers us authed, skip OAuth.
    const probe = await context.request.get(`${labsBaseUrl}/labs/overview/`, {
      maxRedirects: 0,
    });
    if (probe.status() === 200) {
      log('existing labs session is fresh — skipping OAuth flow');
    } else {
      log(`labs probe returned ${probe.status()} — running OAuth flow`);

      // hqOAuthLogin establishes Connect (connect.dimagi.com) session
      // cookies in this BrowserContext. labsOAuthLogin then drives the
      // labs `/labs/login/` button to swap that Connect session for a
      // labs session.
      await hqOAuthLogin({
        context,
        baseUrl: connectBaseUrl,
        hqUsername,
        hqPassword,
      });
      log('Connect session established via hqOAuthLogin');

      await labsOAuthLogin({ context, labsBaseUrl });
      log('labs session established via Authorize-with-Connect click-through');
    }

    await persistStorageState(context, statePath);
    log(`persisted storageState to ${statePath}`);

    const cookies = await context.cookies();
    const labsHost = new URL(labsBaseUrl).hostname;
    const labsCookies = cookies.filter(
      (c) =>
        c.domain === labsHost ||
        c.domain === '.' + labsHost ||
        labsHost.endsWith('.' + (c.domain ?? '').replace(/^\./, '')),
    );

    // Last line of stdout = result envelope.
    process.stdout.write(
      JSON.stringify({
        statePath,
        labsHost,
        cookieCount: labsCookies.length,
        cookieNames: labsCookies.map((c) => c.name),
      }) + '\n',
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  log(`ERROR: ${err.message}`);
  if (err.stack) log(err.stack);
  process.exit(3);
});
