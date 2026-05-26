---
description: Audit ACE plugin structure for drift across agent frontmatter, lib/artifact-manifest.ts, and orchestrator-reference.md § State Schema
argument-hint: [--strict]
allowed-tools: [Read, Bash, Glob]
---

# /ace:detect-structure-drift

Compare the three sources of structural truth in the ACE plugin and report drift:

1. **Agent frontmatter** in `agents/*.md` — the phase spine.
2. **`lib/artifact-manifest.ts`** — the execution roster.
3. **`agents/orchestrator-reference.md` § State Schema** — the human-curated `run_state.yaml` template.

Read-only and idempotent. Surfaces unclaimed skills, orphan SKILL.md directories, missing skill files, phase-vocab mismatches, and state-schema parity gaps.

## Arguments

- `--strict` (optional) — append `EXIT STATUS: 1` to the report if any FAIL finding is reported. Default is report-only (always `EXIT STATUS: 0`).

## Process

Read `skills/detect-structure-drift/SKILL.md` and execute its procedure inline. Pass `--strict` through if provided.

## Examples

```
/ace:detect-structure-drift            # report-only audit
/ace:detect-structure-drift --strict   # exit non-zero on FAIL findings (suitable for CI / pre-release gates)
```

## When to use

- Before a plugin release.
- After adding, renaming, or deleting a skill or phase.
- When investigating why a skill appears under "Utility Skills" on ace-web's `/system` page instead of under its phase.
