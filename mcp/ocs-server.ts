/**
 * OCS MCP Server for ACE
 *
 * Provides tools for managing OCS agents and reading conversation transcripts.
 * Exposes agent CRUD and transcript access over stdio using the Model Context Protocol.
 *
 * TODO: Connect to actual OCS APIs once endpoints are confirmed.
 * For now, this is a scaffold that documents the intended tool interface.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'ocs',
  version: '0.1.0',
});

// ============================================================================
// Agent Management
// ============================================================================

server.tool(
  'ocs_create_agent',
  'Create a new OCS agent for a Connect opportunity. Configures the agent with IDD context, training materials, and opportunity details.',
  {
    name: z.string().describe('Agent name, e.g. "ACE - Malaria Pilot"'),
    context: z.string().describe('Full context document for the agent (IDD + training + opp details)'),
    email: z.string().optional().describe('Email address the agent responds from (default: ace-ai@dimagi.com)'),
    config: z.string().optional().describe('JSON config for agent behavior (escalation rules, cc list, etc.)'),
  },
  async ({ name, context, email, config }) => {
    // TODO: Implement against actual OCS API
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'not_implemented',
          message: 'OCS agent creation API not yet connected. See playbook/integrations/ocs-integration.md for requirements.',
          intended: { name, contextLength: context.length, email: email || 'ace-ai@dimagi.com' },
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'ocs_update_context',
  'Update an existing OCS agent\'s context/knowledge base. Use when new information becomes available during an opportunity.',
  {
    agentId: z.string().describe('The OCS agent ID'),
    context: z.string().describe('Updated context document'),
  },
  async ({ agentId, context }) => {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'not_implemented',
          message: 'OCS context update API not yet connected.',
          intended: { agentId, contextLength: context.length },
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'ocs_agent_status',
  'Check the health and stats of an OCS agent.',
  {
    agentId: z.string().describe('The OCS agent ID'),
  },
  async ({ agentId }) => {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'not_implemented',
          message: 'OCS agent status API not yet connected.',
          intended: { agentId },
        }, null, 2),
      }],
    };
  },
);

// ============================================================================
// Transcript Access
// ============================================================================

server.tool(
  'ocs_list_transcripts',
  'List conversation transcripts for an OCS agent. Supports filtering by date and LLO.',
  {
    agentId: z.string().describe('The OCS agent ID'),
    since: z.string().optional().describe('ISO date string — only transcripts after this date'),
    lloFilter: z.string().optional().describe('Filter by LLO name or ID'),
  },
  async ({ agentId, since, lloFilter }) => {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'not_implemented',
          message: 'OCS transcript list API not yet connected. APIs exist per design spec — need to map endpoints.',
          intended: { agentId, since, lloFilter },
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'ocs_get_transcript',
  'Get a single conversation transcript by ID.',
  {
    transcriptId: z.string().describe('The transcript ID'),
  },
  async ({ transcriptId }) => {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'not_implemented',
          message: 'OCS transcript access API not yet connected.',
          intended: { transcriptId },
        }, null, 2),
      }],
    };
  },
);

// ============================================================================
// Start
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('OCS MCP server error:', err);
  process.exit(1);
});
