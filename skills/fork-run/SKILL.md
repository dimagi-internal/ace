---
name: fork-run
description: >
  Fork an existing ACE run at a skill boundary via ace-web's POST
  /api/opps/<slug>/runs/<from_run_id>/fork endpoint. Copies upstream-of-fork
  step artifacts into a new run; preserves the source run for diff/debug.
  Use to A/B test recipe or skill changes without overwriting prior runs.
disable-model-invocation: false
---

# fork-run

Branches an ACE run at a skill-boundary. The fork copies artifacts for every skill BEFORE the named fork-skill (by ordinal) into a new run folder under `ACE/<opp>/runs/<new-run-id>/`. Skills AT and AFTER the fork-skill are left empty so they re-run fresh in the new run.

Calls ace-web's REST fork endpoint — server-side does the Drive copy (it has the user's Drive OAuth credentials, no need to expose them to the client). Authenticates via the per-human `ACE_WEB_PAT_TOKEN` PAT (same as `upload-transcript`).

## When to use

- **Validate a code change against a prior run's upstream artifacts.** E.g. after fixing a Phase 6 recipe, fork `turmeric/20260513-2243` at `from_skill: app-test-cases` to get a new run with the same PDD/apps/Connect opp but a fresh Phase 6.
- **Compare two skill versions head-to-head.** Fork once with the old skill, fork again with the new skill, diff the verdicts.
- **Investigate a phase-N failure without re-running phases 1..N-1.** Phases 1-N stay frozen; you iterate on phase N+ in the forked run.

For "retry in place, overwrite history" (debug-loop-tightest, no fork history), dispatch the phase subagent directly via `Agent(ace:<phase>)` against the existing run — no fork needed.

## Inputs

- `opp_slug` (required) — the ACE opp slug, e.g. `turmeric`.
- `from_run_id` (required) — source run id, e.g. `20260513-2243`. Must exist on Drive under `ACE/<opp_slug>/runs/<from_run_id>/`.
- `from_skill` (required) — the FIRST skill of the phase you want to re-run. Examples:
  - `app-test-cases` → fork at Phase 6 boundary (re-run all of Phase 6 in the new run)
  - `ocs-agent-setup` → fork at Phase 5 boundary
  - `connect-program-setup` → fork at Phase 4 boundary
  - `solicitation-create` → fork at Phase 8 boundary
- `mode` (optional, default `empty`) — one of:
  - `with-feedback` — copies upstream-of-fork step folders + carries forward `state.yaml`. Best for "iterate on phase N with full upstream context." Requires `feedback`.
  - `empty` — creates a new run with minimal state; skips the artifact copy. Use only when you want a clean slate downstream of the fork point.
- `feedback` (required iff `mode=with-feedback`) — short free-text explaining the reason for the fork. Recorded in the new run's working-session as the seed user message.

## Env vars

- `ACE_WEB_BASE_URL` — deployed ace-web URL, e.g. `https://labs.connect.dimagi.com/ace`. Source: `.env`.
- `ACE_WEB_PAT_TOKEN` — per-human PAT. Source: `.env` local-only secret. Mint via `/ace:ace-web-pat-mint` if absent.

Both are pre-flighted by `/ace:doctor` `[Auth liveness]` — run that first if either env var is missing.

## Process

1. **Pre-flight env.** Read `ACE_WEB_BASE_URL` and `ACE_WEB_PAT_TOKEN` from `$CLAUDE_PLUGIN_DATA/.env`. Halt with an actionable error if either is missing — name the exact env var and the mint command:

   ```
   ACE_WEB_PAT_TOKEN not set. Mint a PAT via /ace:ace-web-pat-mint
   (one-time per machine, ~30s gh-style browser flow), then retry.
   ```

2. **Validate inputs.** `opp_slug`, `from_run_id`, `from_skill` must all be non-empty strings. If `mode == "with-feedback"`, `feedback` must be non-empty.

3. **POST to ace-web's fork endpoint** via curl. Use `set -o pipefail` and capture status + body so the skill can branch on error class:

   ```bash
   url="${ACE_WEB_BASE_URL%/}/api/opps/${opp_slug}/runs/${from_run_id}/fork"
   body=$(jq -n \
     --arg from_skill "$from_skill" \
     --arg mode "$mode" \
     --arg feedback "${feedback:-}" \
     '{from_skill: $from_skill, mode: $mode, feedback: (if $feedback == "" then null else $feedback end)}')
   resp=$(curl -sS -w '\n%{http_code}' \
     -X POST "$url" \
     -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
     -H "Content-Type: application/json" \
     -d "$body")
   http_code=$(printf '%s\n' "$resp" | tail -1)
   payload=$(printf '%s\n' "$resp" | sed '$d')
   ```

