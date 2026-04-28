import type { FlowGraph, FlowNode, LlmNodeParams, PipelineDataResponse } from '../types.js';
import { PipelineShapeError, PipelineValidationError } from '../errors.js';

export interface RequestResult {
  ok: boolean;
  /** HTTP status code. Optional for backward-compat with older test fakes. */
  status?: number;
  /** Response body as text — used for HttpError messages and HTML scraping. Optional for older test fakes. */
  text?: () => Promise<string>;
  /** Response headers as a flat dict. Used to read Location on 302 redirects. */
  headers?: Record<string, string>;
  json: () => Promise<unknown>;
}

/**
 * Request options. Each flag maps to a specific Playwright request.post mode:
 *
 * - `followRedirects: false` → `maxRedirects: 0`, lets us parse 302 Location
 *   headers (e.g. `/copy/`, channel create-dialog).
 * - `multipart` → Playwright's `multipart:` option, required by Django views
 *   that parse `request.FILES` (e.g. `add_collection_files`).
 * - `formEncoded: true` → Playwright's `form:` option (application/x-www-form-urlencoded),
 *   required by Django views that parse `request.POST` via `FormCls(request.POST)`.
 *   Without this, bodies are sent as JSON (`data:`) which Django form views ignore
 *   and the view falls through to its unauthenticated branch.
 *
 * Default (none of the above) sends the body as JSON (`data:`), which is what
 * the pipeline_data endpoint expects (it calls `FlowPipelineData.model_validate_json`).
 */
export interface RequestOptions {
  followRedirects?: boolean;
  multipart?: Record<string, string | { name: string; mimeType: string; buffer: Buffer }>;
  formEncoded?: boolean;
}

export type RequestFn = (
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  options?: RequestOptions,
) => Promise<RequestResult>;

export interface PipelinePatchContext {
  request: RequestFn;
  teamSlug: string;
}

export function findLlmResponseNode(graph: FlowGraph): FlowNode {
  const matches = graph.nodes.filter((n) => n.data.type === 'LLMResponseWithPrompt');
  if (matches.length === 0) {
    throw new PipelineShapeError(
      'Expected exactly 1 LLMResponseWithPrompt node, found 0. Golden template invariant violated.'
    );
  }
  if (matches.length > 1) {
    throw new PipelineShapeError(
      `Expected exactly 1 LLMResponseWithPrompt node, found ${matches.length}. ` +
        'Multi-LLM templates are not supported in v1; add a label convention and pass a node selector.'
    );
  }
  return matches[0];
}

export async function patchLlmNodeParams(
  ctx: PipelinePatchContext,
  pipelineId: number,
  patch: Partial<LlmNodeParams>,
): Promise<void> {
  const url = `/a/${ctx.teamSlug}/pipelines/data/${pipelineId}/`;
  const getRes = await ctx.request('GET', url);
  if (!getRes.ok) {
    throw new Error(`pipeline data GET failed for pipeline ${pipelineId}`);
  }
  const payload = (await getRes.json()) as PipelineDataResponse;
  const graph = payload.pipeline.data;

  const node = findLlmResponseNode(graph);
  Object.assign(node.data.params, patch);

  const postRes = await ctx.request('POST', url, {
    name: payload.pipeline.name,
    data: graph,
  });
  if (!postRes.ok) {
    throw new Error(`pipeline data POST failed for pipeline ${pipelineId}`);
  }
  const errors = extractPipelineErrors(await postRes.json());
  if (errors.length > 0) {
    throw new PipelineValidationError(errors);
  }
}

/**
 * Read-only fetch of the LLM-response node's current params. Used by atoms
 * that need to validate state BEFORE patching (e.g. attach_knowledge needs
 * to verify the prompt contains `{collection_index_summaries}` or the pipeline
 * save will silently reject — the 0.5.19 dogfood-surfaced footgun).
 *
 * Returns the params object plus the name (for parity with patch errors).
 */
export async function getLlmNodeParams(
  ctx: PipelinePatchContext,
  pipelineId: number,
): Promise<{ params: LlmNodeParams; pipelineName: string }> {
  const url = `/a/${ctx.teamSlug}/pipelines/data/${pipelineId}/`;
  const getRes = await ctx.request('GET', url);
  if (!getRes.ok) {
    throw new Error(`pipeline data GET failed for pipeline ${pipelineId}`);
  }
  const payload = (await getRes.json()) as PipelineDataResponse;
  const node = findLlmResponseNode(payload.pipeline.data);
  return { params: node.data.params, pipelineName: payload.pipeline.name };
}

/**
 * Round-trip the current pipeline through the save endpoint to surface any
 * node-level validation errors without modifying the graph. Used as a
 * pre-flight before `publishChatbotVersion` — catches the silent-block class
 * of bug where /versions/create returns 200 + form-re-render instead of an
 * actionable error.
 *
 * The 2026-04-19 phantom-collection bug was invisible at publish time: the
 * version create view re-rendered the form with no errorlist because the
 * errors originated on the pipeline, not on the version form itself. The
 * only place those errors surface is the pipeline-save response body, which
 * `/versions/create` never calls. This helper calls it explicitly.
 */
export async function validatePipeline(
  ctx: PipelinePatchContext,
  pipelineId: number,
): Promise<void> {
  const url = `/a/${ctx.teamSlug}/pipelines/data/${pipelineId}/`;
  const getRes = await ctx.request('GET', url);
  if (!getRes.ok) {
    throw new Error(`pipeline data GET failed for pipeline ${pipelineId}`);
  }
  const payload = (await getRes.json()) as PipelineDataResponse;
  const postRes = await ctx.request('POST', url, {
    name: payload.pipeline.name,
    data: payload.pipeline.data,
  });
  if (!postRes.ok) {
    throw new Error(`pipeline data POST failed for pipeline ${pipelineId}`);
  }
  const errors = extractPipelineErrors(await postRes.json());
  if (errors.length > 0) {
    throw new PipelineValidationError(errors);
  }
}

/**
 * Parse pipeline-save response errors into a flat string list. Handles two
 * observed shapes:
 *   - `{ errors: ["error1", "error2"] }` — top-level string array, historically
 *     the only shape the code checked for
 *   - `{ errors: { node: { "<node-id>": { "<field>": "<msg>" } } } }` — nested
 *     per-node shape that OCS returns for node-level validation errors (e.g.
 *     attaching a collection_index_id that doesn't exist on the team). This
 *     shape was what hid the 2026-04-19 phantom-collection bug: the top-level
 *     `errors` was empty-or-absent, so the old check passed, and only
 *     /versions/create's silent form re-render revealed the issue.
 *
 * Node-level errors are returned as `"<node-id>.<field>: <msg>"` so the
 * resulting `PipelineValidationError` message names exactly which node and
 * which field broke.
 */
export function extractPipelineErrors(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const errors = (body as { errors?: unknown }).errors;
  if (!errors) return [];
  if (Array.isArray(errors)) {
    return errors.filter((e): e is string => typeof e === 'string');
  }
  if (typeof errors !== 'object') return [];
  const out: string[] = [];
  const nodeErrors = (errors as { node?: Record<string, unknown> }).node;
  if (nodeErrors && typeof nodeErrors === 'object') {
    for (const [nodeId, fields] of Object.entries(nodeErrors)) {
      if (!fields || typeof fields !== 'object') continue;
      for (const [field, msg] of Object.entries(fields as Record<string, unknown>)) {
        const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
        out.push(`${nodeId}.${field}: ${text}`);
      }
    }
  }
  return out;
}
