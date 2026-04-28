/**
 * N1 investigation: dump and diff the pipeline graphs of:
 *  - Golden template (11792) — has {collection_index_summaries} in prompt + collection [350]
 *  - Turmeric 12003 — has collection [365] but prompt has no variable (workaround)
 *
 * Look for any field that differs OUTSIDE the LLM node's `params` block —
 * that's where the "available variable bindings" likely live.
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

async function fetchPipeline(ctx: any, exp_id: number): Promise<any> {
  // First scrape /a/<team>/chatbots/<exp_id>/edit/ to discover pipeline_id
  const editRes = await ctx.request.fetch(`${baseUrl}/a/${team}/chatbots/${exp_id}/edit/`);
  const html = await editRes.text();
  const m = html.match(/renderPipeline\("#pipelineBuilder",\s*"[^"]+",\s*(\d+)\)/);
  if (!m) throw new Error(`No pipeline_id for exp ${exp_id}`);
  const pid = m[1];
  const dataRes = await ctx.request.fetch(`${baseUrl}/a/${team}/pipelines/data/${pid}/`);
  return await dataRes.json();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: sessionFile });

  console.log('Fetching pipelines...');
  const golden = await fetchPipeline(ctx, 11792);
  const turmeric = await fetchPipeline(ctx, 12003);

  fs.writeFileSync('/tmp/n1-golden.json', JSON.stringify(golden, null, 2));
  fs.writeFileSync('/tmp/n1-turmeric.json', JSON.stringify(turmeric, null, 2));

  console.log('Top-level keys (golden):', Object.keys(golden));
  console.log('Top-level keys (turmeric):', Object.keys(turmeric));
  console.log('\nPipeline keys (golden):', Object.keys(golden.pipeline ?? {}));
  console.log('Pipeline keys (turmeric):', Object.keys(turmeric.pipeline ?? {}));
  console.log('\nPipeline.data keys (golden):', Object.keys(golden.pipeline?.data ?? {}));
  console.log('Pipeline.data keys (turmeric):', Object.keys(turmeric.pipeline?.data ?? {}));

  // Compare LLM nodes
  function llm(p: any) {
    return p.pipeline.data.nodes.find((n: any) => n.data.type === 'LLMResponseWithPrompt');
  }
  const gLlm = llm(golden);
  const tLlm = llm(turmeric);
  console.log('\nGolden LLM node keys:', Object.keys(gLlm));
  console.log('Turmeric LLM node keys:', Object.keys(tLlm));
  console.log('\nGolden LLM data keys:', Object.keys(gLlm.data));
  console.log('Turmeric LLM data keys:', Object.keys(tLlm.data));

  console.log('\nGolden LLM params keys:', Object.keys(gLlm.data.params).sort());
  console.log('Turmeric LLM params keys:', Object.keys(tLlm.data.params).sort());

  // Differential: any field present in one params block but missing/different in the other?
  const gp = gLlm.data.params;
  const tp = tLlm.data.params;
  const allParamKeys = new Set([...Object.keys(gp), ...Object.keys(tp)]);
  console.log('\nLLM-node params field-by-field comparison:');
  for (const k of [...allParamKeys].sort()) {
    const gv = JSON.stringify(gp[k]).slice(0, 100);
    const tv = JSON.stringify(tp[k]).slice(0, 100);
    if (gv !== tv) console.log(`  DIFF  ${k}:\n    golden:   ${gv}\n    turmeric: ${tv}`);
  }

  // Also dump the node's *outer* attrs (anything outside `data`), and edges
  console.log('\nGolden node outer keys:', Object.keys(gLlm).filter(k => k !== 'data'));
  for (const k of Object.keys(gLlm).filter(k => k !== 'data')) {
    if (JSON.stringify(gLlm[k]) !== JSON.stringify(tLlm[k])) {
      console.log(`  DIFF outer ${k}: golden=${JSON.stringify(gLlm[k])} vs turmeric=${JSON.stringify(tLlm[k])}`);
    }
  }

  // Edges
  const ge = golden.pipeline.data.edges;
  const te = turmeric.pipeline.data.edges;
  console.log('\nGolden edges:', JSON.stringify(ge, null, 2));
  console.log('Turmeric edges:', JSON.stringify(te, null, 2));

  await browser.close();
  console.log('\nFull JSON dumped to /tmp/n1-golden.json and /tmp/n1-turmeric.json');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
