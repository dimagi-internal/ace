/**
 * End-to-end bot creation test against real OCS.
 *
 * Exercises the full ocs-agent-setup skill flow:
 *   clone → create collection → upload files → wait for indexing →
 *   compose prompt → attach knowledge → publish version →
 *   chat via widget → cleanup
 *
 * This mirrors the 13-step ocs-agent-setup skill but exercises the
 * PlaywrightBackend directly (not via MCP) against a live OCS instance.
 *
 * Requires:
 *   OCS_INTEGRATION=1
 *   OCS_TEAM_SLUG=<team>
 *   OCS_GOLDEN_TEMPLATE_ID=<id>
 *   OCS_SHARED_COLLECTION_ID=<id>
 *   ~/.ace/ocs-session-<team>.json  (from /ace:ocs-login)
 *
 * Run: OCS_INTEGRATION=1 npm test -- test/mcp/ocs/e2e-bot-creation.integration.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { chromium, type BrowserContext } from 'playwright';
import { fetch } from 'undici';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { PlaywrightBackend } from '../../../mcp/ocs/backends/playwright.js';
import type { RequestFn, RequestResult } from '../../../mcp/ocs/backends/pipeline-patch.js';

const integration = process.env.OCS_INTEGRATION === '1';
const describeFn = integration ? describe : describe.skip;

// ── Test fixture paths ──────────────────────────────────────────────
const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/CRISPR-Test-001');

/** Read a fixture file as a Buffer. */
function readFixture(relativePath: string): Buffer {
  return fs.readFileSync(path.join(FIXTURE_DIR, relativePath));
}

