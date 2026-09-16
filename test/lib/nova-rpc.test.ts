import { describe, it, expect, vi } from 'vitest';
import {
  parseNovaRpcBody,
  unwrapToolResult,
  novaRpc,
  novaCall,
  novaToolNames,
  NOVA_MCP_URL,
} from '../../lib/nova-rpc.js';

describe('parseNovaRpcBody', () => {
  it('parses a plain JSON body', () => {
    expect(parseNovaRpcBody('{"result":{"ok":true}}')).toEqual({ result: { ok: true } });
  });

  it('parses an SSE body, taking the LAST data frame', () => {
    const sse = 'event: message\ndata: {"result":1}\n\nevent: message\ndata: {"result":2}\n\n';
    expect(parseNovaRpcBody(sse)).toEqual({ result: 2 });
  });

  it('tolerates leading/trailing whitespace around a JSON body', () => {
    expect(parseNovaRpcBody('\n  {"result":"x"}  \n')).toEqual({ result: 'x' });
  });

  it('throws on a body carrying no data frame', () => {
    expect(() => parseNovaRpcBody('event: ping\n\n')).toThrow(/unrecognised response/);
  });
});

describe('unwrapToolResult', () => {
  it('parses JSON text content', () => {
    const r = { content: [{ text: '{"app_id":"abc"}' }] };
    expect(unwrapToolResult(r, 'get_app')).toEqual({ app_id: 'abc' });
  });

  it('returns raw text when the content is not JSON', () => {
    const r = { content: [{ text: 'plain guidance text' }] };
    expect(unwrapToolResult(r, 'get_authoring_guide')).toBe('plain guidance text');
  });

  it('joins multiple content chunks', () => {
    const r = { content: [{ text: '{"a":' }, { text: '1}' }] };
    expect(unwrapToolResult(r, 'x')).toEqual({ a: 1 });
  });

  it('THROWS on isError rather than returning the message as data', () => {
    // Nova applies nothing on rejection and names the problem in the text, so a
    // tool-level rejection must never be mistaken for a successful payload.
    const r = { isError: true, content: [{ text: 'moduleUuid: expected string' }] };
    expect(() => unwrapToolResult(r, 'create_form')).toThrow(/create_form rejected.*moduleUuid/s);
  });

  it('handles a missing content array', () => {
    expect(unwrapToolResult({}, 'x')).toBe('');
  });
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Request',
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('novaRpc', () => {
  it('posts a well-formed JSON-RPC envelope with the bearer token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ result: { ok: 1 } }));
    await novaRpc('tools/list', undefined, { apiKey: 'sk-test', fetchImpl: fetchImpl as never });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(NOVA_MCP_URL);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    // Nova can answer as SSE, so the Accept header must admit it.
    expect(headers.Accept).toContain('text/event-stream');
    const sent = JSON.parse(init.body as string);
    expect(sent.jsonrpc).toBe('2.0');
    expect(sent.method).toBe('tools/list');
    expect(typeof sent.id).toBe('number');
  });

  it('throws a clear error when NOVA_API_KEY is absent', async () => {
    const prev = process.env.NOVA_API_KEY;
    delete process.env.NOVA_API_KEY;
    try {
      await expect(novaRpc('tools/list', undefined, { fetchImpl: vi.fn() as never })).rejects.toThrow(
        /NOVA_API_KEY is not set/,
      );
    } finally {
      if (prev !== undefined) process.env.NOVA_API_KEY = prev;
    }
  });

  it('surfaces a non-2xx as an HTTP error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 502));
    await expect(
      novaRpc('tools/list', undefined, { apiKey: 'k', fetchImpl: fetchImpl as never }),
    ).rejects.toThrow(/HTTP 502/);
  });

  it('surfaces a JSON-RPC error member', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: -32602, message: 'nope' } }));
    await expect(
      novaRpc('tools/call', {}, { apiKey: 'k', fetchImpl: fetchImpl as never }),
    ).rejects.toThrow(/-32602/);
  });

  it('honours a url override', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ result: {} }));
    await novaRpc('tools/list', undefined, {
      apiKey: 'k',
      url: 'https://staging.example/mcp',
      fetchImpl: fetchImpl as never,
    });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://staging.example/mcp');
  });
});

describe('novaCall', () => {
  it('wraps the tool name and arguments into params and unwraps the result', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ result: { content: [{ text: '{"moduleUuid":"m1"}' }] } }),
    );
    const out = await novaCall(
      'create_module',
      { app_id: 'a', name: 'M' },
      { apiKey: 'k', fetchImpl: fetchImpl as never },
    );
    expect(out).toEqual({ moduleUuid: 'm1' });

    const sent = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.method).toBe('tools/call');
    expect(sent.params).toEqual({ name: 'create_module', arguments: { app_id: 'a', name: 'M' } });
  });

  it('reaches a tool whose schema the Messages API will not bind (ace#2408)', async () => {
    // create_module is the canonical case: depth-20 inputSchema, rejected at
    // bind time, perfectly callable over JSON-RPC.
    const fetchImpl = vi.fn(async () => jsonResponse({ result: { content: [{ text: '{"ok":true}' }] } }));
    await expect(
      novaCall('create_module', {}, { apiKey: 'k', fetchImpl: fetchImpl as never }),
    ).resolves.toEqual({ ok: true });
  });

  it('propagates a tool-level rejection as a throw', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ result: { isError: true, content: [{ text: 'Nothing was changed' }] } }),
    );
    await expect(
      novaCall('add_fields', {}, { apiKey: 'k', fetchImpl: fetchImpl as never }),
    ).rejects.toThrow(/Nothing was changed/);
  });
});

describe('novaToolNames', () => {
  it('returns the tool names', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ result: { tools: [{ name: 'get_app' }, { name: 'create_module' }] } }),
    );
    await expect(novaToolNames({ apiKey: 'k', fetchImpl: fetchImpl as never })).resolves.toEqual([
      'get_app',
      'create_module',
    ]);
  });

  it('returns [] when the payload carries no tools array', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ result: {} }));
    await expect(novaToolNames({ apiKey: 'k', fetchImpl: fetchImpl as never })).resolves.toEqual([]);
  });
});
