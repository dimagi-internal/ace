---
description: Run a single step of the CRISPR-Connect process for an opportunity
argument-hint: [<skill-name> <opp-name>]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:step

Run a single skill for an opportunity without running the full lifecycle.

## Arguments
- `<skill-name>` — name of the skill to invoke (e.g., `idea-to-pdd`, `app-test`)
- `<opp-name>` — name of the opportunity

## Process

1. Parse arguments.
2. Verify the opportunity folder exists in GDrive (`ACE/<opp-name>/`).
3. Invoke the specified skill with the opportunity context.
4. Update `state.yaml` with the result.

Useful for re-running a specific step, testing a skill in isolation,
or manually advancing through the process.
