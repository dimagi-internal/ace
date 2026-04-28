/**
 * N1 reproduction: take bot 12003 (current state: prompt has NO variable,
 * collection [365] attached), append `{collection_index_summaries}` to the
 * prompt, and try to save. This is the exact failure case the validation
 * run hit.
 *
 * If save succeeds → the earlier failure was a transient or sequencing
 *   issue, not a server-side rule.
 * If save fails → capture the exact error body to characterize the rule.
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
  const cookies = await ctx.cookies();
  const csrf = cookies.find((c) => c.name === 'csrftoken')?.value ?? '';

  // 1. GET pipeline data
  const editRes = await ctx.request.fetch(`${baseUrl}/a/${team}/chatbots/12003/edit/`);
  const html = await editRes.text();
  const m = html.match(/renderPipeline\("#pipelineBuilder",\s*"[^"]+",\s*(\d+)\)/);
  if (!m) throw new Error('No pipeline_id');
  const pid = m[1];
  console.log(`Pipeline id: ${pid}`);

  const dataRes = await ctx.request.fetch(`${baseUrl}/a/${team}/pipelines/data/${pid}/`);
  const payload = await dataRes.json();
  const graph = payload.pipeline.data;
  const llm = graph.nodes.find((n: any) => n.data.type === 'LLMResponseWithPrompt');

  console.log(`Current prompt has variable: ${llm.data.params.prompt.includes('{collection_index_summaries}')}`);
  console.log(`Current collection_index_ids: ${JSON.stringify(llm.data.params.collection_index_ids)}`);

  // 2. Mutate: add the variable to the prompt
  const original = llm.data.params.prompt;
  llm.data.params.prompt = `${original}\n\n## Knowledge\n\n{collection_index_summaries}`;

  console.log(`\nNew prompt now has variable: ${llm.data.params.prompt.includes('{collection_index_summaries}')}`);

  // 3. POST it back
  const postRes = await ctx.request.fetch(`${baseUrl}/a/${team}/pipelines/data/${pid}/`, {
    method: 'POST',
    headers: { 'X-CSRFToken': csrf, 'Content-Type': 'application/json' },
    data: JSON.stringify({ name: payload.pipeline.name, data: graph }),
  });
  console.log(`\nPOST status: ${postRes.status()}`);
  const body = await postRes.text();
  console.log(`Body length: ${body.length}`);
  if (body.length < 2000) {
    console.log(`\n=== FULL BODY ===\n${body}`);
  } else {
    console.log(`\n=== TRUNCATED BODY (first 1500 chars) ===\n${body.slice(0, 1500)}`);
    // look for error keys
    try {
      const j = JSON.parse(body);
      if (j.errors) console.log(`\n=== ERRORS FIELD ===\n${JSON.stringify(j.errors, null, 2)}`);
    } catch { /* not json */ }
  }

  await browser.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
