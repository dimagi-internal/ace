#!/usr/bin/env npx tsx
/**
 * Make a rebuilt labs-only program a labs WORKSPACE and list Connect orgs as
 * its LLOs — `clone-to-new-workspace` § 4c step 6 (ace#3020).
 *
 *   npx tsx scripts/labs-workspace-setup.ts --program-id 10300 \
 *     --llo noora-health-nm-test --llo noora-health-pm-test [--dry-run]
 *
 * Prints `{program_id, is_workspace, llos, done: [...]}` read back from the page
 * AFTER the writes; exit 0 only when the page shows a workspace listing every
 * `--llo`. Idempotent: an LLO already listed is not re-added, and nothing is
 * ever removed.
 *
 * Why HTTP and not an MCP atom: labs has none for workspace roles (connect-labs#2572). The settings page is a Dimagi-only Django form;
 * ace@dimagi-ai.com is a Dimagi sign-in. Mechanics (`lib/labs-workspace.ts`):
 * the labs UI session from `/ace:labs-login` (`~/.ace/labs-session.json`), the
 * CSRF token read from the rendered page (labs sets no csrftoken cookie —
 * `lib/labs-run-state-reset.ts`), one urlencoded POST per action.
 */
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LABS_BASE_URL, extractCsrfToken } from '../lib/labs-run-state-reset.js';
import { parseWorkspacePage, workspaceFormBody, workspaceSettingsPath, workspaceSteps } from '../lib/labs-workspace.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';

loadPluginEnv(import.meta.url);

function fail(msg: string): never {
  process.stderr.write(`[labs-workspace-setup] ERROR: ${msg}\n`);
  process.exit(1);
}

function argv(): { programId: number; llos: string[]; dryRun: boolean; session: string; base: string } {
  const a = process.argv.slice(2);
  const llos: string[] = [];
  let programId = NaN;
  let dryRun = false;
  let session = path.join(os.homedir(), '.ace', 'labs-session.json');
  let base = process.env.LABS_BASE_URL || LABS_BASE_URL;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--program-id') programId = Number(a[++i]);
    else if (a[i] === '--llo') llos.push(a[++i]);
    else if (a[i] === '--dry-run') dryRun = true;
    else if (a[i] === '--session') session = a[++i];
    else if (a[i] === '--base-url') base = a[++i];
    else fail(`unknown argument ${a[i]}`);
  }
  if (!Number.isInteger(programId) || programId < 10000) fail('--program-id must be a labs-only program id (>= 10000)');
  if (!llos.length) fail('give at least one --llo <connect org slug>');
  return { programId, llos, dryRun, session, base: base.replace(/\/+$/, '') };
}

function cookieHeader(sessionPath: string, baseUrl: string): string {
  let raw: string;
  try {
    raw = readFileSync(sessionPath, 'utf8');
  } catch {
    return fail(`no labs session at ${sessionPath} — run /ace:labs-login first`);
  }
  const state = JSON.parse(raw) as { cookies?: Array<{ name: string; value: string; domain?: string }> };
  const host = new URL(baseUrl).hostname;
  const cookies = (state.cookies ?? []).filter((c) => {
    const d = (c.domain ?? '').replace(/^\./, '');
    return d === '' || host === d || host.endsWith(`.${d}`);
  });
  if (!cookies.length) fail(`labs session at ${sessionPath} carries no cookies for ${host}`);
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function main(): Promise<void> {
  const { programId, llos, dryRun, session, base } = argv();
  const cookie = cookieHeader(session, base);
  const url = `${base}${workspaceSettingsPath(programId)}`;
  const read = async () => {
    const res = await fetch(url, { headers: { Cookie: cookie }, redirect: 'follow' });
    const html = await res.text();
    if (res.status !== 200) fail(`GET ${url} → HTTP ${res.status} (404 = not a labs-only program, or this sign-in is not Dimagi staff)`);
    return { html, state: parseWorkspacePage(html) };
  };
  let { html, state } = await read();
  const steps = workspaceSteps(state, llos);
  const done: string[] = [];
  if (!dryRun) {
    for (const step of steps) {
      const token = extractCsrfToken(html);
      if (!token) fail(`no csrfmiddlewaretoken on ${url} — re-run /ace:labs-login`);
      const body = step.action === 'turn_on' ? workspaceFormBody(token, 'turn_on') : workspaceFormBody(token, 'add_llo', { slug: step.slug });
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(url, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Referer: url },
        body,
        redirect: 'manual',
      });
      if (res.status !== 302 && res.status !== 303) fail(`POST ${step.action} → HTTP ${res.status} (expected a redirect back to the page)`);
      done.push(step.action === 'turn_on' ? 'turn_on' : `add_llo:${step.slug}`);
      // eslint-disable-next-line no-await-in-loop
      ({ html, state } = await read()); // the page is the read-back, and the next token
    }
  }
  const missing = workspaceSteps(state, llos);
  process.stdout.write(JSON.stringify({ program_id: programId, is_workspace: state.is_workspace, llos: state.llos, done, planned: dryRun ? steps : undefined }) + '\n');
  if (!dryRun && missing.length) fail(`after the writes the page still needs ${JSON.stringify(missing)} — a refused turn_on names its reason on the page (e.g. the organisation holds another program)`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
