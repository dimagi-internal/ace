/**
 * N1 differential test: save bot 12003 with golden's EXACT prompt + golden's
 * EXACT collection_index_ids ([350]). If that works → the 365 collection is
 * the broken one. If still rejected → the bot's pipeline state is broken
 * regardless of inputs (e.g. some persistent flag we can't see).
 *
 * Then restore turmeric to its current good state.
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

const TURMERIC_PIPELINE_ID = 5816;

async function attemptSave(ctx: any, csrf: string, label: string, mutate: (graph: any) => void) {
  const dataRes = await ctx.request.fetch(`${baseUrl}/a/${team}/pipelines/data/${TURMERIC_PIPELINE_ID}/`);
  const payload = await dataRes.json();
  const graph = payload.pipeline.data;
  mutate(graph);
  const postRes = await ctx.request.fetch(`${baseUrl}/a/${team}/pipelines/data/${TURMERIC_PIPELINE_ID}/`, {
    method: 'POST',
    headers: { 'X-CSRFToken': csrf, 'Content-Type': 'application/json' },
    data: JSON.stringify({ name: payload.pipeline.name, data: graph }),
  });
  const body = await postRes.text();
  let errorMsg: any = null;
  try {
    const j = JSON.parse(body);
    if (j.errors && Object.keys(j.errors).length > 0) errorMsg = j.errors;
  } catch { /* */ }
  console.log(`\n[${label}] status=${postRes.status()} ${errorMsg ? 'REJECTED' : 'ACCEPTED'}`);
  if (errorMsg) console.log(JSON.stringify(errorMsg, null, 2));
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: sessionFile });
  const cookies = await ctx.cookies();
  const csrf = cookies.find((c: any) => c.name === 'csrftoken')?.value ?? '';

  const golden = JSON.parse(fs.readFileSync('/tmp/n1-golden.json', 'utf-8'));
  const goldenLlm = golden.pipeline.data.nodes.find((n: any) => n.data.type === 'LLMResponseWithPrompt');
  const goldenPrompt = goldenLlm.data.params.prompt;
  console.log(`Golden prompt has variable: ${goldenPrompt.includes('{collection_index_summaries}')}`);
  console.log(`Golden collection_index_ids: ${JSON.stringify(goldenLlm.data.params.collection_index_ids)}`);

  // Test A: prompt has variable + collection [350] (golden's actual config)
  await attemptSave(ctx, csrf, 'A: golden prompt + [350]', (graph) => {
    const llm = graph.nodes.find((n: any) => n.data.type === 'LLMResponseWithPrompt');
    llm.data.params.prompt = goldenPrompt;
    llm.data.params.collection_index_ids = [350];
  });

  // Test B: prompt has variable + collection [365]
  await attemptSave(ctx, csrf, 'B: golden prompt + [365]', (graph) => {
    const llm = graph.nodes.find((n: any) => n.data.type === 'LLMResponseWithPrompt');
    llm.data.params.prompt = goldenPrompt;
    llm.data.params.collection_index_ids = [365];
  });

  // Test C: prompt has variable + collection [350, 365]
  await attemptSave(ctx, csrf, 'C: golden prompt + [350, 365]', (graph) => {
    const llm = graph.nodes.find((n: any) => n.data.type === 'LLMResponseWithPrompt');
    llm.data.params.prompt = goldenPrompt;
    llm.data.params.collection_index_ids = [350, 365];
  });

  // Test D: prompt with variable + minimal config + [365]
  const minimalPrompt = "{collection_index_summaries}";
  await attemptSave(ctx, csrf, 'D: minimal-prompt-with-variable + [365]', (graph) => {
    const llm = graph.nodes.find((n: any) => n.data.type === 'LLMResponseWithPrompt');
    llm.data.params.prompt = minimalPrompt;
    llm.data.params.collection_index_ids = [365];
  });

  // Hypothesis verification: variable required IFF multiple collections.
  // E. variable + multi-collection → should be ACCEPTED if theory holds
  await attemptSave(ctx, csrf, 'E: prompt-with-variable + [350, 365]', (graph) => {
    const llm = graph.nodes.find((n: any) => n.data.type === 'LLMResponseWithPrompt');
    llm.data.params.prompt = `Some text\n{collection_index_summaries}\nMore text`;
    llm.data.params.collection_index_ids = [350, 365];
  });

  // F. variable + single + variable in DIFFERENT position
  await attemptSave(ctx, csrf, 'F: prompt-with-variable + [350] (single)', (graph) => {
    const llm = graph.nodes.find((n: any) => n.data.type === 'LLMResponseWithPrompt');
    llm.data.params.prompt = `Hello\n{collection_index_summaries}`;
    llm.data.params.collection_index_ids = [350];
  });

  // Restore: leave turmeric in a known-good state matching current production
  await attemptSave(ctx, csrf, 'RESTORE: opp prompt-no-variable + [365]', (graph) => {
    const llm = graph.nodes.find((n: any) => n.data.type === 'LLMResponseWithPrompt');
    // Strip any variable that might have leaked from earlier tests
    llm.data.params.prompt = llm.data.params.prompt.replace(/\s*\{collection_index_summaries\}\s*/g, '');
    llm.data.params.collection_index_ids = [365];
  });

  await browser.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
