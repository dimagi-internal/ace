/**
 * End-to-end test against the live connect-labs MCP at
 * labs.connect.dimagi.com/mcp/.
 *
 * Exercises the proxy by issuing real JSON-RPC frames:
 *   tools/list → list_solicitations → optionally create_solicitation (smoke)
 *
 * Requires:
 *   LABS_INTEGRATION=1
 *   LABS_MCP_TOKEN=<bearer PAT>           (from 1Password — ACE_PLUGIN_DATA/.env)
 *   LABS_TEST_PROGRAM_ID=<int>            (optional; gates the create_solicitation smoke)
 *
 * Run: LABS_INTEGRATION=1 npm test -- test/mcp/connect-labs/integration/
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { forward } from '../../../../mcp/connect-labs-server';

const integration = process.env.LABS_INTEGRATION === '1';
const describeFn = integration ? describe : describe.skip;

const URL = process.env.LABS_MCP_URL || 'https://labs.connect.dimagi.com/mcp/';
const TOKEN = process.env.LABS_MCP_TOKEN || '';
const TEST_PROGRAM_ID = process.env.LABS_TEST_PROGRAM_ID;

describeFn('connect-labs MCP — live integration (requires LABS_INTEGRATION=1 + PAT)', () => {
  beforeAll(() => {
    if (!TOKEN) throw new Error('LABS_MCP_TOKEN required for LABS_INTEGRATION=1');
  });

  it('tools/list returns solicitation tools', async () => {
    const reply = await forward(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { token: TOKEN, url: URL },
    );
    expect(reply.error).toBeUndefined();
    const tools = (reply.result as { tools?: Array<{ name: string }> })?.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'list_solicitations',
      'create_solicitation',
      'list_responses',
      'award_response',
    ]));
  });

  it('list_solicitations succeeds (Connect OAuth bridge live)', async () => {
    const reply = await forward(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_solicitations', arguments: {} },
      },
      { token: TOKEN, url: URL },
    );
    // A successful call returns a result; PERMISSION_DENIED on the tool side
    // indicates the ace user hasn't completed Connect OAuth linkage in labs.
    if (reply.error) {
      throw new Error(
        `list_solicitations failed — labs error: ${reply.error.message}. ` +
        `If this says PERMISSION_DENIED, the ace@dimagi-ai.com labs account ` +
        `needs to sign in once and authorize Connect.`,
      );
    }
    expect(reply.result).toBeDefined();
  });

  it.runIf(TEST_PROGRAM_ID)(
    'private solicitation round-trips when program_id is passed (regression for labs PR #156)',
    async () => {
      // Create a private (is_public=false) solicitation. Without program_id
      // on the read path, prod's LabsRecord API filters to public-only and
      // this record is invisible — the bug labs PR #156 fixed.
      const createReply = await forward(
        {
          jsonrpc: '2.0',
          id: 100,
          method: 'tools/call',
          params: {
            name: 'create_solicitation',
            arguments: {
              program_id: String(TEST_PROGRAM_ID),
              data: {
                title: `ACE private round-trip ${new Date().toISOString()}`,
                solicitation_type: 'EOI',
                description: 'private round-trip test — please ignore',
                scope_of_work: 'integration test',
                budget: 1,
                deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
                evaluation_criteria: [{ id: 'fit', weight: 1.0, scale: 10 }],
                questions: [{ id: 'q1', text: 'Why?', type: 'text', required: false }],
                status: 'draft',
                is_public: false,
              },
            },
          },
        },
        { token: TOKEN, url: URL },
      );
      expect(createReply.error).toBeUndefined();

      const created = (createReply.result as { content?: Array<{ text?: string }> })
        ?.content?.[0]?.text;
      const createdParsed = created ? JSON.parse(created) : (createReply.result as Record<string, unknown>);
      const solicitationId = (createdParsed as { id?: number }).id;
      expect(solicitationId).toBeTypeOf('number');

      // get_solicitation with program_id — must return the private record.
      const getReply = await forward(
        {
          jsonrpc: '2.0',
          id: 101,
          method: 'tools/call',
          params: {
            name: 'get_solicitation',
            arguments: {
              solicitation_id: solicitationId,
              program_id: String(TEST_PROGRAM_ID),
            },
          },
        },
        { token: TOKEN, url: URL },
      );
      expect(getReply.error).toBeUndefined();
      const got = (getReply.result as { content?: Array<{ text?: string }> })
        ?.content?.[0]?.text;
      const gotParsed = got ? JSON.parse(got) : (getReply.result as Record<string, unknown>);
      expect((gotParsed as { id?: number }).id).toBe(solicitationId);

      // list_solicitations with program_id — must include the private record.
      const listReply = await forward(
        {
          jsonrpc: '2.0',
          id: 102,
          method: 'tools/call',
          params: {
            name: 'list_solicitations',
            arguments: { program_id: String(TEST_PROGRAM_ID) },
          },
        },
        { token: TOKEN, url: URL },
      );
      expect(listReply.error).toBeUndefined();
      const listed = (listReply.result as { content?: Array<{ text?: string }> })
        ?.content?.[0]?.text;
      const listedParsed = listed
        ? JSON.parse(listed)
        : (listReply.result as Record<string, unknown>);
      const items =
        (listedParsed as { results?: Array<{ id: number }>; items?: Array<{ id: number }> })
          .results ??
        (listedParsed as { items?: Array<{ id: number }> }).items ??
        [];
      expect(items.some((s) => s.id === solicitationId)).toBe(true);

      // update_solicitation with program_id — read-then-merge needs scope.
      const updateReply = await forward(
        {
          jsonrpc: '2.0',
          id: 103,
          method: 'tools/call',
          params: {
            name: 'update_solicitation',
            arguments: {
              solicitation_id: solicitationId,
              program_id: String(TEST_PROGRAM_ID),
              update_data: { status: 'closed' },
            },
          },
        },
        { token: TOKEN, url: URL },
      );
      expect(updateReply.error).toBeUndefined();
    },
  );

  it.runIf(TEST_PROGRAM_ID)(
    'create_solicitation smoke (draft, never published)',
    async () => {
      const reply = await forward(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'create_solicitation',
            arguments: {
              // Schema is { program_id (string) | organization_id (string),
              // data: { ...application fields... } } — application fields go
              // inside `data`, NOT at the top level. Top-level flat fields
              // get dropped by the labs adapter.
              program_id: String(TEST_PROGRAM_ID),
              data: {
                title: `ACE integration test ${new Date().toISOString()}`,
                solicitation_type: 'EOI',
                description: 'integration test — please ignore',
                scope_of_work: 'integration test',
                budget: 1,
                deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
                evaluation_criteria: [{ id: 'fit', weight: 1.0, scale: 10 }],
                questions: [{ id: 'q1', text: 'Why are you interested?', type: 'text', required: false }],
                status: 'draft',  // never publish from a test
                is_public: false,
              },
            },
          },
        },
        { token: TOKEN, url: URL },
      );
      expect(reply.error).toBeUndefined();
    },
  );
});
