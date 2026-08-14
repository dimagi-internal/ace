---
name: sweep-connect
description: >
  Diff Connect programs/opportunities/payment-units/invites against the
  live-set, score orphans, surface a triage report. Soft-deactivate
  orphan opportunities; auto-delete orphan unaccepted FLW invites;
  report-only for programs and payment units.
disable-model-invocation: false
---

# sweep-connect

Find Connect artifacts (programs, opportunities, payment units, FLW invites) that no current opp references, score them, and present them for triage. Connect's upstream API is uneven: opportunity deactivate is available, unaccepted FLW invite delete is available, but programs and payment units have no upstream delete path. This skill deactivates opportunities and deletes unaccepted invites **in its execute pass, after the orchestrator's per-system human-confirmation gate** (see `agents/sweep.md § Human-confirmation gate`); programs and PUs surface in a "upstream-gap — delete via Connect admin UI" section.

## Inputs

- Live-set file path from `sweep-live-set` skill output.
- `ACE_CONNECT_BASE_URL` from `.env` (e.g. `https://connect.dimagi.com`).
- `mode` — `recommend` (default) | `execute`. In `recommend` the skill is **report-only**: diff/score/render + return the recommended-action list; **no mutations**. In `execute` it mutates only `approvedIds`. The human-confirmation gate between the two is the orchestrator's job — see `agents/sweep.md § Human-confirmation gate`.
- `approvedIds` (`execute` mode only) — the exact ids the human approved in chat. Mutate nothing outside this set.

## Products

- `ACE/_sweep/<timestamp>/connect-orphans.md` — human-readable triage report.
- `ACE/_sweep/<timestamp>/connect-orphans.yaml` — machine-readable `OrphanReport`.
- For approved orphan opportunities: `connect_update_opportunity({active: false})` calls.

## Process

1. **Read the live-set** via `drive_read_file`. Parse YAML.
2. **List Connect inventory** using existing atoms:
   - `connect_list_programs`
   - `connect_list_opportunities` (per program)
   - `connect_list_invites` (per program — for unaccepted-invite cleanup tied to orphan opportunities)
   - Payment units are NOT listed standalone — they are implicit children of opportunities. When an opp is deactivated (or eventually hard-deleted), its PUs follow.
3. **Diff** each item's id against the corresponding live-set bucket:
   - programs → `liveSet.identifiers.connectProgramIds`
   - opportunities → `liveSet.identifiers.connectOpportunityIds`
   - invites (for orphan opportunities only) → no diff needed; every invite under an orphan opp is itself orphaned
