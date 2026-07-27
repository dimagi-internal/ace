---
name: fork-run
description: >
  Fork an existing ACE run at a PHASE boundary via ace-web's
  POST /api/w/<workspace_slug>/opps/<slug>/fork endpoint. Copies
  upstream-of-fork phase artifacts into a new run; preserves the source run
  for diff/debug. Use to A/B test skill changes without overwriting prior runs.
disable-model-invocation: false
---

# fork-run

Branches an ACE run at a **phase** boundary. The fork copies every phase folder
BEFORE the named phase into a new run under `ACE/<opp>/runs/<new-run-id>/`. The
named phase and everything after it are left empty so they re-run fresh.

Calls ace-web's REST fork endpoint — the server does the Drive copy (it holds
the user's Drive OAuth credentials, so they never reach the client).
Authenticates via the per-human `ACE_WEB_PAT_TOKEN` (same as `upload-transcript`).

> **Fork granularity is the PHASE, not the skill.** `fork_at_phase` is resolved
> by `_resolve_phase_ordinal` against the `phase:` value in `agents/*.md`
> frontmatter, and trimming is by whole numbered phase folder. A skill name
> raises `unknown-phase`. There is no mechanism that can keep part of a phase
> and re-run the rest. See § Verified contract.

## When to use

- **Validate a code change against a prior run's upstream artifacts.** After
  fixing a Phase 6 recipe, fork at `qa-and-training` to get a fresh Phase 6 over
  the same PDD/apps/Connect opp.
- **Compare two skill versions head-to-head.** Fork twice, diff the verdicts.
- **Investigate a phase-N failure without re-running 1..N-1.**

**To re-run only part of a phase, do NOT fork** — the endpoint cannot express
it. Dispatch the phase subagent directly against the existing run
(`Agent(ace:<phase>)`), which retries in place and overwrites history.

## Verified contract

Verified against ace-web `origin/main` @ `dcac137` (2026-07-27):
`apps/api/api.py:155`, `apps/opps/api.py:1259`, `apps/opps/schemas.py:138-164`,
`apps/opps/opp_forker.py:143-186,504`.

**Route** — workspace-scoped. The router mounts at `/w/{workspace_slug}/opps`:

```
POST ${ACE_WEB_BASE_URL}/api/w/<workspace_slug>/opps/<slug>/fork
```

**Body** — `OppForkIn` is a `StrictModel`, so any unknown key is a hard 422
`extra_forbidden`, not a silent ignore:

| field | required | notes |
|---|---|---|
| `fork_at_phase` | **yes** | a `phase:` value from `agents/*.md` — see the table below |
| `source_run_id` | no | defaults to the opp's latest run |
| `mode` | no | `keep-all` (default) or `keep-overrides-only` |
| `edits` | no | list of `{row_id, new_answer}` decision overrides applied during the fork |

There is **no `feedback` field.** Passing one 422s.

**`fork_at_phase` values** (`phase:` in `agents/*.md` frontmatter — grep it, don't
trust this table):

| ordinal | `fork_at_phase` |
|---|---|
| 1 | `idea-to-design` |
| 2 | `scenarios-and-acceptance` |
| 3 | `commcare-setup` |
| 4 | `connect-setup` |
| 5 | `ocs-setup` |
| 6 | `qa-and-training` |
| 7 | `synthetic-data-and-workflows` |
| 8 | `solicitation-management` |
| 9 | `execution-management` |
| 10 | `closeout` |

**`mode`:**

- `keep-all` (default) — `decisions.yaml` carries ALL upstream rows, both AI
  defaults and overrides. Use when iterating on one downstream phase.
- `keep-overrides-only` — carries only rows with `status: overridden` from
  phases before the fork. AI defaults are dropped so downstream re-derives them.
  Use when you suspect upstream AI defaults shaped downstream phases badly.

**Response** — `OppForkOut`: `{slug, run_id, working_session_slug}`. Note the
field is `run_id`, not `new_run_id`.

**Progress** — forks are async; poll `GET /api/w/<ws>/opps/<slug>/fork/status`
(`ForkStatus`: `unknown | counting | copying | finalizing | done | error`).

## Env vars

- `ACE_WEB_BASE_URL` — e.g. `https://labs.connect.dimagi.com/ace`. Source: `.env`.
- `ACE_WEB_PAT_TOKEN` — per-human PAT. Mint via `/ace:ace-web-pat-mint`.
- `workspace_slug` — **not** in `.env`. Resolve it from `GET /api/workspaces`,
  or read it off any ace-web run URL (`/ace/opps/<workspace>/<opp>/runs/...`).
  For the Dimagi tenant it is `dimagi-team`.

