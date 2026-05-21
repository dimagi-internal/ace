import type { RequestFn, RequestResult } from './pipeline-patch.js';
import { patchLlmNodeParams, validatePipeline, getLlmNodeParams, addPipelineNode, type PipelinePatchContext } from './pipeline-patch.js';
import { PipelineValidationError } from '../errors.js';
import type { LlmNodeParams, ClonedChatbot } from '../types.js';
import { CollectionIndexingTimeoutError, HttpError, PipelineShapeError } from '../errors.js';

// ── HTML scrape helpers ────────────────────────────────────────────
// These match the exact templates rendered by OCS's Django views. If a
// template changes upstream, the corresponding regex here is the first
// thing that breaks. Each helper is unit-tested against a fixture.

/**
 * Extract the widget_token from the channel edit-dialog HTML.
 * Matches the input rendered by templates/channels/widgets/widget_params.html:
 *   <input type="text" id="widget_token" value="{{ widget.token }}" ...>
 */
export function extractWidgetToken(html: string): string | undefined {
  const match = html.match(/id="widget_token"[^>]*value="([^"]+)"/);
  return match?.[1];
}

/**
 * Extract the experiment's public_id UUID from the chatbot home page HTML.
 *
 * We anchor on the `#api-url-link` hidden input which renders as:
 *   <input id="api-url-link" type="hidden"
 *          value="https://.../api/openai/<public_id>/chat/completions" />
 *
 * This is more reliable than scraping the `<open-chat-studio-widget>` tag
 * because OCS itself renders a global support widget on every authenticated
 * page (chatbot-id matches some fixed OCS-support uuid), and the
 * per-experiment widget only renders behind the `flag_chat_widget` feature
 * flag. Using the api-url-link avoids both problems — it's always rendered
 * and always specific to the current experiment.
 */
