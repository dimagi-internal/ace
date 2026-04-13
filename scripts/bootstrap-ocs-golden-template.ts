/**
 * Bootstrap the ACE OCS golden template.
 *
 * One-time (or refresh) setup for an ACE environment. Creates a chatbot on the
 * configured OCS team that acts as the base template every per-opportunity
 * ACE chatbot is cloned from. The result is an experiment_id that gets
 * recorded as OCS_GOLDEN_TEMPLATE_ID in the ACE environment's .env.
 *
 * How it works:
 *   1. Load the Playwright session state from ~/.ace/ocs-session-<team>.json.
 *      (Run `/ocs:login` first to establish the session.)
 *   2. Check if a chatbot named OCS_GOLDEN_TEMPLATE_NAME already exists on the
 *      team. If yes, refuse to create a duplicate — print its id and exit.
 *   3. Clone the source chatbot (OCS_BOOTSTRAP_SOURCE_ID, default: whatever
 *      single chatbot exists on the team, or a hardcoded known id). The clone
 *      inherits the source's LLM provider, embedding model, pipeline shape,
 *      and tool wiring.
 *   4. Rewrite the cloned pipeline's LLMResponseWithPrompt node with a
 *      generic ACE-flavored system prompt (placeholders for per-opp details).
 *   5. (Already done by cloneChatbot) — create the EMBEDDED_WIDGET channel
 *      so connect-labs can mount the widget.
 *   6. Print experiment_id, public_id, pipeline_id, embed_key for recording.
 *
 * Usage (values come from your local .env — see .env.example):
 *   OCS_BASE_URL=https://www.openchatstudio.com \
 *   OCS_TEAM_SLUG=<your team> \
 *   OCS_BOOTSTRAP_SOURCE_ID=<source chatbot id> \
 *   OCS_GOLDEN_TEMPLATE_NAME="ACE Golden Template" \
 *     npx tsx scripts/bootstrap-ocs-golden-template.ts
 *
 * If no source id is provided, the script picks the first chatbot it finds
 * on the team via the HX-loaded table and uses that.
 *
 * To start over (delete the existing golden template and recreate), set
 * OCS_BOOTSTRAP_FORCE=1. This will archive the current golden template via
 * the chatbot delete endpoint before creating a new one.
 */

import { chromium, type BrowserContext } from 'playwright';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { PlaywrightBackend } from '../mcp/ocs/backends/playwright.js';
import type { RequestFn, RequestResult } from '../mcp/ocs/backends/pipeline-patch.js';
import { extractPublicId } from '../mcp/ocs/backends/playwright.js';

// ── Config ──────────────────────────────────────────────────────────

const baseUrl = process.env.OCS_BASE_URL ?? 'https://www.openchatstudio.com';
const teamSlug = process.env.OCS_TEAM_SLUG;
if (!teamSlug) {
  console.error('OCS_TEAM_SLUG is required (set it in your .env).');
  process.exit(1);
}
const templateName = process.env.OCS_GOLDEN_TEMPLATE_NAME ?? 'ACE Golden Template';
const bootstrapSourceId = process.env.OCS_BOOTSTRAP_SOURCE_ID
  ? Number(process.env.OCS_BOOTSTRAP_SOURCE_ID)
  : undefined;
const force = process.env.OCS_BOOTSTRAP_FORCE === '1';
const sharedCollectionId = process.env.OCS_SHARED_COLLECTION_ID
  ? Number(process.env.OCS_SHARED_COLLECTION_ID)
  : undefined;
const stateFile = path.join(os.homedir(), '.ace', `ocs-session-${teamSlug}.json`);

// ── The ACE golden template system prompt ──────────────────────────

const GOLDEN_TEMPLATE_PROMPT = `You are the ACE (AI Connect Engine) support bot for this Connect opportunity.

Your role: answer questions from Network Managers (also called LLOs — Last-Mile Liaison Organizations) who are running this opportunity. They may ask about:
- How to use the Connect app (deliveries, payment units, flagged visits, FLW management)
- How to onboard Frontline Workers (FLWs)
- Opportunity-specific details (intervention, milestones, timelines, training)
- General Connect platform features and troubleshooting

You have two knowledge sources:
1. **Connect knowledge base** — general Connect documentation, shared across all opportunities. Use this for platform questions ("how do I approve a flagged delivery?", "how do I add a payment unit?").
2. **Opportunity-specific materials** — the IDD, training materials, and app summaries for this specific opportunity. Use this for opp-specific questions ("what are my milestones?", "how does this intervention work?").

How to respond:
- Ground your answers in the attached knowledge bases. Search both before answering.
- Keep responses concise, practical, and directly actionable for busy field operators.
- If neither knowledge base covers the question, say so honestly and suggest escalating to the ACE admin group at Ace-AI@Dimagi.com.
- If the user seems confused about a basic Connect feature that IS documented, answer directly and tag your response with [training-gap].
- If the user reports a bug or platform issue, tag the response with [product-feedback].
- Be professional and respectful. Network Managers are experienced organizations, not end-users.

This is the ACE golden template. Per-opportunity customizations — the intervention details, Network Manager names, key dates, and opportunity-specific knowledge base — are injected at setup time by the ocs-agent-setup skill. Do not treat this prompt as final.
`;

