import type { FlowGraph, FlowNode, LlmNodeParams, PipelineDataResponse } from '../types.js';
import { PipelineShapeError, PipelineValidationError } from '../errors.js';

export interface RequestResult {
  ok: boolean;
  json: () => Promise<unknown>;
}

export type RequestFn = (
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
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
