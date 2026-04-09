import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  patchLlmNodeParams,
  findLlmResponseNode,
  type RequestFn,
} from '../../../mcp/ocs/backends/pipeline-patch.js';
import { PipelineShapeError, PipelineValidationError } from '../../../mcp/ocs/errors.js';

// ESM __dirname equivalent
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture() {
  const file = path.join(__dirname, 'fixtures', 'sample-pipeline.json');
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

describe('findLlmResponseNode', () => {
  it('finds the single LLMResponseWithPrompt node', () => {
    const graph = loadFixture().pipeline.data;
    const node = findLlmResponseNode(graph);
    expect(node.id).toBe('llm-1');
  });

  it('throws PipelineShapeError when no LLM node is present', () => {
    const graph = loadFixture().pipeline.data;
    graph.nodes = graph.nodes.filter((n: { data: { type: string } }) => n.data.type !== 'LLMResponseWithPrompt');
    expect(() => findLlmResponseNode(graph)).toThrow(PipelineShapeError);
  });

  it('throws PipelineShapeError when more than one LLM node is present', () => {
    const graph = loadFixture().pipeline.data;
    graph.nodes.push(JSON.parse(JSON.stringify(graph.nodes[1])));
    expect(() => findLlmResponseNode(graph)).toThrow(PipelineShapeError);
  });
});

describe('patchLlmNodeParams', () => {
  const GET_URL = '/a/dimagi/pipelines/data/77/';
  const POST_URL = '/a/dimagi/pipelines/data/77/';

  it('GETs, patches prompt, POSTs the modified graph', async () => {
    const fixture = loadFixture();
    let savedBody: { name: string; data: { nodes: Array<{ data: { type: string; params: { prompt?: string } } }> } } | undefined;

    const request: RequestFn = async (method, url, body) => {
      if (method === 'GET' && url === GET_URL) {
        return { ok: true, json: async () => fixture };
      }
      if (method === 'POST' && url === POST_URL) {
        savedBody = body as typeof savedBody;
        return { ok: true, json: async () => ({ data: fixture.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    await patchLlmNodeParams(
      { request, teamSlug: 'dimagi' },
      77,
      { prompt: 'You are the ACE support bot for Malaria Pilot.' },
    );

    expect(savedBody).toBeDefined();
    const llm = savedBody!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.prompt).toBe('You are the ACE support bot for Malaria Pilot.');
  });

  it('applies multiple field patches to the same node', async () => {
    const fixture = loadFixture();
    let savedBody: { data: { nodes: Array<{ data: { type: string; params: Record<string, unknown> } }> } } | undefined;

    const request: RequestFn = async (method, url, body) => {
      if (method === 'GET') return { ok: true, json: async () => fixture };
      savedBody = body as typeof savedBody;
      return { ok: true, json: async () => ({ data: fixture.pipeline.data, errors: [] }) };
    };

    await patchLlmNodeParams({ request, teamSlug: 'dimagi' }, 77, {
      collection_index_ids: [123],
      max_results: 10,
      generate_citations: false,
    });

    const llm = savedBody!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.collection_index_ids).toEqual([123]);
    expect(llm.data.params.max_results).toBe(10);
    expect(llm.data.params.generate_citations).toBe(false);
  });

  it('throws PipelineValidationError when the save endpoint returns errors', async () => {
    const fixture = loadFixture();
    const request: RequestFn = async (method) => {
      if (method === 'GET') return { ok: true, json: async () => fixture };
      return { ok: true, json: async () => ({ data: fixture.pipeline.data, errors: ['bad edge'] }) };
    };

    await expect(
      patchLlmNodeParams({ request, teamSlug: 'dimagi' }, 77, { prompt: 'x' })
    ).rejects.toBeInstanceOf(PipelineValidationError);
  });
});
