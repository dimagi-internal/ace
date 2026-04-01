---
name: ocs-agent-setup
description: >
  Configure an OCS agent for this opportunity. Inject the IDD, training
  materials, and opportunity context so OCS can answer LLO questions.
---

# OCS Agent Setup

Create and configure an OCS agent that handles LLO questions for this opportunity.

## Process

1. **Read context from GDrive:**
   - IDD: `ACE/<opp-name>/idd.md`
   - Training materials: `ACE/<opp-name>/training-materials/`
   - Opportunity details: `ACE/<opp-name>/connect-setup/opportunity.md`
   - App summaries: `ACE/<opp-name>/app-summaries/`

2. **Compose agent context document:**
   Combine all relevant information into a structured context that tells
   the OCS agent:
   - What this opportunity is about (from IDD)
   - How the apps work (from app summaries)
   - What LLOs need to know (from training materials)
   - Key dates and milestones (from opportunity details)
   - Escalation rules (when to cc the admin group)

3. **Create/configure OCS agent** via OCS MCP:
   - Name: "ACE - [Opportunity Name]"
   - Email: Ace-AI@Dimagi.com
   - Context: the composed document
   - Rules: always CC admin group on responses

4. **Self-evaluate (LLM-as-Judge):**
   - Is the context comprehensive enough to answer typical LLO questions?
   - Are escalation rules clear?
   - Does the agent have enough detail about the apps and workflows?

5. **Write agent config** to `ACE/<opp-name>/ocs-agent-config.md`:
   - Agent ID
   - Context summary
   - Configuration details

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- OCS: `ocs_create_agent`, `ocs_update_context` — **NOT YET BUILT**

## Current Workaround
1. Generate the complete agent context document
2. Write it to `ACE/<opp-name>/ocs-context.md`
3. Ask the user to configure the OCS agent manually with this context
4. Ask for the agent ID and record it

## Mode Behavior
- **Auto:** Configure agent (or guide manual config), proceed
- **Review:** Present agent context for review before configuring
