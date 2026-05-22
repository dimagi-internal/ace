---
description: Verify a Connect Interviews opportunity matches the launch checklist
argument-hint: <connect-opp-url> [--opp <id> --org <pm-org> --domain <hq-domain> --bot <ocs-experiment-id>]
allowed-tools: [Read, Write, Edit, Bash, AskUserQuestion]
---

# /ace:interview-opp-verify

Read-only verifier for a configured Connect Interviews opportunity. Walks every rule in `docs/connect-interviews/checklist-schema.yaml` (per_program + per_domain + per_cohort + per_user) and grades each rule pass / fail / unverifiable / out_of_band.

Outputs a human-readable report + machine-readable verdict YAML. Cross-system consistency checks (e.g. OCS custom action target URL == HQ Inbound API URL) included.

Usage:

```
/ace:interview-opp-verify https://connect.dimagi.com/a/<org>/opportunity/<opp_id>/
```

Exit codes:
- 0 — all rules pass or out_of_band
- 1 — at least one fail
- 2 — no fails but some unverifiable (operator should review action items)

See `skills/interview-opp-verify/SKILL.md` for the report format, atoms used, and per-rule processing.
