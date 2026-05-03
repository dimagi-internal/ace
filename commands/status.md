---
description: Show the current status of an opportunity or list all active opportunities
argument-hint: [<opp-name>] [--mine] [--all]
allowed-tools: [Read, Bash, Glob, Grep]
---

# /ace:status

Show the current status of a CRISPR-Connect opportunity.

Primary use case: a Dimagi admin opens Claude Code and needs to answer
"which of my opps need me right now?" without opening every run_state.yaml by
hand. The list view derives a per-opp status tag and sorts ACTION NEEDED
to the top.

## Arguments
- `<opp-name>` (optional) — if provided, show detailed status for this opportunity.
  If omitted, list all active opportunities.
- `--mine` — in list mode, only show opps where `last_actor` or `initiated_by`
  matches the current operator's `git config user.email`. Use when one admin
  wants to see only their own queue.
- `--all` — in list mode, include `IDLE` and `DONE` opps (default hides them to
  keep the list focused on opps that are progressing or blocked).

## List all opportunities (no opp-name)

1. Resolve the current operator identity once, for the `--mine` filter and
   for the "you've touched N of these" footer:
   ```bash
   OPERATOR="$(git config user.email 2>/dev/null || echo unknown)"
   ```

2. Use `drive_list_folder` on `ACE/` to list opportunity folders.

3. For each folder, read `run_state.yaml` and compute the per-opp fields the
   list view renders. Pull directly from the schema:
   - `initiated_by`, `last_actor`, `last_actor_at` (added 0.3.3; see
     agents/ace-orchestrator.md § State Schema)
   - `phases.<phase>.<skill>` step statuses
   - `gates.<gate>` approval statuses

4. **Derive the status tag** with this rule, in order (first match wins):

   | Tag | Rule | Why |
   |-----|------|-----|
   | `ERROR` | Any step status contains `error` or `failed` or `blocked` | Something broke; needs human |
   | `ACTION NEEDED` | Any of the 5 gates is in state `pending` or `awaiting-approval`, OR any required human-input artifact (producedBy: `external` in the manifest) is missing | Admin must decide or provide input before ACE can proceed |
   | `RUNNING` | There exists at least one non-recurring step with status `pending` in the current phase, and no gate is pending, and no errors | Auto-progressing; admin can leave it alone |
   | `IDLE` | All non-recurring steps across phases 1–6 are `done`, only recurring steps (`timeline-monitor`, `flw-data-review`, `ocs-chatbot-qa-monitor`, `ocs-chatbot-eval-monitor`) remain, and Phase 7 hasn't started | Opp is live; ACE is monitoring; no action expected |
   | `DONE` | Phase 7 `cycle-grade` is `done` | Fully closed out |

   **Recurring skills are never an ACTION NEEDED signal.** They run on a
   schedule after launch and a missing weekly timeline-monitor (or
   `ocs-chatbot-qa-monitor` / `ocs-chatbot-eval-monitor`) entry is
   expected, not a blocker.

5. **Derive the "blocked on" reason** for ACTION NEEDED / ERROR rows so the
   admin knows what to do without opening the opp:
   - Gate pending → `gate: <gate-name>` (e.g., `gate: app-deploy`)
   - Error step → `error: <skill-name>` (e.g., `error: pdd-to-deliver-app`)
   - Missing external input → `input: <file>` (e.g., `input: idea.md`)
   - Multiple → show the earliest-in-sequence one

6. **Sort the list** so admins can triage top-to-bottom:
   1. `ERROR` rows first (by `last_actor_at` descending within the group)
   2. `ACTION NEEDED` rows (by `last_actor_at` descending)
   3. `RUNNING` rows
   4. `IDLE` and `DONE` rows only if `--all` was passed

7. **Apply `--mine` filter** after the status derivation but before sorting:
   drop any row where neither `initiated_by` nor `last_actor` matches
   `$OPERATOR`.

8. **Render the table.** Default columns:

   ```
   Status         Opportunity        Phase              Blocked on           Last touched
   ───────────────────────────────────────────────────────────────────────────────────────
   ACTION NEEDED  malaria-pilot      design-review      gate: idea-to-pdd    neal@dimagi.com, 2d ago
   ACTION NEEDED  turmeric-survey    commcare-setup     input: training-materials/raw-photos  (none yet)
   RUNNING        nutrition-v2       ocs-setup          —                    jjackson@dimagi.com, 20m ago
   IDLE           bednet-pilot       llo-management     —                    sarvesh@dimagi.com, 1w ago
   ```

   - `Phase` is the current *phase key* from `run_state.yaml` (e.g., `ocs-setup`),
     not the display name — keeps the column narrow
   - `Last touched` combines `last_actor` + humanized `last_actor_at`. For
     opps where no skill has run yet (fresh `idea.md` only), show `(none yet)`
   - `Mode` (default/review/auto) is dropped from the default table —
     it appears in the detail view. Add it back only if an admin requests it

9. **Footer.** After the table, print a one-line summary:

   ```
   4 opps shown (1 ERROR, 2 ACTION NEEDED, 1 RUNNING). `--all` to include IDLE/DONE.
   ```

   If `--mine` was passed, add `Filtered to <email>.` after the summary.

## Detailed status (with opp-name)

1. Read `ACE/<opp-name>/run_state.yaml` from GDrive.
2. Display:
   - `Initiated by: <email>, <timestamp>` and `Last touched by: <email>, <humanized>`
   - Current phase and step (with tag — ACTION NEEDED / RUNNING / IDLE / ERROR / DONE)
   - Mode (default/review/auto)
   - All completed steps with timestamps
   - Pending steps (non-recurring)
   - Recurring steps and their last run dates (pulled from `monitoring/`, `qa-reports/`)
   - Any gate approvals (approved / pending / rejected, with approver email)
   - Any errors or manual interventions
   - Links to key artifacts in GDrive (PDD, deployment-summary, invites, QA report, launch-record)
   - If any gate is pending, print the path to the gate brief at
     `ACE/<opp-name>/gate-briefs/<gate-name>.md` so the admin can read it
     before re-running `/ace:run` to approve

## Operator identity and missing `git config`

If `git config user.email` is empty or unset, the list view still works —
rows render with `Last touched: <unknown>, <timestamp>` — but `--mine`
errors with:

```
/ace:status --mine: cannot determine operator; set `git config --global user.email <your-email>` and retry.
```

## Examples

```text
/ace:status
  → Full list, sorted with ACTION NEEDED first, IDLE/DONE hidden

/ace:status --mine
  → Only opps initiated by or last touched by me

/ace:status --all
  → Include IDLE and DONE rows (useful for "what did we ship this quarter")

/ace:status malaria-pilot
  → Full detail view for one opp
```
