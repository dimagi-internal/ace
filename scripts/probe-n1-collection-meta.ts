/**
 * N1 deeper probe: compare metadata of collection 350 (works with the variable)
 * vs collection 365 (rejects the variable). Same LLM-node params otherwise.
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
const sessionFile = path.join(process.env.HOME!, '.ace', `ocs-session-${team}.json`);

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: sessionFile });

  for (const id of [350, 365]) {
    console.log(`\n=== Collection ${id} ===`);
    // Try the edit page (HTML)
    const editRes = await ctx.request.fetch(`${baseUrl}/a/${team}/documents/collections/${id}/edit`, { failOnStatusCode: false });
    console.log(`edit page status: ${editRes.status()}`);
    if (editRes.ok()) {
      const html = await editRes.text();
      // Look for is_index / is_remote_index / summary etc in form fields
      const fields = ['is_index', 'is_remote_index', 'name', 'summary', 'llm_provider', 'embedding_model'];
      for (const f of fields) {
        const m = html.match(new RegExp(`name="${f}"[^>]*value="([^"]*)"`)) ?? html.match(new RegExp(`name="${f}"[^>]*>([^<]*)<`));
        if (m) console.log(`  ${f}: ${m[1].slice(0, 80)}`);
        // checkbox-style
        const cm = html.match(new RegExp(`name="${f}"[^>]*\\bchecked\\b`));
        if (cm) console.log(`  ${f}: checked`);
      }
    }
    // Also try the home/list page
    const homeRes = await ctx.request.fetch(`${baseUrl}/a/${team}/documents/collections/${id}`, { failOnStatusCode: false });
    console.log(`home page status: ${homeRes.status()}`);
    if (homeRes.ok()) {
      const html = await homeRes.text();
      const title = html.match(/<title>([^<]+)/)?.[1];
      console.log(`  title: ${title}`);
      fs.writeFileSync(`/tmp/n1-collection-${id}.html`, html);
      // Search for telltale flag terms
      for (const term of ['is_index', 'is_remote_index', 'is_remote', 'remote_index', 'summary_text', 'auto-sync', 'Auto-sync', 'summarize_documents', 'collection_summary', 'summary"', 'summary:', 'summary-', 'summaries']) {
        if (html.toLowerCase().includes(term.toLowerCase())) {
          // Print surrounding context for first hit
          const i = html.toLowerCase().indexOf(term.toLowerCase());
          console.log(`  HAS "${term}": …${html.slice(Math.max(0, i - 40), i)}<<${html.slice(i, i + term.length)}>>${html.slice(i + term.length, i + term.length + 80)}…`);
        }
      }
    }
  }

  await browser.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
