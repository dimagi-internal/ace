---
name: fork-run
description: >
  Fork an existing ACE run at a phase OR skill boundary via ace-web's
  POST /api/w/<workspace_slug>/opps/<slug>/fork endpoint. Copies
  upstream-of-fork artifacts into a new run and seeds the new working session
  with your reason; preserves the source run for diff/debug. Use to A/B test
  skill changes, or to re-run the tail of a phase, without overwriting a run.
disable-model-invocation: false
---

# fork-run

Branches an ACE run at a point in its lifecycle. Artifacts upstream of that
point are copied into a new run under `ACE/<opp>/runs/<new-run-id>/`; the fork
point and everything after it are left empty so they re-run fresh.

Calls ace-web's REST fork endpoint — the server does the Drive copy (it holds
the user's Drive OAuth credentials, so they never reach the client).
Authenticates via the per-human `ACE_WEB_PAT_TOKEN` (same as `upload-transcript`).

> **A fork point is ONE concept with TWO spellings.** Name a **phase**
> (`fork_at_phase`) to re-run it whole, or a **skill** (`fork_at_skill`) to keep
> that phase's earlier artifacts and re-run from that skill onward. Exactly one
> is required; both resolve to the same internal `ForkPoint`.

## When to use

- **Validate a code change against a prior run's upstream artifacts.** After
  fixing a Phase 6 recipe, fork at `qa-and-training` to get a fresh Phase 6 over
  the same PDD/apps/Connect opp.
- **Re-run the tail of a phase, keeping its earlier work.** Fork at
  `fork_at_skill: app-hq-settings` to redo Phase 3 from Step 2.65 while keeping
  the built + deployed apps. This is usually what you want when one late step in
  a phase was broken.
- **Compare two skill versions head-to-head.** Fork twice, diff the verdicts.
- **Investigate a phase-N failure without re-running 1..N-1.**

For "retry in place, overwrite history" — no fork record, tightest loop —
dispatch the phase subagent directly against the existing run
(`Agent(ace:<phase>)`).

## Verified contract

