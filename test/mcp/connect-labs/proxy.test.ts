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

  // Background: jjackson/ace#106 finding 8 — `notifications/initialized`
  // (a JSON-RPC notification with no `id`) was being forwarded to the
  // labs server, which replied with "Method not found"; the proxy then
  // wrote that error to stdout. The MCP host treats unsolicited messages
  // as a protocol violation and disables tool discovery, so ToolSearch
  // couldn't see any `mcp__connect-labs__*` tools. The fix detects
  // notifications and suppresses any reply.
  describe('isNotification (regression: ToolSearch tool discovery)', () => {
    it('frames without an id are notifications', async () => {
      const { isNotification } = await import('../../../mcp/connect-labs-server');
      expect(
        isNotification({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      ).toBe(true);
    });

    it('frames with explicit null id are notifications', async () => {
      const { isNotification } = await import('../../../mcp/connect-labs-server');
      expect(
        isNotification({ jsonrpc: '2.0', id: null, method: 'notifications/cancelled' }),
      ).toBe(true);
    });

    it('frames with numeric id are requests, not notifications', async () => {
      const { isNotification } = await import('../../../mcp/connect-labs-server');
      expect(
        isNotification({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
      ).toBe(false);
    });

    it('frames with string id are requests, not notifications', async () => {
      const { isNotification } = await import('../../../mcp/connect-labs-server');
      expect(
        isNotification({ jsonrpc: '2.0', id: 'abc', method: 'tools/list' }),
      ).toBe(false);
    });
  });

  describe('labsBaseUrl', () => {
    it('strips /mcp/ suffix to derive REST base', async () => {
      const { labsBaseUrl } = await import('../../../mcp/connect-labs-server');
      expect(labsBaseUrl('https://labs.connect.dimagi.com/mcp/')).toBe('https://labs.connect.dimagi.com');
    });

    it('strips /mcp (no trailing slash) too', async () => {
      const { labsBaseUrl } = await import('../../../mcp/connect-labs-server');
      expect(labsBaseUrl('https://labs.example/mcp')).toBe('https://labs.example');
    });

    it('leaves urls without /mcp suffix unchanged', async () => {
      const { labsBaseUrl } = await import('../../../mcp/connect-labs-server');
      expect(labsBaseUrl('https://labs.example')).toBe('https://labs.example');
    });
  });

  describe('isLocalToolCall', () => {
    it('returns true for tools/call with name=labs_delete_record', async () => {
      const { isLocalToolCall } = await import('../../../mcp/connect-labs-server');
      expect(
        isLocalToolCall({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'labs_delete_record', arguments: { id: 42 } },
        }),
      ).toBe(true);
    });

    it('returns false for tools/call with an upstream tool name', async () => {
      const { isLocalToolCall } = await import('../../../mcp/connect-labs-server');
      expect(
        isLocalToolCall({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'workflow_delete', arguments: { workflow_id: 1 } },
        }),
      ).toBe(false);
    });

    it('returns false for non-tools/call methods', async () => {
      const { isLocalToolCall } = await import('../../../mcp/connect-labs-server');
      expect(
        isLocalToolCall({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      ).toBe(false);
    });
  });

  describe('mergeToolsList', () => {
    it('appends LOCAL_TOOLS to upstream tools array', async () => {
      const { mergeToolsList, LOCAL_TOOLS } = await import('../../../mcp/connect-labs-server');
      const merged = mergeToolsList({
        jsonrpc: '2.0', id: 1,
        result: { tools: [{ name: 'workflow_delete' }, { name: 'pipeline_delete' }] },
      });
      const tools = (merged.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.length).toBe(2 + LOCAL_TOOLS.length);
      expect(tools.map((t) => t.name)).toContain('labs_delete_record');
      expect(tools.map((t) => t.name)).toContain('workflow_delete');
    });

    it('returns error frames unchanged', async () => {
      const { mergeToolsList } = await import('../../../mcp/connect-labs-server');
      const errFrame = {
        jsonrpc: '2.0' as const, id: 1,
        error: { code: -32000, message: 'upstream failure' },
      };
      expect(mergeToolsList(errFrame)).toEqual(errFrame);
    });

    it('handles upstream replies that omit tools array', async () => {
      const { mergeToolsList, LOCAL_TOOLS } = await import('../../../mcp/connect-labs-server');
      const merged = mergeToolsList({ jsonrpc: '2.0', id: 1, result: {} });
      const tools = (merged.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.length).toBe(LOCAL_TOOLS.length);
      expect(tools[0].name).toBe('labs_delete_record');
    });
  });

  describe('callLocal (labs_delete_record)', () => {
    it('issues HTTP DELETE to /export/labs_record/ with the id in body', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response('', { status: 200 }),
      );
      const { callLocal } = await import('../../../mcp/connect-labs-server');
      const out = await callLocal(
        {
          jsonrpc: '2.0', id: 99, method: 'tools/call',
          params: { name: 'labs_delete_record', arguments: { id: 42 } },
        },
        { token: 'test-token', baseUrl: 'https://labs.example' },
      );
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://labs.example/export/labs_record/');
      expect(init?.method).toBe('DELETE');
      expect(init?.headers).toMatchObject({
        'Authorization': 'Bearer test-token',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(init?.body as string)).toEqual([{ id: 42 }]);
      expect(out).toMatchObject({
        jsonrpc: '2.0',
        id: 99,
        result: { content: [{ type: 'text', text: 'Deleted LabsRecord id=42' }] },
      });
    });

    it('returns a JSON-RPC error envelope when upstream returns 401', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response('bad token', { status: 401 }),
      );
      const { callLocal } = await import('../../../mcp/connect-labs-server');
      const out = await callLocal(
        {
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'labs_delete_record', arguments: { id: 42 } },
        },
        { token: 'bad', baseUrl: 'https://labs.example' },
      );
      expect(out).toMatchObject({
        jsonrpc: '2.0', id: 1,
        error: { code: -32000, message: expect.stringContaining('401') },
      });
    });

    it('rejects non-integer id with -32602 invalid params', async () => {
      const { callLocal } = await import('../../../mcp/connect-labs-server');
      const out = await callLocal(
        {
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'labs_delete_record', arguments: { id: 'abc' } },
        },
        { token: 'tok', baseUrl: 'https://labs.example' },
      );
      expect(out).toMatchObject({
        jsonrpc: '2.0', id: 1,
        error: { code: -32602, message: expect.stringContaining('integer') },
      });
    });

    it('throws on unknown local tool name', async () => {
      const { callLocal } = await import('../../../mcp/connect-labs-server');
      await expect(
        callLocal(
          {
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'not_a_real_tool', arguments: {} },
          },
          { token: 'tok', baseUrl: 'https://labs.example' },
        ),
      ).rejects.toThrow(/unknown local tool/);
    });
  });
});
