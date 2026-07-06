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

/**
 * A labs session can be cookie-fresh (sessionid valid → /labs/overview/ 200)
 * yet have EMPTY organization_data: org_data is populated by the Connect
 * org-list call that fires DURING the OAuth click-through, so a session that
 * shortcut that click-through has `session["labs_oauth"]["organization_data"]`
 * empty. Deep-links then land on the context selector ("No organizations
 * found") with `?opportunity_id=` stripped (jjackson/ace#793).
 *
 * Signal — confirmed against the connect-labs source (dimagi-internal/connect-labs):
 * the `labs_org_data_context` context processor (config/settings/base.py:250 →
 * connect_labs/labs/context.py:358) injects `user_organizations` /
 * `user_programs` / `user_opportunities` = `org_data.get(...)` into EVERY
 * server-rendered template, and `templates/labs/overview.html` renders their
 * counts server-side ("{{ user_organizations|length }} organizations" etc.).
 * So an org_data-empty session serves `/labs/overview/` with a literal
 * "0 organizations" in the HTML — that count is the authoritative in-body
 * signal. (The "No organizations found" string I originally guessed lives in
 * the context selector / picker templates, NOT on the overview page, so the
 * overview body never contains it — the count is the correct marker.)
 *
 * FAIL-SAFE: returns true only when the organizations count is parsed AND is 0.
 * If the count line can't be found (template drift), returns false and the
 * caller keeps today's trust-the-200 behavior — never worse than the prior code.
 */
function overviewShowsEmptyOrgData(body: string): boolean {
  // overview.html summary line, rendered server-side:
  //   <span>...fa-building...</i> N organizations</span>
  // Django may collapse whitespace; match a digit run immediately before the
  // word. This label appears only on the overview summary line.
  const orgs = body.match(/(\d+)\s+organizations\b/);
  if (!orgs) return false; // count not present → don't second-guess the 200
  return Number(orgs[1]) === 0;
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

    // Fast-path probe: if labs already considers us authed AND org_data is
    // populated, skip OAuth. A 200 alone is NOT sufficient — a cookie-fresh
    // session can still have empty organization_data and land on the context
    // selector (jjackson/ace#793); re-auth in that case to repopulate it.
    const probe = await context.request.get(`${labsBaseUrl}/labs/overview/`, {
      maxRedirects: 0,
    });
    let orgDataEmpty = false;
    if (probe.status() === 200) {
      const body = await probe.text().catch(() => '');
      orgDataEmpty = overviewShowsEmptyOrgData(body);
    }
    if (probe.status() === 200 && !orgDataEmpty) {
      log('existing labs session is fresh (org_data populated) — skipping OAuth flow');
    } else {
      if (probe.status() === 200 && orgDataEmpty) {
        log(
          'labs session is cookie-fresh but organization_data is empty ' +
            '(overview shows "0 organizations") — forcing OAuth re-auth to ' +
            'repopulate org_data (#793)',
        );
      } else {
        log(`labs probe returned ${probe.status()} — running OAuth flow`);
      }

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
