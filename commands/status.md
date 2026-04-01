---
description: Show the current status of an opportunity or list all active opportunities
argument-hint: [<opp-name>]
allowed-tools: [Read, Bash, Glob, Grep]
---

# /ace:status

Show the current status of a CRISPR-Connect opportunity.

## Arguments
- `<opp-name>` (optional) — if provided, show detailed status for this opportunity.
  If omitted, list all active opportunities.

## Process

### List all opportunities (no argument)
1. Use Google Drive MCP to list folders under `ACE/`
2. For each folder, read `state.yaml` to get current phase and step
3. Display summary table:
   ```
   Opportunity    | Phase          | Current Step      | Mode   | Last Updated
   ---------------------------------------------------------------------------
   malaria-pilot  | app-building   | app-test          | review | 2026-04-01
   nutrition-v2   | llo-management | timeline-monitor  | auto   | 2026-03-28
   ```

### Detailed status (with opp-name)
1. Read `ACE/<opp-name>/state.yaml` from GDrive
2. Display:
   - Current phase and step
   - Mode (auto/review)
   - All completed steps with timestamps
   - Pending steps
   - Any gate approvals
   - Errors or manual interventions
   - Links to key artifacts in GDrive