Both env vars are pre-flighted by `/ace:doctor` `[Auth liveness]`.

## Process

1. **Pre-flight env.** Read both from `$CLAUDE_PLUGIN_DATA/.env`. Halt naming
   the missing var and the fix:

   ```
   ACE_WEB_PAT_TOKEN not set. Mint a PAT via /ace:ace-web-pat-mint
   (one-time per machine, ~30s gh-style browser flow), then retry.
   ```

2. **Resolve `workspace_slug`** if the caller didn't supply it (see above).

3. **Validate inputs.** `opp_slug` and `fork_at_phase` non-empty;
   `fork_at_phase` must appear as a `phase:` value in `agents/*.md`. Check this
   locally — it is the single most common failure, and checking it here turns a
   round-trip 404 into an instant, specific error.

4. **POST.** Send only the fields in the table above:

   ```bash
   set -o pipefail
   url="${ACE_WEB_BASE_URL%/}/api/w/${workspace_slug}/opps/${opp_slug}/fork"
   body=$(jq -n \
     --arg phase "$fork_at_phase" \
     --arg src "${source_run_id:-}" \
     --arg mode "${mode:-keep-all}" \
     '{fork_at_phase: $phase, mode: $mode}
      + (if $src == "" then {} else {source_run_id: $src} end)')
   resp=$(curl -sS -w '\n%{http_code}' -X POST "$url" \
     -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
     -H "Content-Type: application/json" \
     -d "$body")
   http_code=$(printf '%s\n' "$resp" | tail -1)
   payload=$(printf '%s\n' "$resp" | sed '$d')
   ```

5. **Branch on status.** Errors are problem+json; the machine-readable code is
   in **`detail`** (`title` is prose, `status` is the HTTP code):

   | status | `detail` | meaning |
   |---|---|---|
   | 2xx | — | success — parse `run_id` + `working_session_slug` |
   | 400 | `invalid-mode` | `mode` not one of the two literals |
   | 400 | `unknown-phase` | `fork_at_phase` isn't a registered phase (usually a skill name, or a stale `ACE_PLUGIN_PATH`) |
   | 404 | `source-not-found` | `opp_slug` not in Drive |
   | 404 | `no-runs` | opp has no `runs/` folder — old single-run layout |
   | 404 | `source-run-not-found` | `source_run_id` not under `runs/` |
   | 422 | `extra_forbidden` in `extras.errors[].type` | you sent a field the schema doesn't have |
   | 401/403 | — | PAT invalid/revoked → `/ace:ace-web-pat-mint` |
   | HTML body | — | **wrong route.** An unrouted path falls through to the SPA catch-all and returns a bare HTML 404, not JSON. Check `/api/w/<ws>/opps/...`. |

6. **Report.**

   ```
   Forked ACE/<opp>/runs/<source_run_id>/ → runs/<run_id>/
   Fork point: <fork_at_phase> (phases before it copied; it and downstream re-run)
   Mode: <mode>
   Workbench: <ACE_WEB_BASE_URL>/chat/<working_session_slug>

   Next: /ace:run <opp>/<run_id> to resume at <fork_at_phase>.
   ```

## Known issues

- **No seed message.** An earlier version of this doc documented a required
  `feedback` field recorded as the new run's first user-turn. **That was never
  implemented** — `OppForkIn` has no such field and, being strict, 422s on it.
  Explain the fork's purpose in your first message to the forked run instead.
  Whether ace-web *should* accept `feedback` is open (ace#985).

## History — why this file is now source-verified

Every line below § Verified contract was checked against ace-web source, because
this skill was **100% non-functional** until 2026-07-27 (ace#985) and its own
Known-issues section read *"None currently open."* Three independent drifts:

1. Wrong route (`/api/opps/<slug>/runs/<id>/fork`) — unrouted, so it returned
   bare HTML 404 and the skill's own error handling couldn't classify it.
2. Wrong body (`from_skill` / `feedback`) — 422 against a strict schema.
3. Claimed mid-phase forks, which the forker cannot express.

A prior fix attempt (ace#978) corrected a wrong entry in the skill-name table
without noticing that **skill names are the wrong vocabulary entirely** — making
the docs more confident while still broken. Hence the rule at the top: fork
granularity is the phase, and the phase names come from `agents/*.md`.

## Related

- `upload-transcript` — same shape (POST to ace-web with PAT), same env vars.
- `/ace:ace-web-pat-mint` — provisions `ACE_WEB_PAT_TOKEN`.
- `agents/orchestrator-reference.md § Fork Points` — the per-opp vs per-run
  artifact design this endpoint implements.
- ace-web source: `apps/opps/api.py`, `apps/opps/schemas.py`,
  `apps/opps/opp_forker.py`.
