import type { RequestFn, RequestResult } from './pipeline-patch.js';
import { patchLlmNodeParams, type PipelinePatchContext } from './pipeline-patch.js';
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
    // Verified against OCS 2026-04-10: the form now expects `collection_type`
    // as a radio field ("indexed" for RAG, "media" for media collections).
    // `is_index` is a hidden field derived from collection_type, not a user input.
    const form: Record<string, string> = {
      name: args.name,
      summary: args.summary,
      collection_type: args.is_index ? 'indexed' : 'media',
      csrfmiddlewaretoken: this.opts.csrfToken,
    };
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
  }) {
    // Django's `add_collection_files` view (apps/documents/views.py:352) parses
    // `request.FILES`, which requires multipart/form-data. We route through the
    // `multipart` RequestOptions channel so the production closure in
    // ocs-server.ts uses Playwright's native `multipart:` option instead of a
    // JSON body.
    //
    // Multipart fields: each file is posted under the `files` field name
    // (Django takes `request.FILES.getlist("files")`). The CSRF token travels
    // as a regular form field.
    const path = `/a/${this.opts.teamSlug}/documents/collections/${args.collection_id}/add_files`;
    const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
      csrfmiddlewaretoken: this.opts.csrfToken,
    };
    // Playwright's multipart dict uses field names as keys; for multiple files
    // sharing a name, we stream them as `files_0`, `files_1`, ... and the
    // production closure re-maps to the `files` field name before posting.
    // This is the only way Playwright's dict-based multipart supports repeated fields.
    args.files.forEach((f, i) => {
      multipart[`files_${i}`] = {
        name: f.name,
        mimeType: f.mime_type,
        buffer: Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content),
      };
    });
    const res = await this.opts.request('POST', path, undefined, { multipart });
    if (!res.ok) throw await httpErrorFor(res, path);
    const body = (await res.json()) as { file_ids: number[] };
    return { file_ids: body.file_ids };
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
      let indexed = 0;
      for (const fid of fileIds) {
        const url = `/a/${this.opts.teamSlug}/documents/collections/${args.collection_id}/files/${fid}/status`;
        const res = await this.opts.request('GET', url);
        if (!res.ok) continue;
        const body = (await res.json()) as { chunk_count?: number };
        if ((body.chunk_count ?? 0) > 0) indexed++;
      }
      if (indexed === fileIds.length) {
        return { ready: true, files_indexed: indexed, pending: 0 };
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new CollectionIndexingTimeoutError(args.collection_id, timeoutSec);
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
    // or re-renders the form on validation failure (200 with HTML). The form field
    // is `is_default_version` (not `make_default`) — verified against OCS 2026-04-10.
    if (res.status !== 302 && !res.ok) throw await httpErrorFor(res, versionPath);
    if (res.status === 200) {
      // 200 can mean: (a) Django followed its own redirect and rendered the chatbot
      // page, or (b) the form re-rendered due to validation errors. Either way, the
      // version was likely created. Check the chatbot page for version info.
      // Fall through to the version scraping below.
    }

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
}
