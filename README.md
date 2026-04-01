# ACE — AI Connect Engine

Orchestrates the CRISPR-Connect lifecycle for Connect opportunities, from idea through app building, deployment, LLO management, and closeout.

ACE is a Claude Code plugin with the same architecture as canopy: agents orchestrate skills, skills are prompt-based capability definitions, and MCP servers provide programmatic access to external systems.

## Quick Start

Install as a Claude Code plugin, then:

```
/ace:run <opp-name> --mode review    # Run full lifecycle
/ace:step <skill-name> <opp-name>    # Run a single step
/ace:status                          # Show all opportunities
/ace:docs                            # Generate playbook
```

## Architecture

- **5 agents** — ace-orchestrator + 4 phase agents (app-builder, connect-setup, llo-manager, closeout)
- **17 skills** — one per process step, each a SKILL.md that Claude executes
- **4 commands** — run, step, status, docs
- **2 MCP servers** — Google Drive (built), OCS (scaffold)
- **2 execution modes** — auto (hands-off) and review (pauses at gates)

## Documentation

- [Design Spec](docs/superpowers/specs/2026-04-01-ace-design.md) — full architecture and rationale
- [Generated Playbook](docs/generated/playbook.md) — human-readable process flow (generated from agent/skill definitions)
- [Integration Specs](playbook/integrations/) — what APIs exist vs. need to be built

## Planning Spreadsheet

https://docs.google.com/spreadsheets/d/1XxcPxK1oYtDxcfmElBb73U2UtLYEodiaMUazjmEVAWE/edit
