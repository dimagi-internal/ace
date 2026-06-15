# Labs workflow render needs a `run_id` deep-link (not the bare workflow URL)

**Date:** 2026-06-13
**Surfaced by:** bednet-spot-check/20260612-1443 Phase 7 (`synthetic-walkthrough-run` + `synthetic-workflow-polish-eval`) landing `partial` — couldn't headlessly capture the polished workflow dashboard.
**Refs:** jjackson/ace#769, jjackson/ace#788, jjackson/connect-labs#541 (+ labs fix commit `559d6bf4`).

## 2026-06-15 correction (#788) — the recurrence was a malformed PATH, not org_data

bednet-spot-check/20260615-1309 Phase 7 hit the same capture failure and it was
*misattributed to empty `organization_data` again*. Reading the labs source
(`commcare_connect/workflow/urls.py` + `workflow/views.py`) settles it:

- **The only run routes are** `path("<int:definition_id>/run/", WorkflowRunView)`
  and `path("run/<int:run_id>/", WorkflowRunDetailView)`. There is **no**
  `<definition_id>/run/<run_id>/` route. The skills were emitting
  `…/labs/workflow/<id>/run/<run_id>/?opportunity_id=<opp>` — `run_id` as a
  **path segment** — which matches neither route → **Resolver404 / "Page not
  found."** That 404 *is* the #788 symptom.
- `WorkflowRunView.get_context_data` reads the run via
  **`run_id = self.request.GET.get("run_id")`** (a query param) and
  `opportunity_id` from `labs_context`. So the run-loading runner view wants
  `…/<def_id>/run/?run_id=<M>&opportunity_id=<N>`.
- **Empty `organization_data` is NOT a blocker.** `validate_context_access`
  carries an explicit comment + per-field passthrough: it deliberately does
  *not* bail out on empty org_data, forwarding `opportunity_id`/`program_id`
  from the URL "(e.g. headless renders)." So the param is honored regardless —
  the connect-labs#541 fix already covers this. Empty org_data was a red
  herring both times.

**Fix:** ACE skills now emit `…/run/?run_id=<run_id>&opportunity_id=<opp>` (the
query-param form that was already labelled "equivalent" below — it's the ONLY
working form; the path-segment "primary" was wrong). The bare picker fallback
(`…/<id>/?opportunity_id=<opp>`, no `/run/`) is unchanged and still valid.

## The wrong mental model (what ACE used to do)

ACE built workflow render URLs as:

```
${LABS_BASE_URL}/labs/workflow/<workflow_id>/?opportunity_id=<labs_opp_id>
```

…and assumed that rendered the polished per-FLW dashboard. It does not.

## The two real failure modes (observed live against labs prod)

A labs workflow run-view is gated on **two** things, and the bare URL above provides neither reliably:

1. **No `run_id` → run picker, not the dashboard.** The workflow's render
   code gates its completed view on a `view` prop that is populated *only
   for a saved run*. `workflow_get(3913, 2018)` confirms
   `saved_runs.supports_saved_runs: true` with `snapshot_inputs` — the
   completed render expects a run. `/labs/workflow/<id>/?opportunity_id=<opp>`
   (or `…/run/` with no run_id) renders `select_run_mode` — the run *picker*.
   The polished per-FLW render only mounts with a `run_id` in the URL.

2. **Empty `organization_data` → labs strips the context param.** Labs'
   `validate_context_access` early-returned `{}` when the session's cached
   `organization_data` was empty (which happens when the Connect org-list
   API flakes during OAuth login), so the middleware treated `?opportunity_id=`
   as "no access," cleared context, and redirected to strip the param →
   "please select an opportunity" banner / context selector. Headless
   walkthrough sessions are the most likely to hit the org-list flake.
   This is **labs-side** and fixed in connect-labs `559d6bf4` (pass the
   param through to LabsRecord API enforcement even with empty org_data).
   ACE cannot fix this from its side — it only drives the OAuth click-through;
   labs owns `organization_data`.

`?opportunity_id=` was **always honored** for a normal populated-org_data
session — ACE's original issue (#769) misdiagnosed the symptom as "the param
is ignored / there's a React Select Context modal." There is no React modal;
it's an Alpine.js header dropdown + a banner. The real ACE-side bug was the
**missing `run_id`**.

## The correct recipe (verified live)

```
${LABS_BASE_URL}/labs/workflow/<workflow_id>/run/?run_id=<run_id>&opportunity_id=<labs_opp_id>
```

- `<run_id>` = a **saved** run. For LLO Weekly Review prefer the latest
  (`Week 2 run_id`, else `Week 1`); for Program Admin Audit use the
  `audit_run_id`. These are produced + recorded by `synthetic-workflow-seed`
  (Step 8 saved-runs loop; Step 9 summary).
- Equivalent query form: `…/run/?opportunity_id=<N>&run_id=<M>`.

## Where ACE encodes it now

`synthetic-workflow-seed` Step 9 emits ready-to-use **Render deep-links**
(with `run_id`) in its summary; three consumers use them verbatim:

- `synthetic-workflow-polish-eval` Step 6 (visual-judge screenshot capture)
- `synthetic-summary` (the clickable "Demonstrative workflows" links)
- `synthetic-walkthrough-spec` (workflow-dashboard scenes)

Each falls back to the bare URL (picker) only when no run was saved, and
emits a `[WARN]` naming which of the two failure modes applies so the
operator isn't left guessing.

## The general lesson

This is a "close the loop to the source of truth" case. ACE was *guessing*
at how labs renders a workflow (a URL shape another system owns) and shipped
a plausible-but-wrong URL. The fix was to **observe the real render URL from
labs once** (the labs agent drove a real browser against prod with the exact
bednet IDs; `workflow_get` corroborated the saved-runs contract) and encode
the observed recipe — not iterate guesses through the headless walkthrough.
When a render lands on a picker/banner instead of content, suspect a missing
deep-link parameter before suspecting auth.
