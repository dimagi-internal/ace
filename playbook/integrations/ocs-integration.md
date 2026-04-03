# OCS Integration

## OCS's Role in ACE

OCS (Operational Conversational System) is ACE's **mouth and ears** for LLO interaction.
ACE creates and configures an OCS agent per opportunity, injecting the IDD, training
materials, and opportunity-specific context. LLO questions arrive via
`Ace-AI@Dimagi.com`, are handled by the OCS agent, and all responses are cc'd to the
CRISPR Admin group (Neal, Jon, Matt, Sarvesh, Cal) for monitoring.

ACE then reads OCS transcripts via API to:
- Analyze sentiment across LLO conversations
- Identify recurring questions or confusion points
- Surface issues that need human escalation
- Inform the `flw-data-review` and `llo-feedback` skills

The `ocs-agent-setup` skill creates the agent. The `timeline-monitor` and
`flw-data-review` skills periodically read transcripts for analysis.

---

## What Needs Exploration

The following OCS capabilities need to be scoped before building the OCS MCP server.
Owner: Jon.

### Agent Creation API
- Can OCS agents be created programmatically via API?
- What parameters are required? (name, email routing, initial context, persona)
- Is there an existing REST endpoint or does this need to be built?

### Context Injection
- How does OCS accept context updates? (initial prompt only? live injection? document
  upload?)
- What format does context need to be in? (Markdown? structured JSON? plain text?)
- Can context be updated after an agent is live without recreating it?
- Are there size limits on injected context?

### Dynamic Updates
- Can ACE push updates to a live OCS agent? (e.g., when training materials change,
  or when a new batch of FLWs is onboarded)
- What is the update latency?

### Webhooks
- Does OCS support webhooks for new messages or conversation events?
- Can ACE be notified when an LLO sends a message, so the `timeline-monitor` skill
  can react in near-real-time?

### Transcript API Shape
- What does the transcript API response look like? (conversation structure, timestamps,
  speaker attribution, message content)
- Is there pagination for long conversation histories?
- Can transcripts be filtered by date range or conversation ID?

---

## Planned OCS MCP Server Tools

Once the above is scoped with the OCS team, the `mcp/ocs-server.ts` will expose:

| Tool | Description |
|------|-------------|
| `ocs_create_agent` | Create a new OCS agent for an opportunity, with name, email, and initial context |
| `ocs_update_context` | Push updated context (IDD, training materials, etc.) to a live agent |
| `ocs_list_transcripts` | List conversations for an agent, with optional date filter |
| `ocs_get_transcript` | Get the full message history for a specific conversation |
| `ocs_agent_status` | Check agent health, last activity, and message volume |

These tools will be consumed by:
- `ocs-agent-setup` skill — uses `ocs_create_agent`, `ocs_update_context`
- `timeline-monitor` skill — uses `ocs_list_transcripts`, `ocs_get_transcript`
- `flw-data-review` skill — uses `ocs_list_transcripts`, `ocs_get_transcript`

---

## Manual Workaround

Until the OCS MCP server is built:

1. The `ocs-agent-setup` skill generates a **context document** from the IDD and
   training materials — a ready-to-paste prompt for the OCS agent
2. The skill presents this document and instructs the user to:
   - Create the OCS agent manually
   - Set the email routing to `Ace-AI@Dimagi.com`
   - Paste the generated context as the agent's system prompt
3. The user confirms the agent is active before ACE proceeds
4. Transcript analysis in `timeline-monitor` and `flw-data-review` is skipped or
   performed manually until the API is accessible

## Staging Environment

When `--sandbox` is active, ACE routes OCS API calls to a staging instance if available.

- **Staging URL:** TBD — staging OCS may not exist yet. Confirm with Jon.
- **How it works:** OCS MCP server reads `ACE_SANDBOX=true` environment variable and switches endpoints
- **Data isolation:** TBD — depends on whether OCS supports multi-tenancy or separate staging instances
- **Fallback:** If no staging OCS exists, sandbox mode for OCS skills falls back to dry-run behavior (log intended actions without executing)
