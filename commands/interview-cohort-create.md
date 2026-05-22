---
description: Launch a single Connect Interviews cohort (per-opportunity automation)
argument-hint: <cohort.yaml>
allowed-tools: [Read, Write, Edit, Bash, AskUserQuestion]
---

# /ace:interview-cohort-create

Per-cohort launch automation for the Connect Interviews program: linked-app copies, lookup-table rows, Connect opportunity + payment unit, per-cohort OCS bot routing.

Reads a single YAML spec mirroring the team's Cohort tracker columns. Implements the per_cohort section of `docs/connect-interviews/checklist-schema.yaml`. Idempotent where possible; manual fallbacks for the deferred atoms (linked-app copy, user-field choice add, conditional alert).

Usage:

```
/ace:interview-cohort-create <path-to-cohort.yaml>
```

See `skills/interview-cohort-create/SKILL.md` for the input format and per-step process.