// ── Helpers ─────────────────────────────────────────────────────────

function makeProductionRequest(context: BrowserContext, csrfToken: string): RequestFn {
  return async (method, url, body, options): Promise<RequestResult> => {
    const maxRedirects = options?.followRedirects === false ? 0 : undefined;
    const headers = { 'X-CSRFToken': csrfToken, Referer: baseUrl };

    if (method === 'GET') {
      const res = await context.request.get(url, { maxRedirects });
      return {
        ok: res.ok(), status: res.status(), headers: res.headers(),
        text: () => res.text(), json: () => res.json(),
      };
    }
    if (options?.multipart) {
      const form = new FormData();
      for (const [key, value] of Object.entries(options.multipart)) {
        if (typeof value === 'string') {
          form.append(key.startsWith('files_') ? 'files' : key, value);
        } else if (value && typeof value === 'object' && 'buffer' in value) {
          const f = value as { name: string; mimeType: string; buffer: Buffer };
          form.append(
            key.startsWith('files_') ? 'files' : key,
            new Blob([new Uint8Array(f.buffer)], { type: f.mimeType }),
            f.name,
          );
        }
      }
      const res = await context.request.post(url, { headers, multipart: form, maxRedirects });
      return {
        ok: res.ok(), status: res.status(), headers: res.headers(),
        text: () => res.text(), json: () => res.json(),
      };
    }
    if (options?.formEncoded) {
      const res = await context.request.post(url, {
        headers, form: body as Record<string, string>, maxRedirects,
      });
      return {
        ok: res.ok(), status: res.status(), headers: res.headers(),
        text: () => res.text(), json: () => res.json(),
      };
    }
    const res = await context.request.post(url, { headers, data: body, maxRedirects });
    return {
      ok: res.ok(), status: res.status(), headers: res.headers(),
      text: () => res.text(), json: () => res.json(),
    };
  };
}

interface ChatbotListing {
  id: number;
  name: string;
}

async function listChatbots(context: BrowserContext): Promise<ChatbotListing[]> {
  const res = await context.request.get(`/a/${teamSlug}/chatbots/table/`);
  if (!res.ok()) throw new Error(`Could not list chatbots: ${res.status()}`);
  const html = await res.text();
  // Each row is <tr id="record-<id>" ... data-redirect-url="/a/.../chatbots/<id>/">
  // containing an <a href="/a/.../chatbots/<id>/">Name</a>.
  const rowRegex = /id="record-(\d+)"[^]*?href="\/a\/[^"]+\/chatbots\/\1\/"[^>]*>\s*([^<]+)/g;
  const listings: ChatbotListing[] = [];
  for (const m of html.matchAll(rowRegex)) {
    listings.push({ id: Number(m[1]), name: m[2].trim() });
  }
  return listings;
}

