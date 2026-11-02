---
name: connect-tech-interrupt
description: >
  File a Connect Tech Interrupt ticket (the CI Jira form) for a Connect program, or draft it for a person to submit. Use when a member asks ACE to raise an interrupt or tech request with the Connect tech team.
disable-model-invocation: false
---

# Connect Tech Interrupt

Raises one ticket through Dimagi's Connect Tech Interrupt process, on behalf of
a member, for any Connect program (an ACE-built opp or a program ACE only
supports). Requested by Lilianna Bagnoli in #connect-kc-ace, 2026-11-02.

Terminology: say "Connect", never "CommCare Connect" ([`_terminology.md`](../_terminology.md)).

## The process and the form are read live, never copied here

Both change without notice, so this skill carries no field list, priority
definition or triage rule. Every run reads them first:

| What | Where |
|---|---|
| The process: when to file, who triages, what a good ticket says | Confluence page `3086581903` (space `connect`), `https://dimagi.atlassian.net/wiki/spaces/connect/pages/3086581903/Connect+Tech+Interrupt+Process` |
| The form: its fields, which are required, the allowed values | Jira project `CI`, `https://dimagi.atlassian.net/jira/software/c/projects/CI/form` |

If either cannot be read, **stop and say which**. Do not fall back to remembered
fields, and do not ask the member to retype them. See
`docs/access-requests/2026-11-02-atlassian-read-access.md` for the access this
skill is waiting on.

## Inputs

- The member's description of the problem or ask.
- The program: `<ws>/<opp>` for an ACE-built opp, otherwise the Connect program
  id or name. Read the live program (`connect_get_program`,
  `connect_get_opportunity`, the program project's context doc) to pre-fill
  program, opportunity, org and links. Never invent context the member did not
  give and the live read does not show (no inferred backstory).
- For an ACE-built opp, lead any link to the run with its ace-web page
  (`ace_web_summary_url`).

## Procedure

1. **Read the process page and the form definition** (table above). Apply the
   process's own "should this be an interrupt" test; if it says this belongs
   elsewhere, tell the member and stop.
2. **Map the request onto the form's fields**, one value per field, using only
   the allowed values the form lists. A required field you cannot fill from the
   member's words or the live read is a question to the member, not a guess.
3. **Show the complete ticket** (every field, final text) and get the member's
   yes. Filing is outward-facing and not reversible by ACE.
4. **Submit or hand over**, by what access exists:
   - **Atlassian API access present:** create the issue in `CI`. Transport:
     TODO, set when access lands (a `scripts/` helper under
     `lib/bash-reachable-scripts.ts` rules, since MCP-only env is not in the
     shell). Read the created issue back and report its key and URL.
   - **No API access (draft-only):** put the final ticket in a gdoc
     ([`gdoc-writer`](../gdoc-writer/SKILL.md)) with the form link, and tell the
     member to paste it in. Say plainly that nothing was filed.
5. **Record it** where the work lives: for an ACE-built opp, the run's
   comms-log; for a program project, its program-context doc.

## Who may ask

Any caller canopy-web admits at the act tier. A confined `ask` caller gets a
draft only, never a filed ticket.

## Removal criteria

Delete if the Interrupt process moves off this Jira project, or a canopy-wide
skill for it ships.
