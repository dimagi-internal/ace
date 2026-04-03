---
description: Run the full CRISPR-Connect lifecycle for an opportunity
argument-hint: [<opp-name> --mode auto|review] [--dry-run] [--sandbox]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:run

Run the full CRISPR-Connect lifecycle for a Connect opportunity.

## Arguments
- `<opp-name>` — name of the opportunity (used as the GDrive folder name)
- `--mode auto|review` — execution mode (default: review)
- `--dry-run` — execute all skills but log effectful actions to `comms-log/dry-run-<step>.md` instead of performing them. Emails are not sent, apps are not published, tickets are not created. LLM-as-Judge and gates still apply. State tracks as `dry-run-success` or `dry-run-blocked`.
- `--sandbox` — route external API calls to staging endpoints. Connect calls go to staging Connect, CommCare calls go to the staging project space. Requires staging URLs configured in MCP server settings. Can be combined with `--dry-run`.

## Process

1. Parse arguments. Default mode is `review` if not specified.

2. Dispatch to the **ace-orchestrator** agent with:
   - Opportunity name
   - Execution mode
   - Dry-run flag (if set)
   - Sandbox flag (if set)
   - Any existing state from GDrive (if resuming)

The orchestrator handles all phases from there.
