/**
 * Validate the 0.6.6 N2 fix end-to-end against live OCS:
 * after composite enrichment, every chatbot in listChatbots should have
 * a non-null experiment_id matching its row in the chatbots table.
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const ENV_FILE = path.join(process.env.HOME!, '.claude/plugins/data/ace-ace/.env');
for (const line of fs.readFileSync(ENV_FILE, 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}

const baseUrl = process.env.OCS_BASE_URL!;
const team = process.env.OCS_TEAM_SLUG!;
const token = process.env.OCS_API_TOKEN!;
const sessionFile = path.join(process.env.HOME!, '.ace', `ocs-session-${team}.json`);

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: sessionFile });

  const { CompositeBackend } = await import('../mcp/ocs/backends/composite.js');
  const { RestBackend } = await import('../mcp/ocs/backends/rest.js');
  const { PlaywrightBackend } = await import('../mcp/ocs/backends/playwright.js');

  const cookies = await ctx.cookies();
  const csrf = cookies.find((c) => c.name === 'csrftoken')?.value ?? '';

  const rest = new RestBackend({ baseUrl, token });
  const playwright = new PlaywrightBackend({
    teamSlug: team,
    baseUrl,
    csrfToken: csrf,
    request: async (method, urlPath, body) => {
      const res = await ctx.request.fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: { 'X-CSRFToken': csrf, Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
        data: body,
      });
      return {
        ok: res.ok(),
        status: res.status(),
        headers: Object.fromEntries(Object.entries(res.headers())),
        text: async () => res.text(),
        json: async () => res.json(),
      };
    },
  });
  const composite = new CompositeBackend({ rest, playwright });

  const out = await composite.listChatbots({ page_size: 5 });
  console.log(`\nReturned ${out.chatbots.length} chatbots:\n`);
  for (const c of out.chatbots) {
    const status = c.experiment_id != null ? '✓' : '✗';
    console.log(`  ${status} experiment_id=${c.experiment_id ?? 'NULL'}  id=${c.id.slice(0, 8)}…  name=${c.name}`);
  }

  const withId = out.chatbots.filter((c) => c.experiment_id != null).length;
  console.log(`\n${withId}/${out.chatbots.length} bots resolved to experiment_id.`);

  await browser.close();
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
