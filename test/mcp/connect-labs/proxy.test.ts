import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('connect-labs-server (stdio → HTTP proxy)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards a JSON-RPC frame to labs with Bearer auth and returns the body', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { forward } = await import('../../../mcp/connect-labs-server');
    const out = await forward(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { token: 'test-token', url: 'https://labs.example/mcp/' },
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe('https://labs.example/mcp/');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'Authorization': 'Bearer test-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    expect(out).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  it('returns a JSON-RPC error envelope when the upstream returns 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'PERMISSION_DENIED', message: 'bad token' } }), {
        status: 401,
      }),
    );
    const { forward } = await import('../../../mcp/connect-labs-server');
    const out = await forward(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { token: 'bad', url: 'https://labs.example/mcp/' },
    );
    expect(out).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      error: {
        code: -32000,
        message: expect.stringContaining('401'),
      },
    });
  });

  it('throws if token is empty when invoked', async () => {
    const { forward } = await import('../../../mcp/connect-labs-server');
    await expect(
      forward({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { token: '', url: 'https://labs.example/mcp/' }),
    ).rejects.toThrow(/LABS_MCP_TOKEN/);
  });
});