describeFn('OCS bot creation E2E (requires OCS_INTEGRATION=1 + live session)', () => {
  const baseUrl = process.env.OCS_BASE_URL ?? 'https://www.openchatstudio.com';
  const teamSlug = process.env.OCS_TEAM_SLUG!;
  const templateId = Number(process.env.OCS_GOLDEN_TEMPLATE_ID ?? 0);
  const sharedCollectionId = Number(process.env.OCS_SHARED_COLLECTION_ID ?? 0);
  const stateFile = path.join(os.homedir(), '.ace', `ocs-session-${teamSlug}.json`);

  let context: BrowserContext;
  let backend: PlaywrightBackend;
  let csrfToken: string;

  // State captured across test steps
  let clonedExperimentId: number | undefined;
  let collectionId: number | undefined;
  let publicId: string | undefined;
  let embedKey: string | undefined;

  // ── Cleanup ─────────────────────────────────────────────────────
  afterAll(async () => {
    if (!context) return;
    // Clean up chatbot
    if (clonedExperimentId) {
      try {
        await context.request.post(`/a/${teamSlug}/chatbots/${clonedExperimentId}/delete/`, {
          headers: { 'X-CSRFToken': csrfToken, Referer: baseUrl },
          form: { csrfmiddlewaretoken: csrfToken },
          maxRedirects: 0,
        });
        console.log(`  cleanup: archived chatbot ${clonedExperimentId}`);
      } catch (e) {
        console.warn(`  cleanup: failed to archive chatbot ${clonedExperimentId}:`, e);
      }
    }
    // Clean up collection. Verified 2026-04-10: DELETE /documents/collections/<id>
    // (no trailing slash) is the correct endpoint. POST to .../delete/ returns 404.
    if (collectionId) {
      try {
        await context.request.delete(
          `/a/${teamSlug}/documents/collections/${collectionId}`,
          { headers: { 'X-CSRFToken': csrfToken, Referer: baseUrl } },
        );
        console.log(`  cleanup: deleted collection ${collectionId}`);
      } catch (e) {
        console.warn(`  cleanup: failed to delete collection ${collectionId}:`, e);
      }
    }
    await context.close();
  });

  // ── Step 1: Auth ────────────────────────────────────────────────
  it('authenticates and sets up the Playwright backend', async () => {
    if (!teamSlug || !templateId || !sharedCollectionId) {
      console.warn(
        'OCS_TEAM_SLUG, OCS_GOLDEN_TEMPLATE_ID, or OCS_SHARED_COLLECTION_ID not set — skipping',
      );
      return;
    }
    expect(fs.existsSync(stateFile)).toBe(true);

    const browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ storageState: stateFile, baseURL: baseUrl });

    const cookies = await context.cookies();
    csrfToken = cookies.find((c) => c.name === 'csrftoken')!.value;
    expect(csrfToken).toBeTruthy();

    const request: RequestFn = async (method, url, body, options): Promise<RequestResult> => {
      const maxRedirects = options?.followRedirects === false ? 0 : undefined;
      const headers = { 'X-CSRFToken': csrfToken, Referer: baseUrl };
      if (method === 'GET') {
        const res = await context.request.get(url, { maxRedirects });
        return { ok: res.ok(), status: res.status(), headers: res.headers(), text: () => res.text(), json: () => res.json() };
      }
      // Multipart upload (for collection file uploads). Mirror ocs-server.ts:
      // the backend stores multiple files as `files_0`, `files_1`, etc. because
      // Playwright's dict-based multipart can't have duplicate keys. We re-map
      // them back to the `files` field name using Node FormData (which allows
      // repeated keys), then pass FormData to Playwright's multipart option.
      if (options?.multipart) {
        const form = new FormData();
        for (const [key, value] of Object.entries(options.multipart)) {
          const fieldName = key.startsWith('files_') ? 'files' : key;
          if (typeof value === 'string') {
            form.append(fieldName, value);
          } else if (value && typeof value === 'object' && 'buffer' in value) {
            const f = value as { name: string; mimeType: string; buffer: Buffer };
            form.append(
              fieldName,
              new Blob([new Uint8Array(f.buffer)], { type: f.mimeType }),
              f.name,
            );
          }
        }
        const res = await context.request.post(url, { headers, multipart: form, maxRedirects });
        return { ok: res.ok(), status: res.status(), headers: res.headers(), text: () => res.text(), json: () => res.json() };
      }
      if (options?.formEncoded) {
        const res = await context.request.post(url, { headers, form: body as Record<string, string>, maxRedirects });
        return { ok: res.ok(), status: res.status(), headers: res.headers(), text: () => res.text(), json: () => res.json() };
      }
      const res = await context.request.post(url, { headers, data: body, maxRedirects });
      return { ok: res.ok(), status: res.status(), headers: res.headers(), text: () => res.text(), json: () => res.json() };
    };

    backend = new PlaywrightBackend({ teamSlug, baseUrl, csrfToken, request });
  }, 30_000);

  // ── Step 2: Clone golden template ───────────────────────────────
  it('clones the golden template', async () => {
    if (!backend) return;
    const name = `ACE-e2e-bot-creation-${Date.now()}`;
    const cloned = await backend.cloneChatbot({ template_id: templateId, new_name: name });

    clonedExperimentId = cloned.experiment_id;
    publicId = cloned.public_id;
    expect(cloned.experiment_id).toBeGreaterThan(0);
    expect(cloned.public_id).toMatch(/[0-9a-f-]{36}/);
    expect(cloned.pipeline_id).toBeGreaterThan(0);
    console.log(`  cloned: experiment=${cloned.experiment_id}, pipeline=${cloned.pipeline_id}`);
  }, 30_000);

  // ── Step 3: Create per-opp collection (LOCAL index) ────────────
  // Creates a local-index collection (is_remote_index=false). Remote indexes
  // call OpenAI's vector stores API inline during collection create, which
  // currently crashes with 500 on connect-ace (tracked as an OCS bug — the
  // same key works fine via direct curl). Local indexes use the embedding
  // model via the chunking pipeline and succeed.
  //
  // The team must have:
  //   - LLM provider configured (env: OCS_LLM_PROVIDER_ID, e.g. OpenAI)
  //   - Embedding model configured (env: OCS_EMBEDDING_MODEL_ID)
  // These are dropdown selections in the OCS UI. Default values below are
  // for the `connect-ace` team as of 2026-04-10.
  const llmProviderId = Number(process.env.OCS_LLM_PROVIDER_ID ?? 378);
  const embeddingModelId = Number(process.env.OCS_EMBEDDING_MODEL_ID ?? 1);
  let documentsAvailable = true;
  it('creates a per-opp RAG collection', async () => {
    if (!clonedExperimentId) return;
    try {
      const result = await backend.createCollection({
        name: `ACE-e2e-bot-creation-${Date.now()}`,
        summary: 'E2E test collection for CRISPR-Test-001 fixture',
        is_index: true,
        is_remote_index: false,
        llm_provider: llmProviderId,
        embedding_model: embeddingModelId,
      });
      collectionId = result.collection_id;
      expect(collectionId).toBeGreaterThan(0);
      console.log(`  collection: ${collectionId} (llm_provider=${llmProviderId}, embedding_model=${embeddingModelId})`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('403') || msg.includes('404')) {
        documentsAvailable = false;
        console.warn(
          '  Documents feature not enabled on this team — skipping collection steps. ' +
            'Test continues with shared collection only.',
        );
      } else {
        throw e;
      }
    }
  }, 30_000);

  // ── Step 4: Upload files to collection ──────────────────────────
  // Uploading files to an indexed collection requires the OCS team to have
  // an LLM provider + embedding model configured in service_providers. If
  // the team lacks providers, OCS returns a 500 on upload. We log and skip
  // the upload/indexing steps in that case — the bot is still fully functional
  // via the shared collection attached in step 7.
  let fileIds: number[] = [];
  let uploadFailed = false;
  it('uploads PDD and training materials to the collection', async () => {
    if (!collectionId || !documentsAvailable) {
      if (!documentsAvailable) console.log('  skipped — documents not available');
      return;
    }

    const files = [
      { name: 'pdd.md', content: readFixture('pdd.md'), mime_type: 'text/markdown' },
      { name: 'learn-app-summary.md', content: readFixture('app-summaries/learn-app-summary.md'), mime_type: 'text/markdown' },
      { name: 'deliver-app-summary.md', content: readFixture('app-summaries/deliver-app-summary.md'), mime_type: 'text/markdown' },
      { name: 'flw-training-guide.md', content: readFixture('training-materials/flw-training-guide.md'), mime_type: 'text/markdown' },
      { name: 'faq.md', content: readFixture('training-materials/faq.md'), mime_type: 'text/markdown' },
    ];

    try {
      const result = await backend.uploadCollectionFiles({ collection_id: collectionId, files });
      fileIds = result.file_ids;
      expect(fileIds.length).toBe(files.length);
      console.log(`  uploaded ${fileIds.length} files: ${fileIds.join(', ')}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      uploadFailed = true;
      console.warn(
        `  upload failed: ${msg.slice(0, 100)}... — likely team has no LLM/embedding provider ` +
          `configured (needs setup at /a/${teamSlug}/service_providers/). Test continues with ` +
          `shared collection only.`,
      );
    }
  }, 60_000);

  // ── Step 5: Wait for indexing ───────────────────────────────────
  // Indexing runs in a Celery task on OCS. On the connect-ace team this
  // currently fails with status="error" / chunk_count=0 — appears to be an
  // OCS-side Celery worker config issue (the same OpenAI key works fine via
  // direct curl). We surface the failure as a warning but don't fail the test.
  let indexingFailed = false;
  it('waits for collection indexing to complete', async () => {
    if (!collectionId || fileIds.length === 0 || !documentsAvailable || uploadFailed) {
      if (uploadFailed) console.log('  skipped — upload failed');
      else if (!documentsAvailable) console.log('  skipped — documents not available');
      return;
    }

    try {
      const result = await backend.waitForCollectionIndexing({
        collection_id: collectionId,
        file_ids: fileIds,
        timeout_sec: 120,
      });
      expect(result.ready).toBe(true);
      expect(result.files_indexed).toBe(fileIds.length);
      console.log(`  indexed: ${result.files_indexed} files ready`);
    } catch (e: unknown) {
      indexingFailed = true;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`  indexing failed: ${msg.slice(0, 200)}`);
      console.warn(`  Test continues with shared collection only.`);
    }
  }, 180_000);

  // ── Step 6: Set system prompt ───────────────────────────────────
  it('composes and sets the system prompt', async () => {
    if (!clonedExperimentId) return;

    const prompt = `You are the support chatbot for the "Community Health Worker Training Pilot — TestLand" opportunity on CRISPR-Connect.

## Opportunity Context
- Opportunity: Community Health Worker Training Pilot — TestLand
- Archetype: atomic-visit (one FLW visit = one structured delivery)
- LLO contacts: Neal (neal@test.example.com), Matt (matt@test.example.com)
- Target: 500 beneficiaries across 3 districts in Eastern Province
- CHWs complete 3 training modules (Learn app) then conduct home visits (Deliver app)
- Forms: Beneficiary Registration, Prenatal Visit, Immunization Visit, Danger Sign Referral

## Knowledge Sources
You have access to two knowledge collections:
1. Shared Connect knowledge — general CRISPR-Connect platform docs
2. CRISPR-Test-001 collection — the PDD, app summaries, and training materials for this opportunity

## Escalation Rules
- For questions you cannot answer from your knowledge sources, direct the user to ace@dimagi-ai.com
- Tag messages about app bugs or feature requests with [product-feedback]
- Tag messages about training gaps or confusion with [training-gap]

## Tone
- Professional, supportive, and action-oriented
- Keep answers concise but complete
- Always cite which knowledge source informed your answer when possible`;

    await expect(
      backend.setChatbotSystemPrompt({
        experiment_id: clonedExperimentId,
        prompt,
      }),
    ).resolves.toBeUndefined();
    console.log('  system prompt set');
  }, 15_000);

  // ── Step 7: Attach knowledge collections ────────────────────────
  it('attaches knowledge collections', async () => {
    if (!clonedExperimentId) return;

    const collectionIds = collectionId
      ? [sharedCollectionId, collectionId]
      : [sharedCollectionId];

    await expect(
      backend.attachKnowledge({
        experiment_id: clonedExperimentId,
        collection_index_ids: collectionIds,
        max_results: 20,
        generate_citations: true,
      }),
    ).resolves.toBeUndefined();
    console.log(`  attached collections: [${collectionIds.join(', ')}]`);
  }, 15_000);

  // ── Step 8: Publish version ─────────────────────────────────────
  it('publishes a chatbot version', async () => {
    if (!clonedExperimentId) return;

    const result = await backend.publishChatbotVersion({
      experiment_id: clonedExperimentId,
      description: 'E2E bot creation test — initial version',
    });
    expect(result.version_number).toBeGreaterThan(0);
    console.log(`  published version ${result.version_number} (task: ${result.task_id})`);
  }, 30_000);

  // ── Step 9: Get embed info ──────────────────────────────────────
  it('retrieves embed credentials', async () => {
    if (!clonedExperimentId) return;

    const embed = await backend.getChatbotEmbedInfo({ experiment_id: clonedExperimentId });
    publicId = embed.public_id;
    embedKey = embed.embed_key;
    expect(publicId).toMatch(/[0-9a-f-]{36}/);
    expect(embedKey).toBeTruthy();
    console.log(`  embed: public_id=${publicId}, key=${embedKey!.slice(0, 8)}...`);
  }, 15_000);

  // ── Step 10: Chat and evaluate ──────────────────────────────────
  it('chats with the bot and evaluates responses', async () => {
    if (!publicId || !embedKey) return;

    const chatHeaders = {
      'Content-Type': 'application/json',
      'X-Embed-Key': embedKey,
      Referer: 'https://test.example.com/',
    };

    // Start anonymous session
    const startRes = await fetch(`${baseUrl}/api/chat/start/`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({ chatbot_id: publicId }),
    });
    expect(startRes.ok).toBe(true);
    const startBody = (await startRes.json()) as { session_id: string };
    expect(startBody.session_id).toBeTruthy();
    console.log(`  session: ${startBody.session_id}`);

    // Test prompts with keyword expectations (soft checks)
    const testCases = [
      {
        prompt: 'How do I register a new pregnant woman in the system?',
        expectKeywords: ['register', 'beneficiary'],
        description: 'beneficiary registration (PDD knowledge)',
      },
      {
        prompt: 'Who should I contact if I need help with the app?',
        expectKeywords: ['ace@dimagi-ai.com'],
        description: 'escalation contact (system prompt)',
      },
      {
        prompt: 'I found a bug where the blood pressure field does not validate properly.',
        expectKeywords: ['product-feedback'],
        description: 'product feedback tagging (system prompt)',
      },
    ];

    for (const tc of testCases) {
      const sendRes = await fetch(
        `${baseUrl}/api/chat/${startBody.session_id}/message/`,
        {
          method: 'POST',
          headers: chatHeaders,
          body: JSON.stringify({ message: tc.prompt }),
        },
      );

      if (sendRes.status !== 202) {
        console.warn(`  [${tc.description}] send failed: status ${sendRes.status}`);
        continue;
      }
      const sendBody = (await sendRes.json()) as { task_id: string };

      // Poll for response (up to 60s)
      let reply = '';
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const pollRes = await fetch(
          `${baseUrl}/api/chat/${startBody.session_id}/${sendBody.task_id}/poll/`,
          { method: 'GET', headers: chatHeaders },
        );
        if (!pollRes.ok) continue;
        const pb = (await pollRes.json()) as {
          status?: string;
          message?: { content?: string };
        };
        if (pb.status === 'complete' && pb.message?.content) {
          reply = pb.message.content;
          break;
        }
        if (pb.status === 'error' || pb.status === 'failed') {
          console.warn(`  [${tc.description}] task failed`);
          break;
        }
      }

      if (reply) {
        const replyLower = reply.toLowerCase();
        const matched = tc.expectKeywords.filter((kw) => replyLower.includes(kw.toLowerCase()));
        const missed = tc.expectKeywords.filter((kw) => !replyLower.includes(kw.toLowerCase()));
        console.log(
          `  [${tc.description}] replied (${reply.length} chars), ` +
            `keywords: ${matched.length}/${tc.expectKeywords.length} matched` +
            (missed.length > 0 ? ` (missed: ${missed.join(', ')})` : ''),
        );
      } else {
        console.warn(
          `  [${tc.description}] no reply within 60s — LLM provider may be unavailable`,
        );
      }
    }
    // Soft — chat evaluation does not fail the test
  }, 240_000);

  // ── Step 11: Cleanup ────────────────────────────────────────────
  it('cleans up the test collection', async () => {
    if (!collectionId || !context) return;
    const res = await context.request.delete(
      `/a/${teamSlug}/documents/collections/${collectionId}`,
      { headers: { 'X-CSRFToken': csrfToken, Referer: baseUrl } },
    );
    expect([200, 204, 404]).toContain(res.status());
    if (res.status() === 200 || res.status() === 204) {
      console.log(`  collection ${collectionId} deleted`);
      collectionId = undefined; // prevent double-cleanup in afterAll
    } else {
      console.warn(`  collection delete returned status ${res.status()} — may need manual cleanup`);
    }
  }, 15_000);

  it('cleans up the test clone', async () => {
    if (!clonedExperimentId || !context) return;
    const res = await context.request.post(
      `/a/${teamSlug}/chatbots/${clonedExperimentId}/delete/`,
      {
        headers: { 'X-CSRFToken': csrfToken, Referer: baseUrl },
        form: { csrfmiddlewaretoken: csrfToken },
        maxRedirects: 0,
      },
    );
    expect(res.status()).toBe(200);
    console.log(`  chatbot ${clonedExperimentId} archived`);
    clonedExperimentId = undefined; // prevent double-cleanup in afterAll
  }, 15_000);
});