Verified against ace-web `origin/main` @ `5478629` (ace-web#698, 2026-07-27):
`apps/api/api.py:155`, `apps/opps/api.py:1259`, `apps/opps/schemas.py`
(`OppForkIn`), `apps/opps/opp_forker.py`, `apps/opps/skills.py`
(`resolve_fork_point`).

**Route** — workspace-scoped. The router mounts at `/w/{workspace_slug}/opps`:

```
POST ${ACE_WEB_BASE_URL}/api/w/<workspace_slug>/opps/<slug>/fork
```

**Body** — `OppForkIn` is a `StrictModel`, so any unknown key is a hard 422
`extra_forbidden`, not a silent ignore:

| field | required | notes |
|---|---|---|
| `fork_at_phase` | **one of** | a `phase:` value from `agents/*.md` — re-runs the phase whole |
| `fork_at_skill` | **one of** | a skill name — keeps that phase's earlier artifacts, re-runs from this skill |
| `source_run_id` | no | defaults to the opp's latest run |
| `mode` | no | `keep-all` (default) or `keep-overrides-only` |
| `edits` | no | list of `{row_id, new_answer}` decision overrides applied during the fork |
| `feedback` | no | ≤8000 chars; seeded as the **first user turn** of the new run's working session |

Exactly one of `fork_at_phase` / `fork_at_skill` — neither or both is a 422.

**How a skill fork trims.** Phases before the fork skill's phase copy whole;
phases after are empty. Within the fork skill's own phase, an artifact is kept
iff the skill that produced it has a lower ordinal. Attribution comes from
`lib/artifact-manifest.ts`'s `producedBy`, **not** from parsing
`<skill>_<role>.ext` filenames — so artifacts that don't follow the convention
(e.g. `deliver-connect-coverage.md`) aren't silently dropped. Anything the
manifest can't attribute is **kept**.

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

3. **Validate inputs.** `opp_slug` non-empty, and exactly one of
   `fork_at_phase` / `fork_at_skill`. A phase must appear as a `phase:` value in
   `agents/*.md`; a skill must be a `skills/<name>/` directory. Check locally —
   it's the most common failure, and checking here turns a round-trip into an
   instant, specific error.

4. **POST.** Send only the fields in the table above:

   ```bash
   set -o pipefail
   url="${ACE_WEB_BASE_URL%/}/api/w/${workspace_slug}/opps/${opp_slug}/fork"
   body=$(jq -n \
     --arg phase "${fork_at_phase:-}" \
     --arg skill "${fork_at_skill:-}" \
     --arg src "${source_run_id:-}" \
     --arg mode "${mode:-keep-all}" \
     --arg fb "${feedback:-}" \
     '{mode: $mode}
      + (if $phase == "" then {} else {fork_at_phase: $phase} end)
      + (if $skill == "" then {} else {fork_at_skill: $skill} end)
      + (if $src   == "" then {} else {source_run_id: $src} end)
      + (if $fb    == "" then {} else {feedback: $fb} end)')
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
   | 400 | `invalid-fork-point` | neither or both of `fork_at_phase` / `fork_at_skill` |
   | 400 | `unknown-phase` | `fork_at_phase` isn't a registered phase (or a stale `ACE_PLUGIN_PATH`) |
   | 400 | `unknown-skill` | `fork_at_skill` isn't in the skill registry |
   | 404 | `source-not-found` | `opp_slug` not in Drive |
   | 404 | `no-runs` | opp has no `runs/` folder — old single-run layout |
   | 404 | `source-run-not-found` | `source_run_id` not under `runs/` |
   | 422 | `extra_forbidden` in `extras.errors[].type` | you sent a field the schema doesn't have |
   | 401/403 | — | PAT invalid/revoked → `/ace:ace-web-pat-mint` |
   | HTML body | — | **wrong route.** An unrouted path falls through to the SPA catch-all and returns a bare HTML 404, not JSON. Check `/api/w/<ws>/opps/...`. |

6. **Report.**

   ```
   Forked ACE/<opp>/runs/<source_run_id>/ → runs/<run_id>/
   Fork point: <phase|skill> (earlier work copied; from here on re-runs)
   Mode: <mode>
   Workbench: <ACE_WEB_BASE_URL>/chat/<working_session_slug>

   Next: /ace:run <opp>/<run_id> to resume there.
   ```

## Known issues

None currently open. *(This section read the same thing while the skill was
100% broken — see § History. If you're relying on it, spot-check the contract
against ace-web source instead.)*

## History — why this file is source-verified

This skill was **100% non-functional** from 2026-04-20 to 2026-07-27, and its
Known-issues section read *"None currently open"* the whole time (ace#985).

**What actually happened:** ace-web had two fork implementations.
`apps/opps/fork.py` did skill-granular forks with a seeded working session —
which is exactly what this doc described, and it was real. It was deleted in
`289ee20` ("run forking gone with multi-run") because it trimmed by a
`steps/<NN>-<skill>/` layout the multi-run redesign replaced. The older
phase-level `opp_forker.py` survived, so *a* fork endpoint still existed and
nothing noticed ACE was pointing at a corpse. The later `/api/v2/ → /api/`
rename moved the route again.

So the doc wasn't fiction — it documented a real endpoint that was removed, and
no test on either side noticed for three months.

**Restored in ace-web#698** (2026-07-27): skill-granular forking and `feedback`
seeding are back, unified onto the surviving endpoint. A fork point is now one
concept with two spellings rather than two competing implementations.

**A prior fix attempt made it worse.** ace#978 corrected one row of the old
skill-name table without noticing skill names were the wrong vocabulary for
*that* endpoint — raising the doc's confidence while it stayed broken. Fixing
the map while the road was out.

**Preventer:** `test/fork-run-phase-references.test.ts` asserts every fork point
this file offers resolves in the agent registry. It does **not** yet assert the
route exists — that's the half that actually broke here, and it wants a contract
check (POST an invalid body, assert a JSON 4xx rather than the SPA's HTML 404).

## Related

- `upload-transcript` — same shape (POST to ace-web with PAT), same env vars.
- `/ace:ace-web-pat-mint` — provisions `ACE_WEB_PAT_TOKEN`.
- `agents/orchestrator-reference.md § Fork Points` — the per-opp vs per-run
  artifact design this endpoint implements.
- ace-web source: `apps/opps/api.py`, `apps/opps/schemas.py`,
  `apps/opps/opp_forker.py`.