export function extractPublicId(html: string): string | undefined {
  const match = html.match(/id="api-url-link"[^>]*\/api\/openai\/([0-9a-f-]{36})\//);
  return match?.[1];
}

/**
 * Extract the pipeline_id from the pipeline-builder page HTML.
 * Matches the script block rendered by templates/pipelines/pipeline_builder.html:
 *   SiteJS.pipeline.renderPipeline("#pipelineBuilder", "<team>", <pipeline_id>);
 */
export function extractPipelineId(html: string): number | undefined {
  const match = html.match(/renderPipeline\("#pipelineBuilder",\s*"[^"]+",\s*(\d+)\)/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Extract the EMBEDDED_WIDGET channel id from the chatbot home page HTML.
 * Matches the hx-get URL on the channel button in templates/chatbots/components/channel_buttons.html:
 *   hx-get="/a/<team>/chatbots/<eid>/channels/<channel_id>/edit-dialog/"
 * Only returns the id if the surrounding button's i tag is the embedded_widget icon.
 */
export function extractEmbeddedWidgetChannelId(html: string, experimentId: number): number | undefined {
  // Each channel button has: hx-get="...channels/<id>/edit-dialog/" and i.fa-brands.fa-embedded_widget
  // We look for channel edit-dialog URLs and then cross-reference which one is embedded_widget.
  const rowRegex = new RegExp(
    `hx-get="[^"]*chatbots/${experimentId}/channels/(\\d+)/edit-dialog/"[^]*?fa-(embedded_widget)`,
    'g'
  );
  for (const m of html.matchAll(rowRegex)) {
    return Number(m[1]);
  }
  return undefined;
}

/**
 * Extract the new experiment integer id from a 302 Location header after POST /copy/.
 * Matches: /a/<team>/chatbots/<experiment_id>/
 */
export function extractExperimentIdFromLocation(location: string): number | undefined {
  const match = location.match(/\/chatbots\/(\d+)\//);
  return match ? Number(match[1]) : undefined;
}

/**
 * Enforce the OCS LLMResponseWithPrompt cross-field rule for the
 * `{collection_index_summaries}` template variable.
 *
 * The actual server-side rule, characterized by direct probe against live
 * OCS on 2026-04-28 (see `scripts/probe-n1-cross-test.ts` for the truth
 * table): **the variable is required if and only if `collection_index_ids`
 * has length >= 2.** Single or zero collections must NOT include the
 * variable; multiple collections must include it.
 *
 * This corrects the wrong invariant 0.6.4 was checking ("variable iff
 * non-empty collections"). The 0.6.4 framing matched neither error path:
 *   - Multi-collection without variable → "Prompt expects
 *     collection_index_summaries variable."
 *   - Single/zero collections WITH variable → "collection_index_summaries
 *     variable is specified, but collection_index_summaries is missing."
 *
 * Architectural intuition: with a single collection there's nothing to
 * disambiguate — OCS substitutes the collection content directly via the
 * retriever pipeline. The `{collection_index_summaries}` template is only
 * meaningful when the LLM needs to choose between multiple attached
 * collections at runtime.
 */
export function assertCollectionPromptInvariant(prompt: string, collectionIds: readonly number[]): void {
  const VARIABLE = '{collection_index_summaries}';
  const hasVar = prompt.includes(VARIABLE);
  const isMulti = collectionIds.length >= 2;

  if (hasVar && !isMulti) {
    throw new PipelineValidationError([
      `LLMResponseWithPrompt.prompt: \`${VARIABLE}\` is present but only ` +
        `${collectionIds.length} collection${collectionIds.length === 1 ? ' is' : 's are'} attached ` +
        `(the variable requires 2 or more). OCS pipeline-save will reject this with ` +
        `"variable is specified, but is missing". ` +
        `Either remove the template variable from the prompt, or attach a second collection.`,
    ]);
  }

  if (!hasVar && isMulti) {
    throw new PipelineValidationError([
      `LLMResponseWithPrompt.prompt: ${collectionIds.length} collections are attached but ` +
        `the prompt is missing required template variable \`${VARIABLE}\`. OCS pipeline-save ` +
        `will reject this with "Prompt expects collection_index_summaries variable." ` +
        `Add \`${VARIABLE}\` somewhere in the prompt (typically in a "Knowledge:" section), ` +
        `or reduce the attached collections to a single one.`,
    ]);
  }
}

/**
 * Parse the HTMX-rendered `/a/<team>/chatbots/table/` HTML into a
 * `name → experiment_id` map. Each row in the live OCS response has the
 * shape:
 *   `<tr id="record-<int>" data-redirect-url="/a/<team>/chatbots/<int>/">
 *      ... <a href="/a/<team>/chatbots/<int>/" ...>NAME</a> ... </tr>`
 * The `id` attribute is the cheapest reliable signal for the integer; the
 * inner anchor body (trimmed of whitespace) is the canonical chatbot name.
 *
 * Returns an empty map on a malformed or unexpected page. Bots with
 * duplicate names map to whichever row appeared last; OCS treats name as
 * effectively unique per team.
 */
export function parseChatbotTable(html: string): Map<string, number> {
  const map = new Map<string, number>();
  // Anchor on `id="record-<int>"` then find the first `<a ...>NAME</a>` after
  // it. `[\s\S]*?` is lazy across newlines so we stop at the first anchor.
  const rowRegex = /id="record-(\d+)"[\s\S]*?<a [^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(rowRegex)) {
    const id = Number(m[1]);
    const name = m[2].trim();
    if (name && Number.isFinite(id)) map.set(name, id);
  }
  return map;
}

/**
 * Build a 302-response error with context for debugging.
 */
async function httpErrorFor(res: RequestResult, path: string): Promise<HttpError> {
  const status = res.status ?? 0;
  let body = '';
  if (res.text) {
    try { body = await res.text(); } catch { /* swallow */ }
  }
  return new HttpError(status, path, body);
}

export interface PlaywrightBackendOptions {
  teamSlug: string;
  baseUrl: string;
  csrfToken: string;
  request: RequestFn;
  /**
   * Optional seed for the experiment_id → pipeline_id cache. Used by unit tests
   * to avoid needing to mock /api/experiments/<id>/ on every pipeline-patch test.
   * In production, the cache is populated lazily by `cloneChatbot` and `pipelineIdFor`.
   */
  pipelineCacheSeed?: Map<number, number>;
}

export class PlaywrightBackend {
  private pipelineCache: Map<number, number>;

  constructor(private opts: PlaywrightBackendOptions) {
    this.pipelineCache = new Map(opts.pipelineCacheSeed ?? []);
  }

  private patchContext(): PipelinePatchContext {
    return { request: this.opts.request, teamSlug: this.opts.teamSlug };
  }

  /**
   * Resolve an experiment_id to the pipeline_id of its working version.
   * Checks cache, then falls back to GET /api/experiments/<id>/.
   * Throws if the experiment retrieve doesn't include a pipeline reference.
   */
  /**
   * Resolve an experiment_id (integer) to its pipeline_id (integer).
   *
   * The OCS REST API's `/api/experiments/<id>/` response does NOT include
   * `pipeline_id` (see apps/api/views/experiments.py + api-schema.yml Experiment
   * schema). Instead we scrape it from the pipeline-builder page, which renders
   * it inline as `SiteJS.pipeline.renderPipeline("#pipelineBuilder", "<team>", <pipeline_id>)`.
   * See templates/pipelines/pipeline_builder.html.
   *
   * The result is cached so subsequent pipeline-patch atoms on the same experiment
   * don't re-scrape. Populated eagerly by cloneChatbot.
   */
  /**
   * Scrape the team's chatbots-table HTMX endpoint for a `name → experiment_id`
   * map. Used to recover the integer experiment_id for bots returned by REST
   * `listChatbots` / `getChatbot`, which only carry the UUID public_id and an
   * API-shaped `url` (not the `/a/<team>/chatbots/<int>/` URL the 0.6.1
   * URL-regex parser assumed). Surfaced 2026-04-28 as N2 in the run log
   * addendum: live OCS responses don't match the unit-test mock shape.
   *
   * Endpoint: `/a/<team>/chatbots/table/` returns server-rendered rows of
   *   `<tr id="record-<int>" data-redirect-url="/a/<team>/chatbots/<int>/">
   *      <td>...<a ...>NAME</a>...</td>...
   *    </tr>`
   * The map is keyed by name because OCS bots are unique by name within a team
   * (and that's the field skill code uses to look up "is there a bot for this
   * opp already?").
   *
   * Single-call cost is one ~30KB authenticated GET; results are returned
   * eagerly without caching since this map is consumed per-listChatbots call
   * and we'd rather see fresh state than stale.
   */
  async fetchExperimentIdsByName(): Promise<Map<string, number>> {
    const path = `/a/${this.opts.teamSlug}/chatbots/table/`;
    const res = await this.opts.request('GET', path);
    if (!res.ok) throw await httpErrorFor(res, path);
    if (!res.text) {
      throw new Error('RequestResult.text is required for fetchExperimentIdsByName');
    }
    const html = await res.text();
    return parseChatbotTable(html);
  }

  async pipelineIdFor(experimentId: number): Promise<number> {
    const cached = this.pipelineCache.get(experimentId);
    if (cached !== undefined) return cached;

    const path = `/a/${this.opts.teamSlug}/chatbots/${experimentId}/edit/`;
    const res = await this.opts.request('GET', path);
    if (!res.ok) throw await httpErrorFor(res, path);
    if (!res.text) {
      throw new Error('RequestResult.text is required for pipelineIdFor; backend injected an older-shape fake');
    }
    const html = await res.text();
    const pipelineId = extractPipelineId(html);
    if (!pipelineId) {
      throw new PipelineShapeError(
        `Could not find pipeline_id in the edit page for experiment ${experimentId}. ` +
          'Template drift on templates/pipelines/pipeline_builder.html?'
      );
    }
    this.pipelineCache.set(experimentId, pipelineId);
    return pipelineId;
  }

  async setChatbotSystemPrompt(args: { experiment_id: number; prompt: string }) {
    const pipelineId = await this.pipelineIdFor(args.experiment_id);
    await patchLlmNodeParams(this.patchContext(), pipelineId, { prompt: args.prompt });
  }

  /**
   * Transactional update of the LLM node's params. Reads the current
   * pipeline, merges any provided fields, runs cross-field validation,
   * and POSTs back in one save. See the OcsClient interface for the
   * cross-field constraint this fixes.
   */
  async setChatbotPipeline(args: {
    experiment_id: number;
    prompt?: string;
    collection_index_ids?: number[];
    max_results?: number;
    generate_citations?: boolean;
    source_material_id?: number | null;
    tools?: string[];
    custom_actions?: string[];
    built_in_tools?: string[];
    mcp_tools?: string[];
  }) {
    const pipelineId = await this.pipelineIdFor(args.experiment_id);

    // Read current state to compute the *final* state after this patch
    // would apply. We need that to decide whether the cross-field invariant
    // (`{collection_index_summaries}` ↔ non-empty collection_index_ids)
    // holds, and we'd be doing the GET inside patchLlmNodeParams anyway.
    const { params: current } = await getLlmNodeParams(this.patchContext(), pipelineId);

    const finalPrompt = args.prompt !== undefined ? args.prompt : (typeof current.prompt === 'string' ? current.prompt : '');
    const finalCollectionIds = args.collection_index_ids !== undefined
      ? args.collection_index_ids
      : (Array.isArray(current.collection_index_ids) ? current.collection_index_ids : []);

    assertCollectionPromptInvariant(finalPrompt, finalCollectionIds);

    const patch: Partial<LlmNodeParams> = {};
    if (args.prompt !== undefined) patch.prompt = args.prompt;
    if (args.collection_index_ids !== undefined) patch.collection_index_ids = args.collection_index_ids;
    if (args.max_results !== undefined) patch.max_results = args.max_results;
    if (args.generate_citations !== undefined) patch.generate_citations = args.generate_citations;
    if (args.source_material_id !== undefined) patch.source_material_id = args.source_material_id;
    if (args.tools !== undefined) patch.tools = args.tools;
    if (args.custom_actions !== undefined) patch.custom_actions = args.custom_actions;
    if (args.built_in_tools !== undefined) patch.built_in_tools = args.built_in_tools;
    if (args.mcp_tools !== undefined) patch.mcp_tools = args.mcp_tools;

    await patchLlmNodeParams(this.patchContext(), pipelineId, patch);
  }

  async attachKnowledge(args: {
    experiment_id: number;
    collection_index_ids: number[];
    max_results?: number;
    generate_citations?: boolean;
  }) {
    const patch: Partial<LlmNodeParams> = { collection_index_ids: args.collection_index_ids };
    if (args.max_results !== undefined) patch.max_results = args.max_results;
    if (args.generate_citations !== undefined) patch.generate_citations = args.generate_citations;
    const pipelineId = await this.pipelineIdFor(args.experiment_id);

    const { params } = await getLlmNodeParams(this.patchContext(), pipelineId);
    const finalPrompt = typeof params.prompt === 'string' ? params.prompt : '';
    assertCollectionPromptInvariant(finalPrompt, args.collection_index_ids);

    await patchLlmNodeParams(this.patchContext(), pipelineId, patch);
  }

  async setChatbotTools(args: {
    experiment_id: number;
    tools?: string[];
    custom_actions?: string[];
    built_in_tools?: string[];
    mcp_tools?: string[];
  }) {
    const patch: Partial<LlmNodeParams> = {};
    if (args.tools !== undefined) patch.tools = args.tools;
    if (args.custom_actions !== undefined) patch.custom_actions = args.custom_actions;
    if (args.built_in_tools !== undefined) patch.built_in_tools = args.built_in_tools;
    if (args.mcp_tools !== undefined) patch.mcp_tools = args.mcp_tools;
    const pipelineId = await this.pipelineIdFor(args.experiment_id);
    await patchLlmNodeParams(this.patchContext(), pipelineId, patch);
  }

  async setSourceMaterial(args: { experiment_id: number; source_material_id: number | null }) {
    const pipelineId = await this.pipelineIdFor(args.experiment_id);
    await patchLlmNodeParams(this.patchContext(), pipelineId, {
      source_material_id: args.source_material_id,
    });
  }

  async createCollection(args: {
    name: string;
    summary: string;
    is_index: boolean;
    is_remote_index: boolean;
    llm_provider?: number;
    embedding_model?: number;
  }) {
    const path = `/a/${this.opts.teamSlug}/documents/collection/new/`;
    // Django CollectionForm parses request.POST → form-encoded.
    //
    // Verified against OCS 2026-04-10 via UI-driven Playwright probe:
    //   - `is_index` is the actual form field (hidden input), not `collection_type`.
    //     `collection_type` is a UI-only Alpine radio that sets `is_index` client-side.
    //   - `is_remote_index` defaults to False in the UI (local index is the normal path).
    //     Remote indexes trigger `create_remote_index()` which crashes with 500 on
    //     the connect-ace team even with valid OpenAI creds — likely an OCS bug.
    //   - For indexed collections, `llm_provider` AND `embedding_provider_model` are
    //     BOTH required (enforced in CollectionForm.clean()). Without them, the form
    //     silently drops the is_index flag and creates a media collection instead.
    const form: Record<string, string> = {
      name: args.name,
      summary: args.summary,
      csrfmiddlewaretoken: this.opts.csrfToken,
    };
    if (args.is_index) form.is_index = 'True';
    if (args.is_remote_index) form.is_remote_index = 'on';
    if (args.llm_provider !== undefined) form.llm_provider = String(args.llm_provider);
    if (args.embedding_model !== undefined) form.embedding_provider_model = String(args.embedding_model);
    const res = await this.opts.request('POST', path, form, { formEncoded: true, followRedirects: false });
    if (!res.ok && res.status !== 302) throw await httpErrorFor(res, path);
    // CollectionFormMixin.get_success_url redirects to the collection detail page.
    // URL pattern (verified 2026-04-10): /a/<team>/documents/collections/<id> (no trailing slash)
    const loc = res.headers?.location;
    if (!loc) throw new Error(`createCollection: no Location header (status ${res.status})`);
    const match = loc.match(/\/collections?\/(\d+)/);
    if (!match) throw new Error(`createCollection: could not parse collection id from Location: ${loc}`);
    return { collection_id: Number(match[1]) };
  }

  async uploadCollectionFiles(args: {
    collection_id: number;
    files: Array<{ name: string; content: Buffer | string; mime_type: string }>;
    /**
     * Chunking parameters for indexing. Django's add_collection_files form
     * requires these — the view validates `chunk_size > 0` and
     * `chunk_overlap < chunk_size`. Omitting them before 0.4.6 caused the
     * upload to silently skip indexing (file uploaded but 0 chunks produced).
     * Defaults match the NM Bot collection on ccc-support (the reference for
     * Connect-general knowledge).
     */
    chunk_size?: number;
    chunk_overlap?: number;
  }) {
    // Django's `add_collection_files` view (apps/documents/views.py) parses
    // `request.FILES`, which requires multipart/form-data. The view returns a
    // 302 redirect to the collection home page on success (NOT a JSON response
    // with file_ids). We have to scrape the file IDs from the files listing
    // partial after upload. Verified via UI-driven Playwright probe 2026-04-10.
    //
    // chunk_size / chunk_overlap are mandatory form fields (observed during
    // Iter 8 on 2026-04-20: without them the form validated but indexing
    // produced zero chunks — the MCP call "succeeded" but retrieval silently
    // never worked). Defaults match upstream NM Bot collection.
    const chunkSize = args.chunk_size ?? 800;
    const chunkOverlap = args.chunk_overlap ?? 400;
    if (chunkOverlap >= chunkSize) {
      throw new Error(
        `uploadCollectionFiles: chunk_overlap (${chunkOverlap}) must be < chunk_size (${chunkSize})`,
      );
    }
    const addPath = `/a/${this.opts.teamSlug}/documents/collections/${args.collection_id}/add_files`;
    const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
      csrfmiddlewaretoken: this.opts.csrfToken,
      chunk_size: String(chunkSize),
      chunk_overlap: String(chunkOverlap),
    };
    args.files.forEach((f, i) => {
      multipart[`files_${i}`] = {
        name: f.name,
        mimeType: f.mime_type,
        buffer: Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content),
      };
    });
    const res = await this.opts.request('POST', addPath, undefined, { multipart, followRedirects: false });
    // Expect a 302 redirect to the collection home page on success.
    if (res.status !== 302 && !res.ok) throw await httpErrorFor(res, addPath);

    // Scrape the CollectionFile PKs from the files listing endpoint. Note:
    // the listing renders TWO different IDs per uploaded file:
    //   - File.id   → in anchor href `/files/file/<file_id>/`
    //   - CollectionFile.id → in wrapper div `id="collection_file_<id>"`
    //
    // The status-polling endpoint `/collections/<cid>/files/<pk>/status` uses
    // `<pk>` = CollectionFile PK (NOT File PK). Verified against OCS 2026-04-11:
    // scraping File IDs and polling with them returns HTML 404s because
    // `get_object_or_404(CollectionFile, pk=...)` can't find the row.
    //
    // We keep the return-value field named `file_ids` for interface stability,
    // but the values are semantically CollectionFile IDs — they round-trip to
    // `waitForCollectionIndexing` which polls the status endpoint.
    const listPath = `/a/${this.opts.teamSlug}/documents/collections/${args.collection_id}/files/`;
    const listRes = await this.opts.request('GET', listPath);
    if (!listRes.ok || !listRes.text) throw await httpErrorFor(listRes, listPath);
    const html = await listRes.text();
    const cfIdMatches = [...html.matchAll(/id="collection_file_(\d+)"/g)];
    const fileIds = [...new Set(cfIdMatches.map((m) => Number(m[1])))];
    if (fileIds.length === 0) {
      throw new Error(
        `uploadCollectionFiles: no CollectionFile IDs scraped from files listing for collection ${args.collection_id}. ` +
          'The upload may have failed silently — check file extension (must be in SUPPORTED_FILE_TYPES).'
      );
    }
    return { file_ids: fileIds };
  }

  // file_ids is now a required caller-supplied list (from uploadCollectionFiles).
  // _pollIntervalMs is retained as an underscore-prefixed test seam only.
  async waitForCollectionIndexing(args: {
    collection_id: number;
    file_ids: number[];
    timeout_sec?: number;
    _pollIntervalMs?: number;
  }) {
    const fileIds = args.file_ids;
    if (!fileIds || fileIds.length === 0) {
      throw new Error(
        `waitForCollectionIndexing called with empty file_ids for collection ${args.collection_id}. ` +
          'Pass the file_ids returned by uploadCollectionFiles.'
      );
    }
    const timeoutSec = args.timeout_sec ?? 300;
    const pollInterval = args._pollIntervalMs ?? 2000;
    const deadline = Date.now() + timeoutSec * 1000;

    while (Date.now() < deadline) {
      // Probe all files in parallel — they're independent CollectionFile rows
      // on the OCS side; serial probing burns N×RTT per cycle for no benefit.
      // For 5 files at ~200ms RTT, parallelizing shaves ~800ms/cycle, which
      // adds up across the 150–300 cycles a 5–10 min indexing wait spans.
      // The status endpoint returns an HTMX partial (HTML), not JSON. Scrape
      // `data-tip="<status>"` ("In Progress" | "Failed" | "Complete") and
      // `<N> chunks` from the chunk_count span. Verified against OCS
      // 2026-04-11. `pk` in the URL is the CollectionFile PK, not File PK.
      const probes = await Promise.all(
        fileIds.map(async (fid) => {
          const url = `/a/${this.opts.teamSlug}/documents/collections/${args.collection_id}/files/${fid}/status`;
          const res = await this.opts.request('GET', url);
          if (!res.ok || !res.text) return { fid, status: '', chunkCount: 0, ok: false };
          const html = await res.text();
          const statusMatch = html.match(/data-tip="([^"]+)"/);
          const chunkMatch = html.match(/>(\d+)\s+chunks?<\/span>/);
          return {
            fid,
            status: statusMatch?.[1] ?? '',
            chunkCount: chunkMatch ? Number(chunkMatch[1]) : 0,
            ok: true,
          };
        })
      );
      let indexed = 0;
      const failed: number[] = [];
      for (const p of probes) {
        if (!p.ok) continue;
        const lc = p.status.toLowerCase();
        if (p.chunkCount > 0 || lc === 'complete' || lc === 'completed') {
          indexed++;
        } else if (lc === 'failed' || lc === 'error') {
          failed.push(p.fid);
        }
      }
      if (failed.length > 0) {
        throw new Error(
          `waitForCollectionIndexing: ${failed.length} file(s) failed to index ` +
            `(collection ${args.collection_id}, collection_file_ids ${failed.join(', ')}). ` +
            `Check the OCS Celery worker logs — exception was caught in ` +
            `LocalIndexManager.add_files (apps/service_providers/llm_service/index_managers.py).`
        );
      }
      if (indexed === fileIds.length) {
        return { ready: true, files_indexed: indexed, pending: 0 };
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new CollectionIndexingTimeoutError(args.collection_id, timeoutSec);
  }

  /**
   * Create a brand-new chatbot from scratch (not cloning a template).
   *
   * POST /a/<team>/chatbots/new/ via the CSRF-protected CreateChatbot
   * view (apps/chatbots/views.py:CreateChatbot). Form takes just `name` +
   * optional `description`. On `form_valid` OCS auto-creates a default
   * Pipeline (with the team's first LLM provider), then 302-redirects to
   * /a/<team>/chatbots/<id>/edit/.
   *
   * Returns the new experiment_id + the auto-created pipeline_id. The
   * caller can then mutate the pipeline graph via
   * `/pipelines/data/<pipeline_id>/` (see pipeline-patch.ts).
   *
   * Note: this does NOT create channels. For a fully-usable chatbot in
   * Connect Messaging, the caller must follow up with channel creation —
   * cloneChatbot's `createEmbeddedWidgetChannel` is the template. The
   * stub-template flow for Connect Interviews doesn't need a channel
   * (only used as a clone source), so the channel step is split off.
   */
  async createChatbot(args: { name: string; description?: string }): Promise<{ experiment_id: number; pipeline_id: number }> {
    const newPath = `/a/${this.opts.teamSlug}/chatbots/new/`;
    const res = await this.opts.request(
      'POST',
      newPath,
      {
        name: args.name,
        description: args.description ?? '',
        csrfmiddlewaretoken: this.opts.csrfToken,
      },
      { followRedirects: false, formEncoded: true },
    );
    if (res.status !== 302 && !res.ok) {
      throw await httpErrorFor(res, newPath);
    }
    const location = res.headers?.location ?? res.headers?.['Location'];
    if (!location) {
      throw new Error(
        `createChatbot returned ${res.status} with no Location header. ` +
          `Form likely failed validation (CreateChatbot.form_invalid re-renders 200). ` +
          `Common cause: team has no LLM providers configured — ChatbotForm.save() ` +
          `calls get_first_llm_provider_by_team and the auto-Pipeline.create_default_pipeline_with_name ` +
          `needs an LLM provider id.`,
      );
    }
    const experimentId = extractExperimentIdFromLocation(location);
    if (!experimentId) {
      throw new Error(`Could not parse experiment_id from Location header: ${location}`);
    }
    // GET /edit/ to scrape the auto-created pipeline_id.
    const editPath = `/a/${this.opts.teamSlug}/chatbots/${experimentId}/edit/`;
    const editRes = await this.opts.request('GET', editPath);
    if (!editRes.ok || !editRes.text) throw await httpErrorFor(editRes, editPath);
    const editHtml = await editRes.text();
    const pipelineId = extractPipelineId(editHtml);
    if (!pipelineId) {
      throw new PipelineShapeError(
        `Could not find pipeline_id in edit page for newly-created experiment ${experimentId}. ` +
          `OCS template drift on pipeline_builder.html?`,
      );
    }
    this.pipelineCache.set(experimentId, pipelineId);
    return { experiment_id: experimentId, pipeline_id: pipelineId };
  }

  /**
   * Add a node to a chatbot's pipeline. Wraps the pipeline-patch helper —
   * see `addPipelineNode` in pipeline-patch.ts for the splice semantics.
   *
   * Used by the ACE Interviews stub-template build to insert
   * DynamicRouterNode + PythonNode into the default Start→LLM→End graph
   * that createChatbot produces.
   */
  async addPipelineNode(args: {
    pipeline_id: number;
    node_type: string;
    node_id?: string;
    position?: { x: number; y: number };
    params?: Record<string, unknown>;
    connect_from?: string;
    connect_to?: string;
    disconnect_edge?: { source: string; target: string };
  }): Promise<{ node_id: string }> {
    const { nodeId } = await addPipelineNode(this.patchContext(), {
      pipelineId: args.pipeline_id,
      nodeType: args.node_type,
      nodeId: args.node_id,
      position: args.position,
      params: args.params,
      connectFrom: args.connect_from,
      connectTo: args.connect_to,
      disconnectEdge: args.disconnect_edge,
    });
    return { node_id: nodeId };
  }

  async cloneChatbot(args: { template_id: number; new_name: string }): Promise<ClonedChatbot> {
    // Step 1: POST the copy form. `copy_chatbot` in apps/chatbots/views.py:772
    // parses request.POST (form-encoded) and returns a 302 redirect to
    // single_chatbot_home on form.is_valid() — otherwise it silently re-renders
    // the original chatbot's home page with a 200, which looks deceptively
    // successful. Verified against real OCS 2026-04-09.
    const copyUrl = `/a/${this.opts.teamSlug}/chatbots/${args.template_id}/copy/`;
    const copyRes = await this.opts.request(
      'POST',
      copyUrl,
      { new_name: args.new_name, csrfmiddlewaretoken: this.opts.csrfToken },
      { followRedirects: false, formEncoded: true },
    );
    if (copyRes.status !== 302 && !copyRes.ok) {
      throw await httpErrorFor(copyRes, copyUrl);
    }
    const location = copyRes.headers?.location ?? copyRes.headers?.['Location'];
    if (!location) {
      throw new Error(
        `Clone of template ${args.template_id} did not return a Location header. ` +
          `Status: ${copyRes.status}`
      );
    }
    const experimentId = extractExperimentIdFromLocation(location);
    if (!experimentId) {
      throw new Error(`Could not parse experiment_id from Location header: ${location}`);
    }

    // Step 2: GET the edit page to scrape both public_id and pipeline_id. The
    // pipeline builder page renders `pipeline_id` inline in a <script> block,
    // and the chatbot home page renders `public_id` as a widget tag attribute
    // — but since the edit page links to both, GETting the home page is one
    // call that gets us the public_id cheaply. Then we separately GET /edit/
    // for pipeline_id.
    const homePath = `/a/${this.opts.teamSlug}/chatbots/${experimentId}/`;
    const homeRes = await this.opts.request('GET', homePath);
    if (!homeRes.ok || !homeRes.text) throw await httpErrorFor(homeRes, homePath);
    const homeHtml = await homeRes.text();
    const publicId = extractPublicId(homeHtml);
    if (!publicId) {
      throw new Error(
        `Could not find public_id in chatbot home page for experiment ${experimentId}. ` +
          'Template may have changed or flag_chat_widget is off (the widget tag is behind that flag).'
      );
    }

    const editPath = `/a/${this.opts.teamSlug}/chatbots/${experimentId}/edit/`;
    const editRes = await this.opts.request('GET', editPath);
    if (!editRes.ok || !editRes.text) throw await httpErrorFor(editRes, editPath);
    const editHtml = await editRes.text();
    const pipelineId = extractPipelineId(editHtml);
    if (!pipelineId) {
      throw new PipelineShapeError(
        `Could not find pipeline_id in edit page for experiment ${experimentId}. ` +
          'Template drift on templates/pipelines/pipeline_builder.html?'
      );
    }
    this.pipelineCache.set(experimentId, pipelineId);

    // Step 3: Create the EMBEDDED_WIDGET channel on the clone. The clone does
    // NOT inherit the template's ExperimentChannel rows (channels are
    // ForeignKey(experiment, CASCADE) and create_new_version(is_copy=True) in
    // apps/experiments/models.py:895 doesn't touch them). Without this step,
    // getChatbotEmbedInfo would always fail because the clone has zero channels.
    await this.createEmbeddedWidgetChannel(experimentId, args.new_name);

    return { experiment_id: experimentId, public_id: publicId, pipeline_id: pipelineId };
  }

  /**
   * Create an EMBEDDED_WIDGET channel on an existing experiment.
   *
   * POSTs to the channel create-dialog endpoint. The server auto-generates
   * `widget_token = secrets.token_urlsafe(24)` in EmbeddedWidgetChannelForm.clean()
   * (apps/channels/forms.py:649), so we don't supply one. We pass
   * `allow_all_domains=on` so the widget can be embedded on any origin (ACE's
   * connect-labs chat route will add per-opp domain restrictions later if needed).
   */
  private async createEmbeddedWidgetChannel(experimentId: number, channelName: string): Promise<void> {
    // Note the URL prefix: channel create-dialog lives under /channels/<team>/...
    // not /a/<team>/... — verified from apps/channels/urls.py. The `/a/` routes
    // are for the HTML dashboard; `/channels/` is a separate app URL include.
    const path = `/channels/${this.opts.teamSlug}/chatbots/${experimentId}/channels/create-dialog/embedded_widget/`;
    const res = await this.opts.request(
      'POST',
      path,
      {
        name: channelName,
        platform: 'embedded_widget',
        allow_all_domains: 'on',
        csrfmiddlewaretoken: this.opts.csrfToken,
      },
      { followRedirects: false, formEncoded: true },
    );
    // Verified 2026-04-09: on success the view returns 200 with HTMX out-of-band
    // swap HTML containing the new channel button. A 302 would indicate a redirect.
    // Anything else is a failure.
    if (!res.ok && res.status !== 302) {
      throw await httpErrorFor(res, path);
    }
  }

  async publishChatbotVersion(args: { experiment_id: number; description: string }) {
    // Pre-flight: round-trip the pipeline through /pipelines/data/ to surface
    // any node-level validation errors BEFORE hitting /versions/create.
    //
    // Background: Django's create_version view re-renders the form with HTTP
    // 200 and NO `<ul class="errorlist">` when the backing pipeline fails
    // server-side validation (e.g., an attached collection_index_id doesn't
    // exist on the team). The only place the real error surfaces is the
    // pipeline-save response body's nested `errors.node.<id>.<field>`, which
    // /versions/create never calls. This check plugs the gap.
    //
    // Discovered 2026-04-19 when a phantom collection 718 bricked the golden
    // template: attach silently succeeded, every publish silently blocked,
    // and the only diagnostic signal was "form re-rendered without redirect."
    // See CHANGELOG 0.4.4 for the bootstrap-side defense and 0.4.6 for this
    // MCP-layer defense (catches the entire pipeline-invalidity class, not
    // just collection-id drift).
    const pipelineId = await this.pipelineIdFor(args.experiment_id);
    await validatePipeline(this.patchContext(), pipelineId);

    const versionPath = `/a/${this.opts.teamSlug}/chatbots/${args.experiment_id}/versions/create`;
    const res = await this.opts.request(
      'POST',
      versionPath,
      {
        version_description: args.description,
        is_default_version: 'on',
        csrfmiddlewaretoken: this.opts.csrfToken,
      },
      { formEncoded: true, followRedirects: false },
    );
    // Django's create_version view redirects to the chatbot page on success (302),
    // or re-renders the form on validation failure (200 with HTML). Since we POST
    // with followRedirects: false, a 200 unambiguously means the form was
    // re-rendered — the version was NOT created. The form field is
    // `is_default_version` (not `make_default`) — verified against OCS 2026-04-10.
    if (res.status === 200) {
      const body = res.text ? await res.text().catch(() => '') : '';
      const errorMatches = [...body.matchAll(/<ul class="errorlist[^"]*">([\s\S]*?)<\/ul>/g)]
        .flatMap((m) => [...m[1].matchAll(/<li[^>]*>([^<]+)<\/li>/g)].map((li) => li[1].trim()))
        .filter((s) => s.length > 0);
      const summary = errorMatches.length > 0 ? errorMatches.join('; ') : 'form re-rendered without redirect';
      throw new HttpError(200, versionPath, `Version publish rejected: ${summary}`);
    }
    if (res.status !== 302 && !res.ok) throw await httpErrorFor(res, versionPath);

    // Scrape the version number from the chatbot home page. The versions tab
    // renders version badges; we grab the highest number.
    const homePath = `/a/${this.opts.teamSlug}/chatbots/${args.experiment_id}/`;
    const homeRes = await this.opts.request('GET', homePath);
    let versionNumber = 1;
    if (homeRes.ok && homeRes.text) {
      const html = await homeRes.text();
      const versionMatches = [...html.matchAll(/Version\s+(\d+)/g)].map((m) => Number(m[1]));
      if (versionMatches.length > 0) {
        versionNumber = Math.max(...versionMatches);
      }
    }

    return { version_number: versionNumber, task_id: 'none' };
  }

  /**
   * Fetch the public_id + embed_key for an experiment's EMBEDDED_WIDGET channel.
   *
   * Three HTTP calls:
   *   1. GET /a/<team>/chatbots/<eid>/              → scrape public_id from the
   *                                                    <open-chat-studio-widget>
   *                                                    tag + find the channel_id
   *                                                    of the embedded_widget
   *                                                    channel from its hx-get
   *                                                    URL on the channel button
   *   2. GET /a/<team>/chatbots/<eid>/channels/<channel_id>/edit-dialog/
   *                                                 → scrape widget_token from
   *                                                    the widget_params.html
   *                                                    partial's hidden input
   *
   * Why not the REST API? Because `/api/experiments/<id>/` takes a UUID path
   * parameter and doesn't expose the channel's embed_key at all. Everything
   * hangs off the admin HTML.
   */
  async getChatbotEmbedInfo(args: { experiment_id: number }) {
    const homePath = `/a/${this.opts.teamSlug}/chatbots/${args.experiment_id}/`;
    const homeRes = await this.opts.request('GET', homePath);
    if (!homeRes.ok || !homeRes.text) throw await httpErrorFor(homeRes, homePath);
    const homeHtml = await homeRes.text();

    const publicId = extractPublicId(homeHtml);
    if (!publicId) {
      throw new Error(
        `Could not scrape public_id from chatbot home page for experiment ${args.experiment_id}. ` +
          'Flag `flag_chat_widget` may be off (the widget tag is behind that flag).'
      );
    }

    const channelId = extractEmbeddedWidgetChannelId(homeHtml, args.experiment_id);
    if (!channelId) {
      throw new Error(
        `No EMBEDDED_WIDGET channel found on chatbot home page for experiment ${args.experiment_id}. ` +
          'Clone may have skipped the channel-creation step; run cloneChatbot instead.'
      );
    }

    const editDialogPath = `/channels/${this.opts.teamSlug}/chatbots/${args.experiment_id}/channels/${channelId}/edit-dialog/`;
    const dialogRes = await this.opts.request('GET', editDialogPath);
    if (!dialogRes.ok || !dialogRes.text) throw await httpErrorFor(dialogRes, editDialogPath);
    const dialogHtml = await dialogRes.text();

    const embedKey = extractWidgetToken(dialogHtml);
    if (!embedKey) {
      throw new Error(
        `Could not scrape widget_token from channel edit-dialog for experiment ${args.experiment_id}, channel ${channelId}. ` +
          'Template may have changed on templates/channels/widgets/widget_params.html.'
      );
    }

    return { public_id: publicId, embed_key: embedKey };
  }

  /**
   * Delete a chatbot (experiment). POST to /a/<team>/chatbots/<pk>/delete/
   * triggers `archive_chatbot` view (apps/experiments/views/experiment.py) which
   * calls `Experiment.archive()` and sets `is_archived=True`. The user-visible
   * effect is deletion — the chatbot disappears from listings. Returns 302
   * with HTMX `HX-Redirect` to chatbots_home.
   *
   * Safety boundary: the caller MUST exclude OCS_GOLDEN_TEMPLATE_ID from the
   * sweep set before calling — this atom has no concept of "template" and
   * will happily delete any experiment by id. The `sweep-ocs` skill is
   * responsible for the exclusion check; this method is a thin form-POST.
   */
  async deleteChatbot(args: { experiment_id: number }): Promise<{ deleted: number }> {
    const path = `/a/${this.opts.teamSlug}/chatbots/${args.experiment_id}/delete/`;
    const res = await this.opts.request(
      'POST',
      path,
      { csrfmiddlewaretoken: this.opts.csrfToken },
      { followRedirects: false, formEncoded: true },
    );
    if (res.status === 200 || res.status === 302) {
      return { deleted: 1 };
    }
    throw await httpErrorFor(res, path);
  }

  /**
   * Delete a pipeline. HTTP DELETE to /a/<team>/pipelines/<pk>/delete/
   * triggers `DeletePipeline` view (apps/pipelines/views.py) which calls
   * `Pipeline.archive()` and sets `is_archived=True`. Returns 200 with empty
   * body.
   *
   * Per-opp pipeline delete is SAFE: when ACE clones a chatbot, the upstream
   * `copy_chatbot` view deep-clones the Pipeline (via `create_new_version(is_copy=True)`)
   * — each clone has its own Pipeline row. Verified 2026-05-15 against
   * apps/pipelines/models.py.
   *
   * Note: deleting the pipeline does NOT cascade-delete its referenced
   * Collections — those need separate `deleteCollection` calls. The sweep
   * pairs pipeline+chatbot+per-opp-collection deletes per orphan clone.
   */
  async deletePipeline(args: { pipeline_id: number }): Promise<{ deleted: number }> {
    const path = `/a/${this.opts.teamSlug}/pipelines/${args.pipeline_id}/delete/`;
    const res = await this.opts.request(
      'DELETE',
      path,
      undefined,
      { followRedirects: false },
    );
    if (res.status === 200 || res.status === 204) {
      return { deleted: 1 };
    }
    throw await httpErrorFor(res, path);
  }

  /**
   * Delete a collection. HTTP DELETE to /a/<team>/documents/collection/<pk>/delete/
   * triggers `DeleteCollection` view (apps/documents/views.py) which calls
   * `Collection.archive()` — sets `is_archived=True` AND triggers
   * `delete_document_source_task` to async-purge the underlying File rows,
   * object-storage blobs, and FileChunkEmbedding vectors. The user-visible
   * effect is a full delete: files gone, vector storage reclaimed. Returns
   * 200 with empty body.
   *
   * Safety boundary: the caller MUST exclude OCS_GOLDEN_TEMPLATE_COLLECTION_ID
   * (typically 350) from the sweep set before calling. That collection is
   * referenced by every clone's pipeline (the `if not is_copy` branch in
   * `Node.create_new_version` skips versioning collection_id refs on clone,
   * so all clones inherit it). Deleting it would break every clone's RAG
   * retrieval. Per-opp collections created fresh by Phase 5 are NOT shared
   * and are safe to delete.
   */
  async deleteCollection(args: { collection_id: number }): Promise<{ deleted: number }> {
    const path = `/a/${this.opts.teamSlug}/documents/collection/${args.collection_id}/delete/`;
    const res = await this.opts.request(
      'DELETE',
      path,
      undefined,
      { followRedirects: false },
    );
    if (res.status === 200 || res.status === 204) {
      return { deleted: 1 };
    }
    throw await httpErrorFor(res, path);
  }
}
