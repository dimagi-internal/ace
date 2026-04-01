---
description: Run the full CRISPR-Connect lifecycle for an opportunity
argument-hint: [<opp-name> --mode auto|review]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:run

Run the full CRISPR-Connect lifecycle for a Connect opportunity.

## Arguments
- `<opp-name>` — name of the opportunity (used as the GDrive folder name)
- `--mode auto|review` — execution mode (default: review)

## Process

1. Parse arguments. Default mode is `review` if not specified.

2. Dispatch to the **ace-orchestrator** agent with:
   - Opportunity name
   - Execution mode
   - Any existing state from GDrive (if resuming)

The orchestrator handles all phases from there.