4. **Score** each orphan via `scoreConnectItem(item, liveSet)` from `lib/sweep-fingerprint.ts`.
4b. **Opportunity health + demo-user invite hygiene (ace#953 / ace#938).** For each candidate opportunity, `connect_get_opportunity` and record `end_date` onto the `ConnectItemInfo` you pass to the scorer, then `connect_list_flw_invites({ organization_slug, opportunity_id, phone: '${ACE_E2E_PHONE}' })` and record whether the demo user holds access and in what state.

   - **`end_date === ''` is a DEFECT, not an orphan signal.** An opportunity with no end date **bricks the mobile app for every worker invited to it** — that is ace#938, where one poisoned opp was found the hard way and a hand sweep of the same org turned up **ten more** loaded landmines. `scoreConnectItem` now flags it `high` with a `MALFORMED:` signal. Note `undefined` (not read) is deliberately NOT malformed: the repair writes a date, so scoring an unread field as malformed would mutate healthy opportunities.
   - **The demo-user rows are report-only, and split by state.** `match.status === 'accepted'` has **no ACE-side delete path at all** — Connect's delete view excludes accepted invites server-side, and `delete_opportunity()` exists only as a Celery task with no view, no REST, no atom. The escape is rotating `${ACE_E2E_PHONE}`. `match.claimed === false` (pending) is deletable **once ace#1159 lands** — that atom currently cannot be called because no atom returns the invite row id.

   **Cost note:** `connect_get_opportunity` is 2 HTTP GETs per opportunity, and `connect_list_opportunities` cannot substitute (the list page renders no date). `ai-demo-space` held 114 opportunities at ace#938 time, so an org-wide deep pass is ~340 requests. Scope it to live-set-diffed orphans plus a periodic full audit, or accept the cost — the hand sweep that found the ten landmines did the full pass successfully.

5. **Build the `OrphanReport`** with `system: 'connect'`. Partition the report into **four** sections:
   - **Actionable — repair:** malformed opportunities (empty `end_date`). This is a *repair*, not a deletion, and it is the highest-value output of this sweep.
   - **Actionable — deactivate/delete:** orphan opportunities (soft-deactivate) and unaccepted FLW invites (auto-delete).
   - **Report-only — demo-user access:** one row per opportunity where `${ACE_E2E_PHONE}` holds access, annotated with its reason: `accepted → no upstream delete path; rotate ${ACE_E2E_PHONE}` or `pending → awaiting ace#1159`.
   - **Upstream-gap:** programs only — print Connect admin URLs (`<base_url>/a/<org_slug>/program/<id>/`) for manual deletion. There is no upstream delete view for programs.
6. **Render** via `renderOrphanReport()` from `lib/sweep-report.ts`. Write `connect-orphans.md` and `connect-orphans.yaml` to the sweep folder.
7. **Recommend — stop here in `mode: recommend`.** Return the structured recommended-action list (opportunities to deactivate; unaccepted FLW invites to delete — each with id, name, confidence) plus the programs report-only list and the report Drive link, to the orchestrator. **Perform no mutations.** Do not try to prompt the human from this skill — a dispatched subagent can't reach them; the orchestrator runs the confirmation gate (see `agents/sweep.md § Human-confirmation gate`).

## Execute phase (`mode: execute` only)

Runs only when the orchestrator re-dispatches with `mode: execute` + `approvedIds` (the ids the human approved in chat). Mutate **only** those ids:

- **Malformed opportunities (repair)** → call `connect_update_opportunity` with `{ organization_slug, opportunity_id, end_date: <date> }`. **Two guards, both load-bearing:** (1) only ever FILL an empty `end_date` — never shorten an existing one; (2) if the opportunity is **in the live-set**, propose a FUTURE date so the repair cannot end a run that is still going. A past date is fine only for an orphan. The atom re-reads via `getOpportunity` on the 302, so the repair is verified rather than asserted.
- **Opportunities** → call `connect_update_opportunity` with `{ organization_slug, opportunity_id, active: false }`.
- **Unaccepted FLW invites** → call `connect_delete_unaccepted_flw_invites({ organization_slug, opportunity_id, user_invite_ids: [...] })`. **This path is currently unreachable — see ace#1159:** no atom returns the invite row id. `connect_list_flw_invites` shipped (ace#824/#855, `b23303ff`) but its `FlwInviteRow` carries no id, and `connect_list_invites` is PROGRAM-scoped, not the FLW invite table. Until #1159 surfaces the `UserInvite` pk, report these rather than attempting the delete. Accepted invites in the list are silently skipped server-side; cascade-deletes associated `OpportunityAccess` rows.

Return the per-item result. Programs are never mutated (upstream gap — report-only).

## Failure modes

- **Live-set path doesn't resolve:** abort with "Run `sweep-live-set` first."
- **`connect_list_*` returns 401/403:** session is stale; recommend `/ace:connect-login` then retry.
- **An orphan opportunity is already inactive:** treat as success (no-op).

## Implementation notes for agents

- The Connect `delete_opportunity()` helper exists in `commcare_connect/opportunity/deletion.py` (used by Celery tasks) but no Django view exposes it. Building a connect-delete-opportunity atom (*not yet implemented*) requires an upstream PR — out of scope.
- **The accepted-invite gap is permanent until upstream moves, and ace#1159 does NOT close it.** The delete view filters `exclude(status=accepted)` server-side, so accepted invites are unreachable through it no matter what ids we obtain — and every successful Phase 6 run CLAIMS its tile, which makes the invite accepted. That is the dominant class of accumulated demo-user access. `delete_opportunity()` (the only thing that cascade-deletes `OpportunityAccess` for an accepted worker) has no view. So: #1159 unblocks the pending minority; the accepted majority needs an upstream Connect PR or a `${ACE_E2E_PHONE}` rotation. Do not let #1159 read as finishing this job.
- **Why the accumulation matters beyond tidiness:** the mobile opp-list endpoint filters `Opportunity.objects.filter(opportunityaccess__user=...)` with no `active=True` filter, so ACE's existing soft-deactivate does NOT remove device tiles. They accumulate per demo user forever. Phase 6's claim recipe scrolls to find its target tile among them on a FIXED budget (`speed 80` / `timeout 40000`), which has already produced two deterministic failures when the target sat 8+ tiles deep (ace#647). A fixed budget against an unbounded list degrades on a cadence.
- The Connect `delete_user_invites` HTML view at `/a/<org_slug>/opportunity/<opp_id>/delete_invites/` is `@csrf_exempt` and the atom `connect_delete_unaccepted_flw_invites` calls it directly. Accepted invites are silently skipped server-side, so the caller doesn't need to pre-filter — but doing so saves a server roundtrip.

## Related skills

- `sweep-live-set` produces the live-set this skill diffs against.