4. **Branch on HTTP status:**

   - `201` → success. Parse `payload.data` for `new_run_id` and `working_session_slug`. Surface both to the operator. Build the workbench URL (`${ACE_WEB_BASE_URL}/chat/<working_session_slug>`) and log it.
   - `400` with `code: invalid-mode` → caller passed an invalid `mode`. Restate the valid choices.
   - `400` with `code: feedback-required` → `mode=with-feedback` without `feedback`. Restate the requirement.
   - `400` with `code: no-runs-folder` → opp doesn't have a `runs/` subfolder. Probably an old single-run opp; the fork endpoint requires multi-run layout.
   - `400` with `code: src-run-missing` → `from_run_id` not under `runs/`. Typo or wrong format.
   - `404` with `code: opp-not-found` → `opp_slug` not in Drive.
   - `404` with `code: step-not-found` → `from_skill` not in the source run's step list. Skill name typo or the source run never ran the skill.
   - `401`/`403` → `ACE_WEB_PAT_TOKEN` invalid/revoked. Run `/ace:ace-web-pat-mint`.
   - `5xx` → ace-web outage. Re-run later.

5. **Report the result.** Print to the operator's console:

   ```
   Forked ACE/<opp>/runs/<from_run_id>/ → runs/<new_run_id>/
   Mode: <mode>
   Fork point: <from_skill> (skills upstream of this point copied; <from_skill> + downstream will re-run)
   Workbench: <ACE_WEB_BASE_URL>/chat/<working_session_slug>

   Next: /ace:run <opp>/<new_run_id> to resume from <from_skill>.
   ```

## Known issues (file against ace-web)

These don't block use of the fork API but operators should be aware:

1. **Run-id format mismatch.** ace-web's fork endpoint creates run-ids of the form `run-001`, `run-002`, … (sequential per opp). ACE's own commands (`/ace:run`, `/ace:status`) generate and address runs by `YYYYMMDD-HHMM`. A fork-created run with id `run-NNN` IS valid Drive state but `/ace:run <opp>/run-001` may or may not work depending on the orchestrator's slug-resolution rules. Verify before relying.

2. **`state.yaml` vs `run_state.yaml`.** ACE renamed the per-run state file from `state.yaml` to `run_state.yaml` in plugin v0.11.3, but `apps/opps/fork.py` still looks for `state.yaml` when copying carry-forward state. On a current-ACE run the carry-forward step finds no `state.yaml` (because the file is named `run_state.yaml`) and the new run gets no state file copied. The forked run will need its `run_state.yaml` seeded manually for the orchestrator to see upstream phase products.

Both of these are tracked in `docs/learnings/2026-05-14-fork-run-skill.md` (with proposed fixes for the ace-web side). Until ace-web ships those fixes, treat fork-run as an experimental tool — verify the new run's state on Drive before invoking `/ace:run` against it.

## Example invocations

```bash
# Fork at Phase 6 boundary (validate recipe changes against the same upstream
# artifacts):
ACE_WEB_BASE_URL=$ACE_WEB_BASE_URL \
ACE_WEB_PAT_TOKEN=$ACE_WEB_PAT_TOKEN \
fork-run \
  --opp_slug turmeric \
  --from_run_id 20260513-2243 \
  --from_skill app-test-cases \
  --mode with-feedback \
  --feedback "Re-run Phase 6 against the deterministic-bootstrap heal layer (PR #282)."

# Empty fork — fresh slate downstream of solicitation:
fork-run \
  --opp_slug turmeric \
  --from_run_id 20260513-2243 \
  --from_skill solicitation-create \
  --mode empty
```

## Related

- `upload-transcript` — analogous shape (POST to ace-web with PAT), same env var dependencies.
- `/ace:ace-web-pat-mint` — provisions `ACE_WEB_PAT_TOKEN`.
- `agents/orchestrator-reference.md § Fork Points` — describes the design pattern (per-opp vs per-run artifacts) that the fork endpoint implements.
- ace-web source: `apps/opps/fork.py`, `apps/opps/views.py` (`opp_fork` view), `apps/opps/urls.py`.
