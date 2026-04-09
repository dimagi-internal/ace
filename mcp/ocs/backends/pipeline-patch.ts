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
  const saveBody = (await postRes.json()) as { errors: string[] };
  if (saveBody.errors && saveBody.errors.length > 0) {
    throw new PipelineValidationError(saveBody.errors);
  }
}
