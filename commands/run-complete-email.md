---
description: Send the run-complete email for a finished run — what it produced, what it decided, what it's unsure about, plus the run-summary link. Works on any run already in Drive.
allowed-tools: [Read, Bash, Skill, mcp__plugin_ace_ace-gdrive__resolve_opp_path, mcp__plugin_ace_ace-gdrive__resolve_current_run_id, mcp__plugin_ace_ace-gdrive__drive_list_folder, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__drive_create_doc_from_markdown]
---

# /ace:run-complete-email

Compose and send the run-complete email for one run.

`/ace:run` fires this at close. This command is the same skill on demand, so a
run that finished weeks ago can still be sent — which is most of them.

## Arguments

- `<opp>` — required. The opp slug.
- `<opp>/<run-id>` — a specific run. Omit the run-id for the current one.
- `--to <email>` — recipient. Defaults to the run's `initiated_by`, then to you.
- `--dry-run` — compose and write the artifact, print the body, send nothing.

## Process

Invoke `Skill(run-complete-email)` with the resolved opp and run-id and follow it.

Show the composed body before sending, always — this goes out under ACE's
identity, and the operator should see what leaves.

## Notes

**The recipient default is internal on purpose.** A completion notice names what
the run is unsure about and which gates did not pass. That is the honest half and
the reason a reply is worth writing, but it is an internal read: sending a run's
rough edges to an external partner is a per-run decision a human makes with
`--to`, never a default.

**A reply comes back on its own.** canopy-web's inbound doorbell rings the runner
on a Gmail push, and `inbox-triage` routes the thread to the run this email came
from. The recipient does not need to tell anyone they replied.