async function archiveChatbot(
  context: BrowserContext,
  csrfToken: string,
  experimentId: number,
): Promise<void> {
  const res = await context.request.post(`/a/${teamSlug}/chatbots/${experimentId}/delete/`, {
    headers: { 'X-CSRFToken': csrfToken, Referer: baseUrl },
    form: { csrfmiddlewaretoken: csrfToken },
    maxRedirects: 0,
  });
  if (!res.ok() && res.status() !== 302) {
    throw new Error(`Archive failed for ${experimentId}: ${res.status()}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────

(async () => {
  console.log('ACE OCS golden template bootstrap');
  console.log('─'.repeat(50));
  console.log(`  team:          ${teamSlug}`);
  console.log(`  base URL:      ${baseUrl}`);
  console.log(`  template name: ${templateName}`);
  console.log(`  state file:    ${stateFile}`);
  console.log();

  if (!fs.existsSync(stateFile)) {
    console.error(`No session state at ${stateFile}.`);
    console.error('Run /ocs:login first (or manually create the file via Playwright).');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: stateFile, baseURL: baseUrl });

  try {
    // Verify the session is still valid
    const healthRes = await context.request.get(`/a/${teamSlug}/chatbots/`);
    if (healthRes.status() !== 200) {
      console.error(`Session invalid: /a/${teamSlug}/chatbots/ returned ${healthRes.status()}.`);
      console.error('Run /ocs:login to refresh.');
      process.exit(1);
    }

    const cookies = await context.cookies();
    const csrfToken = cookies.find((c) => c.name === 'csrftoken')?.value;
    if (!csrfToken) throw new Error('No csrftoken cookie in session state');

    // Step 1: see if the golden template already exists
    console.log('[1/5] Checking for existing golden template...');
    const listings = await listChatbots(context);
    console.log(`      Found ${listings.length} chatbot(s) on team:`);
    for (const l of listings) console.log(`        ${l.id}: ${l.name}`);

    const existing = listings.find((l) => l.name === templateName);
    if (existing && !force) {
      // Already exists — fetch its public_id + pipeline_id + embed_key and print
      console.log(`      Golden template already exists as experiment ${existing.id}.`);
      console.log('      Use OCS_BOOTSTRAP_FORCE=1 to archive and recreate.');
      await printGoldenTemplateInfo(context, csrfToken, existing.id);
      return;
    }
    if (existing && force) {
      console.log(`      FORCE mode: archiving existing template ${existing.id}...`);
      await archiveChatbot(context, csrfToken, existing.id);
      console.log('      Archived.');
    }

    // Step 2: choose the source chatbot to clone from
    console.log('\n[2/5] Choosing source chatbot for the clone...');
    let sourceId = bootstrapSourceId;
    if (!sourceId) {
      const nonTemplate = listings.find((l) => l.name !== templateName);
      if (!nonTemplate) {
        throw new Error(
          'No source chatbot available to clone from. Set OCS_BOOTSTRAP_SOURCE_ID or ' +
            'ensure at least one chatbot exists on the team.',
        );
      }
      sourceId = nonTemplate.id;
      console.log(`      Auto-picked source: ${sourceId} (${nonTemplate.name})`);
    } else {
      console.log(`      Using configured source: ${sourceId}`);
    }

    // Step 3: clone + scrape ids + create widget channel (all in one atom)
    console.log('\n[3/5] Cloning source and creating widget channel...');
    const request = makeProductionRequest(context, csrfToken);
    const backend = new PlaywrightBackend({ teamSlug, baseUrl, csrfToken, request });
    const cloned = await backend.cloneChatbot({ template_id: sourceId, new_name: templateName });
    console.log(`      Cloned to experiment ${cloned.experiment_id}`);
    console.log(`        public_id:   ${cloned.public_id}`);
    console.log(`        pipeline_id: ${cloned.pipeline_id}`);

    // Step 4: rewrite the system prompt with the ACE-flavored skeleton
    console.log('\n[4/6] Setting the ACE golden template system prompt...');
    await backend.setChatbotSystemPrompt({
      experiment_id: cloned.experiment_id,
      prompt: GOLDEN_TEMPLATE_PROMPT,
    });
    console.log('      Prompt patched.');

    // Step 5: attach the shared Connect knowledge collection (if configured)
    if (sharedCollectionId) {
      console.log(`\n[5/6] Attaching shared Connect collection (id ${sharedCollectionId})...`);
      await backend.attachKnowledge({
        experiment_id: cloned.experiment_id,
        collection_index_ids: [sharedCollectionId],
        max_results: 20,
        generate_citations: true,
      });
      console.log('      Attached. Per-opp clones will inherit this + get their own opp-specific collection appended.');
    } else {
      console.log('\n[5/6] Skipping shared collection — OCS_SHARED_COLLECTION_ID not set.');
      console.log('      Per-opp bots will only have opp-specific knowledge unless you set this later.');
    }

    // Step 6: read back embed info (verifies the widget channel was created)
    console.log('\n[6/6] Reading embed info...');
    const embed = await backend.getChatbotEmbedInfo({ experiment_id: cloned.experiment_id });
    console.log(`      public_id: ${embed.public_id}`);
    console.log(`      embed_key: ${embed.embed_key}`);

    // Summary for the user to paste into .env
    console.log('\n' + '─'.repeat(50));
    console.log('Golden template bootstrapped successfully.');
    console.log('\nAdd to your ACE .env:');
    console.log(`  OCS_BASE_URL=${baseUrl}`);
    console.log(`  OCS_TEAM_SLUG=${teamSlug}`);
    console.log(`  OCS_GOLDEN_TEMPLATE_ID=${cloned.experiment_id}`);
    console.log(`  OCS_GOLDEN_TEMPLATE_PUBLIC_ID=${cloned.public_id}`);
    console.log(`  OCS_GOLDEN_TEMPLATE_EMBED_KEY=${embed.embed_key}`);
    if (sharedCollectionId) {
      console.log(`  OCS_SHARED_COLLECTION_ID=${sharedCollectionId}  # already set`);
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error('Bootstrap failed:', e);
  process.exit(1);
});

async function printGoldenTemplateInfo(
  context: BrowserContext,
  csrfToken: string,
  experimentId: number,
): Promise<void> {
  void csrfToken;
  const homeRes = await context.request.get(`/a/${teamSlug}/chatbots/${experimentId}/`);
  const html = await homeRes.text();
  const publicId = extractPublicId(html);
  console.log();
  console.log(`  OCS_GOLDEN_TEMPLATE_ID=${experimentId}`);
  console.log(`  OCS_GOLDEN_TEMPLATE_PUBLIC_ID=${publicId ?? '<scrape failed>'}`);
  console.log('  (run with OCS_BOOTSTRAP_FORCE=1 to refresh and get the embed_key)');
}
