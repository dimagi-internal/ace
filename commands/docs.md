---
description: Generate a human-readable playbook from agent and skill definitions
allowed-tools: [Read, Write, Glob, Grep, Bash]
---

# /ace:docs

Generate the ACE playbook — a human-readable document that explains the full
CRISPR-Connect process, generated from the actual agent and skill definitions.

## Process

1. **Read all agent definitions** from `agents/`:
   - Extract: name, description, workflow steps, gate points

2. **Read all skill definitions** from `skills/*/SKILL.md`:
   - Extract: name, description, process steps, MCP tools used, mode behavior,
     current workarounds (if any)

3. **Read integration specs** from `playbook/integrations/`:
   - Extract: what's available, what's needed, manual workarounds

4. **Generate playbook** at `docs/generated/playbook.md` with sections:

   ```markdown
   # ACE Playbook — CRISPR-Connect Process

   Generated: [date]

   ## Overview
   [From ace-orchestrator agent description]

   ## Process Flow
   [Sequential list of all steps across all phases, with dependencies and gates]

   ## Phase 1: App Building
   ### Agent: app-builder
   [From agent definition]
   ### Skills
   #### idea-to-pdd
   [Summary from SKILL.md]
   ...

   ## Phase 3: Connect Setup
   ...

   ## Phase 4: LLO Management
   ...

   ## Phase 5: Closeout
   ...

   ## External Integrations
   ### Connect API
   [Summary: what's available, what's needed]
   ### CommCare API
   ...
   ### OCS
   ...
   ### Nova
   ...

   ## Current Limitations
   [Auto-generated list of all "Current Workaround" sections from skills]

   ## Skill Reference
   [Quick reference table: skill name, description, MCP tools, LLM-as-Judge]
   ```

5. **Commit** the generated playbook.
