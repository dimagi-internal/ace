import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  patchLlmNodeParams,
  findLlmResponseNode,
  validatePipeline,
  extractPipelineErrors,
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

  it('throws PipelineValidationError when the save endpoint returns nested node errors (2026-04-19 phantom-collection shape)', async () => {
    const fixture = loadFixture();
    const request: RequestFn = async (method) => {
      if (method === 'GET') return { ok: true, json: async () => fixture };
      return {
        ok: true,
        json: async () => ({
          data: fixture.pipeline.data,
          errors: {
            node: {
              'LLMResponseWithPrompt-abc': {
                collection_index_ids: 'Collection index(s) with ID(s) 718 not found',
              },
            },
          },
        }),
      };
    };
    await expect(
      patchLlmNodeParams({ request, teamSlug: 'dimagi' }, 77, { prompt: 'x' }),
    ).rejects.toThrow(/LLMResponseWithPrompt-abc\.collection_index_ids.*718 not found/);
  });
});

describe('extractPipelineErrors', () => {
  it('returns [] for null / non-object input', () => {
    expect(extractPipelineErrors(null)).toEqual([]);
    expect(extractPipelineErrors(undefined)).toEqual([]);
    expect(extractPipelineErrors('oops')).toEqual([]);
    expect(extractPipelineErrors(42)).toEqual([]);
  });

  it('returns [] when errors field is absent or empty', () => {
    expect(extractPipelineErrors({})).toEqual([]);
    expect(extractPipelineErrors({ errors: [] })).toEqual([]);
    expect(extractPipelineErrors({ errors: {} })).toEqual([]);
    expect(extractPipelineErrors({ errors: { node: {} } })).toEqual([]);
  });

  it('returns top-level string array unchanged (legacy shape)', () => {
    expect(extractPipelineErrors({ errors: ['bad edge', 'orphan node'] })).toEqual([
      'bad edge',
      'orphan node',
    ]);
  });

  it('flattens nested node errors with node-id / field prefixes', () => {
    const body = {
      errors: {
        node: {
          'LLMResponseWithPrompt-abc': {
            collection_index_ids: 'Collection index(s) with ID(s) 718 not found',
            prompt: 'prompt cannot be empty',
          },
          'StartNode-xyz': {
            next: 'missing connection',
          },
        },
      },
    };
    expect(extractPipelineErrors(body).sort()).toEqual(
      [
        'LLMResponseWithPrompt-abc.collection_index_ids: Collection index(s) with ID(s) 718 not found',
        'LLMResponseWithPrompt-abc.prompt: prompt cannot be empty',
        'StartNode-xyz.next: missing connection',
      ].sort(),
    );
  });

  it('JSON-stringifies non-string error values so they are still surfaced', () => {
    const body = {
      errors: {
        node: {
          'abc': {
            max_results: { min: 1, got: 0 },
          },
        },
      },
    };
    expect(extractPipelineErrors(body)).toEqual([
      'abc.max_results: {"min":1,"got":0}',
    ]);
  });
});

describe('validatePipeline', () => {
  const URL = '/a/dimagi/pipelines/data/77/';

  it('round-trips the pipeline through save and resolves on empty errors', async () => {
    const fixture = loadFixture();
    let postCount = 0;
    const request: RequestFn = async (method, url, body) => {
      if (method === 'GET' && url === URL) return { ok: true, json: async () => fixture };
      if (method === 'POST' && url === URL) {
        postCount++;
        // The body is the unchanged graph (no patch applied)
        expect(body).toMatchObject({ name: fixture.pipeline.name, data: fixture.pipeline.data });
        return { ok: true, json: async () => ({ data: fixture.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    await validatePipeline({ request, teamSlug: 'dimagi' }, 77);
    expect(postCount).toBe(1);
  });

  it('throws PipelineValidationError on nested node errors (publish pre-flight)', async () => {
    const fixture = loadFixture();
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url === URL) return { ok: true, json: async () => fixture };
      if (method === 'POST' && url === URL) {
        return {
          ok: true,
          json: async () => ({
            errors: {
              node: {
                'LLMResponseWithPrompt-abc': {
                  collection_index_ids: 'Collection index(s) with ID(s) 999 not found',
                },
              },
            },
          }),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    await expect(
      validatePipeline({ request, teamSlug: 'dimagi' }, 77),
    ).rejects.toThrow(/LLMResponseWithPrompt-abc\.collection_index_ids.*999 not found/);
  });

  it('throws on GET failure', async () => {
    const request: RequestFn = async (method) => {
      if (method === 'GET') return { ok: false, json: async () => ({}) };
      throw new Error('should not POST');
    };
    await expect(
      validatePipeline({ request, teamSlug: 'dimagi' }, 77),
    ).rejects.toThrow(/pipeline data GET failed/);
  });
});
